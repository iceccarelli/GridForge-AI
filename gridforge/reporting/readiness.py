"""The Power Readiness Case — one object answering the buyer's real question.

Not "what MW does this site have," which every parcel-intelligence and grid-data
vendor already answers, and answers well. The question that stays unanswered once
a site clears that first filter is: what is the fastest DEFENSIBLE path from here
to the capacity a customer actually needs, what does each step of relief cost,
what does it do to the schedule, and what evidence backs the answer.

    REQUIRED CAPACITY
    -> CURRENT DEPLOYABLE CAPACITY
    -> BINDING CONSTRAINT
    -> RELIEF OPTIONS (the Headroom Ladder, priced and dated)
    -> TIME TO POWER (what sets the date, and why)
    -> EVIDENCE STRENGTH (never claim more than the inputs support)
    -> NEXT ACTION

This module computes none of the physics. It reads an already-solved
ScenarioResult (envelope + headroom ladder + economics, from `gridforge.scenario`)
and composes it with the existing procurement, time-to-power and calibration
modules into the shape a buyer, a lender, or an agent actually needs. Duplicating
any of those calculations here would be the exact "fact in two places" failure
this codebase spends its test suite guarding against.
"""
from __future__ import annotations

from ..calibration import accuracy_block, constraint_key
from ..envelope.time_to_power import schedule
from ..intake.loader import Intake
from ..procurement import relief_steps
from ..scenario.run import ScenarioResult
from ..validation import Quantity
from .study import Objective, _pick_recommended


def _q(q: Quantity | None) -> dict | None:
    """A `Quantity` as a machine-readable dict, with its evidence class attached.

    Duplicates `serialize._q` rather than importing it: `tests/test_architecture.py`
    forbids `reporting` from depending on `serialize` (they are siblings, both
    consumed by `api` and `cli`), and this function is six lines against a rule the
    test suite enforces on purpose. If it drifts from `serialize._q`, fix both —
    they must always describe a Quantity identically."""
    if q is None:
        return None
    lo, hi = q.band
    return {"value": q.rounded(), "low": lo, "high": hi, "unit": q.unit,
            "evidence": q.evidence.name, "label": q.prov.label,
            "model": f"{q.prov.model_id}@{q.prov.model_version}", "digest": q.prov.digest}


def _relief_option(step) -> dict:
    return {
        "id": f"R{step.step}",
        "binding_constraint": step.binding_id,
        "binding_name": step.binding_name,
        "domain": step.domain,
        "description": step.relief_description,
        "basis": step.basis,
        "racks_before": step.racks_before,
        "racks_after": step.racks_after,
        "racks_gained": step.racks_unlocked,
        "capex_eur": _q(step.capex_eur),
        "lead_time_weeks": _q(step.lead_time_weeks),
        "risk": step.risk,
        # A rung can exist on paper (`taken=False`) with no capital relief behind
        # it (`cost_key` in (None, "", "not-capital")) — an architecture change or
        # a client-supplied fact, not something procurement can go and buy.
        "purchasable": bool(step.taken and step.cost_key not in (None, "", "not-capital")),
        "cost_key": step.cost_key,
    }


def _weakest_evidence(relief: list[dict]) -> list[str]:
    seen = set()
    for r in relief:
        for field in ("capex_eur", "lead_time_weeks"):
            q = r.get(field)
            if q:
                seen.add(q["evidence"])
    return sorted(seen)


def _dependencies(steps) -> list[dict]:
    """The distinct items on the critical path, longest lead time first.

    `HeadroomLadder.steps` can name the same constraint more than once across
    the scenarios it explores — that is correct for `time_to_power.schedule()`,
    which walks the taken steps in order to build the energisation curve, but a
    buyer asking "what am I waiting on" wants a short, distinct list, not the
    same transformer procurement item repeated for every architecture branch
    that happens to share it.
    """
    seen: dict[str, dict] = {}
    for s in steps:
        if not s.taken or s.lead_time_weeks is None:
            continue
        prev = seen.get(s.binding_name)
        if prev is None or s.lead_time_weeks.value > prev["lead_time_weeks"]["value"]:
            seen[s.binding_name] = {"step": s.binding_name, "lead_time_weeks": _q(s.lead_time_weeks)}
    return sorted(seen.values(), key=lambda d: -d["lead_time_weeks"]["value"])


def _next_action(intake: Intake, relief: list[dict]) -> dict:
    """One deterministic recommendation, never an invented one.

    Ordered by what actually blocks a defensible answer: an intake gap means the
    model is running on library defaults for something the client already knows;
    a top relief option still priced at E0/E1 means the number on the page is not
    yet something procurement can act on; otherwise the answer is real enough to
    act on and the next step is the purchase itself.
    """
    gaps = intake.report.required_gaps
    if gaps:
        g = gaps[0]
        return {
            "action": f"Close the data gap: {g.label}",
            "why": g.why_it_binds,
            "how": g.how_to_get_it,
        }
    purchasable = [r for r in relief if r["purchasable"]]
    if not purchasable:
        return {
            "action": "No purchasable relief identified in the current headroom ladder.",
            "why": ("Either the site meets the target platform as found, or every binding "
                    "constraint on the ladder has no capital relief modelled yet."),
            "how": "Escalate to a named engineering review before committing capital.",
        }
    top = purchasable[0]
    weak = {"E0_ASSUMPTION", "E1_MODELLED"}
    top_evidence = {q["evidence"] for q in (top["capex_eur"], top["lead_time_weeks"]) if q}
    label = top["description"] or top["binding_name"]
    if top_evidence & weak:
        return {
            "action": f"Obtain a budgetary or firm quote for: {label}",
            "why": ("This is the leading relief option, and its cost and/or lead time are "
                    "still a library default, not a price. A quote is what moves it from "
                    "modelled to actionable, and upgrades the cost library for every future "
                    "case that touches this constraint."),
            "how": "Run a Procurement Specification against this constraint "
                   f"({top['binding_constraint']}).",
        }
    return {
        "action": f"Proceed to procurement for: {label}",
        "why": "This is the constraint that sets the earliest credible energisation date; "
               "relieving it first is what actually moves the schedule.",
        "how": "Issue the technical specification and compare bids on capacity and date, "
               "not price alone.",
    }


def assess(intake: Intake, results: list[ScenarioResult], *,
           objective: Objective = Objective.MAX_COMPUTE,
           target_racks: int | None = None) -> dict:
    """Compose one Power Readiness Case from an already-solved scenario set.

    `target_racks` is optional: a customer with a named requirement ("we need
    2,000 racks of this platform") gets a gap computed against it; without one,
    the gap is reported against what the headroom ladder itself can reach, which
    is the most the site can be pushed to on the inputs given.
    """
    rec = _pick_recommended(results, objective)
    t = schedule(rec.ladder)
    steps = relief_steps(rec)
    relief = [_relief_option(s) for s in steps]
    plat = intake.context.cluster.platform

    current = rec.envelope.max_racks
    ladder_ceiling = rec.unlocked_racks
    target = target_racks if target_racks is not None else ladder_ceiling
    gap = max(target - current, 0)

    bound_ids = sorted({r.envelope.binding.id for r in results})
    keys = [constraint_key(b) for b in bound_ids] + ["envelope.racks", "envelope.it_load_kW"]

    return {
        "project": intake.project,
        "objective": objective.value,
        "platform": {"id": plat.id, "name": plat.name, "rack_kW": _q(plat.rack_kW)},
        "capacity": {
            "target_racks": target,
            "current_deployable_racks": current,
            "racks_after_full_headroom_ladder": ladder_ceiling,
            "gap_racks": gap,
            "current_deployable_MW": round(current * plat.rack_kW.value / 1000, 3),
            "requested_target_given": target_racks is not None,
        },
        "binding_constraint": {
            "id": rec.envelope.binding.id,
            "name": rec.envelope.binding.name,
            "domain": rec.envelope.binding.domain,
            "basis": rec.envelope.binding.basis,
        },
        "headroom_ladder": relief,
        "time_to_power": {
            "weeks_to_first_rack": t.weeks_to_first_rack,
            "weeks_to_full": t.weeks_to_full,
            "critical_item": t.critical_item,
            "critical_path_weeks": t.critical_weeks,
            "dependencies": _dependencies(steps),
        },
        "evidence": {
            "calibration": accuracy_block(keys),
            "evidence_classes_in_headroom_ladder": _weakest_evidence(relief),
            "disclosure": (
                "Every figure above is modelled or a library default unless its own "
                "evidence class says otherwise. E0/E1 relief costs and lead times are not "
                "prices or commitments. See 'calibration' for how far this engine has been "
                "reconciled against measured outcomes — today, on most constraints, not at "
                "all, and this case says so rather than implying otherwise."
            ),
        },
        "next_action": _next_action(intake, relief),
        "intake": {
            "completeness": round(intake.report.completeness, 3),
            "can_issue_a_study": intake.report.can_issue,
            "required_gaps": len(intake.report.required_gaps),
        },
    }
