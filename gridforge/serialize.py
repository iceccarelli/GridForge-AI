"""Machine-readable model pack.

The deliverable a customer keeps, and the artefact that makes project N+1 cheap:
inputs, scenarios, results, ladder, schedule, economics and the provenance of every
headline number, as one JSON file. It is also the only honest way to let a customer
re-run our conclusion when their inputs change.
"""
from __future__ import annotations

import json
from datetime import date
from typing import Any

from .envelope.time_to_power import schedule
from .intake.loader import Intake
from .scenario.run import ScenarioResult
from .validation import Quantity

SCHEMA_VERSION = "gridforge/model-pack/1"


def _q(q: Quantity | None) -> dict | None:
    if q is None:
        return None
    lo, hi = q.band
    return {"value": q.rounded(), "low": lo, "high": hi, "unit": q.unit,
            "evidence": q.evidence.name, "label": q.prov.label,
            "model": f"{q.prov.model_id}@{q.prov.model_version}", "digest": q.prov.digest}


def _constraint(c) -> dict:
    return {"id": c.id, "domain": c.domain, "name": c.name, "gate": c.gate,
            "racks_permitted": None if c.racks == float("inf") else int(c.racks),
            "basis": c.basis,
            "relief": None if c.relief is None else {
                "description": c.relief.description,
                "capex_eur": _q(c.relief.capex_eur),
                "lead_time_weeks": _q(c.relief.lead_time_weeks),
                "risk": c.relief.risk,
            }}


def scenario_dict(res: ScenarioResult) -> dict:
    t = schedule(res.ladder)
    return {
        "id": res.spec.id,
        "name": res.spec.name,
        "architecture": res.envelope.architecture,
        "rationale": res.spec.rationale,
        "as_found": {"racks": res.envelope.max_racks,
                     "binding": res.envelope.binding.id,
                     "binding_name": res.envelope.binding.name,
                     "basis": res.envelope.binding.basis},
        "after_ladder": {"racks": res.unlocked_racks,
                         "binding": res.ladder.final.binding.id if res.ladder.final else None,
                         "it_load_kW": _q(res.ladder.final.it_load_kW if res.ladder.final
                                          else res.envelope.it_load_kW),
                         "gpus": res.ladder.final.gpus if res.ladder.final else res.envelope.gpus},
        "ladder": [{"step": s.step, "constraint": s.binding_id, "name": s.binding_name,
                    "domain": s.domain, "racks_before": s.racks_before,
                    "racks_after": s.racks_after, "taken": s.taken,
                    "relief": s.relief_description,
                    "capex_eur": _q(s.capex_eur), "lead_time_weeks": _q(s.lead_time_weeks),
                    "risk": s.risk}
                   for s in res.ladder.steps],
        "time_to_power": {"weeks_to_first_rack": t.weeks_to_first_rack,
                          "weeks_to_full": t.weeks_to_full,
                          "sets_the_date": t.critical_item,
                          "curve": [{"weeks": p.weeks, "racks": p.racks,
                                     "unlocked_by": p.unlocked_by} for p in t.points]},
        "economics": {"capex_total_eur": _q(res.economics.capex_total_eur),
                      "capex_per_kW_it": _q(res.economics.capex_eur_per_kW_it),
                      "annual_energy_cost_eur": _q(res.economics.annual_energy_cost_eur),
                      "energy_cost_per_gpu_hour_eur": _q(res.economics.energy_cost_per_gpu_hour_eur),
                      "critical_path_weeks": res.economics.critical_path_weeks,
                      "basis": res.economics.aace_class},
        "constraints": [_constraint(c) for c in res.envelope.sorted_constraints()],
    }


def model_pack(intake: Intake, results: list[ScenarioResult],
               sensitivities: list[tuple[str, int]] | None = None) -> dict[str, Any]:
    return {
        "schema": SCHEMA_VERSION,
        "generated": date.today().isoformat(),
        "project": intake.project,
        "intake": {
            "document": intake.document,
            "completeness": round(intake.report.completeness, 3),
            "can_issue": intake.report.can_issue,
            "supplied": sorted(set(intake.report.supplied)),
            "gaps": [{"path": g.path, "label": g.label, "unit": g.unit, "required": g.required,
                      "assumed": g.fallback_description, "why_it_binds": g.why_it_binds,
                      "how_to_get_it": g.how_to_get_it} for g in intake.report.gaps],
            "warnings": intake.report.warnings,
            "engagement_recommendation": intake.report.engagement_recommendation,
        },
        "scenarios": [scenario_dict(r) for r in results],
        "sensitivity": [{"input": k, "racks": v} for k, v in (sensitivities or [])],
        "disclaimer": (
            "Every quantity carries an evidence class. Nothing in this pack is a measurement of "
            "a physical asset unless labelled E5 or above. Modelled values are what the stated "
            "inputs imply, not what the site has been observed to do."
        ),
    }


def write_model_pack(path, intake: Intake, results: list[ScenarioResult],
                     sensitivities: list[tuple[str, int]] | None = None) -> None:
    from pathlib import Path
    Path(path).write_text(json.dumps(model_pack(intake, results, sensitivities), indent=2))
