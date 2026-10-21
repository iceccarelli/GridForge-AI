"""Machine-readable model pack.

The deliverable a customer keeps, and the artefact that makes project N+1 cheap:
inputs, scenarios, results, ladder, schedule, economics and the provenance of every
headline number, as one JSON file. It is also the only honest way to let a customer
re-run our conclusion when their inputs change.
"""
from __future__ import annotations

import csv
import io
import json
from typing import Any

from .clock import report_date_iso
from .costs import active_evidence

from .envelope.time_to_power import date_basis, schedule
from .intake.loader import Intake
from .scenario.run import ScenarioResult
from .validation import Quantity

SCHEMA_VERSION = "gridforge/model-pack/2"


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


def economics_dict(res: ScenarioResult) -> dict:
    """The economics of one scenario as data: every total, what it is made of, what is missing, and whether it is
    decision-grade. One function, so the model pack, the API and the reports cannot tell different stories."""
    from .costs import BASIS_LABEL
    e = res.economics
    btm = e.btm
    return {
        # A hall that can carry nothing has no capex to quote: null with the reason, never 0 EUR.
        "capex_total_eur": None if e.nothing_deployable else _q(e.capex_total_eur),
        "capex_na_reason": "n/a: nothing deployable" if e.nothing_deployable else None,
        "capex_per_kW_it": None if e.nothing_deployable else _q(e.capex_eur_per_kW_it),
        "capex_components": {
            "relief_works_eur": _q(e.capex_relief_eur),
            "in_hall_conversion_eur": _q(e.capex_conversion_eur),
            "initial_cdu_kit_eur": _q(e.capex_cdu_kit_eur),
            "initial_cdu_kit_scope": e.cdu_kit_scope or None,
        },
        "capex_complete": e.capex_complete,
        "unpriced_components": [dict(u) for u in e.unpriced],
        "cost_basis_mix": {k: {"lines": v, "label": BASIS_LABEL.get(k, k)}
                           for k, v in sorted((e.cost_basis_mix or {}).items())},
        "annual_energy_cost_eur": _q(e.annual_energy_cost_eur),
        "annual_grid_energy_cost_eur": _q(e.annual_grid_energy_cost_eur),
        "energy_cost_per_gpu_hour_eur": _q(e.energy_cost_per_gpu_hour_eur),
        "grid_tariff": {"eur_per_MWh": _q(e.tariff_eur_per_MWh), "declared_by_client": e.tariff_declared},
        "btm_operating_cost": None if btm is None else {
            "applied": btm.applied, "missing": list(btm.missing), "options": btm.options,
            "generated_MWh": _q(btm.generated_MWh), "used_on_site_MWh": _q(btm.used_MWh),
            "variable_eur_per_year": _q(btm.variable_eur), "fixed_eur_per_year": _q(btm.fixed_eur),
            "generation_above_site_demand_is_not_valued": btm.curtailed},
        "opex_complete": e.opex_complete,
        "lifecycle": None if e.horizon_years is None else {
            "horizon_years": e.horizon_years, "discount_rate": e.discount_rate,
            "cost_eur": _q(e.lifecycle_cost_eur), "complete": e.lifecycle_complete, "basis": e.lifecycle_basis},
        "critical_path_weeks": e.critical_path_weeks if e.critical_path_complete else None,
        "critical_path_complete": e.critical_path_complete,
        **date_basis(res.ladder).to_dict(),
        "basis": e.aace_class,
        "decision_grade": e.decision_grade,
        "limitations": e.limitations,
    }


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
                    "risk": s.risk, "cost_key": s.cost_key, "cost_kind": s.cost_kind or None,
                    "scope": s.scope or None, "cost_basis": s.cost_basis or None,
                    "unpriced_components": [{"key": k, "component": w, "unit": u, "quantity": q}
                                            for k, w, u, q in s.unpriced],
                    "basis_note": s.basis_note or None, "not_taken_reason": s.not_taken_reason or None}
                   for s in res.ladder.steps],
        "time_to_power": {"weeks_to_first_rack": t.weeks_to_first_rack,
                          "weeks_to_full": t.weeks_to_full,
                          "schedule_complete": t.complete,
                          "sets_the_date": t.critical_item,
                          **date_basis(res.ladder, t).to_dict(),
                          "curve": [{"weeks": p.weeks, "racks": p.racks,
                                     "unlocked_by": p.unlocked_by} for p in t.points]},
        "economics": economics_dict(res),
        "constraints": [_constraint(c) for c in res.envelope.sorted_constraints()],
    }


def model_pack(intake: Intake, results: list[ScenarioResult],
               sensitivities: list[tuple[str, int]] | None = None) -> dict[str, Any]:
    return {
        "schema": SCHEMA_VERSION,
        "generated": report_date_iso(),
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
        # Which accepted supplier evidence this run used (and which it refused to use), and what it changed. Explicit
        # when empty: a model pack that is silent about evidence has not said there was none.
        "cost_evidence": active_evidence() or {"used": [], "ignored": [], "effect": None},
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


# --- the working files -------------------------------------------------------
#
# An engineer who is about to spend eight figures on the back of a document will
# want to check its arithmetic, and they will want to do that in a spreadsheet
# rather than in our JSON. Handing over the working files is the whole
# differentiation: a study you cannot check is a study you have to take on trust,
# and nobody sensible does that with a capital decision.
#
# Standard library only — no spreadsheet dependency reaches the engine. CSV opens
# in Excel, LibreOffice, pandas and a text editor, which is more than can be said
# for a .xlsx.

def _csv(header: list[str], rows: list[list[Any]]) -> str:
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\n")
    w.writerow(header)
    w.writerows(rows)
    return buf.getvalue()


def _q_cells(q) -> list[Any]:
    if q is None:
        return ["", "", "", "", "", "", ""]
    lo, hi = q.band
    return [q.rounded(), lo, hi, q.unit, q.evidence.name, q.prov.label, q.prov.digest]


_Q_HEAD = ["value", "low", "high", "unit", "evidence", "label", "provenance"]


def csv_bundle(intake: Intake, results: list[ScenarioResult]) -> dict[str, str]:
    """Every table behind the study, as files a client's own engineer can open."""
    from .change import flatten
    from .envelope.time_to_power import date_basis, schedule

    out: dict[str, str] = {}

    rows = []
    for r in results:
        t = schedule(r.ladder)
        final = r.ladder.final or r.envelope
        rows.append([
            r.spec.id, r.spec.name, r.envelope.architecture,
            r.envelope.max_racks, r.unlocked_racks,
            r.envelope.binding.id, r.envelope.binding.name,
            final.gpus, t.weeks_to_full if t.weeks_to_full is not None else "",
            t.critical_item, date_basis(r.ladder, t).basis, date_basis(r.ladder, t).evidence_class or "",
            *_q_cells(final.it_load_kW),
            *_q_cells(r.economics.capex_total_eur),
            r.economics.aace_class,
            r.economics.capex_complete, r.economics.opex_complete, r.economics.decision_grade,
        ])
    out["scenarios.csv"] = _csv(
        ["scenario_id", "scenario", "architecture", "racks_as_found", "racks_after_ladder",
         "binds_first_id", "binds_first", "gpus", "weeks_to_full", "sets_the_date", "date_basis",
         "date_evidence_class",
         *[f"it_load_kW.{h}" for h in _Q_HEAD], *[f"capex_eur.{h}" for h in _Q_HEAD],
         "accuracy_class", "capex_complete", "opex_complete", "decision_grade"], rows)

    # The economics, component by component, each with its unit and evidence class, so a client's analyst can
    # re-add the total, and every missing component named on its own row.
    rows, miss = [], []
    for r in results:
        e = r.economics
        lines = [("capex: in-hall conversion", e.capex_conversion_eur),
                 ("capex: relief works along the ladder", e.capex_relief_eur),
                 ("capex: initial CDU kit (assumed, not installed)", e.capex_cdu_kit_eur),
                 ("capex: total", e.capex_total_eur),
                 ("annual: grid energy cost", e.annual_grid_energy_cost_eur),
                 ("annual: BTM variable operating cost", e.btm.variable_eur if e.btm else None),
                 ("annual: BTM fixed O&M", e.btm.fixed_eur if e.btm else None),
                 ("annual: total energy cost", e.annual_energy_cost_eur),
                 (f"lifecycle over {e.horizon_years} years" if e.horizon_years else "lifecycle (no horizon declared)",
                  e.lifecycle_cost_eur)]
        for name, q in lines:
            if q is None:
                continue
            rows.append([r.spec.id, name, *_q_cells(q)])
        rows.append([r.spec.id, "capex complete", e.capex_complete, "", "", "", "", "", ""])
        rows.append([r.spec.id, "operating cost complete", e.opex_complete, "", "", "", "", "", ""])
        rows.append([r.spec.id, "decision grade", e.decision_grade, "", "", "", "", "", ""])
        for u in e.unpriced:
            miss.append([r.spec.id, u["where"], u["component"], u["key"], u["unit"], u["scope"],
                         "no library price: the capex total excludes this component"])
        if e.btm is not None and not e.btm.applied:
            for m in e.btm.missing:
                miss.append([r.spec.id, "behind-the-meter operating cost", m, "", "", "",
                             "not applied: the energy cost prices all energy at the grid tariff"])
    out["economics.csv"] = _csv(["scenario_id", "item", *_Q_HEAD], rows)
    out["unpriced_components.csv"] = _csv(
        ["scenario_id", "where", "missing", "library_key", "unit", "scope", "consequence"], miss)

    rows = []
    for r in results:
        for st in r.ladder.steps:
            rows.append([
                r.spec.id, st.step, st.binding_id, st.binding_name, st.domain,
                st.racks_before, st.racks_after, st.taken,
                st.relief_description or "", st.cost_key or "", st.risk or "",
                st.cost_kind, st.scope, st.cost_basis,
                "; ".join(w for _k, w, _u, _q in st.unpriced), st.not_taken_reason,
                *_q_cells(st.capex_eur), *_q_cells(st.lead_time_weeks),
            ])
    out["headroom_ladder.csv"] = _csv(
        ["scenario_id", "step", "constraint_id", "constraint", "domain", "racks_before",
         "racks_after", "relief_taken", "relief", "cost_library_key", "risk",
         "cost_kind", "scope", "cost_basis", "unpriced_components", "not_taken_reason",
         *[f"capex.{h}" for h in _Q_HEAD], *[f"lead_time_weeks.{h}" for h in _Q_HEAD]], rows)

    rows = []
    inf = float("inf")
    for r in results:
        for c in r.envelope.sorted_constraints():
            rows.append([
                r.spec.id, c.id, c.name, c.domain, "gate" if c.gate else "capacity",
                c.id == r.envelope.binding.id,
                "" if c.racks == inf else int(c.racks), c.basis,
                c.relief.description if c.relief else "",
                *_q_cells(c.max_racks if c.max_racks.value != inf else None),
            ])
    # 'binds' is stated rather than left to be inferred from the minimum: a reader
    # scanning this file should not have to reconstruct the argmin to find the
    # one constraint the whole answer turns on.
    out["constraints.csv"] = _csv(
        ["scenario_id", "constraint_id", "constraint", "domain", "type", "binds",
         "racks_permitted", "basis", "relief", *[f"racks.{h}" for h in _Q_HEAD]], rows)

    # Which side of the line each input sits on is the single most important thing
    # about it. A study that blends client measurements with our fill-ins into one
    # undifferentiated table is exactly the document this business must not produce.
    assumed_paths = {g.path for g in intake.report.gaps}
    out["inputs.csv"] = _csv(
        ["path", "value", "source"],
        [[k, "" if v is None else v, "assumed" if k in assumed_paths else "client"]
         for k, v in sorted(flatten(intake.document).items())])

    out["assumed_inputs.csv"] = _csv(
        ["input", "unit", "required", "assumed_value", "why_it_binds", "how_to_get_it"],
        [[g.label, g.unit, g.required, g.fallback_description, g.why_it_binds, g.how_to_get_it]
         for g in intake.report.gaps])

    seen: set[str] = set()
    rows = []
    for r in results:
        for q in (r.envelope.it_load_kW, r.envelope.facility_load_kW,
                  r.economics.capex_total_eur, r.economics.capex_eur_per_kW_it,
                  r.economics.annual_energy_cost_eur):
            for node in q.prov.walk():
                if node.digest in seen:
                    continue
                seen.add(node.digest)
                rows.append([
                    node.digest, node.label, node.evidence.name,
                    f"{node.model_id}@{node.model_version}",
                    " | ".join(node.assumptions), " | ".join(str(x) for x in node.sources),
                    " ".join(p.digest for p in node.inputs),
                ])
    out["provenance.csv"] = _csv(
        ["digest", "quantity", "evidence", "model", "assumptions", "sources", "derived_from"],
        rows)

    out["README.txt"] = (
        "GridForge capacity study — working files\n"
        "=======================================\n\n"
        "These are the tables behind the document, so your own engineers can check the\n"
        "arithmetic rather than take it on trust.\n\n"
        "scenarios.csv          one row per architecture compared\n"
        "headroom_ladder.csv    every rung: what binds, what relieves it, what that costs\n"
        "constraints.csv        every constraint evaluated, not only the binding one\n"
        "inputs.csv             every input the model used, flattened, each marked\n"
        "                       'client' (it came from you) or 'assumed' (nobody\n"
        "                       supplied it, so we used a defensible default)\n"
        "assumed_inputs.csv     the ones nobody supplied, and where to get them\n"
        "economics.csv          every capex and annual cost component with its unit and evidence\n"
        "                       class, and whether the total is complete and decision-grade\n"
        "unpriced_components.csv every cost with no price at all: the totals exclude these and\n"
        "                       are therefore lower bounds, never estimates\n"
        "provenance.csv         every headline quantity traced back to its inputs\n\n"
        "Reading provenance.csv: each row is one quantity with a digest. 'derived_from'\n"
        "lists the digests it was computed from, so a number can be walked back to the\n"
        "assumptions underneath it. 'evidence' is the honest status of that number:\n"
        "E0 assumed, E1 modelled, E2 simulated, E3 estimated, E4 tested, E5 supplied by\n"
        "the client (not measured by us), E6 field-validated, E7 observed in operation. A computed number is never\n"
        "stronger than the weakest input it came from.\n\n"
        "If you find an error in here, tell us. We would rather be corrected than cited.\n"
    )
    return out


def write_csv_bundle(directory, intake: Intake, results: list[ScenarioResult]) -> list:
    from pathlib import Path
    d = Path(directory)
    d.mkdir(parents=True, exist_ok=True)
    written = []
    for name, text in csv_bundle(intake, results).items():
        p = d / name
        p.write_text(text)
        written.append(p)
    return written
