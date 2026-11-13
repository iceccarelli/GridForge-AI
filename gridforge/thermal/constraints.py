"""Thermal constraints.

The two most commonly missed, and therefore the two most commercially valuable:
  * residual air load per rack  (10-15% of a 135 kW rack is still 13-20 kW of air
    cooling per position, which a legacy hall usually cannot deliver);
  * CDU capacity derated to the FACILITY water temperature the site can actually
    supply, rather than the temperature the vendor quoted the rating at.
"""
from __future__ import annotations

import math
from dataclasses import dataclass

from ..common import ASSUMED, ESTIMATED, SIMULATED, V
from ..costs import cdu_cost, cost, scaled_cost
from ..constraints import (ConstraintResult, EnvelopeContext, ReliefOption, constraint, floor_racks,
                           gate_racks)
from ..numerics import floor_whole, leq
from ..thermal.library import ARCH_RACK_CAPABILITY_kW, implied_delta_T_K
from ..thermal.schema import Architecture
from ..validation import Provenance, Quantity, qsum


def _effective_units(units: int, redundancy: str) -> int:
    r = redundancy.upper().replace(" ", "")
    table = {"N": units, "N+0": units, "N+1": max(units - 1, 0), "N+2": max(units - 2, 0),
             "2N": units // 2, "N+N": units // 2}
    if r not in table:
        raise ValueError(f"unknown redundancy {redundancy!r}; expected one of {sorted(table)}")
    return table[r]


def _active_cdus(cdus) -> list:
    """The CDU banks that exist: those with at least one unit. A bank with no units is a planned or empty bank, not equipment: it adds no capacity,
    sets no flow, is not priced and receives no relief, so it is ignored (the same rule as ``power.constraints.active_banks``, including its one
    exception: a list in which no bank has a unit is kept as declared, a declaration of zero capacity; thermal may not import power)."""
    return [c for c in cdus if c.units >= 1] or list(cdus)


def _cdu_derate_ratio(c, available_approach_K: float) -> float:
    """The share of a CDU's rating it keeps at the approach the site offers: linear, capped at 1. A non-positive rated approach is not a rating:
    refuse to derate against it (fail closed, no capacity) instead of dividing by zero."""
    return 0.0 if c.rated_approach_K.value <= 0 else min(1.0, max(0.0, available_approach_K / c.rated_approach_K.value))


def _cdu_host(ctx: EnvelopeContext):
    """The CDU bank that receives a relief's unit(s), or None when no bank has a unit.

    THE RULE: a relief buys ONE further usable unit in total (a matched pair under 2N, where a single added unit buys nothing) and puts it in ONE
    bank, the fewest banks that can host it. The bank is fixed by the plant, never by how it was listed: the one whose added unit(s) carry the most
    heat at the water temperature the site can supply (rating x derate x usable units gained), then the most declared flow, then the larger rating,
    then the id. The price follows the units actually added.

    The old relief added one unit to EVERY bank, priced on the sum, so the same CDUs listed as one bank or as several were priced differently, and an
    empty bank doubled the step (audit N2). Banks with no units are not hosts."""
    live = _active_cdus(ctx.thermal.cdus)
    if not live:
        return None
    avail = (ctx.thermal.tcs_target_supply_C.value - facility_water_supply(ctx).temperature.value)

    def gain(c) -> int:
        return _effective_units(c.units + _units_per_relief_step(c.redundancy), c.redundancy) - _effective_units(c.units, c.redundancy)

    def key(c):
        flow = c.rated_flow_l_per_min.value * gain(c) if c.rated_flow_declared else 0.0
        return (-(c.rated_capacity_kW.value * _cdu_derate_ratio(c, avail) * gain(c)), -flow, -c.rated_capacity_kW.value,
                c.id, c.units, c.redundancy, c.rated_approach_K.value)
    return min(live, key=key)


def _units_per_relief_step(redundancy: str) -> int:
    """Units that must be bought to raise the USABLE count of a bank by one. Under 2N (or N+N) the usable count is
    units // 2, so a single added unit buys nothing: capacity arrives in matched pairs."""
    return 2 if redundancy.upper().replace(" ", "") in ("2N", "N+N") else 1


PLANT_UPRATE = 1.5     # screening assumption: the plant relief adds 50% to chilled-water capacity
PUMP_UPRATE = 1.8      # screening assumption: the pump relief adds 80% to pumped flow

#: Disclosures for the trim-chiller relief (tcs_supply_achievable). Each is stated once per place it can be read: the relief's
#: basis note (travels with the ladder step wherever the relief is taken) and the constraint's notes. They change no number.
TRIM_CHILLER_LIMIT_NOTE = ("The cost and electrical load of a trim chiller would depend on the heat it must reject, which is not "
                           "modelled. PUE is not recomputed for the achievable water temperature or for a trim chiller's power, so "
                           "the racks after this relief include no allowance for that load.")
TRIM_CHILLER_PUE_NOTE = ("PUE is not recomputed for the achievable facility-water temperature (design dry-bulb, free-cooling "
                         "hours) or for any trim chiller's power draw: the architecture's fixed library figure is used.")


def _liquid_load_to_plant(ctx: EnvelopeContext) -> bool:
    """Does the whole rack load land on the existing chilled-water plant? Under retained air
    all of it does (it is air-cooled and the plant removes it); under full direct-to-chip
    only the residual air share does, the liquid going to a dedicated loop."""
    return ctx.architecture in (Architecture.HYBRID_DLC, Architecture.RDHX,
                                Architecture.RETAINED_AIR)


@dataclass(frozen=True)
class FacilityWaterSupply:
    """The facility-water temperature a context's liquid loop can hold, and where it comes from."""
    #: The temperature, as the quantity it is built from (the plant's own supply setpoint, or dry bulb plus the dry-cooler approach).
    temperature: Quantity
    #: "trim_chiller" | "dry_coolers" | "existing_plant"
    source: str
    #: The mechanism in words, for a basis sentence.
    mechanism: str


def facility_water_supply(ctx: EnvelopeContext) -> FacilityWaterSupply:
    """The ONE facility-water supply temperature of this context, read by every constraint that needs it (``cdu_capacity`` derates against
    it, ``tcs_supply_achievable`` compares it with the temperature the CDU needs).

    * a proposed trim chiller (the tcs relief set ``trim_chiller_installed``): the plant's supply setpoint, an ASSUMPTION about an asset
      that is not installed (its capacity is not modelled);
    * full DLC with a dry-cooler approach: design dry bulb plus that approach, the water the dedicated high-temperature loop can deliver
      without mechanical cooling;
    * otherwise the existing chilled-water plant's supply setpoint (retained air, rear door, hybrid DLC, and a full-DLC context with no
      dry-cooler approach).

    Before this helper existed ``cdu_capacity`` always derated against the legacy plant's setpoint (a 6 degC chiller) while the gate
    one constraint later used the dry-cooler water: under full DLC the CDU was credited an approach of 24 K on water that was 25 degC."""
    t = ctx.thermal
    if t.trim_chiller_installed:
        return FacilityWaterSupply(t.plant.design_supply_C, "trim_chiller", "a proposed trim chiller (capacity not assessed)")
    if ctx.architecture == Architecture.FULL_DLC and t.plant.dry_cooler_approach_K is not None:
        water = (ctx.site.design_drybulb_C + t.plant.dry_cooler_approach_K).relabel(
            "facility water temperature achievable by dry coolers at design dry bulb",
            "thermal.dry_cooler_fws", step_evidence=SIMULATED)
        # Say the sum, not only its result: the approach is an ASSUMPTION when the client did not supply it (default 10 K, E0), and a reader
        # of "36 degC" must be able to see that 26 degC of it is the site's dry bulb and 10 K is an approach nobody measured.
        appr = t.plant.dry_cooler_approach_K
        return FacilityWaterSupply(
            water, "dry_coolers",
            f"dry coolers at design dry-bulb ({ctx.site.design_drybulb_C.value:g} degC) plus an approach of {appr.value:g} K ({appr.evidence.short})")
    return FacilityWaterSupply(t.plant.design_supply_C, "existing_plant", "existing chilled-water plant")


def _required_fws(t) -> Quantity:
    """The warmest facility water that still lets a CDU hold the TCS target: the target less the CDU approach."""
    return (t.tcs_target_supply_C - t.cdu_approach_K).relabel(
        "facility water supply temperature required", "thermal.required_fws", step_evidence=ESTIMATED)


def _floor(x: float) -> int | float:
    """Whole racks for a basis sentence and for the tie tests below: floor of a finite figure, the figure itself (inf, nan) otherwise.
    It rounds exactly as ``floor_racks`` does (``numerics.floor_whole``), so a sentence or a tie test never says 15 racks where the
    constraint's own rack count says 16."""
    return floor_whole(x) if math.isfinite(x) else x


def _lesser(label: str, model_id: str, a: Quantity, b: Quantity) -> Quantity:
    """The smaller of two rack limits, carrying the weakest evidence of BOTH. (``qmin`` keeps only the winner's lineage, so a limit that
    happens not to be the lower one would silently drop its own evidence class.) Band: the lower of each end."""
    prov = Provenance.derive(label, model_id, [a.prov, b.prov], step_evidence=ESTIMATED)
    (alo, ahi), (blo, bhi) = a.band, b.band
    return Quantity(min(a.value, b.value), a.unit, prov, min(alo, blo), min(ahi, bhi))


@constraint
def architecture_capability(ctx: EnvelopeContext) -> ConstraintResult:
    """Can this cooling architecture carry a rack of this platform at all?

    This is a scenario choice, not a capex line. It has no relief: the answer is
    to compare a different architecture, which is what the scenario set is for.
    """
    capability = ARCH_RACK_CAPABILITY_kW[ctx.architecture]
    declared = False
    if ctx.architecture == Architecture.RDHX and ctx.thermal.rdhx is not None:
        # The client's own rear-door unit, not the screening default.
        capability = ctx.thermal.rdhx.capacity_kW_per_rack
        declared = True
    need = ctx.cluster.platform.rack_kW
    peak = ctx.cluster.platform.peak_rack_kW
    ok = leq(need.value, capability.value)          # a rack exactly at the architecture's capability passes (numerics.LIMIT_REL_TOL)
    racks = gate_racks(ok, "racks permitted by the chosen cooling architecture", need, capability)
    return ConstraintResult(
        "architecture_capability", "thermal",
        "Cooling architecture per-rack capability",
        racks, gate=True,
        basis=(f"{ctx.architecture.value} is practically capable of {capability.render()} per rack"
               + (" (the client's declared rear-door rating)" if declared else
                  " (a library default for the architecture, not a manufacturer's rating or a site measurement)"
                  if ctx.architecture == Architecture.RDHX else "")
               + f"; the target platform draws {need.render()}"
               + f". Modelling limit: the platform's peak rack power ({peak.value:g} kW) is used by no constraint; every "
                 f"limit is sized on the rack power (TDP) figure"),
        relief=None,
        notes=("No capex relieves this constraint. If it binds, the architecture is wrong for the "
               "platform and a different scenario must be selected.",),
    )


@constraint
def cdu_capacity(ctx: EnvelopeContext) -> ConstraintResult:
    t = ctx.thermal
    cdus = _active_cdus(t.cdus)           # a bank with no units is not equipment: no capacity, no flow, no price
    if ctx.architecture in (Architecture.RETAINED_AIR, Architecture.RDHX) or not cdus:
        return ConstraintResult("cdu_capacity", "thermal", "CDU capacity",
                                V(float("inf"), "racks", "CDU capacity: not limiting", ESTIMATED),
                                basis=("architecture does not use CDUs"
                                       if ctx.architecture in (Architecture.RETAINED_AIR, Architecture.RDHX)
                                       else "no CDU schedule declared: CDU capacity was not assessed, so this "
                                            "does not limit the hall here and has not been shown adequate"))
    fws = facility_water_supply(ctx)             # the SAME water temperature tcs_supply_achievable tests (one source of truth)
    fws_supply = fws.temperature
    available_approach = (t.tcs_target_supply_C - fws_supply).relabel(
        "available CDU approach (TCS target minus facility water supply)",
        "thermal.available_approach", step_evidence=ESTIMATED)
    caps: list[Quantity] = []
    # A CDU flow is a limit only when EVERY CDU in the schedule declared one: summing the declared flows alone would understate the bank's
    # flow and refuse racks it can carry. An undeclared flow is a library placeholder that nothing reads (and a named gap at load).
    flow_declared = all(c.rated_flow_declared for c in cdus)
    flows: list[Quantity] = []
    for c in cdus:
        n = _effective_units(c.units, c.redundancy)
        # Vendor ratings are stated AT a specific approach. Derate linearly, capped at rated.
        # A non-positive rated approach is not a rating: refuse to derate against it (fail closed, no capacity)
        # instead of dividing by zero.
        ratio = _cdu_derate_ratio(c, available_approach.value)
        derate = V(ratio, "1", f"{c.id} derate to site facility-water temperature", ESTIMATED,
                   band=(max(ratio * 0.85, 0.0), min(ratio * 1.1, 1.0)),
                   assumptions=[f"Rating quoted at {c.rated_approach_K.value:g} K approach; site offers "
                                f"{available_approach.value:g} K. Linear derate is a screening "
                                f"approximation - confirm against the manufacturer's performance curve."])
        caps.append((c.rated_capacity_kW * derate * V(float(n), "1", f"{c.id} usable units ({c.redundancy})", ASSUMED)
                     ).relabel(f"{c.id} usable capacity at site conditions", "thermal.cdu_usable"))
        if flow_declared:
            flows.append((c.rated_flow_l_per_min * V(float(n), "1", f"{c.id} usable units ({c.redundancy})", ASSUMED)
                          ).relabel(f"{c.id} usable CDU flow", "thermal.cdu_flow_usable"))
    # qsum: order-independent (math.fsum), so the same banks listed in another order are the same capacity and the same rack count.
    total = qsum(caps)
    flow_total = qsum(flows) if flows else None
    plat = ctx.cluster.platform
    racks = total / plat.liquid_kW()
    flow_text = ""
    if flow_declared:
        # Usable units x declared rated flow, over the platform's published flow per rack (a vendor figure, E0): the limit carries the
        # weakest evidence of both limits it is the lesser of.
        flow_racks = (flow_total / plat.flow_l_per_min_per_rack).relabel(
            "racks permitted by declared CDU flow", "thermal.cdu_flow_limit", step_evidence=ESTIMATED)
        racks = _lesser("racks permitted by CDU heat capacity and CDU flow", "thermal.cdu_limit", racks, flow_racks)
        flow_text = (f"; flow {flow_total.render()} usable (declared rated flow x usable units) against {plat.flow_l_per_min_per_rack.render()} "
                     f"per rack permits {_floor(flow_racks.value)} racks")

    def _apply(c: EnvelopeContext) -> EnvelopeContext:
        c = c.copy()
        host = _cdu_host(c)           # the same bank the price below was formed on (the ladder applies a relief to the context it came from)
        if host is not None:
            host.units += _units_per_relief_step(host.redundancy)
        return c

    # One further usable unit in total (a matched pair under 2N), in the one bank that gains most (``_cdu_host``): the price follows the units
    # actually added, so the same CDUs listed as one bank or as several get the same step.
    host = _cdu_host(ctx)
    added_units = _units_per_relief_step(host.redundancy)
    cdu_capex, cdu_kind, cdu_scope, cdu_unpriced, cdu_extra, cdu_limited, cdu_note = cdu_cost(
        added_units, "additional CDU")
    rule = (f"Each step buys {added_units} CDU unit(s) in total ({'a matched pair under 2N' if added_units == 2 else 'one further usable unit'}), "
            f"put in one bank ({host.id}): the fewest banks that can host it, chosen as the bank whose added unit carries the most heat at the site's "
            f"water temperature (then the most declared flow, the larger rating, the id). The price follows the units added, so the same CDUs listed as "
            f"one bank or as several are priced the same; a bank declared with no units is ignored.")
    relief = ReliefOption(
        description="Add CDU capacity (one further usable unit, in one bank)",
        capex_eur=cdu_capex, cost_kind=cdu_kind, scope=cdu_scope, unpriced=cdu_unpriced,
        extra_cost_keys=cdu_extra, quantity=float(added_units), quantity_unit="unit", limited=cdu_limited,
        basis_note="; ".join(x for x in (cdu_note, rule) if x),
        cost_key="cdu.addition",
        lead_time_weeks=V(26, "weeks", "CDU lead time", ASSUMED, band=(16, 40)),
        apply=_apply,
    )
    notes = ("TCS water quality per OCP: conductivity <1500 uS/cm, pH 8.0-10.5, 50 um inline "
             "filtration, sidestream <5 um at 10% of flow.",)

    # Dry-cooler water that the gate has already refused, and a CDU row that comes to zero whole racks as well (no approach at all, OR so
    # little that the derated duty rounds to nothing: a few tenths of a kelvin below the TCS target leaves duty for no rack). Adding CDU units
    # cannot help while the water is too warm (0 x n = 0) and the two zero-rack constraints tie, so the first in evaluation order would be
    # "binding" and the ladder would end at zero racks with the trim chiller that relieves BOTH never reached. The gate holds the hall at zero
    # and owns the relief; the CDU is assessed once the water is. (The relief stays on this row: the assumed CDU kit's lead time is read from
    # it.) The test is the TIE, not "approach <= 0": the earlier test left a window just below the target where the CDU row floored to zero,
    # won the tie, and the ladder stalled at zero racks (review R1).
    if (fws.source == "dry_coolers" and _floor(racks.value) < 1
            and not leq(fws_supply.value, _required_fws(t).value)):
        return ConstraintResult(
            "cdu_capacity", "thermal", "CDU capacity (derated to site water temperature)",
            V(float("inf"), "racks", "CDU capacity: not assessed until the water-temperature gate is relieved", ESTIMATED),
            basis=(f"not assessed here: the facility water the dry coolers can supply ({fws_supply.render()}) leaves a CDU "
                   f"{'no' if available_approach.value <= 0 else 'too little'} approach against the TCS target "
                   f"({t.tcs_target_supply_C.render()}) to carry a rack ({available_approach.value:g} K available), and the "
                   f"water-temperature gate (tcs_supply_achievable) already holds this hall at zero racks. CDU capacity is assessed once "
                   f"that gate is relieved"),
            relief=relief, notes=notes)
    return ConstraintResult(
        "cdu_capacity", "thermal", "CDU capacity (derated to site water temperature)",
        floor_racks(racks),
        basis=(f"{total.render()} usable against {plat.liquid_kW().render()} of liquid load "
               f"per rack; {available_approach.render()} approach available" + flow_text),
        relief=relief, notes=notes,
    )


@constraint
def plant_capacity(ctx: EnvelopeContext) -> ConstraintResult:
    t = ctx.thermal
    plat = ctx.cluster.platform
    per_rack = plat.rack_kW if _liquid_load_to_plant(ctx) else plat.residual_air_kW()
    existing = ctx.power.current_it_load_MW.convert(1000.0, "kW", "existing hall heat load on plant")
    other_heat = t.plant.existing_non_it_heat_kW
    if other_heat is None:
        headroom = (t.plant.chilled_water_capacity_kW - existing).relabel(
            "chilled-water plant headroom", "thermal.plant_headroom", step_evidence=ESTIMATED)
    else:
        # Plant capacity less the IT load less the other heat the existing hall already puts on the plant, never below zero.
        net = (t.plant.chilled_water_capacity_kW - existing - other_heat).relabel(
            "chilled-water plant headroom", "thermal.plant_headroom", step_evidence=ESTIMATED)
        lo, hi = net.band
        headroom = Quantity(max(net.value, 0.0), net.unit, net.prov, max(lo, 0.0), max(hi, 0.0))
    racks = headroom / per_rack

    # Heat rejection of the DEDICATED high-temperature loop (full DLC), when the client declared its dry-cooler capacity. Read as a
    # nameplate: the conditions it is rated at (water and ambient temperature) are not known, so NO derating for the site's design dry
    # bulb is applied and the figure is not claimed at site conditions. Undeclared (or zero: none installed), there is no limit here.
    dry = t.plant.dry_cooler_capacity_kW
    heat_rejection = None
    dry_binds = False
    if ctx.architecture == Architecture.FULL_DLC and dry is not None and dry.value > 0:
        heat_rejection = (dry / plat.liquid_kW()).relabel(
            "racks permitted by dry-cooler heat rejection on the dedicated loop", "thermal.heat_rejection_limit",
            step_evidence=ESTIMATED)
        dry_binds = _floor(heat_rejection.value) < _floor(racks.value)       # a tie keeps the chilled-water relief, as before
        racks = _lesser("racks permitted by chilled-water headroom and dry-cooler heat rejection", "thermal.plant_limit",
                        racks, heat_rejection)

    def _apply(c: EnvelopeContext) -> EnvelopeContext:
        c = c.copy()
        c.thermal.plant.chilled_water_capacity_kW = (
            c.thermal.plant.chilled_water_capacity_kW *
            V(PLANT_UPRATE, "1", "plant uprate factor", ASSUMED))
        return c

    def _apply_dry_coolers(c: EnvelopeContext) -> EnvelopeContext:
        c = c.copy()
        c.thermal.plant.dry_cooler_capacity_kW = (
            c.thermal.plant.dry_cooler_capacity_kW * V(PLANT_UPRATE, "1", "dry-cooler uprate factor", ASSUMED))
        return c

    added_kW = t.plant.chilled_water_capacity_kW.value * (PLANT_UPRATE - 1.0)
    price = scaled_cost(
        "plant.uprate", 900_000 / 3400.0, "EUR/kW", added_kW, "kW",
        "chilled-water plant uprate",
        note="Placeholder re-expressed per kW of cooling added from the earlier 900 kEUR lump at the reference "
             "hall's 3,400 kW (+50% of 6,800 kW). Not a market price.")

    route = ("full rack load (rack heat rejected into the existing plant)" if _liquid_load_to_plant(ctx)
             else "residual air load only (liquid rejected to a dedicated high-temperature loop)")
    if other_heat is None:
        basis = (f"{headroom.render()} of plant headroom against {per_rack.render()} per rack — {route}. Modelling limit: the headroom is "
                 f"plant capacity less the IT load only; UPS, fan and pump heat, plant redundancy and condenser derating are not modelled, so headroom is overstated by their share")
    else:
        basis = (f"{headroom.render()} of plant headroom = {t.plant.chilled_water_capacity_kW.render()} plant capacity less "
                 f"{existing.render()} IT load less {other_heat.render()} of other heat the existing hall already puts on the plant "
                 f"(never below zero), against {per_rack.render()} per rack — {route}. Modelling limit: plant redundancy and condenser derating "
                 f"are not modelled, and only the other heat the client gave is subtracted; a plant uprate scales the capacity, not that heat")
    relief = ReliefOption(
        description="Uprate chilled-water plant (+50%) or add a dedicated high-temperature loop",
        capex_eur=price.capex, cost_kind=price.kind, scope=price.scope,
        quantity=price.quantity, quantity_unit=price.quantity_unit, limited=price.limited,
        basis_note=price.note,
        cost_key="plant.uprate",
        lead_time_weeks=V(44, "weeks", "chiller / dry cooler lead time", ASSUMED, band=(30, 70)),
        apply=_apply,
        risk="A dedicated high-temperature loop is usually cheaper to run and should be compared "
             "against uprating legacy low-temperature plant.",
    )
    notes: tuple[str, ...] = ()
    if ctx.architecture == Architecture.FULL_DLC:
        if heat_rejection is not None:
            basis += (f". Heat rejection on the dedicated loop: {dry.render()} declared dry-cooler capacity against "
                      f"{plat.liquid_kW().render()} of liquid load per rack permits {_floor(heat_rejection.value)} racks. No derating for the "
                      f"design dry bulb ({ctx.site.design_drybulb_C.render()}) or for the conditions the nameplate is rated at was applied: "
                      f"neither is known, so this is the nameplate figure, class E0 as a rack count")
            notes = ("Dry-cooler output falls as ambient temperature rises toward the water temperature; this limit applies no such "
                     "derating (the rating conditions of the declared figure are not known). Confirm the capacity at the site's design "
                     "dry bulb before relying on it.",)
            if dry_binds:
                # The declared dry coolers are the lesser limit: the relief is more of them. Neither its price nor its lead time exists in
                # the library, so both are unknown and reported as such (never zero): the capex becomes a lower bound.
                relief = ReliefOption(
                    description="Add dry-cooler capacity on the dedicated high-temperature loop (+50%, a screening assumption)",
                    capex_eur=None, lead_time_weeks=None, apply=_apply_dry_coolers,
                    risk="Dry-cooler capacity, its pumps and pipework are not priced or dated by this engine; obtain quotations.")
        else:
            notes = ("The heat rejection of the dedicated high-temperature loop (dry coolers) is not sized or limited here: "
                     "thermal.plant.dry_cooler_capacity_kW "
                     + ("was declared as zero (none installed; the loop is what this scenario buys)"
                        if dry is not None else "was not declared")
                     + ". The loop is an unpriced component of the capex.",)
    return ConstraintResult(
        "plant_capacity", "thermal", "Chilled-water plant capacity",
        floor_racks(racks),
        basis=basis,
        relief=relief,
        notes=notes,
    )


def _flow_disclosure(ctx: EnvelopeContext) -> str:
    """Which per-kW flow hydraulic_flow uses and the delta-T it implies, so the flow figure can be checked against a heat balance.
    Discloses only: the limit is still the plant's pumped flow over the platform's own flow per rack. The 1.45 l/min/kW (10 K)
    screening constant in the thermal library is not used. Heat balance: flow = heat / (rho cp dT), so a plant with a SMALLER
    delta-T than the rack-side loop needs MORE flow per rack than the platform figure, and comparing the two without conversion
    overstates the racks (a larger plant delta-T understates them). That only matters if the intake figure is the plant's flow."""
    plat = ctx.cluster.platform
    flow = plat.flow_l_per_min_per_rack.value
    liquid_dT = implied_delta_T_K(plat.liquid_kW().value, flow)
    rack_dT = implied_delta_T_K(plat.rack_kW.value, flow)
    plant = ctx.thermal.plant
    plant_dT = plant.design_return_C.value - plant.design_supply_C.value
    # Only a DLC architecture has a CDU / technology (TCS) loop; under RDHx the platform figure is still the library's flow per rack.
    dlc = ctx.architecture in (Architecture.HYBRID_DLC, Architecture.FULL_DLC)
    loop = "rack-side (TCS) delta-T" if dlc else "delta-T"
    compared = "the rack-side flow without converting between the two loops" if dlc else "the platform's flow per rack without converting for the plant's delta-T"
    if abs(liquid_dT - 10.0) > 1.0:
        versus = ("the platform figure and the 10 K / 1.45 l/min/kW screening reference in the thermal library differ, and the "
                  "screening reference is not used by any constraint")
    else:
        versus = ("the platform figure agrees with the 10 K / 1.45 l/min/kW screening reference in the thermal library to within "
                  "1 K, which is not itself used by any constraint")
    if plant_dT < liquid_dT:
        direction = (f"; the plant delta-T is smaller than the {liquid_dT:.1f} K implied by the platform flow, so if the pumped flow is "
                     f"the plant's this can overstate the racks it supports")
    elif plant_dT > liquid_dT:
        direction = (f"; the plant delta-T is larger than the {liquid_dT:.1f} K implied by the platform flow, so if the pumped flow is "
                     f"the plant's this can understate the racks it supports")
    else:
        direction = ""
    return (f". Flow basis: {flow:g} l/min per rack is {flow / plat.rack_kW.value:.3f} l/min/kW of rack power "
            f"({flow / plat.liquid_kW().value:.2f} l/min/kW of the liquid-captured heat), which implies a {loop} of "
            f"{liquid_dT:.1f} K on the liquid-captured load ({rack_dT:.1f} K if the whole rack power were carried by the liquid); "
            f"{versus}. The plant's own design delta-T is {plant_dT:g} K and the plant flow is compared with {compared}{direction}")


@constraint
def hydraulic_flow(ctx: EnvelopeContext) -> ConstraintResult:
    t = ctx.thermal
    if ctx.architecture in (Architecture.RETAINED_AIR,):
        return ConstraintResult("hydraulic_flow", "thermal", "Hydraulic flow capacity",
                                V(float("inf"), "racks", "flow: not limiting", ESTIMATED),
                                basis="no liquid circuit in this architecture")
    pump = t.plant.pump_flow_capacity_l_per_min
    existing = t.plant.existing_flow_l_per_min

    def _available(plant_flow: Quantity) -> Quantity:
        """Flow left for the new load: the plant's pumped flow less what the existing hall already draws, never below zero.
        With no existing-flow figure the pumped flow is returned untouched (the long-standing reading)."""
        if existing is None:
            return plant_flow
        net = plant_flow - existing
        lo, hi = net.band
        return Quantity(max(net.value, 0.0), net.unit, net.prov, max(lo, 0.0), max(hi, 0.0))

    racks = (_available(pump) / ctx.cluster.platform.flow_l_per_min_per_rack).relabel(
        "racks permitted by available pumped flow", "thermal.flow_limit", step_evidence=SIMULATED)

    def _apply(c: EnvelopeContext) -> EnvelopeContext:
        # The uprate scales the PUMP capacity. What the existing hall draws does not change, so it is subtracted after the uprate.
        c = c.copy()
        c.thermal.plant.pump_flow_capacity_l_per_min = (
            c.thermal.plant.pump_flow_capacity_l_per_min * V(PUMP_UPRATE, "1", "pump uprate factor", ASSUMED))
        return c

    added_lpm = pump.value * (PUMP_UPRATE - 1.0)
    price = scaled_cost(
        "pump.uprate", 420_000 / 7200.0, "EUR/lpm", added_lpm, "lpm",
        "pump and secondary pipework uprate",
        note="Placeholder re-expressed per litre/min of flow added from the earlier 420 kEUR lump at the "
             "reference hall's 7,200 l/min (+80% of 9,000). Not a market price. lpm = litres per minute.")

    if existing is None:
        basis = (f"{pump.render()} available against "
                 f"{ctx.cluster.platform.flow_l_per_min_per_rack.render()} per rack "
                 f"(the platform library's secondary-loop flow){_flow_disclosure(ctx)}. Modelling limit: the intake figure is read as flow "
                 f"available to the new load; existing hall flow, plant delta-T and pump head are not modelled, so this overstates if the "
                 f"figure is the plant's total")
    else:
        basis = (f"{pump.render()} pumped flow less {existing.render()} already drawn by the existing hall = "
                 f"{_available(pump).render()} available to the new load (never below zero), against "
                 f"{ctx.cluster.platform.flow_l_per_min_per_rack.render()} per rack "
                 f"(the platform library's secondary-loop flow){_flow_disclosure(ctx)}. Modelling limit: plant delta-T and pump head are not "
                 f"modelled; a pump uprate scales the pumped flow, not the existing hall's draw")

    return ConstraintResult(
        "hydraulic_flow", "thermal", "Hydraulic flow capacity",
        floor_racks(racks),
        basis=basis,
        relief=ReliefOption(
            description="Uprate pumps and secondary pipework",
            capex_eur=price.capex, cost_kind=price.kind, scope=price.scope,
            quantity=price.quantity, quantity_unit=price.quantity_unit, limited=price.limited,
            basis_note=price.note,
            cost_key="pump.uprate",
            lead_time_weeks=V(30, "weeks", "pump / pipework lead time", ASSUMED, band=(18, 48)),
            apply=_apply,
            risk="Flow, not delta-T, governs a retrofit. Check pipe DN and available head before "
                 "assuming pumps alone solve it.",
        ),
        notes=("Pressure drop budget and pipe DN are not modelled at screening level; "
               "a hydraulic model is required before design.",),
    )


@constraint
def residual_air_removal(ctx: EnvelopeContext) -> ConstraintResult:
    """The constraint most often missed. 10-15% of 135 kW is still 13-20 kW per rack."""
    plat = ctx.cluster.platform
    need = plat.residual_air_kW() if ctx.architecture in (
        Architecture.HYBRID_DLC, Architecture.FULL_DLC) else plat.rack_kW
    have = ctx.thermal.residual_air_capacity_kW_per_rack
    # leq, not <=: 100 x (1 - 0.85) is 15.000000000000002 in binary, so a hall that removes exactly 15 kW per position failed a 15 kW need.
    ok = leq(need.value, have.value)
    racks = gate_racks(ok, "racks permitted by per-position air removal capacity", need, have)

    def _apply(c: EnvelopeContext) -> EnvelopeContext:
        c = c.copy()
        if c.thermal.residual_air_capacity_kW_per_rack.value < 25:          # a relief never lowers a capacity that is already better
            c.thermal.residual_air_capacity_kW_per_rack = V(
                25, "kW", "per-position air capacity after in-row / RDHx augmentation", ASSUMED, band=(20, 30))
        return c

    return ConstraintResult(
        "residual_air_removal", "thermal", "Residual air load removal per rack",
        racks, gate=True,
        basis=(f"{need.render()} of air-side load per rack against {have.render()} the hall can remove "
               f"per position"),
        relief=ReliefOption(
            description="Add in-row cooling or rear-door heat exchangers for the residual air load",
            capex_eur=cost("inrow_rdhx.per_rack", 9_000, "EUR/rack",
                           "in-row cooling or rear-door heat exchanger, installed"),
            cost_key="inrow_rdhx.per_rack",
            lead_time_weeks=V(20, "weeks", "in-row / RDHx lead time", ASSUMED, band=(12, 32)),
            apply=_apply, per_rack=True,
        ),
        notes=("A rack whose residual air load cannot be removed cannot be placed at all, "
               "however much liquid cooling is installed.",),
    )


@constraint
def tcs_supply_achievable(ctx: EnvelopeContext) -> ConstraintResult:
    """Can the facility side actually deliver water cold enough to hit the TCS target?"""
    t = ctx.thermal
    required_fws = _required_fws(t)
    fws = facility_water_supply(ctx)              # the SAME temperature cdu_capacity derates against
    mech = fws.mechanism
    if fws.source == "trim_chiller":
        achievable = fws.temperature.relabel(
            "facility water temperature assumed achievable with a proposed trim chiller on the high-temperature loop",
            "thermal.trim_chiller_fws", step_evidence=ASSUMED)
        # A trim chiller exists in this context only because the relief proposed it. Its capacity, power draw and cost scaling are not
        # modelled, so the temperature is an ASSUMPTION about an asset that is not installed, never a delivered figure.
    elif fws.source == "dry_coolers":
        achievable = fws.temperature
    else:
        achievable = fws.temperature.relabel(
            "facility water temperature achievable by existing plant", "thermal.plant_fws",
            step_evidence=ESTIMATED)
    # leq, not <=: a plant at exactly the required temperature passes (27.9 - 5.1 is 22.799999999999997 in binary, not 22.8).
    ok = leq(achievable.value, required_fws.value)
    racks = gate_racks(ok, "racks permitted by achievable water temperature", achievable, required_fws)

    def _apply(c: EnvelopeContext) -> EnvelopeContext:
        c = c.copy()
        have = c.thermal.plant.dry_cooler_approach_K
        if have is None or have.value > 6:                                   # a lower approach is better: never replace one with a worse
            c.thermal.plant.dry_cooler_approach_K = V(
                6, "K", "dry cooler approach with adiabatic assist", ASSUMED, band=(4, 8))
        c.thermal.trim_chiller_installed = True
        return c

    return ConstraintResult(
        "tcs_supply_achievable", "thermal", "Achievable facility water temperature",
        racks, gate=True,
        basis=(f"TCS target {t.tcs_target_supply_C.render()} needs facility water at or below "
               f"{required_fws.render()}; {mech} {'is assumed to hold' if t.trim_chiller_installed else 'is estimated to supply'} {achievable.render()}"
),
        relief=ReliefOption(
            description="Adiabatic assist plus trim chiller on the high-temperature loop",
            capex_eur=cost("trim_chiller.adiabatic", 350_000, "EUR",
                           "adiabatic assist and trim chiller"),
            cost_key="trim_chiller.adiabatic",
            cost_kind="fixed_site",
            basis_note="One lump placeholder per hall. The trim chiller is sized to the liquid loop, but no "
                       "loop capacity is modelled, so the lump is not scaled with hall size. " + TRIM_CHILLER_LIMIT_NOTE,
            lead_time_weeks=V(32, "weeks", "lead time", ASSUMED, band=(20, 48)),
            apply=_apply,
            risk="Adiabatic assist reintroduces water consumption; check permits and WUE targets.",
        ),
        notes=("The ASHRAE W45 rating on the platform is an equipment survival rating, not an "
               "operating point; operators specify 27-30 degC for 500-700 W parts.",
               TRIM_CHILLER_PUE_NOTE),
    )
