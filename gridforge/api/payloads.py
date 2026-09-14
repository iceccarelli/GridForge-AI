"""Response shapes. One place, so the website and a client integration cannot drift."""
from __future__ import annotations

from ..calibration import accuracy_block, constraint_key
from ..envelope.time_to_power import schedule
from ..intake.loader import Intake
from ..reporting.study import Objective, _pick_recommended
from ..scenario.run import ScenarioResult
from ..serialize import _q, scenario_dict
from .tiers import PUBLIC_NOTICE, Tier, redact


def calibration_block(results: list[ScenarioResult]) -> dict:
    """How far this engine has been reconciled against site data, on every payload.

    On every payload, including the free one, including when the answer is "not at
    all". A consumer that is a machine cannot read a footnote; if the accuracy
    record is not a field, it does not exist as far as an agent is concerned, and
    an E0 figure will be written into someone's model as though it were surveyed.
    """
    bound = sorted({r.envelope.binding.id for r in results})
    keys = [constraint_key(b) for b in bound] + ["envelope.racks", "envelope.it_load_kW"]
    return accuracy_block(keys)


def _gap_list(intake: Intake) -> list[dict]:
    return [{"input": g.label, "unit": g.unit, "required": g.required,
             "assumed": g.fallback_description, "why_it_binds": g.why_it_binds,
             "how_to_get_it": g.how_to_get_it} for g in intake.report.gaps]


def qualify_payload(intake: Intake, results: list[ScenarioResult],
                    objective: Objective = Objective.MAX_COMPUTE) -> dict:
    """The website qualifier. Real engineering, no priced content."""
    rec = _pick_recommended(results, objective)
    t = schedule(rec.ladder)
    plat = intake.context.cluster.platform
    return {
        "platform": {"id": plat.id, "name": plat.name,
                     "rack_kW": _q(plat.rack_kW), "gpus_per_rack": plat.gpus_per_rack},
        "as_found": {
            "racks": rec.envelope.max_racks,
            "it_load_kW": _q(rec.envelope.it_load_kW),
            "binding_constraint": rec.envelope.binding.name,
            "domain": rec.envelope.binding.domain,
            "basis": rec.envelope.binding.basis,
        },
        "after_relief": {
            "racks": rec.unlocked_racks,
            "architecture": rec.spec.name,
            "then_binds_on": rec.ladder.final.binding.name if rec.ladder.final else None,
            "sets_the_date": t.critical_item,
        },
        "first_three_constraints": [
            {"name": s.binding_name, "domain": s.domain, "relief": s.relief_description}
            for s in rec.ladder.steps[:3]
        ],
        "intake": {
            "completeness": round(intake.report.completeness, 3),
            "required_inputs_missing": len(intake.report.required_gaps),
            "can_issue_a_study": intake.report.can_issue,
            "gaps": _gap_list(intake),
            "warnings": intake.report.warnings,
            "recommended_engagement": intake.report.engagement_recommendation,
        },
        "calibration": calibration_block(results),
        "notice": PUBLIC_NOTICE,
    }


def screen_payload(intake: Intake, results: list[ScenarioResult],
                   objective: Objective = Objective.MAX_COMPUTE, *,
                   tier: Tier = Tier.CLIENT) -> dict:
    rec = _pick_recommended(results, objective)
    body = {
        "project": intake.project,
        "objective": objective.value,
        "recommended": rec.spec.id,
        "scenarios": [scenario_dict(r) for r in results],
        "intake": {"completeness": round(intake.report.completeness, 3),
                   "can_issue_a_study": intake.report.can_issue,
                   "gaps": _gap_list(intake),
                   "warnings": intake.report.warnings,
                   "recommended_engagement": intake.report.engagement_recommendation},
        "calibration": calibration_block(results),
    }
    return redact(body, tier)
