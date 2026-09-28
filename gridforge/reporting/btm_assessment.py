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
from ..power.reliability import ContingencyCase, ContingencyStatus, Redundancy, evaluate
from ..power.storage import BatteryEnergyStorageSystem
from ..validation import Quantity


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

    @property
    def buildable(self) -> bool:
        """Technically sound AND commercially describable. A PASS with an
        unpriced generator is not yet a comparable option — it is an engineering
        answer waiting on a quote, and the ranking below must not silently treat
        'unpriced' as 'free'."""
        return (self.contingency.status == ContingencyStatus.PASS
                and self.capex_eur is not None)


def assess_architecture(candidate: ArchitectureCandidate, *, grid_firm_MW: Quantity,
                        critical_load_MW: Quantity, ride_through_hours: Quantity,
                        redundancy: Redundancy) -> ArchitectureAssessment:
    case = ContingencyCase(critical_load_MW=critical_load_MW, grid_firm_MW=grid_firm_MW,
                           generation=candidate.generation, bess=candidate.bess,
                           ride_through_hours=ride_through_hours, redundancy=redundancy)
    result = evaluate(case)
    capex, uncosted = _total_capex(candidate.generation + candidate.bess)
    lead_time, undated = _critical_path_weeks(candidate.generation + candidate.bess)
    return ArchitectureAssessment(candidate.label, result, capex, uncosted, lead_time, undated)


def _next_action(load_profile_report, assessments: list[ArchitectureAssessment],
                 gap_MW: float) -> dict:
    """One deterministic recommendation, in priority order: fix the data before
    trusting any comparison; then close a missing quote before ranking; then, if
    everything needed to compare is present, point at the winner or say plainly
    that nothing declared clears the bar."""
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
    winner = min((a for a in passing if a.buildable), key=lambda a: a.capex_eur.value)
    return {"action": f"Proceed to procurement for: {winner.label}",
           "why": "The cheapest architecture that passes its own declared contingency test, "
                  "among those with every unit costed."}


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
    return dict(load_profile=load_profile, grid_firm_MW=grid_firm_MW, generation=generation,
               bess=bess, target_MW=target_MW, ride_through_hours=ride_through_hours,
               redundancy=redundancy)


def assess_deployment(*, load_profile: LoadProfile, grid_firm_MW: Quantity,
                      generation: list[GenerationUnit],
                      bess: list[BatteryEnergyStorageSystem],
                      target_MW: Quantity, ride_through_hours: Quantity | None = None,
                      redundancy: Redundancy = Redundancy.N,
                      critical_load_MW: Quantity | None = None) -> dict:
    """The Power Deployment Assessment: current grid-only capacity vs. target,
    every declared hybrid architecture compared under the same contingency test,
    and one next action. `critical_load_MW` defaults to the load profile's own
    peak — the load a real contingency test has to survive, not its average."""
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
                            ride_through_hours=ride, redundancy=redundancy)
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
            }
            for a in assessments
        ],
        "next_action": _next_action(report, assessments, gap_MW),
    }
