"""Thermal constraints.

The two most commonly missed, and therefore the two most commercially valuable:
  * residual air load per rack  (10-15% of a 135 kW rack is still 13-20 kW of air
    cooling per position, which a legacy hall usually cannot deliver);
  * CDU capacity derated to the FACILITY water temperature the site can actually
    supply, rather than the temperature the vendor quoted the rating at.
"""
from __future__ import annotations

from ..common import ASSUMED, ESTIMATED, SIMULATED, V
from ..costs import cost
from ..constraints import ConstraintResult, EnvelopeContext, ReliefOption, constraint, floor_racks
from ..thermal.library import ARCH_RACK_CAPABILITY_kW
from ..thermal.schema import Architecture
from ..validation import Quantity


def _effective_units(units: int, redundancy: str) -> int:
    r = redundancy.upper().replace(" ", "")
    return {"N": units, "N+1": max(units - 1, 0), "N+2": max(units - 2, 0),
            "2N": units // 2, "N+N": units // 2}.get(r, units)


def _liquid_load_to_plant(ctx: EnvelopeContext) -> bool:
    """Does the liquid load land on the existing chilled-water plant?"""
    return ctx.architecture in (Architecture.HYBRID_DLC, Architecture.RDHX)


@constraint
def architecture_capability(ctx: EnvelopeContext) -> ConstraintResult:
    """Can this cooling architecture carry a rack of this platform at all?

    This is a scenario choice, not a capex line. It has no relief: the answer is
    to compare a different architecture, which is what the scenario set is for.
    """
    capability = ARCH_RACK_CAPABILITY_kW[ctx.architecture]
    need = ctx.cluster.platform.rack_kW
    ok = need.value <= capability.value
    racks = V(float("inf") if ok else 0.0, "racks",
              "racks permitted by the chosen cooling architecture", ESTIMATED)
    return ConstraintResult(
        "architecture_capability", "thermal",
        "Cooling architecture per-rack capability",
        racks, gate=True,
        basis=(f"{ctx.architecture.value} is practically capable of {capability.render()} per rack; "
               f"the target platform draws {need.render()}"),
        relief=None,
        notes=("No capex relieves this constraint. If it binds, the architecture is wrong for the "
               "platform and a different scenario must be selected.",),
    )


@constraint
def cdu_capacity(ctx: EnvelopeContext) -> ConstraintResult:
    t = ctx.thermal
    if ctx.architecture in (Architecture.RETAINED_AIR, Architecture.RDHX) or not t.cdus:
        return ConstraintResult("cdu_capacity", "thermal", "CDU capacity",
                                V(float("inf"), "racks", "CDU capacity: not limiting", ESTIMATED),
                                basis="architecture does not use CDUs" if not t.cdus else "no CDUs installed")
    fws_supply = t.plant.design_supply_C
    available_approach = (t.tcs_target_supply_C - fws_supply).relabel(
        "available CDU approach (TCS target minus facility water supply)",
        "thermal.available_approach", step_evidence=ESTIMATED)
    total = None
    for c in t.cdus:
        n = _effective_units(c.units, c.redundancy)
        # Vendor ratings are stated AT a specific approach. Derate linearly, capped at rated.
        ratio = min(1.0, max(0.0, available_approach.value / c.rated_approach_K.value))
        derate = V(ratio, "1", f"{c.id} derate to site facility-water temperature", ESTIMATED,
                   band=(max(ratio * 0.85, 0.0), min(ratio * 1.1, 1.0)),
                   assumptions=[f"Rating quoted at {c.rated_approach_K.value:g} K approach; site offers "
                                f"{available_approach.value:g} K. Linear derate is a screening "
                                f"approximation - confirm against the manufacturer's performance curve."])
        cap = (c.rated_capacity_kW * derate * V(float(n), "1", f"{c.id} usable units ({c.redundancy})", ASSUMED)
               ).relabel(f"{c.id} usable capacity at site conditions", "thermal.cdu_usable")
        total = cap if total is None else total + cap
    racks = total / ctx.cluster.platform.liquid_kW()

    def _apply(c: EnvelopeContext) -> EnvelopeContext:
        c = c.copy()
        for cdu in c.thermal.cdus:
            cdu.units += 1
        return c

    return ConstraintResult(
        "cdu_capacity", "thermal", "CDU capacity (derated to site water temperature)",
        floor_racks(racks),
        basis=(f"{total.render()} usable against {ctx.cluster.platform.liquid_kW().render()} of liquid load "
               f"per rack; {available_approach.render()} approach available"),
        relief=ReliefOption(
            description="Add CDU capacity (one further unit per bank)",
            capex_eur=cost("cdu.addition", 180_000, "EUR", "additional row CDU, installed"),
            cost_key="cdu.addition",
            lead_time_weeks=V(26, "weeks", "CDU lead time", ASSUMED, band=(16, 40)),
            apply=_apply,
        ),
        notes=("TCS water quality per OCP: conductivity <1500 uS/cm, pH 8.0-10.5, 50 um inline "
               "filtration, sidestream <5 um at 10% of flow.",),
    )


@constraint
def plant_capacity(ctx: EnvelopeContext) -> ConstraintResult:
    t = ctx.thermal
    plat = ctx.cluster.platform
    per_rack = plat.rack_kW if _liquid_load_to_plant(ctx) else plat.residual_air_kW()
    existing = ctx.power.current_it_load_MW.convert(1000.0, "kW", "existing hall heat load on plant")
    headroom = (t.plant.chilled_water_capacity_kW - existing).relabel(
        "chilled-water plant headroom", "thermal.plant_headroom", step_evidence=ESTIMATED)
    racks = headroom / per_rack

    def _apply(c: EnvelopeContext) -> EnvelopeContext:
        c = c.copy()
        c.thermal.plant.chilled_water_capacity_kW = (
            c.thermal.plant.chilled_water_capacity_kW *
            V(1.5, "1", "plant uprate factor", ASSUMED))
        return c

    route = ("full rack load (liquid rejected into the existing plant)" if _liquid_load_to_plant(ctx)
             else "residual air load only (liquid rejected to a dedicated high-temperature loop)")
    return ConstraintResult(
        "plant_capacity", "thermal", "Chilled-water plant capacity",
        floor_racks(racks),
        basis=f"{headroom.render()} of plant headroom against {per_rack.render()} per rack — {route}",
        relief=ReliefOption(
            description="Uprate chilled-water plant (+50%) or add a dedicated high-temperature loop",
            capex_eur=cost("plant.uprate", 900_000, "EUR", "chilled-water plant uprate"),
            cost_key="plant.uprate",
            lead_time_weeks=V(44, "weeks", "chiller / dry cooler lead time", ASSUMED, band=(30, 70)),
            apply=_apply,
            risk="A dedicated high-temperature loop is usually cheaper to run and should be compared "
                 "against uprating legacy low-temperature plant.",
        ),
    )


@constraint
def hydraulic_flow(ctx: EnvelopeContext) -> ConstraintResult:
    t = ctx.thermal
    if ctx.architecture in (Architecture.RETAINED_AIR,):
        return ConstraintResult("hydraulic_flow", "thermal", "Hydraulic flow capacity",
                                V(float("inf"), "racks", "flow: not limiting", ESTIMATED),
                                basis="no liquid circuit in this architecture")
    racks = (t.plant.pump_flow_capacity_l_per_min / ctx.cluster.platform.flow_l_per_min_per_rack).relabel(
        "racks permitted by available pumped flow", "thermal.flow_limit", step_evidence=SIMULATED)

    def _apply(c: EnvelopeContext) -> EnvelopeContext:
        c = c.copy()
        c.thermal.plant.pump_flow_capacity_l_per_min = (
            c.thermal.plant.pump_flow_capacity_l_per_min * V(1.8, "1", "pump uprate factor", ASSUMED))
        return c

    return ConstraintResult(
        "hydraulic_flow", "thermal", "Hydraulic flow capacity",
        floor_racks(racks),
        basis=(f"{t.plant.pump_flow_capacity_l_per_min.render()} available against "
               f"{ctx.cluster.platform.flow_l_per_min_per_rack.render()} per rack "
               f"(~1.45 l/min/kW at 10 K delta-T)"),
        relief=ReliefOption(
            description="Uprate pumps and secondary pipework",
            capex_eur=cost("pump.uprate", 420_000, "EUR", "pump and secondary pipework uprate"),
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
    ok = need.value <= have.value
    racks = V(float("inf") if ok else 0.0, "racks",
              "racks permitted by per-position air removal capacity", ESTIMATED)

    def _apply(c: EnvelopeContext) -> EnvelopeContext:
        c = c.copy()
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
    required_fws = (t.tcs_target_supply_C - t.cdu_approach_K).relabel(
        "facility water supply temperature required", "thermal.required_fws", step_evidence=ESTIMATED)
    if t.trim_chiller_installed:
        achievable = t.plant.design_supply_C.relabel(
            "facility water temperature achievable with trim chiller on the high-temperature loop",
            "thermal.trim_chiller_fws", step_evidence=ESTIMATED)
        mech = "trim chiller on the high-temperature loop"
    elif ctx.architecture == Architecture.FULL_DLC and t.plant.dry_cooler_approach_K is not None:
        achievable = (ctx.site.design_drybulb_C + t.plant.dry_cooler_approach_K).relabel(
            "facility water temperature achievable by dry coolers at design dry bulb",
            "thermal.dry_cooler_fws", step_evidence=SIMULATED)
        mech = "dry coolers at design dry-bulb"
    else:
        achievable = t.plant.design_supply_C.relabel(
            "facility water temperature achievable by existing plant", "thermal.plant_fws",
            step_evidence=ESTIMATED)
        mech = "existing chilled-water plant"
    ok = achievable.value <= required_fws.value
    racks = V(float("inf") if ok else 0.0, "racks", "racks permitted by achievable water temperature", ESTIMATED)

    def _apply(c: EnvelopeContext) -> EnvelopeContext:
        c = c.copy()
        c.thermal.plant.dry_cooler_approach_K = V(
            6, "K", "dry cooler approach with adiabatic assist", ASSUMED, band=(4, 8))
        c.thermal.trim_chiller_installed = True
        return c

    return ConstraintResult(
        "tcs_supply_achievable", "thermal", "Achievable facility water temperature",
        racks, gate=True,
        basis=(f"TCS target {t.tcs_target_supply_C.render()} needs facility water at or below "
               f"{required_fws.render()}; {mech} delivers {achievable.render()}"),
        relief=ReliefOption(
            description="Adiabatic assist plus trim chiller on the high-temperature loop",
            capex_eur=cost("trim_chiller.adiabatic", 350_000, "EUR",
                           "adiabatic assist and trim chiller"),
            cost_key="trim_chiller.adiabatic",
            lead_time_weeks=V(32, "weeks", "lead time", ASSUMED, band=(20, 48)),
            apply=_apply,
            risk="Adiabatic assist reintroduces water consumption; check permits and WUE targets.",
        ),
        notes=("The ASHRAE W45 rating on the platform is an equipment survival rating, not an "
               "operating point; operators specify 27-30 degC for 500-700 W parts.",),
    )
