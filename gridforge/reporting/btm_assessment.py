"""The BTM Power Deployment Assessment — one object, real architectures compared.

Two cycles ago this repository gained real physics: a duration-aware battery
model, an availability-aware generator model, and deterministic N/N+1/N+2/2N
contingency analysis. All three were correct and all three were orphaned — no
customer question actually got answered by calling them, because nothing
composed them against a real load and a real target the way `reporting.study`
already composes the envelope solver, or `reporting.readiness` composes the
headroom ladder.

This module is that composition. It answers the question a developer actually
asks: "I need this much firm power by this date — what combination of grid,
generation and storage gets me there, what does each option cost, and what do I
do next?" Every number is read from the engine modules already built; this file
computes no new physics, exactly like `reporting/readiness.py` before it.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

from ..common import ASSUMED, V
from ..intake.loader import PLAUSIBLE_MAX
from ..power.generation import GenerationUnit
from ..power.load_profile import LoadProfile, peak_plausibility_problem
from ..power.readiness_gates import GateResult, GateStatus, evaluate_gates
from ..envelope.time_to_power import NO_DATE, DateBasis, date_basis_of
from ..power.reliability import (UNDECLARED_RIDE_THROUGH_LABEL, ContingencyCase, ContingencyStatus,
                                 Redundancy, evaluate)
from ..power.storage import BatteryEnergyStorageSystem
from ..scenario.objective import Objective
from ..validation import Quantity

#: Why each objective means what it means for a BTM architecture comparison,
#: reusing the same `Objective` the hall-side headroom ladder and Power
#: Readiness Case already use (gridforge/scenario/objective.py) — "what the
#: customer is optimising" is one concept in this codebase, not one per
#: product. The values keep their existing meaning; only the English
#: explanation below is BTM-specific.
_BTM_OBJECTIVE_RATIONALE = {
    Objective.MAX_COMPUTE:
        "Maximum firm capacity. Appropriate when the site's demand is the binding "
        "constraint and any capacity gained is worth capturing, even at a higher cost "
        "or a longer lead time.",
    Objective.MIN_COST_PER_RACK:
        "Lowest capital cost among architectures that clear the contingency test. "
        "Appropriate where capital, not capacity or schedule, is the binding constraint.",
    Objective.FASTEST_TO_POWER:
        "Shortest critical-path lead time among architectures that clear the "
        "contingency test. Appropriate where a committed energisation date makes a "
        "week of delay more expensive than the capex difference.",
}

_BTM_OBJECTIVE_KEY = {
    Objective.MAX_COMPUTE: lambda a: -a.contingency.available_MW.value,
    Objective.MIN_COST_PER_RACK: lambda a: a.capex_eur.value,
    Objective.FASTEST_TO_POWER: lambda a: (
        a.lead_time_weeks.value if a.lead_time_weeks is not None else float("inf")),
}


@dataclass
class ArchitectureCandidate:
    label: str
    generation: list[GenerationUnit] = field(default_factory=list)
    bess: list[BatteryEnergyStorageSystem] = field(default_factory=list)


def candidate_architectures(generation: list[GenerationUnit],
                            bess: list[BatteryEnergyStorageSystem]
                            ) -> list[ArchitectureCandidate]:
    """The standard hybrid combinations a real BTM RFP actually compares — built
    only from what the customer declared. A technology nobody mentioned does not
    appear as an option; this is not a catalogue of everything GridForge could
    someday model, it is a comparison of what is actually on the table."""
    out = [ArchitectureCandidate("GRID ONLY")]
    if generation:
        out.append(ArchitectureCandidate("GRID + GENERATION", generation=generation))
    if bess:
        out.append(ArchitectureCandidate("GRID + BESS", bess=bess))
    if generation and bess:
        out.append(ArchitectureCandidate("GRID + BESS + GENERATION",
                                         generation=generation, bess=bess))
    return out


def _total_capex(units: list) -> tuple[Quantity | None, list[str]]:
    """Sum of declared CAPEX, or None with the names of what is uncosted.
    Never silently prices an uncosted unit at zero — even ONE uncosted unit in
    an architecture of five makes the total None, not a sum that quietly
    excludes it. A partial total that looks complete is worse than an honest
    'unknown'."""
    missing = [u.id for u in units if u.capex_eur is None]
    if missing or not units:
        return None, missing
    total = units[0].capex_eur
    for u in units[1:]:
        total = total + u.capex_eur
    return total.relabel("architecture CAPEX", "power.deploy_capex"), missing


def _critical_path_weeks(units: list) -> tuple[Quantity | None, list[str]]:
    """Longest declared lead time — units procure in parallel, so the slowest
    one sets the date, exactly as the headroom ladder's own schedule logic
    already assumes elsewhere in this codebase. Undated for the whole
    architecture, not just silently ignoring the undated unit, if even one
    lead time is missing."""
    missing = [u.id for u in units if u.lead_time_weeks is None]
    if missing or not units:
        return None, missing
    worst = max((u.lead_time_weeks for u in units), key=lambda q: q.value)
    return worst, missing


def _lead_time_basis(units: list) -> DateBasis:
    """The weakest evidence class among the units' lead times and the unit that sets the longest one. A lead time
    declared in an intake or a request is an assumption (E0) until a supplier's quotation says otherwise."""
    if not units or any(u.lead_time_weeks is None for u in units):
        return NO_DATE
    weakest = min(u.lead_time_weeks.evidence for u in units)
    binding = max(units, key=lambda u: u.lead_time_weeks.value)
    return date_basis_of(weakest, binding.id)


@dataclass
class ArchitectureAssessment:
    label: str
    contingency: "object"          # ContingencyResult
    capex_eur: Quantity | None
    capex_uncosted_units: list[str]
    lead_time_weeks: Quantity | None
    lead_time_undated_units: list[str]
    gates: list[GateResult] = field(default_factory=list)
    #: What the architecture's lead time rests on: the weakest class among its units and the unit that sets it.
    date: DateBasis = NO_DATE

    @property
    def buildable(self) -> bool:
        """Technically sound AND commercially describable. A PASS with an
        unpriced generator is not yet a comparable option — it is an engineering
        answer waiting on a quote, and the ranking below must not silently treat
        'unpriced' as 'free'."""
        return (self.contingency.status == ContingencyStatus.PASS
                and self.capex_eur is not None)

    @property
    def rfq_ready(self) -> bool:
        """"GridForge has enough information to prepare an RFQ" — buildable AND
        no gate is stuck on MISSING_DATA or UNKNOWN. This is deliberately NOT
        "cleared to build": a protection gate that reads REQUIRES_LICENSED_REVIEW
        does not block RFQ preparation (a supplier can be asked to quote while a
        protection engineer works in parallel) but it absolutely blocks
        `execution_ready` below. Conflating the two — an earlier version of this
        property was literally named `ready_for_procurement` and only excluded
        MISSING_DATA — read as "cleared to build" to anyone skimming the field
        name, which it never was. Renamed and split rather than patched, because
        the bug was the name promising more than the check delivered, not the
        check itself."""
        return self.buildable and not any(
            g.status in (GateStatus.MISSING_DATA, GateStatus.UNKNOWN) for g in self.gates)

    @property
    def external_clearances_required(self) -> list[GateResult]:
        """Every gate still standing between this architecture and physical
        construction, each naming who owns clearing it. Never resolves to empty
        for an architecture with any on-site generation or storage — protection
        coordination always requires a licensed engineer, by design (see
        `readiness_gates._protection_gate`) — and that is the correct, honest
        answer, not a gap to be closed by this tool."""
        return [g for g in self.gates
               if g.status in (GateStatus.REQUIRES_ENGINEERING_STUDY,
                              GateStatus.REQUIRES_LICENSED_REVIEW, GateStatus.FAIL)]

    @property
    def execution_ready(self) -> bool:
        """Cleared to build: every gate is PASS or NOT_APPLICABLE, with no
        external clearance outstanding. For any architecture with on-site
        generation or storage this is honestly almost never true from a
        screening tool alone — protection review in particular cannot resolve
        to PASS here by construction. It becomes true only once the gates
        themselves are updated with real external evidence (a licensed
        engineer's sign-off, a utility's approval letter) — a future capability,
        not something this property fakes by omission today."""
        return self.rfq_ready and not self.external_clearances_required


def assess_architecture(candidate: ArchitectureCandidate, *, grid_firm_MW: Quantity,
                        critical_load_MW: Quantity, ride_through_hours: Quantity,
                        redundancy: Redundancy, interconnection: dict | None = None,
                        permitting: dict | None = None, profile_problem: str = "") -> ArchitectureAssessment:
    case = ContingencyCase(critical_load_MW=critical_load_MW, grid_firm_MW=grid_firm_MW,
                           generation=candidate.generation, bess=candidate.bess,
                           ride_through_hours=ride_through_hours, redundancy=redundancy)
    result = evaluate(case)
    if profile_problem:
        # The same mechanism the contingency test itself uses for an open question (a blocking note turns a PASS into REQUIRES_ENGINEERING_STUDY):
        # a PASS computed on a load that is probably a unit slip is not a pass, and the note says what to check.
        result.blocking.append(f"load profile: {profile_problem}")
        if result.status == ContingencyStatus.PASS:
            result.status = ContingencyStatus.REQUIRES_ENGINEERING_STUDY
    capex, uncosted = _total_capex(candidate.generation + candidate.bess)
    lead_time, undated = _critical_path_weeks(candidate.generation + candidate.bess)
    gates = evaluate_gates(generation=candidate.generation, bess=candidate.bess,
                          interconnection=interconnection, permitting=permitting,
                          contingency=result)
    return ArchitectureAssessment(candidate.label, result, capex, uncosted, lead_time, undated,
                                  gates, date=_lead_time_basis(candidate.generation + candidate.bess))


def _rank(buildable: list[ArchitectureAssessment], objective: Objective) -> list[ArchitectureAssessment]:
    return sorted(buildable, key=_BTM_OBJECTIVE_KEY[objective])


def _trade_offs(winner: ArchitectureAssessment, runner_up: ArchitectureAssessment | None,
                objective: Objective) -> list[str]:
    """What the customer gives up by taking the winner instead of the next-best
    alternative, stated in the currency the objective did NOT optimise for —
    never silent, and never a second hidden ranking."""
    if runner_up is None:
        return []
    out = []
    if objective is not Objective.MIN_COST_PER_RACK and winner.capex_eur is not None \
            and runner_up.capex_eur is not None and winner.capex_eur.value != runner_up.capex_eur.value:
        delta = winner.capex_eur.value - runner_up.capex_eur.value
        out.append(f"'{runner_up.label}' costs {'less' if delta > 0 else 'more'} "
                  f"(EUR {abs(delta):,.0f} difference) but was not chosen because the objective "
                  f"is {objective.value}, not lowest cost.")
    if objective is not Objective.FASTEST_TO_POWER and winner.lead_time_weeks is not None \
            and runner_up.lead_time_weeks is not None \
            and winner.lead_time_weeks.value != runner_up.lead_time_weeks.value:
        delta = winner.lead_time_weeks.value - runner_up.lead_time_weeks.value
        out.append(f"'{runner_up.label}' is {'faster' if delta > 0 else 'slower'} "
                  f"({abs(delta):.0f} week(s) difference) but was not chosen because the "
                  f"objective is {objective.value}, not fastest to power.")
    if objective is not Objective.MAX_COMPUTE and (
            winner.contingency.available_MW.value != runner_up.contingency.available_MW.value):
        delta = winner.contingency.available_MW.value - runner_up.contingency.available_MW.value
        out.append(f"'{runner_up.label}' has {'less' if delta > 0 else 'more'} firm capacity "
                  f"margin ({abs(delta):.1f} MW difference) but was not chosen because the "
                  f"objective is {objective.value}, not maximum capacity.")
    return out


def _next_action(load_profile_report, assessments: list[ArchitectureAssessment],
                 gap_MW: float, objective: Objective, *, profile_problem: str = "") -> dict:
    """One deterministic recommendation, in priority order: fix the data before
    trusting any comparison; then close a missing quote before ranking; then
    close a missing-data readiness gate before recommending procurement — a
    technically passing, fully-costed architecture with an unpermitted
    generator is "technically feasible, not yet schedule-credible", and saying
    "proceed to procurement" would hide that; only then point at the winner
    UNDER THE STATED OBJECTIVE, with the trade-off against the runner-up named
    explicitly — never a silent "lowest cost wins" default, which is the
    mistake this function used to make before `objective` existed.

    Every answer carries `directional` when the load profile is too short to size from (load_profile.MIN_SAMPLES_FOR_SIZING readings over
    MIN_SPAN_HOURS_FOR_SIZING hours): the caveat is in the action itself, because a warning list nobody opens is not a caveat."""
    out = _next_action_core(load_profile_report, assessments, gap_MW, objective, profile_problem)
    if load_profile_report.directional:
        out["directional"] = True
        out["directional_reason"] = load_profile_report.directional_reason
    return out


def _next_action_core(load_profile_report, assessments: list[ArchitectureAssessment],
                      gap_MW: float, objective: Objective, profile_problem: str) -> dict:
    if profile_problem:
        return {"action": "Check the units of the load profile before anything else: its peak is implausible against the stated target and grid "
                          "capacity, so no architecture result below can be relied on.",
               "why": f"{profile_problem[0].upper()}{profile_problem[1:]}. No architecture is called a pass while this stands.",
               "profile_problem": profile_problem}
    if not load_profile_report.usable:
        return {"action": "Resolve the load profile's duplicate timestamps before "
                          "trusting any architecture comparison built on it.",
               "why": "A profile with duplicate timestamps cannot be ordered, which makes "
                      "every ramp-rate and step-event figure derived from it meaningless."}
    passing = [a for a in assessments if a.contingency.status == ContingencyStatus.PASS]
    if not passing:
        return {"action": "No declared architecture passes its own contingency test — "
                          "add generation, storage, or grid firm capacity before proceeding.",
               "why": f"Every candidate falls short of the critical load by at least "
                      f"the worst-case margin shown; the gap to target is {gap_MW:.1f} MW."}
    # An architecture with no equipment declared has nothing to price: it is not "uncosted", and a quote for an empty list is not an action.
    uncosted = [a for a in passing if not a.buildable and a.capex_uncosted_units]
    if uncosted:
        u = uncosted[0]
        names = ", ".join(u.capex_uncosted_units)
        return {"action": f"Obtain a budgetary or firm quote for: {names}",
               "why": f"'{u.label}' passes its contingency test but cannot be compared on "
                      f"cost or schedule until every unit in it is priced."}
    buildable = [a for a in passing if a.buildable]
    if not buildable:
        # Only architectures that buy nothing pass: the grid connection alone carries the critical load the profile defines.
        grid_only = passing[0]
        return {"action": f"No equipment purchase is indicated: '{grid_only.label}' passes its contingency test on the profile's critical load.",
               "why": (f"Every architecture that passes declares no equipment to buy, so there is nothing to price or tender. The contingency test is run "
                       f"against the load profile's own peak, not against the stated target (the gap to the target is {gap_MW:.1f} MW): if you are "
                       f"sizing for the target, supply a profile that reflects it. Confirm the profile's peak and units first.")}
    ranked = _rank(buildable, objective)
    no_equipment = next((a for a in passing if not a.buildable and not a.capex_uncosted_units), None)
    no_equipment_note = (f" Note: '{no_equipment.label}' also passes its contingency test on this profile, so the equipment below is not needed to carry "
                         f"the profile's own critical load; it is what the stated target needs." if no_equipment is not None else "")
    winner = ranked[0]
    runner_up = ranked[1] if len(ranked) > 1 else None
    if not winner.rfq_ready:
        missing_gates = [g for g in winner.gates
                        if g.status in (GateStatus.MISSING_DATA, GateStatus.UNKNOWN)]
        fields = sorted({m for g in missing_gates for m in g.missing})
        return {"action": f"Supply the missing readiness data for '{winner.label}': "
                          f"{', '.join(fields) if fields else 'see readiness_gates'}",
               "why": f"'{winner.label}' is the best architecture under the {objective.value} "
                      f"objective, fully costed — but it is technically feasible, "
                      f"not yet schedule-credible: "
                      + "; ".join(g.reason for g in missing_gates)}
    clearances = winner.external_clearances_required
    clearance_note = (
        "; ".join(sorted({g.review_requirement for g in clearances if g.review_requirement}))
        if clearances else "none outstanding from this screening")
    if load_profile_report.directional:
        # Short profile: the ranking is indicative. The action still names the architecture (the engineer needs to know which one the numbers favour),
        # but it is not offered as a green light, and it says what to do before an RFQ is prepared.
        return {"action": f"Proceed to RFQ for: {winner.label} — directional only: re-run on a full-day load profile before an RFQ is issued",
               "why": f"{load_profile_report.directional_reason[:1].upper()}{load_profile_report.directional_reason[1:]} "
                      f"'{winner.label}' is the best architecture under the {objective.value} objective among those that pass their own "
                      f"contingency test and are fully costed, but a profile this short cannot show the ramp, step and duration the sizing rests on, "
                      f"so treat the ranking as indicative and confirm it on a full-day profile before preparing an RFQ. "
                      f"It is NOT a green light to build: external clearance still required from: {clearance_note}.{no_equipment_note}",
               "objective": objective.value,
               "objective_rationale": _BTM_OBJECTIVE_RATIONALE[objective],
               "trade_offs": _trade_offs(winner, runner_up, objective)}
    return {"action": f"Proceed to RFQ for: {winner.label}",
           "why": f"The best architecture under the {objective.value} objective among those "
                  f"that pass their own contingency test, fully costed, with every readiness "
                  f"gate screened. This is a green light to prepare an RFQ, NOT a green light "
                  f"to build: external clearance still required from: {clearance_note}.{no_equipment_note}",
           "objective": objective.value,
           "objective_rationale": _BTM_OBJECTIVE_RATIONALE[objective],
           "trade_offs": _trade_offs(winner, runner_up, objective)}


class DeploymentRequestError(ValueError):
    pass


#: Plausibility ceilings for the numbers a deployment request carries, taken from the intake loader's own (PLAUSIBLE_MAX) where it has one, so the two
#: doors agree on what a hall can be: a figure above is a unit slip or an overflow. Without them `nan`, `inf` and 1e300 passed this parser, reached
#: the solver as a quantity and left in the response as the literals NaN / Infinity, which are not JSON.
_MAX_MW = PLAUSIBLE_MAX["grid.contracted_MW"]
_MAX_MWH = PLAUSIBLE_MAX["btm_options.energy_MWh"]
_MAX_WEEKS = PLAUSIBLE_MAX["btm_options.lead_time_weeks"]
_MAX_HOURS = 8_784.0                    # a leap year
_MAX_EUR = 1e12                         # in step with change._STATE_MAX_EUR


def _number(raw, what: str, high: float, unit: str) -> float:
    """A finite number from 0 to `high`, or a refusal that names the field. (`float()` alone accepts nan, inf and a numeric string, and says nothing
    about a magnitude no site has.)"""
    try:
        v = float(raw)
    except (TypeError, ValueError, OverflowError):
        raise DeploymentRequestError(f"{what} is {str(raw)[:40]!r}, which is not a number") from None
    if not math.isfinite(v):
        raise DeploymentRequestError(f"{what} is {raw!r}; it must be a finite number of {unit}")
    if v < 0 or v > high:
        raise DeploymentRequestError(f"{what} is {v:g} {unit}; it must be from 0 to {high:g} {unit}, the most this tool will model for one site. "
                                     f"Check the unit and for a stray digit.")
    return v


def _optional_number(d: dict, key: str, what: str, high: float, unit: str) -> float | None:
    return None if d.get(key) is None else _number(d[key], what, high, unit)


def _generation_from_request(d: dict) -> GenerationUnit:
    from ..power.generation import default_generation_unit
    ident = str(d["id"])
    unit = default_generation_unit(ident, str(d.get("kind", "gas_engine")),
                                   _number(d["nameplate_MW"], f"generation {ident} nameplate_MW", _MAX_MW, "MW"))
    capex = _optional_number(d, "capex_eur", f"generation {ident} capex_eur", _MAX_EUR, "EUR")
    if capex is not None:
        unit.capex_eur = V(capex, "EUR", f"{unit.id} capex", ASSUMED, band=0.3)
    lead = _optional_number(d, "lead_time_weeks", f"generation {ident} lead_time_weeks", _MAX_WEEKS, "weeks")
    if lead is not None:
        unit.lead_time_weeks = V(lead, "weeks", f"{unit.id} lead time", ASSUMED, band=0.35)
    if d.get("fuel_type"):
        unit.fuel_type = str(d["fuel_type"])
    if d.get("operating_mode") is not None:
        from ..power.generation import OPERATING_MODES
        mode = d["operating_mode"]
        if not isinstance(mode, str) or mode not in OPERATING_MODES:
            raise DeploymentRequestError(
                f"generation {unit.id}: operating_mode must be one of {', '.join(OPERATING_MODES)}, not {mode!r}")
        unit.operating_mode = mode
    if d.get("startup_time_min") is not None:
        raw = d["startup_time_min"]
        if isinstance(raw, bool) or not isinstance(raw, (int, float)) or not (0 <= raw <= 1440) or raw != raw:
            raise DeploymentRequestError(
                f"generation {unit.id}: startup_time_min must be a number of minutes from 0 to 1440, not {raw!r}")
        unit.startup_time_min = V(float(raw), "min", f"{unit.id} start-up time (declared)", ASSUMED)
    return unit


def _bess_from_request(d: dict) -> BatteryEnergyStorageSystem:
    from ..power.storage import default_bess
    ident = str(d["id"])
    unit = default_bess(ident, power_MW=_number(d["power_MW"], f"bess {ident} power_MW", _MAX_MW, "MW"),
                        energy_MWh=_number(d["energy_MWh"], f"bess {ident} energy_MWh", _MAX_MWH, "MWh"))
    capex = _optional_number(d, "capex_eur", f"bess {ident} capex_eur", _MAX_EUR, "EUR")
    if capex is not None:
        unit.capex_eur = V(capex, "EUR", f"{unit.id} capex", ASSUMED, band=0.3)
    lead = _optional_number(d, "lead_time_weeks", f"bess {ident} lead_time_weeks", _MAX_WEEKS, "weeks")
    if lead is not None:
        unit.lead_time_weeks = V(lead, "weeks", f"{unit.id} lead time", ASSUMED, band=0.35)
    if d.get("grid_forming") is not None:
        unit.grid_forming = bool(d["grid_forming"])
    return unit


def _load_profile_from_request(d: dict) -> LoadProfile:
    from ..power.load_profile import LOAD_PROFILE_MAX_HOURS, LOAD_PROFILE_MAX_kW, LoadProfileError, flat
    from .load_profile_csv import load_profile_from_csv
    if not isinstance(d, dict):
        raise DeploymentRequestError(f"load_profile must be an object with 'csv' or 'flat_kW', not {type(d).__name__}")
    try:
        if d.get("csv"):
            return load_profile_from_csv(str(d["csv"]), source=str(d.get("source") or "uploaded CSV"))
        if d.get("flat_kW") is not None:
            return flat(_number(d["flat_kW"], "load_profile.flat_kW", LOAD_PROFILE_MAX_kW, "kW"),
                        hours=_number(d.get("flat_hours", 24.0), "load_profile.flat_hours", LOAD_PROFILE_MAX_HOURS, "h"))
    except LoadProfileError as exc:
        raise DeploymentRequestError(f"load_profile: {exc}") from exc
    raise DeploymentRequestError(
        "load_profile must supply either 'csv' (timestamp,kW rows) or 'flat_kW' "
        "(a single-figure screening assumption)")


def deployment_request(doc: dict) -> dict:
    """Parse the wire shape (JSON body / request file) into `assess_deployment`'s
    keyword arguments. Kept separate from `assess_deployment` itself so the CLI,
    REST and MCP surfaces share one parser and cannot drift on what a field
    means — the same discipline `lib/products.ts` vs `commercial.py` parity
    testing enforces on the commercial side of this repository."""
    try:
        load_profile = _load_profile_from_request(doc["load_profile"])
        grid_firm_MW = V(_number(doc["grid_firm_MW"], "grid_firm_MW", _MAX_MW, "MW"), "MW", "grid firm capacity", ASSUMED)
        target_MW = V(_number(doc["target_MW"], "target_MW", _MAX_MW, "MW"), "MW", "target firm power", ASSUMED)
        generation = [_generation_from_request(g) for g in doc.get("generation", [])]
        bess = [_bess_from_request(b) for b in doc.get("bess", [])]
    except KeyError as exc:
        raise DeploymentRequestError(f"missing required field: {exc}") from exc
    ride_through_hours = (V(_number(doc["ride_through_hours"], "ride_through_hours", _MAX_HOURS, "h"), "h", "ride-through window", ASSUMED)
                          if doc.get("ride_through_hours") is not None else None)
    redundancy = Redundancy(doc.get("redundancy", Redundancy.N.value))
    interconnection = doc.get("interconnection") if isinstance(doc.get("interconnection"), dict) else None
    permitting = doc.get("permitting") if isinstance(doc.get("permitting"), dict) else None
    try:
        objective = Objective(doc.get("objective", Objective.MAX_COMPUTE.value))
    except ValueError as exc:
        raise DeploymentRequestError(
            f"unknown objective {doc.get('objective')!r} — one of "
            f"{[o.value for o in Objective]}") from exc
    return dict(load_profile=load_profile, grid_firm_MW=grid_firm_MW, generation=generation,
               bess=bess, target_MW=target_MW, ride_through_hours=ride_through_hours,
               redundancy=redundancy, interconnection=interconnection, permitting=permitting,
               objective=objective)


def assess_deployment(*, load_profile: LoadProfile, grid_firm_MW: Quantity,
                      generation: list[GenerationUnit],
                      bess: list[BatteryEnergyStorageSystem],
                      target_MW: Quantity, ride_through_hours: Quantity | None = None,
                      redundancy: Redundancy = Redundancy.N,
                      critical_load_MW: Quantity | None = None,
                      interconnection: dict | None = None,
                      permitting: dict | None = None,
                      objective: Objective = Objective.MAX_COMPUTE) -> dict:
    """The Power Deployment Assessment: current grid-only capacity vs. target,
    every declared hybrid architecture compared under the same contingency test,
    each screened against the engineering readiness gates it can actually be
    screened against, and one next action. `critical_load_MW` defaults to the
    load profile's own peak — the load a real contingency test has to survive,
    not its average. `interconnection`/`permitting` are optional declared data
    for the readiness gates (gridforge.power.readiness_gates) — omitting them
    is honest: the gates read MISSING_DATA rather than guessing.

    `objective` is the same `gridforge.scenario.objective.Objective` the hall-
    side headroom ladder and Power Readiness Case already use — one concept
    of "what the customer is optimising" for the whole product, not a second
    ranking system invented for BTM. Defaults to MAX_COMPUTE (most firm
    capacity) rather than silently ranking by lowest cost, which earlier
    versions of this function did without ever saying so."""
    report = load_profile.validate()
    peak_MW = V(load_profile.peak_kW().value / 1000.0, "MW",
               "load profile peak", load_profile.evidence)
    critical = critical_load_MW if critical_load_MW is not None else peak_MW
    # An undeclared window is the ContingencyCase default and is flagged by it as blocking: a PASS on a 2 h library
    # figure becomes REQUIRES_ENGINEERING_STUDY, and the result says so.
    ride = ride_through_hours if ride_through_hours is not None else V(
        2.0, "h", UNDECLARED_RIDE_THROUGH_LABEL, ASSUMED)

    gap_MW = max(target_MW.value - grid_firm_MW.value, 0.0)
    # A peak a hundred times off the stated target AND the grid capacity is a probable unit slip: it is named, and no architecture passes on it.
    profile_problem = peak_plausibility_problem(load_profile.peak_kW().value, target_MW.value, grid_firm_MW.value)
    warnings = list(report.warnings) + ([f"implausible peak: {profile_problem}"] if profile_problem else [])
    architectures = candidate_architectures(generation, bess)
    assessments = [
        assess_architecture(c, grid_firm_MW=grid_firm_MW, critical_load_MW=critical,
                            ride_through_hours=ride, redundancy=redundancy,
                            interconnection=interconnection, permitting=permitting, profile_problem=profile_problem)
        for c in architectures
    ]

    return {
        "load_profile": {
            "source": load_profile.source,
            "evidence": load_profile.evidence.name,
            "peak_MW": round(peak_MW.value, 3),
            "mean_kW": load_profile.mean_kW().rounded(),
            "load_factor": round(load_profile.load_factor(), 3),
            "ramp_rate_kW_per_min": load_profile.ramp_rate_kW_per_min().rounded(),
            "step_events": len(load_profile.step_events()),
            "warnings": warnings,
            "usable": report.usable,
            # Whether the peak is believable against the target and grid capacity, and whether the profile is long enough to size from.
            "peak_plausible": not profile_problem,
            "directional": report.directional,
        },
        "capacity": {
            "target_MW": round(target_MW.value, 3),
            "grid_firm_MW": round(grid_firm_MW.value, 3),
            "gap_MW": round(gap_MW, 3),
            "critical_load_MW": round(critical.value, 3),
            "ride_through_hours": round(ride.value, 3),
            "ride_through_declared": ride_through_hours is not None,
            "redundancy": redundancy.value,
            "objective": objective.value,
        },
        "architectures": [
            {
                "label": a.label,
                "status": a.contingency.status.value,
                "scenario": a.contingency.scenario,
                "available_MW": round(a.contingency.available_MW.value, 3),
                "margin_MW": round(a.contingency.margin_MW.value, 3),
                "basis": a.contingency.basis,
                "blocking": a.contingency.blocking,
                "capex_eur": a.capex_eur.rounded() if a.capex_eur is not None else None,
                "capex_uncosted_units": a.capex_uncosted_units,
                "lead_time_weeks": a.lead_time_weeks.rounded() if a.lead_time_weeks is not None else None,
                "lead_time_undated_units": a.lead_time_undated_units,
                **a.date.to_dict(),
                "buildable": a.buildable,
                # `rfq_ready`: GridForge has enough information to prepare an RFQ.
                # `execution_ready`: cleared to build — almost never true for an
                # architecture with on-site generation/storage, and that is correct,
                # not a bug. See ArchitectureAssessment's own docstrings for why these
                # are two different questions and were never one field.
                "rfq_ready": a.rfq_ready,
                "execution_ready": a.execution_ready,
                "external_clearances_required": [
                    {"gate": g.gate, "review_requirement": g.review_requirement,
                    "reason": g.reason}
                    for g in a.external_clearances_required
                ],
                "readiness_gates": [
                    {
                        "gate": g.gate, "status": g.status.value, "reason": g.reason,
                        "evidence": g.evidence, "missing": g.missing,
                        "review_requirement": g.review_requirement, "blocking": g.blocking,
                    }
                    for g in a.gates
                ],
            }
            for a in assessments
        ],
        "next_action": _next_action(report, assessments, gap_MW, objective, profile_problem=profile_problem),
    }
