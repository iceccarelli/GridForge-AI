"""Deriving a specification from the constraint that actually binds.

One generator per constraint. Each returns requirements whose numbers come out of
the solved model — the tap-off rating a rack genuinely needs, the transformer
capacity the target load genuinely implies, the CDU duty at THIS site's water
temperature rather than at the manufacturer's 5 K approach.

What is deliberately absent: any equipment selection, any make, any model, any
supplier. We specify the duty and the interfaces; the supplier proposes the
equipment and we do not take a margin on it. That is the same line the engagement
scope draws, and it is the reason a client can hand this document to their own
procurement without a conflict to declare.
"""
from __future__ import annotations

import math
import re
from dataclasses import replace
from typing import Iterable

from ..common import ASSUMED, ESTIMATED, V
from ..constraints import EnvelopeContext
from ..envelope.solver import LadderStep, rack_evidence
from ..scenario.run import ScenarioResult
from ..thermal.constraints import facility_water_supply
from ..thermal.library import PUE_BY_ARCHITECTURE
from ..thermal.schema import Architecture
from ..validation import EvidenceClass, Provenance, Quantity
from .schema import (INFORMATIVE, MANDATORY, PREFERRED, SC_ASSUMED, SC_LIBRARY, SC_NOT_MODELLED,
                     SC_SUPPLIED, AssumedInput, EvaluationCriterion, ProcurementError,
                     Requirement, ResponseField, ScopeItem, SiteCondition, SpecPackage)


def default_step(steps: list[LadderStep]) -> LadderStep:
    """Which relief to tender when nobody said.

    The one that unlocks the most racks across the whole ladder, which is the same
    ordering `gridforge spec --list` prints. A client who reads the list and then
    runs the command without arguments must get the thing at the top of it —
    anything else is the tool disagreeing with itself.

    Not the first rung: the ladder starts with whatever bound first, which is often
    a small item, and tendering it first buys three racks and no date movement.
    """
    totals: dict[str, int] = {}
    for st in steps:
        totals[st.binding_id] = totals.get(st.binding_id, 0) + st.racks_unlocked
    best_id = max(totals, key=lambda k: (totals[k], k))
    return next(st for st in steps if st.binding_id == best_id)


def relief_steps(result: ScenarioResult) -> list[LadderStep]:
    """Rungs that are actually a purchase. A commercial relief has nothing to tender."""
    return [s for s in result.ladder.steps
            if s.taken and s.cost_key not in (None, "", "not-capital")]


#: The strongest class any figure this module computes may claim: an engineering estimate.
SPEC_CEILING = ESTIMATED


def _q(value: float, unit: str, label: str, model: str, inputs: Iterable[Quantity],
       ceiling: EvidenceClass = SPEC_CEILING) -> Quantity:
    """A requirement value, carrying the provenance of the quantities it was computed from.

    Its evidence class is the MINIMUM of ``ceiling`` and the class of every input (arithmetic carries the weakest input,
    docs/01 section 6): racks x a platform figure that is a library assumption (E0) is E0, whatever class the specification
    would like to claim. The class is never raised above an input's, and a figure with no input at all is refused: it would
    be a class asserted from nothing, which is what this function used to build for every requirement. A value that is
    itself an input (the client's facility-water temperature, say) is passed through as the Quantity it is, not wrapped here.
    The result is a point value: a "not less than" figure is one number, and its inputs' bands stay in the basis."""
    ins = [q.prov for q in inputs]
    if not ins:
        raise ProcurementError(f"{label}: a requirement value must name the quantities it was computed from")
    return Quantity(float(value), unit, Provenance.derive(label, model, ins, step_evidence=ceiling), float(value), float(value))


def _ceil_sig(x: float, n: int) -> float:
    """`x` rounded UP to `n` significant figures (the precision `Quantity.render` prints it at)."""
    if not math.isfinite(x) or x <= 0:
        return x
    unit = 10.0 ** (math.floor(math.log10(x)) - n + 1)
    return round(math.ceil(x / unit - 1e-9) * unit, 12)


def _floor(q: Quantity | None) -> Quantity | None:
    """A "not less than" requirement value, rounded UP to the precision it is printed at, and stored as that figure so the printed number and the
    value agree. `Quantity.render` rounds to NEAREST, so a minimum could print up to 0.5% under what the engine sized it for (T-20 = 531 kW for an exact
    531.4: the plant it asked for then reached 68 racks, not the 69 it was sized for). Applied per requirement, to the clauses that say "not less
    than" only: a stated CONDITION (a water temperature, an approach, a head) or a count is not a floor, and rounding an approach up would overstate it."""
    if q is None:
        return None
    v = _ceil_sig(q.value, q.sigfigs())
    if v == q.value:
        return q
    lo, hi = q.band
    return replace(q, value=v, lo=min(lo, v), hi=max(hi, v))


def _count(n: int, ev: EvidenceClass = SPEC_CEILING) -> Quantity:
    """The rack count the duties are sized for, as an input. Its class is that of the rack count the capacity model reached
    (the weakest constraint behind it), capped at the engineering-estimate ceiling."""
    return Quantity.given(float(n), "racks", "rack positions the duties are sized for", min(ev, SPEC_CEILING))


def scenario_context(intake, result: ScenarioResult) -> EnvelopeContext:
    """The hall AS FOUND in the scenario being tendered: its cooling architecture, PUE and any equipment the scenario assumed,
    before a single relief on the ladder was applied. That is what "installed" means in a requirement's basis.

    Not ``intake.context`` (the intake's DEFAULT architecture, with no scenario overrides applied) and not ``result.context``
    (the hall AFTER the ladder: its plant is already uprated). The ladder keeps the first for exactly this purpose."""
    ctx = result.ladder.initial_context
    if ctx is not None:
        return ctx
    # A result assembled without a ladder context: rebuild the scenario the way scenario.run.run() does.
    c = intake.context.copy()
    c.architecture = result.spec.architecture
    c.pue = PUE_BY_ARCHITECTURE[result.spec.architecture]
    return result.spec.overrides(c) if result.spec.overrides is not None else c


def context_at_step(intake, result: ScenarioResult, step) -> EnvelopeContext:
    """The hall at the moment ``step`` is bought: the scenario as found with every EARLIER relief on the ladder applied, in order (the ladder
    applies them one after another and keeps only the first and last context).

    A CDU is bought AFTER the trim chiller that fixes the facility water, so its duty has to be specified against that water, not against the
    dry-cooler water of the hall as found (which under full DLC can be above the TCS target and leave no approach at all). Only reliefs that
    were actually taken change the context, exactly as the ladder itself treats them."""
    from ..constraints import all_constraints
    ctx = scenario_context(intake, result)
    for st in result.ladder.steps:
        if st.step == step.step:
            break
        if not st.taken:
            continue
        evaluated = [fn(ctx) for fn in all_constraints()]
        c = next((x for x in evaluated if x.id == st.binding_id), None)
        if c is None or c.relief is None or c.relief.apply is None:
            continue
        ctx = c.relief.apply(ctx)
    return ctx


# --- per-constraint requirement generators ----------------------------------

def _tapoff(ctx: EnvelopeContext, racks: int, count_ev: EvidenceClass = SPEC_CEILING) -> list[Requirement]:
    plat = ctx.cluster.platform
    lv = ctx.power.lv
    need_A = plat.rack_feed_current_A
    if need_A is not None:
        # the rating a supplier must meet is the current at THIS hall's busway voltage, the same figure the capacity model tested
        from ..power.constraints import rack_feed_current_at
        need_A, _ = rack_feed_current_at(need_A, lv)
    reqs = [
        Requirement(
            id="E-01", clause="Tap-off continuous rating",
            statement=(f"Each rack tap-off unit shall be rated for continuous operation at "
                       f"not less than the rack feed current stated in the response "
                       f"schedule, at the busway voltage and the hall's design ambient."),
            value=_floor(need_A), unit="A", derived_from="rack_feed_tapoff",
            basis=(f"{plat.name} draws {need_A.render() if need_A else 'the stated current'} "
                   f"per rack; the installed tap-offs are rated "
                   f"{lv.tapoff_max_A.render()}."),
            verification="Type test certificate and manufacturer's rating curve at design ambient."),
        Requirement(
            id="E-02", clause="Quantity",
            statement=f"The supply shall cover {racks} rack positions.",
            value=_q(float(racks), "racks", "tap-off units required", "spec.quantity", [_count(racks, count_ev)]),
            unit="racks", derived_from="rack_feed_tapoff",
            basis="Racks unlocked by this relief in the capacity model.",
            verification="Bill of quantities in the response."),
        Requirement(
            id="E-03", clause="Busway compatibility",
            statement=("Tap-off units shall be mechanically and electrically compatible with "
                       "the installed busway system, or the response shall state the busway "
                       "replacement it requires as a separate priced item."),
            obligation=MANDATORY, derived_from="rack_feed_tapoff",
            basis=(f"Installed busway ampacity {lv.busway_ampacity_A.render()} at "
                   f"{lv.voltage_V.render()}, {lv.busway_runs} runs."),
            verification="Compatibility statement naming the installed system."),
        Requirement(
            id="E-04", clause="Live working",
            statement=("Tap-off units should be capable of installation onto an energised "
                       "busway, or the response shall state the outage duration required "
                       "per run."),
            obligation=PREFERRED, derived_from="rack_feed_tapoff",
            basis=("An occupied hall cannot take an unplanned outage; outage duration is a "
                   "commercial cost to the client, not only a programme item."),
            verification="Method statement."),
    ]
    return reqs


def _busway(ctx: EnvelopeContext, racks: int, count_ev: EvidenceClass = SPEC_CEILING) -> list[Requirement]:
    lv = ctx.power.lv
    plat = ctx.cluster.platform
    # Required ampacity per run for the target rack count, at the site's own
    # utilisation limit. This is the number a supplier can actually quote against.
    per_run = max(1, lv.busway_runs)
    load_kW = plat.rack_kW.value * racks
    amps = (load_kW * 1000.0) / (lv.voltage_V.value * math.sqrt(3) * 0.95)
    required = amps / per_run / max(0.1, lv.busway_utilisation_limit.value)
    return [
        Requirement(
            id="E-10", clause="Busway continuous ampacity",
            statement=("Each busway run shall have a continuous ampacity not less than the "
                       "figure stated, at the hall's design ambient and installed "
                       "configuration."),
            value=_floor(_q(required, "A", "required busway ampacity per run", "spec.busway_ampacity",
                            [plat.rack_kW, lv.voltage_V, lv.busway_utilisation_limit, _count(racks, count_ev)])),
            unit="A", derived_from="busway_ampacity",
            basis=(f"{racks} racks at {plat.rack_kW.render()} over {per_run} run(s) at "
                   f"{lv.voltage_V.render()}, three phase, power factor 0.95, derated to "
                   f"the site's {lv.busway_utilisation_limit.render()} continuous limit. "
                   f"Installed: {lv.busway_ampacity_A.render()}."),
            verification="Type test certificate to the applicable standard, with derating basis stated."),
        Requirement(
            id="E-11", clause="Phasing and outage",
            statement=("The programme shall allow replacement run by run with the hall in "
                       "service. The response shall state the outage window per run."),
            derived_from="busway_ampacity",
            basis="Live tenancy in the hall during the works.",
            verification="Method statement and programme."),
        Requirement(
            id="E-12", clause="Tap-off provision",
            statement=("Busway shall accept tap-off units at the density required by the "
                       "rack pitch stated in the response schedule."),
            obligation=MANDATORY, derived_from="busway_ampacity",
            basis=f"Hall aisle configuration; {racks} positions to be fed.",
            verification="Layout drawing."),
    ]


def _transformer(ctx: EnvelopeContext, racks: int, count_ev: EvidenceClass = SPEC_CEILING) -> list[Requirement]:
    plat = ctx.cluster.platform
    pue = ctx.pue
    facility_kW = plat.rack_kW.value * racks * pue.value
    mva = facility_kW / 1000.0 / 0.95
    banks = ctx.power.transformers
    derate = banks[0].derating_factor.render() if banks else "the site's derating policy"
    return [
        Requirement(
            id="E-20", clause="Transformer rating",
            statement=("Transformer capacity shall be not less than the figure stated, after "
                       "the site's derating policy and at the specified redundancy."),
            value=_floor(_q(mva, "MVA", "required transformer capacity", "spec.transformer_rating",
                            [plat.rack_kW, pue, _count(racks, count_ev)])),
            unit="MVA", derived_from="transformer_capacity",
            basis=(f"{racks} racks at {plat.rack_kW.render()}, PUE {pue.render()}, power "
                   f"factor 0.95. Site derating {derate}."),
            verification="Rating plate and factory test certificate."),
        Requirement(
            id="E-21", clause="Redundancy",
            statement=(f"The configuration shall maintain "
                       f"{banks[0].redundancy if banks else 'N+1'} with any one unit out of "
                       f"service."),
            derived_from="transformer_capacity",
            basis="Existing site redundancy policy; a retrofit may not reduce it.",
            verification="Single line diagram."),
        Requirement(
            id="E-22", clause="Harmonic performance",
            statement=("The response shall state the K-factor or harmonic derating basis for "
                       "an IT load of this class, and the resulting continuous rating."),
            derived_from="transformer_capacity",
            basis=("GPU rectifier loads are harmonic-rich; a nameplate rating without a "
                   "stated harmonic basis is not a usable number."),
            verification="Calculation and, where available, measured data from a comparable installation."),
        Requirement(
            id="E-23", clause="Delivery programme",
            statement=("The response shall state ex-works and delivered-to-site dates, and "
                       "identify which long-lead component governs them."),
            obligation=MANDATORY, derived_from="transformer_capacity",
            basis=("Transformer lead time frequently sets the energisation date for the "
                   "whole retrofit; which component governs is the thing worth managing."),
            verification="Programme with named long-lead items."),
    ]


def _ups(ctx: EnvelopeContext, racks: int, count_ev: EvidenceClass = SPEC_CEILING) -> list[Requirement]:
    plat = ctx.cluster.platform
    kW = plat.rack_kW.value * racks
    blocks = ctx.power.ups
    step = blocks[0].step_load_capability.render() if blocks else "the stated fraction"
    return [
        Requirement(
            id="E-30", clause="Protected capacity",
            statement="Additional protected capacity shall be not less than the figure stated.",
            value=_floor(_q(kW, "kW", "additional protected load", "spec.ups_capacity",
                            [plat.rack_kW, _count(racks, count_ev)])),
            unit="kW", derived_from="ups_capacity",
            basis=f"{racks} racks at {plat.rack_kW.render()}.",
            verification="Rating and factory test certificate."),
        Requirement(
            id="E-31", clause="Step load",
            statement=("The system shall accept the step load stated in the response schedule "
                       "without transfer to bypass."),
            derived_from="ups_capacity",
            basis=(f"AI training loads step far harder than general IT. Installed blocks are "
                   f"rated for {step} of nameplate as a step."),
            verification="Witnessed step-load test at the stated fraction."),
        Requirement(
            id="E-32", clause="Compatibility",
            statement=("New modules shall parallel with the installed system, or the response "
                       "shall price a standalone block and its switchgear separately."),
            obligation=MANDATORY, derived_from="ups_capacity",
            basis="Mixed-vintage parallel operation is a common and expensive surprise.",
            verification="Manufacturer's compatibility statement."),
    ]


def _cdu(ctx: EnvelopeContext, racks: int, count_ev: EvidenceClass = SPEC_CEILING) -> list[Requirement]:
    plat = ctx.cluster.platform
    plant = ctx.thermal.plant
    count = _count(racks, count_ev)
    duty = plat.liquid_kW() * count
    flow = plat.flow_l_per_min_per_rack * count
    # The approach the capacity model derates the CDU on: the technology loop's OPERATING target less the facility-water
    # supply (thermal/constraints.py cdu_capacity, `t.tcs_target_supply_C - fws_supply`). Not the platform's maximum liquid
    # inlet: that is an equipment survival rating, not an operating point (docs/02 section 4). No floor is applied: a
    # facility water that is not colder than the target leaves no approach, and the specification says so.
    tcs = ctx.thermal.tcs_target_supply_C
    # The facility water is read from the SAME helper the engine's cdu_capacity and water-temperature gate read
    # (thermal/constraints.py facility_water_supply), never from the legacy plant setpoint directly: under full DLC the water the
    # dedicated loop receives is the dry coolers' (design dry bulb plus their approach), not the existing chiller's.
    fws = facility_water_supply(ctx)
    fws_t = fws.temperature
    if fws.source == "trim_chiller":
        # The setpoint of a chiller the relief PROPOSES: an assumption about an asset that is not installed, whatever class the plant's own
        # setpoint carries (thermal/constraints.py tcs_supply_achievable labels it the same way).
        fws_t = fws_t.relabel("facility water temperature assumed achievable with a proposed trim chiller on the high-temperature loop",
                              "spec.trim_chiller_fws", step_evidence=ASSUMED)
    approach = tcs - fws_t
    if approach.value > 0:
        approach_note = (f"Available approach = TCS supply target {tcs.render()} less facility-water supply "
                         f"{fws_t.render()} ({fws.mechanism}) = {approach.value:g} K. This is the figure the capacity model "
                         f"derates a CDU on: its rated duty is scaled linearly by the available approach over the approach "
                         f"it is rated at, capped at the rating. Approach at site conditions is what determines usable duty.")
    else:
        approach_note = (f"TCS supply target {tcs.render()} less facility-water supply {fws_t.render()} ({fws.mechanism}) = "
                         f"{approach.value:g} K: the facility water is not colder than the technology-loop target, so the "
                         f"capacity model derates a CDU to no usable duty at this site. The supply temperature or the target "
                         f"must change before a CDU duty can be specified.")
    water_return = (f", return {plant.design_return_C.render()}" if fws.source == "existing_plant" else "")
    return [
        Requirement(
            id="T-01", clause="Rated duty at site conditions",
            statement=("CDU duty shall be not less than the figure stated WHEN RATED AT THE "
                       "SITE FACILITY WATER TEMPERATURE below, not at the manufacturer's "
                       "reference approach."),
            value=_floor(_q(duty.value, "kW", "required CDU duty at site conditions", "spec.cdu_duty", [duty])),
            unit="kW", derived_from="cdu_capacity",
            basis=(f"{racks} racks at {plat.liquid_kW().render()} liquid load per rack. Rated with facility water supplied "
                   f"at {fws_t.render()} ({fws.mechanism}); the design operating point of the technology loop is the TCS "
                   f"supply target {tcs.render()}. The platform accepts liquid inlet up to "
                   f"{plat.max_inlet_liquid_C.render()}, but that is the equipment's survival rating, not an operating "
                   f"point: the duty is not rated there."),
            verification="Performance curve or selection output at the stated facility water temperature."),
        Requirement(
            id="T-02", clause="Facility water conditions",
            statement=(f"Equipment shall achieve the rated duty with facility water supplied "
                       f"at {fws_t.render()}{water_return}."),
            value=fws_t, unit="degC", derived_from="cdu_capacity",
            basis=("A CDU is rated at a stated approach (a 5 K approach is usual). Where the approach this site's facility "
                   "water leaves the technology loop (T-04) is NARROWER than the rated one, usable duty falls in proportion "
                   "(available approach over rated approach), so a rating quoted at the reference approach and installed "
                   "here under-delivers."),
            verification="Selection output at these exact conditions."),
        Requirement(
            id="T-03", clause="Technology loop flow",
            statement="Technology-side flow shall be not less than the figure stated.",
            value=_floor(_q(flow.value, "l/min", "required technology loop flow", "spec.tcs_flow", [flow])),
            unit="l/min", derived_from="cdu_capacity",
            basis=f"{racks} racks at {plat.flow_l_per_min_per_rack.render()}.",
            verification="Pump curve and duty point."),
        Requirement(
            id="T-04", clause="Approach temperature",
            statement=("The response shall state the approach temperature achieved at the "
                       "duty point above."),
            value=_q(approach.value, "K", "available approach at site conditions", "spec.cdu_approach", [approach]),
            unit="K", derived_from="cdu_capacity",
            basis=approach_note,
            verification="Selection output."),
        Requirement(
            id="T-05", clause="Redundancy and water quality",
            statement=("Configuration shall be N+1 at the stated duty. The response shall "
                       "state technology-loop water chemistry and filtration requirements."),
            derived_from="cdu_capacity",
            basis="Cold-plate fouling is a warranty question before it is a capacity question.",
            verification="Manufacturer's water quality specification."),
    ]


#: How the capacity model's plant constraint describes the route the heat takes (thermal/constraints.py `plant_capacity`, `route`).
_ROUTE_FULL = "full rack load (rack heat rejected into the existing plant)"
_ROUTE_RESIDUAL = "residual air load only (liquid rejected to a dedicated high-temperature loop)"


def plant_load_per_rack(ctx: EnvelopeContext) -> tuple[Quantity, bool]:
    """The load the capacity model charges the EXISTING chilled-water plant per rack, and whether that is the whole rack.

    Replicates thermal/constraints.py: `_liquid_load_to_plant` (~line 47: hybrid DLC, rear-door and retained air put the whole
    rack on the plant; full DLC sends the liquid to a dedicated loop) and the `per_rack = plat.rack_kW if ... else
    plat.residual_air_kW()` choice in `plant_capacity` (~line 154). It is copied, not imported, so this module does not depend on
    a private helper of the thermal domain; tests/test_spec_engine_consistency.py fails if the two ever disagree for any
    architecture."""
    plat = ctx.cluster.platform
    whole = ctx.architecture in (Architecture.HYBRID_DLC, Architecture.RDHX, Architecture.RETAINED_AIR)
    return (plat.rack_kW if whole else plat.residual_air_kW()), whole


def _existing_it_kW(ctx: EnvelopeContext) -> Quantity:
    """The IT load the existing hall already puts on the plant, in kW (the engine's `existing`, ~line 155)."""
    return ctx.power.current_it_load_MW.convert(1000.0, "kW", "existing hall heat load on plant")


def plant_headroom(ctx: EnvelopeContext) -> Quantity:
    """Chilled-water plant capacity less the IT load already on it, and less any other heat the client declared the existing hall
    puts on the plant: the headroom thermal/constraints.py `plant_capacity` divides by the per-rack load (~lines 155-165).

    SIGNED, where the engine floors the headroom it DISPLAYS at zero when other heat is declared. Hosting N racks needs the plant
    to cover the load AND make good any shortfall (an uprate scales the capacity, not the existing hall's heat), so the
    requirement is built on the unfloored figure and is never lower than the engine's own."""
    t = ctx.thermal
    net = t.plant.chilled_water_capacity_kW - _existing_it_kW(ctx)
    if t.plant.existing_non_it_heat_kW is not None:
        net = net - t.plant.existing_non_it_heat_kW
    return net.relabel("chilled-water plant headroom", "thermal.plant_headroom", step_evidence=ESTIMATED)


def _plant(ctx: EnvelopeContext, racks: int, count_ev: EvidenceClass = SPEC_CEILING) -> list[Requirement]:
    plat = ctx.cluster.platform
    plant = ctx.thermal.plant
    per_rack, whole = plant_load_per_rack(ctx)
    headroom = plant_headroom(ctx)
    load = replace(per_rack * _count(racks, count_ev), unit="kW")        # kW x racks; the racks are a count, not a unit of power
    additional = max(0.0, load.value - headroom.value)
    existing = _existing_it_kW(ctx)
    other = plant.existing_non_it_heat_kW
    value = _q(additional, "kW", "required additional plant capacity", "spec.plant_duty", [load, headroom])
    # The three numbers a supplier can check: the load for N racks, the headroom already there, and what is left to add.
    load_text = load.render(with_band=False)
    headroom_text = (f"{headroom.render()} = {plant.chilled_water_capacity_kW.render()} installed plant capacity less "
                     f"{existing.render()} of IT load already on it"
                     + (f" less {other.render()} of other heat the existing hall puts on the plant" if other is not None else ""))
    if headroom.value < 0:
        headroom_text += (" (negative: the existing hall already exceeds the plant, and that shortfall is part of the "
                          "additional capacity)")
    if additional > 0:
        result_text = (f"Additional capacity required = {load_text} less {headroom.render(with_band=False)} = "
                       f"{value.render(with_band=False)}.")
    else:
        result_text = (f"The existing headroom already covers this load ({load_text} against "
                       f"{headroom.render(with_band=False)}), so no additional plant capacity is required for these racks.")
    if other is None:
        limit_text = ("Modelling limit: UPS, fan and pump heat, plant redundancy and condenser derating at the design ambient "
                      "are not modelled, so the headroom is overstated by their share and the additional capacity is a minimum.")
    else:
        limit_text = ("Modelling limit: plant redundancy and condenser derating at the design ambient are not modelled, and "
                      "only the other heat the client gave is subtracted, so the additional capacity is a minimum.")
    if whole:
        route, scope_note = _ROUTE_FULL, ""
    else:
        route = _ROUTE_RESIDUAL
        scope_note = (f" The liquid share ({plat.liquid_kW().render()} per rack) is not charged to this plant: its heat "
                      f"rejection is a dedicated high-temperature loop that this requirement does not size.")
    return [
        Requirement(
            id="T-20", clause="Additional cooling capacity",
            statement=("Additional chilled-water plant capacity, over and above the installed plant, shall be not less than "
                       f"the figure stated, which is the plant load of {racks} racks ({load_text}) less the existing plant "
                       f"headroom ({headroom.render(with_band=False)})."),
            value=_floor(value), unit="kW", derived_from="plant_capacity",
            basis=(f"Load for {racks} racks: {racks} x {per_rack.render()} per rack = {load_text} on the existing plant, "
                   f"{route}.{scope_note} Existing plant headroom: {headroom_text}. {result_text} {limit_text}"),
            verification="Selection output at site design ambient."),
        Requirement(
            id="T-21", clause="Design ambient",
            statement=("Capacity shall be achieved at the site summer design dry bulb stated "
                       "in the response schedule, not at a standard rating condition."),
            derived_from="plant_capacity",
            basis="A rating at 35 degC on a site that sees 38 degC is a shortfall by design.",
            verification="Performance data at the stated ambient."),
        Requirement(
            id="T-22", clause="Free cooling",
            statement=("The response should state annual free-cooling hours at the site's "
                       "weather file and the resulting annual energy."),
            obligation=PREFERRED, derived_from="plant_capacity",
            basis=(f"Existing plant achieves {plant.free_cooling_hours_per_year.render()}; "
                   f"raising the loop temperature is usually worth more than raising duty."),
            verification="Annual simulation against the site weather file."),
    ]


def _hydraulic(ctx: EnvelopeContext, racks: int, count_ev: EvidenceClass = SPEC_CEILING) -> list[Requirement]:
    plat = ctx.cluster.platform
    plant = ctx.thermal.plant
    flow = plat.flow_l_per_min_per_rack * _count(racks, count_ev)
    return [
        Requirement(
            id="T-40", clause="Pumped flow",
            statement="Available pumped flow shall be not less than the figure stated.",
            value=_floor(_q(flow.value, "l/min", "required pumped flow", "spec.pumped_flow", [flow])),
            unit="l/min", derived_from="hydraulic_flow",
            basis=(f"{racks} racks at {plat.flow_l_per_min_per_rack.render()}. Installed "
                   f"capacity {plant.pump_flow_capacity_l_per_min.render()} at "
                   f"{plant.available_head_kPa.render()}."),
            verification="Pump curve at the system duty point."),
        Requirement(
            id="T-41", clause="Head",
            statement=("The response shall state available head at the duty point and the "
                       "assumed system resistance."),
            value=plant.available_head_kPa, unit="kPa", derived_from="hydraulic_flow",
            basis="A flow figure without a head figure is not a duty point.",
            verification="Hydraulic calculation."),
    ]


def _generic(ctx: EnvelopeContext, racks: int, step: LadderStep,
             count_ev: EvidenceClass = SPEC_CEILING) -> list[Requirement]:
    """A constraint with no specialist generator yet.

    Produces an honest skeleton rather than an invented specification: the duty is
    stated in racks and the supplier is asked what they would propose. Inventing
    technical clauses for a constraint nobody has written a generator for is how a
    tender ends up specifying equipment the hall does not need.
    """
    return [
        Requirement(
            id="G-01", clause="Duty",
            statement=(f"The works shall relieve the following constraint: "
                       f"{step.binding_name}. {step.relief_description or ''}".strip()),
            value=_q(float(racks), "racks", "rack positions to be unlocked", "spec.quantity", [_count(racks, count_ev)]),
            unit="racks", derived_from=step.binding_id,
            basis=step.basis,
            verification="Method statement demonstrating how the constraint is relieved."),
        Requirement(
            id="G-02", clause="Technical proposal",
            statement=("The response shall state the equipment proposed, the duty achieved, "
                       "and the site conditions the duty is quoted at."),
            obligation=MANDATORY, derived_from=step.binding_id,
            basis="No specialist clause set exists for this constraint yet; the proposal is "
                  "assessed against the capacity model rather than against a clause list.",
            verification="Technical submittal."),
    ]


GENERATORS = {
    "rack_feed_tapoff": _tapoff,
    "busway_ampacity": _busway,
    "transformer_capacity": _transformer,
    "ups_capacity": _ups,
    "cdu_capacity": _cdu,
    "plant_capacity": _plant,
    "hydraulic_flow": _hydraulic,
}


# --- the package -------------------------------------------------------------

COMMON_SCOPE_OUT = (
    ScopeItem("X-1", "Structural sign-off",
              "Any structural strengthening arising from the works is by others.", False),
    ScopeItem("X-2", "Protection and arc-flash studies",
              "Provided by the client's electrical engineer.", False),
    ScopeItem("X-3", "Migration and tenancy",
              "Moving or decanting existing tenants is outside this package.", False),
)

CRITERIA = (
    EvaluationCriterion("C1", "Compliance with the mandatory duty", 35,
                        "Every 'shall' requirement met, at the site conditions stated. "
                        "A duty quoted at a reference condition rather than at ours scores nothing."),
    EvaluationCriterion("C2", "Delivered programme", 30,
                        "Weeks to site and to energisation, and which long-lead item governs. "
                        "Assessed against what the item does to the energisation date."),
    EvaluationCriterion("C3", "Price", 20,
                        "Delivered capex, and price per kW actually unlocked rather than "
                        "price per unit of equipment."),
    EvaluationCriterion("C4", "Installation in a live hall", 10,
                        "Outage duration per run or per unit, and the method statement."),
    EvaluationCriterion("C5", "Evidence quality", 5,
                        "Test certificates and selection outputs at our conditions, rather "
                        "than datasheets at reference conditions."),
)


def _response_fields(step: LadderStep) -> list[ResponseField]:
    # The library holds this relief on whatever basis the constraint priced it —
    # EUR, EUR/rack or EUR/kW. Ask the library, not the step: a step's capex is the
    # already-multiplied total, so a EUR/kW line arrives here reading "EUR" and a
    # lump-sum bid would enter the library a thousand times too large.
    from ..costs import declared_unit
    fallback = step.capex_eur.unit if step.capex_eur is not None else "EUR"
    cost_unit = declared_unit(step.cost_key or "", fallback)
    return [
        ResponseField("capex_eur", "Delivered price, excluding VAT", "EUR",
                      cost_key=step.cost_key or "", cost_unit=cost_unit,
                      note="Delivered and installed. State exclusions separately."),
        ResponseField("lead_time_weeks", "Weeks from order to delivered on site", "weeks"),
        ResponseField("install_weeks", "Weeks from delivery to energised", "weeks",
                      required=False),
        ResponseField("outage_hours_per_unit", "Outage required per unit or per run", "hours",
                      required=False),
        ResponseField("duty_at_site_conditions", "Duty achieved at the site conditions stated",
                      "kW or A", required=False,
                      note="At OUR conditions. A figure at a reference condition is not a bid."),
        ResponseField("validity_days", "Price validity", "days", required=False),
    ]


def _scope_quantity(result: ScenarioResult, step: LadderStep) -> float | None:
    """What this constraint's package asks suppliers to price: the capacity the ladder adds at it, over EVERY taken
    step for that constraint (you tender for the constraint once, for the end state, not once per rung)."""
    qs = [s.quantity for s in result.ladder.taken_steps
          if s.binding_id == step.binding_id and s.quantity is not None and s.quantity_unit == step.quantity_unit]
    total = float(sum(qs)) if qs else None
    if step.binding_id == "cdu_capacity" and result.unlocked_racks > 0 and result.ladder.initial_context is not None:
        # The CDUs the model assumed (the hall has no CDU schedule on file) are bought too, and priced on the same line.
        kit = sum(c.units for c in result.ladder.initial_context.thermal.cdus if not c.installed)
        if kit:
            total = (total or 0.0) + float(kit)
    return total


def _declared(doc: dict, path: str) -> bool:
    """Did the intake document itself carry this field? (Not the context: a default is in the context too.)"""
    cur = doc
    for part in path.split("."):
        if not isinstance(cur, dict) or part not in cur:
            return False
        cur = cur[part]
    if isinstance(cur, dict) and "value" in cur:
        cur = cur["value"]
    return cur is not None


def _bank_scheme(doc: dict, key: str, ident: str, field_name: str) -> bool:
    for item in doc.get(key) or []:
        if isinstance(item, dict) and str(item.get("id", "")) == ident:
            return item.get(field_name) is not None
    return False


def site_conditions(intake, ctx: EnvelopeContext) -> list[SiteCondition]:
    """The conditions the duties are quoted at, from the model that sized them. A condition the client did not
    supply is printed as "not supplied: assumed X (E0)"; one the engine has no input for says so and says that no
    derating for it has been applied. Nothing is defaulted silently."""
    doc = getattr(intake, "document", None) or {}
    site, plant, power, plat = ctx.site, ctx.thermal.plant, ctx.power, ctx.cluster.platform
    rows: list[SiteCondition] = []

    def q_row(i: int, label: str, path: str, q: Quantity, *, library: bool = False, extra: str = "") -> None:
        if library:
            status, stmt = SC_LIBRARY, "platform library figure, not a client declaration or a measurement"
        elif _declared(doc, path):
            status, stmt = SC_SUPPLIED, "supplied by the client (not measured or surveyed by us)"
        else:
            status = SC_ASSUMED
            stmt = f"not supplied: assumed {q.render(with_band=False)}"
        rows.append(SiteCondition(f"SC-{i:02d}", label, status, (stmt + (" · " + extra if extra else "")),
                                  value=q, path=path))

    q_row(1, "Design ambient dry bulb (summer)", "site.design_drybulb_C", site.design_drybulb_C)
    q_row(2, "Design ambient wet bulb (summer)", "site.design_wetbulb_C", site.design_wetbulb_C)
    q_row(3, "Facility-water supply temperature (existing plant)", "thermal.plant.design_supply_C",
          plant.design_supply_C)
    q_row(4, "Technology-loop (TCS) supply target", "thermal.tcs_target_supply_C", ctx.thermal.tcs_target_supply_C)
    rows.append(SiteCondition(
        "SC-05", "Site altitude", SC_NOT_MODELLED,
        "not supplied: the capacity model has no altitude input, so no altitude derating of air-cooled plant, "
        "motors or electrical equipment has been applied to any duty. Responders shall quote at the site "
        "altitude the client confirms and state it.", text="not modelled"))
    q_row(6, "LV distribution voltage", "lv.voltage_V", power.lv.voltage_V,
          extra=f"{power.lv.phases}-phase")
    rows.append(SiteCondition(
        "SC-07", "Supply frequency", SC_NOT_MODELLED,
        "not supplied: the capacity model has no frequency input. Responders shall state the frequency they "
        "have assumed for the equipment quoted.", text="not modelled"))
    q_row(8, "Site power factor", "grid.power_factor", power.grid.power_factor)
    rows.append(SiteCondition(
        "SC-09", f"Rack power basis: {plat.name}", SC_LIBRARY,
        "per-rack total TDP from the platform library, used for every electrical and thermal duty "
        "(utilisation is not applied to a duty)", value=plat.rack_kW))
    rows.append(SiteCondition(
        "SC-10", f"Liquid heat-capture fraction: {plat.name}", SC_LIBRARY,
        "platform library figure; the remainder is residual air load per rack", value=plat.liquid_fraction))
    n = 10
    for key, kind, banks in (("transformers", "transformer", power.transformers), ("ups", "UPS", power.ups)):
        for b in banks:
            n += 1
            declared = _bank_scheme(doc, key, b.id, "redundancy")
            rows.append(SiteCondition(
                f"SC-{n}", f"Redundancy, {kind} bank {b.id}",
                SC_SUPPLIED if declared else SC_ASSUMED,
                ("supplied by the client" if declared else
                 f"not supplied: assumed {b.redundancy} (E0)"),
                text=f"{b.redundancy} on {b.units} units"))
    for c in ctx.thermal.cdus:
        n += 1
        # An installed CDU is the client's, but only what the client WROTE is supplied: a bank whose units or redundancy were left out is read at the
        # library default (1 unit, N+1) and must say so, as the transformer and UPS rows do.
        assumed = []
        if not c.units_declared:
            assumed.append(f"assumed {c.units} unit(s)")
        if not c.redundancy_declared:
            assumed.append(f"assumed {c.redundancy}")
        if not c.installed:
            status, stmt = SC_ASSUMED, f"not supplied: no CDU schedule; the model assumed {c.units} units at {c.redundancy} (E0)"
        elif assumed:
            status, stmt = SC_ASSUMED, f"not supplied: {' and '.join(assumed)} (E0); the rest as declared in the CDU schedule"
        else:
            status, stmt = SC_SUPPLIED, "as declared in the CDU schedule"
        rows.append(SiteCondition(f"SC-{n}", f"Redundancy, CDU bank {c.id}", status, stmt, text=f"{c.redundancy} on {c.units} units"))
    return rows


def assumed_inputs(intake, conditions: list[SiteCondition] | None = None) -> list[AssumedInput]:
    """Every intake input that was not supplied and was filled from the library, with what was used. The intake
    report lists the fields it tracks; site conditions that were assumed but are not tracked there (the wet bulb)
    are added from the conditions table so the two lists cannot disagree."""
    out = []
    for g in getattr(getattr(intake, "report", None), "gaps", []) or []:
        fb = (g.fallback_description or "—").strip()
        if fb in ("[]", "—"):
            fb = "nothing: no value was assumed in its place and the constraint it feeds is not assessed (E0)"
        elif fb.lower().startswith("none"):
            fb = f"no value ({fb}) (E0)"
        elif not re.search(r"\bE[0-7]\)", fb):          # already carries its class: "(E0)" or "(library, E0)"
            fb = f"{fb} (E0)"
        out.append(AssumedInput(g.path, g.label, "" if g.unit in ("-", "—") else g.unit, fb))
    have = {a.path for a in out}
    for c in conditions or []:
        if c.status == SC_ASSUMED and c.value is not None and c.path and c.path not in have:
            out.append(AssumedInput(c.path, c.label, c.value.unit, c.value.render(with_band=True)))
    return out


def build_spec(intake, result: ScenarioResult, *, step: LadderStep | None = None,
               constraint_id: str = "") -> SpecPackage:
    """One specification, for one relief on one hall.

    Deliberately one at a time. A combined tender for four unrelated reliefs gets
    four suppliers quoting the parts they are comfortable with and nobody owning
    the constraint, which is how the date slips without anyone being late.
    """
    steps = relief_steps(result)
    if not steps:
        raise ProcurementError(
            "this scenario has no relief that is a purchase — nothing to tender")
    if step is None:
        if constraint_id:
            matches = [s for s in steps if s.binding_id == constraint_id]
            if not matches:
                raise ProcurementError(
                    f"no purchasable relief for {constraint_id!r}. Available: "
                    f"{', '.join(sorted({s.binding_id for s in steps}))}")
            step = matches[0]
        else:
            step = default_step(steps)

    # The scenario being tendered, as found (see scenario_context): never the intake's default context.
    ctx = scenario_context(intake, result)

    # Size against the END STATE, not the marginal racks this rung unlocks.
    #
    # A ladder rung often unlocks three racks, or none at all — it moves a
    # constraint that was not the tightest. Nobody buys a transformer for three
    # racks: they buy it for the hall the client intends to end up with. Sizing to
    # the rung's own delta produces a specification that is technically traceable
    # and commercially absurd, which is worse than one that is neither.
    racks = max(result.unlocked_racks, step.racks_after, 1)
    # The rack count is itself a result of the capacity model, so it is no better evidenced than the weakest constraint behind it.
    count_ev = rack_evidence(result.ladder.final or result.envelope)
    gen = GENERATORS.get(step.binding_id)
    # A CDU's duty depends on the facility water it will be fed, and that is fixed by reliefs EARLIER on the ladder (the trim chiller): specify it
    # at its own rung. Every other generator keeps the scenario as found, which is what "installed" means in its basis.
    gen_ctx = context_at_step(intake, result, step) if step.binding_id == "cdu_capacity" else ctx
    reqs = gen(gen_ctx, racks, count_ev) if gen else _generic(ctx, racks, step, count_ev)

    conds = site_conditions(intake, ctx)
    pkg = SpecPackage(
        project=intake.client,
        hall=ctx.hall.id,
        relief_title=step.relief_description or step.binding_name,
        constraint_id=step.binding_id,
        constraint_name=step.binding_name,
        racks_before=step.racks_before,
        racks_after=step.racks_after,
        scope=[
            ScopeItem("S-1", "Supply", "Equipment meeting the duty specified in section 3."),
            ScopeItem("S-2", "Delivery", "Delivered to site, offloaded, positioned."),
            ScopeItem("S-3", "Installation and commissioning",
                      "Installation in a live hall, commissioning and witnessed testing."),
            ScopeItem("S-4", "Documentation",
                      "Test certificates, selection outputs at site conditions, O&M."),
            *COMMON_SCOPE_OUT,
        ],
        requirements=reqs + [
            Requirement(
                id="C-01", clause="Price basis",
                statement=("Prices shall be delivered and installed, excluding VAT, in EUR, "
                           "with exclusions listed separately."),
                basis="Comparability. Four quotations on four bases cannot be evaluated.",
                verification="Completed response schedule."),
            Requirement(
                id="C-02", clause="Validity",
                statement="Prices shall remain valid for not less than 60 days.",
                basis="The evaluation and approval cycle on a capital item of this size.",
                verification="Stated on the quotation."),
            Requirement(
                id="C-03", clause="Response schedule",
                statement=("The response schedule in section 6 shall be returned completed. "
                           "An incomplete schedule will not be evaluated."),
                basis=("Every figure in it feeds a comparison the client can check. A bid "
                       "that answers a different question cannot be compared with one that "
                       "answers this one."),
                verification="Returned document."),
        ],
        criteria=list(CRITERIA),
        response_fields=_response_fields(step),
        lead_time_weeks=step.lead_time_weeks,
        budget_eur=step.capex_eur,
        scope_quantity=_scope_quantity(result, step),
        scope_quantity_unit=step.quantity_unit if step.quantity is not None else "",
        sized_for_racks=racks,
        sized_for_kW=ctx.cluster.platform.rack_kW.value * racks,
        site_conditions=conds,
        assumed_inputs=assumed_inputs(intake, conds),
        notes=[
            (f"Duties in section 3 are sized for the end state of {racks} racks of "
             f"{ctx.cluster.platform.name} — the hall this relief is part of delivering — "
             f"not for the {step.racks_unlocked} rack(s) this single step unlocks on its "
             f"own. Nobody buys plant for a marginal rack."),
            (f"In the capacity model this step moves the hall from {step.racks_before} to "
             f"{step.racks_after} racks; the full ladder reaches "
             f"{result.unlocked_racks}."),
            ("Every numeric requirement is derived from the capacity model and names the "
             "constraint it came from. Nothing here specifies a make or a model: we state "
             "the duty and the interfaces, the supplier proposes the equipment, and we take "
             "no margin on it."),
            ("The budget figure is our modelled estimate, not a price. It is stated so the "
             "client can see whether a response is in the right universe, and it carries its "
             "own evidence class."),
        ],
    )
    pkg.validate()
    return pkg
