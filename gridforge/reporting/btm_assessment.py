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

from dataclasses import dataclass, field

from ..common import ASSUMED, V
from ..power.generation import GenerationUnit
from ..power.load_profile import LoadProfile
from ..power.readiness_gates import GateResult, GateStatus, evaluate_gates
from ..power.reliability import ContingencyCase, ContingencyStatus, Redundancy, evaluate
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


@dataclass
class ArchitectureAssessment:
    label: str
    contingency: "object"          # ContingencyResult
    capex_eur: Quantity | None
    capex_uncosted_units: list[str]
    lead_time_weeks: Quantity | None
    lead_time_undated_units: list[str]
    gates: list[GateResult] = field(default_factory=list)

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
                        permitting: dict | None = None) -> ArchitectureAssessment:
    case = ContingencyCase(critical_load_MW=critical_load_MW, grid_firm_MW=grid_firm_MW,
                           generation=candidate.generation, bess=candidate.bess,
                           ride_through_hours=ride_through_hours, redundancy=redundancy)
    result = evaluate(case)
    capex, uncosted = _total_capex(candidate.generation + candidate.bess)
    lead_time, undated = _critical_path_weeks(candidate.generation + candidate.bess)
    gates = evaluate_gates(generation=candidate.generation, bess=candidate.bess,
                          interconnection=interconnection, permitting=permitting,
                          contingency=result)
    return ArchitectureAssessment(candidate.label, result, capex, uncosted, lead_time, undated,
                                  gates)


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
                 gap_MW: float, objective: Objective) -> dict:
    """One deterministic recommendation, in priority order: fix the data before
    trusting any comparison; then close a missing quote before ranking; then
    close a missing-data readiness gate before recommending procurement — a
    technically passing, fully-costed architecture with an unpermitted
    generator is "technically feasible, not yet schedule-credible", and saying
    "proceed to procurement" would hide that; only then point at the winner
    UNDER THE STATED OBJECTIVE, with the trade-off against the runner-up named
    explicitly — never a silent "lowest cost wins" default, which is the
    mistake this function used to make before `objective` existed."""
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
    uncosted = [a for a in passing if not a.buildable]
    if uncosted:
        u = uncosted[0]
        names = ", ".join(u.capex_uncosted_units)
        return {"action": f"Obtain a budgetary or firm quote for: {names}",
               "why": f"'{u.label}' passes its contingency test but cannot be compared on "
                      f"cost or schedule until every unit in it is priced."}
    buildable = [a for a in passing if a.buildable]
    ranked = _rank(buildable, objective)
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
    return {"action": f"Proceed to RFQ for: {winner.label}",
           "why": f"The best architecture under the {objective.value} objective among those "
                  f"that pass their own contingency test, fully costed, with every readiness "
                  f"gate screened. This is a green light to prepare an RFQ, NOT a green light "
                  f"to build: external clearance still required from: {clearance_note}.",
           "objective": objective.value,
           "objective_rationale": _BTM_OBJECTIVE_RATIONALE[objective],
           "trade_offs": _trade_offs(winner, runner_up, objective)}


class DeploymentRequestError(ValueError):
    pass


def _generation_from_request(d: dict) -> GenerationUnit:
    from ..power.generation import default_generation_unit
    unit = default_generation_unit(str(d["id"]), str(d.get("kind", "gas_engine")),
                                   float(d["nameplate_MW"]))
    if d.get("capex_eur") is not None:
        unit.capex_eur = V(float(d["capex_eur"]), "EUR", f"{unit.id} capex", ASSUMED, band=0.3)
    if d.get("lead_time_weeks") is not None:
        unit.lead_time_weeks = V(float(d["lead_time_weeks"]), "weeks",
                                 f"{unit.id} lead time", ASSUMED, band=0.35)
    if d.get("fuel_type"):
        unit.fuel_type = str(d["fuel_type"])
    return unit


def _bess_from_request(d: dict) -> BatteryEnergyStorageSystem:
    from ..power.storage import default_bess
    unit = default_bess(str(d["id"]), power_MW=float(d["power_MW"]),
                        energy_MWh=float(d["energy_MWh"]))
    if d.get("capex_eur") is not None:
        unit.capex_eur = V(float(d["capex_eur"]), "EUR", f"{unit.id} capex", ASSUMED, band=0.3)
    if d.get("lead_time_weeks") is not None:
        unit.lead_time_weeks = V(float(d["lead_time_weeks"]), "weeks",
                                 f"{unit.id} lead time", ASSUMED, band=0.35)
    if d.get("grid_forming") is not None:
        unit.grid_forming = bool(d["grid_forming"])
    return unit


def _load_profile_from_request(d: dict) -> LoadProfile:
    from ..power.load_profile import flat, from_csv
    if d.get("csv"):
        return from_csv(str(d["csv"]), source=str(d.get("source") or "uploaded CSV"))
    if d.get("flat_kW") is not None:
        return flat(float(d["flat_kW"]), hours=float(d.get("flat_hours", 24.0)))
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
        grid_firm_MW = V(float(doc["grid_firm_MW"]), "MW", "grid firm capacity", ASSUMED)
        target_MW = V(float(doc["target_MW"]), "MW", "target firm power", ASSUMED)
        generation = [_generation_from_request(g) for g in doc.get("generation", [])]
        bess = [_bess_from_request(b) for b in doc.get("bess", [])]
    except KeyError as exc:
        raise DeploymentRequestError(f"missing required field: {exc}") from exc
    ride_through_hours = (V(float(doc["ride_through_hours"]), "h", "ride-through window", ASSUMED)
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
    ride = ride_through_hours if ride_through_hours is not None else V(
        2.0, "h", "ride-through window (undeclared default)", ASSUMED)

    gap_MW = max(target_MW.value - grid_firm_MW.value, 0.0)
    architectures = candidate_architectures(generation, bess)
    assessments = [
        assess_architecture(c, grid_firm_MW=grid_firm_MW, critical_load_MW=critical,
                            ride_through_hours=ride, redundancy=redundancy,
                            interconnection=interconnection, permitting=permitting)
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
            "warnings": report.warnings,
            "usable": report.usable,
        },
        "capacity": {
            "target_MW": round(target_MW.value, 3),
            "grid_firm_MW": round(grid_firm_MW.value, 3),
            "gap_MW": round(gap_MW, 3),
            "critical_load_MW": round(critical.value, 3),
            "ride_through_hours": round(ride.value, 3),
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
        "next_action": _next_action(report, assessments, gap_MW, objective),
    }
