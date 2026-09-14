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

from ..common import V
from ..constraints import EnvelopeContext
from ..envelope.solver import LadderStep
from ..scenario.run import ScenarioResult
from ..validation import EvidenceClass, Quantity
from .schema import (INFORMATIVE, MANDATORY, PREFERRED, EvaluationCriterion,
                     ProcurementError, Requirement, ResponseField, ScopeItem,
                     SpecPackage)


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


def _q(value: float, unit: str, label: str, ev: EvidenceClass, model: str) -> Quantity:
    return Quantity.given(value, unit, label, ev).relabel(label, model)


# --- per-constraint requirement generators ----------------------------------

def _tapoff(ctx: EnvelopeContext, racks: int) -> list[Requirement]:
    plat = ctx.cluster.platform
    lv = ctx.power.lv
    need_A = plat.rack_feed_current_A
    reqs = [
        Requirement(
            id="E-01", clause="Tap-off continuous rating",
            statement=(f"Each rack tap-off unit shall be rated for continuous operation at "
                       f"not less than the rack feed current stated in the response "
                       f"schedule, at the busway voltage and the hall's design ambient."),
            value=need_A, unit="A", derived_from="rack_feed_tapoff",
            basis=(f"{plat.name} draws {need_A.render() if need_A else 'the stated current'} "
                   f"per rack; the installed tap-offs are rated "
                   f"{lv.tapoff_max_A.render()}."),
            verification="Type test certificate and manufacturer's rating curve at design ambient."),
        Requirement(
            id="E-02", clause="Quantity",
            statement=f"The supply shall cover {racks} rack positions.",
            value=_q(float(racks), "racks", "tap-off units required",
                     EvidenceClass.E3_ENGINEERING_ESTIMATE, "spec.quantity"),
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


def _busway(ctx: EnvelopeContext, racks: int) -> list[Requirement]:
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
            value=_q(required, "A", "required busway ampacity per run",
                     EvidenceClass.E3_ENGINEERING_ESTIMATE, "spec.busway_ampacity"),
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


def _transformer(ctx: EnvelopeContext, racks: int) -> list[Requirement]:
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
            value=_q(mva, "MVA", "required transformer capacity",
                     EvidenceClass.E3_ENGINEERING_ESTIMATE, "spec.transformer_rating"),
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


def _ups(ctx: EnvelopeContext, racks: int) -> list[Requirement]:
    plat = ctx.cluster.platform
    kW = plat.rack_kW.value * racks
    blocks = ctx.power.ups
    step = blocks[0].step_load_capability.render() if blocks else "the stated fraction"
    return [
        Requirement(
            id="E-30", clause="Protected capacity",
            statement="Additional protected capacity shall be not less than the figure stated.",
            value=_q(kW, "kW", "additional protected load",
                     EvidenceClass.E3_ENGINEERING_ESTIMATE, "spec.ups_capacity"),
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


def _cdu(ctx: EnvelopeContext, racks: int) -> list[Requirement]:
    plat = ctx.cluster.platform
    plant = ctx.thermal.plant
    duty = plat.liquid_kW().value * racks
    flow = plat.flow_l_per_min_per_rack.value * racks
    approach = max(1.0, plat.max_inlet_liquid_C.value - plant.design_supply_C.value)
    return [
        Requirement(
            id="T-01", clause="Rated duty at site conditions",
            statement=("CDU duty shall be not less than the figure stated WHEN RATED AT THE "
                       "SITE FACILITY WATER TEMPERATURE below, not at the manufacturer's "
                       "reference approach."),
            value=_q(duty, "kW", "required CDU duty at site conditions",
                     EvidenceClass.E3_ENGINEERING_ESTIMATE, "spec.cdu_duty"),
            unit="kW", derived_from="cdu_capacity",
            basis=(f"{racks} racks at {plat.liquid_kW().render()} liquid load. Facility water "
                   f"{plant.design_supply_C.render()}; platform accepts up to "
                   f"{plat.max_inlet_liquid_C.render()} at the technology cooling loop."),
            verification="Performance curve or selection output at the stated facility water temperature."),
        Requirement(
            id="T-02", clause="Facility water conditions",
            statement=(f"Equipment shall achieve the rated duty with facility water supplied "
                       f"at {plant.design_supply_C.render()}, return "
                       f"{plant.design_return_C.render()}."),
            value=plant.design_supply_C, unit="degC", derived_from="cdu_capacity",
            basis=("Rating a CDU at a 5 K approach and installing it on a site with a far "
                   "wider approach is the single most common way a liquid retrofit "
                   "under-delivers."),
            verification="Selection output at these exact conditions."),
        Requirement(
            id="T-03", clause="Technology loop flow",
            statement="Technology-side flow shall be not less than the figure stated.",
            value=_q(flow, "l/min", "required technology loop flow",
                     EvidenceClass.E3_ENGINEERING_ESTIMATE, "spec.tcs_flow"),
            unit="l/min", derived_from="cdu_capacity",
            basis=f"{racks} racks at {plat.flow_l_per_min_per_rack.render()}.",
            verification="Pump curve and duty point."),
        Requirement(
            id="T-04", clause="Approach temperature",
            statement=("The response shall state the approach temperature achieved at the "
                       "duty point above."),
            value=_q(approach, "K", "available approach at site conditions",
                     EvidenceClass.E3_ENGINEERING_ESTIMATE, "spec.cdu_approach"),
            unit="K", derived_from="cdu_capacity",
            basis="Approach at site conditions is what determines usable duty.",
            verification="Selection output."),
        Requirement(
            id="T-05", clause="Redundancy and water quality",
            statement=("Configuration shall be N+1 at the stated duty. The response shall "
                       "state technology-loop water chemistry and filtration requirements."),
            derived_from="cdu_capacity",
            basis="Cold-plate fouling is a warranty question before it is a capacity question.",
            verification="Manufacturer's water quality specification."),
    ]


def _plant(ctx: EnvelopeContext, racks: int) -> list[Requirement]:
    plat = ctx.cluster.platform
    plant = ctx.thermal.plant
    duty = plat.residual_air_kW().value * racks
    return [
        Requirement(
            id="T-20", clause="Additional cooling capacity",
            statement="Additional plant capacity shall be not less than the figure stated.",
            value=_q(duty, "kW", "required additional plant capacity",
                     EvidenceClass.E3_ENGINEERING_ESTIMATE, "spec.plant_duty"),
            unit="kW", derived_from="plant_capacity",
            basis=(f"{racks} racks at {plat.residual_air_kW().render()} residual air load. "
                   f"Installed plant {plant.chilled_water_capacity_kW.render()}."),
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


def _hydraulic(ctx: EnvelopeContext, racks: int) -> list[Requirement]:
    plat = ctx.cluster.platform
    plant = ctx.thermal.plant
    flow = plat.flow_l_per_min_per_rack.value * racks
    return [
        Requirement(
            id="T-40", clause="Pumped flow",
            statement="Available pumped flow shall be not less than the figure stated.",
            value=_q(flow, "l/min", "required pumped flow",
                     EvidenceClass.E3_ENGINEERING_ESTIMATE, "spec.pumped_flow"),
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


def _generic(ctx: EnvelopeContext, racks: int, step: LadderStep) -> list[Requirement]:
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
            value=_q(float(racks), "racks", "rack positions to be unlocked",
                     EvidenceClass.E3_ENGINEERING_ESTIMATE, "spec.quantity"),
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

    ctx = result.envelope.context if hasattr(result.envelope, "context") else intake.context

    # Size against the END STATE, not the marginal racks this rung unlocks.
    #
    # A ladder rung often unlocks three racks, or none at all — it moves a
    # constraint that was not the tightest. Nobody buys a transformer for three
    # racks: they buy it for the hall the client intends to end up with. Sizing to
    # the rung's own delta produces a specification that is technically traceable
    # and commercially absurd, which is worse than one that is neither.
    racks = max(result.unlocked_racks, step.racks_after, 1)
    gen = GENERATORS.get(step.binding_id)
    reqs = gen(ctx, racks) if gen else _generic(ctx, racks, step)

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
        sized_for_racks=racks,
        sized_for_kW=ctx.cluster.platform.rack_kW.value * racks,
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
