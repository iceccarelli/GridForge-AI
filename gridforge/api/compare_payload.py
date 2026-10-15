"""Time-to-Power scenario comparison: the same solved scenarios, side by side, with only the dates we can defend.

This is not a second model. It takes the results of ``run_all`` (the scenarios an intake defines) and reports, for each,
the capacity, the binding constraint, the date, the capital and the evidence behind them, then says how each one differs
from the baseline and ranks them under an explicit objective.

Three rules separate it from the older report renderers:

* A date is only ever taken from ``full_capacity_band``. ``schedule`` reads a missing lead time as zero weeks; here a
  missing lead time yields NO date and a stated reason, never a small number.
* Nothing is ranked on a figure it does not have. ``fastest`` ranks dated scenarios only; ``min_cost`` ranks scenarios
  whose capex is complete only; whatever is left out is listed with the reason. When nothing can be ranked there is no
  leader.
* The evidence class travels with the answer. A comparison whose weakest lead time is an assumption (E0) is labelled
  indicative, whatever the rack counts say.
"""
from __future__ import annotations

import hashlib
import json

from ..envelope.time_to_power import full_capacity_band, schedule, schedule_complete
from ..serialize import _q, economics_dict
from ..scenario.objective import Objective
from ..scenario.run import ScenarioResult
from ..validation import EvidenceClass

SCHEMA = "gridforge/ttp-compare/1"


class CompareError(ValueError):
    """The request cannot be answered without inventing something. The message says what to supply."""

    def __init__(self, message: str, **detail):
        super().__init__(message)
        self.detail = detail


def _cls(name: str) -> str:
    return name.split("_", 1)[0]          # "E3_ENGINEERING_ESTIMATE" -> "E3"


def request_digest(document: dict, ids: list[str], objective: Objective, baseline: str) -> str:
    """Identity of the question asked: the same inputs, scenarios, objective and baseline give the same digest."""
    canon = json.dumps({"schema": SCHEMA, "intake": document, "scenarios": ids,
                        "objective": objective.value, "baseline": baseline},
                       sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(canon.encode()).hexdigest()


def select(results: list[ScenarioResult], ids: list[str] | None) -> list[ScenarioResult]:
    """The scenarios to compare, in the order the caller named them (or the intake's own order)."""
    by_id = {r.spec.id: r for r in results}
    if not ids:
        return list(results)
    unknown = [i for i in ids if i not in by_id]
    if unknown:
        raise CompareError(
            f"unknown scenario(s): {', '.join(unknown)}",
            available=list(by_id),
            hint=("full_dlc_btm needs behind-the-meter options: declare btm_options in the intake"
                  if "full_dlc_btm" in unknown else None))
    if len(set(ids)) != len(ids):
        raise CompareError("scenarios names the same scenario twice")
    return [by_id[i] for i in ids]


def _date(res: ScenarioResult) -> dict:
    t = schedule(res.ladder)
    if not t.max_racks:
        return {"status": "no_deployable_racks", "weeks": None, "low": None, "high": None, "evidence": None,
                "first_rack_weeks": None, "sets_the_date": None,
                "reason": "No rack is deployable in this scenario, so there is nothing to date."}
    if not schedule_complete(res.ladder):
        gaps = [s.binding_name for s in res.ladder.taken_steps if s.lead_time_weeks is None]
        return {"status": "lead_time_missing", "weeks": None, "low": None, "high": None, "evidence": None,
                "first_rack_weeks": None, "sets_the_date": None,
                "reason": "No defensible date: no lead time is known for " + ", ".join(gaps) + "."}
    band = full_capacity_band(res.ladder, t)
    if band is None:
        return {"status": "no_date", "weeks": None, "low": None, "high": None, "evidence": None,
                "first_rack_weeks": None, "sets_the_date": None,
                "reason": "The energisation curve never reaches the full envelope."}
    weeks, lo, hi, cls = band
    return {"status": "dated", "weeks": weeks, "low": lo, "high": hi, "evidence": _cls(cls.name),
            "first_rack_weeks": t.weeks_to_first_rack, "sets_the_date": t.critical_item, "reason": None}


def _scenario(res: ScenarioResult) -> dict:
    date = _date(res)
    taken = res.ladder.taken_steps
    lead_times = [{"constraint": s.binding_id, "name": s.binding_name, "domain": s.domain,
                   "lead_time_weeks": _q(s.lead_time_weeks), "missing": s.lead_time_weeks is None,
                   "capex_eur": _q(s.capex_eur), "cost_basis": s.cost_basis or None}
                  for s in taken]
    classes = [s.lead_time_weeks.evidence for s in taken if s.lead_time_weeks is not None]
    weakest = min(classes) if classes else None
    econ = economics_dict(res)
    missing: list[str] = []
    missing += [f"lead time: {s.binding_name}" for s in taken if s.lead_time_weeks is None]
    missing += [f"price: {u.get('component') or u.get('key')}" for u in econ["unpriced_components"]]
    final = res.ladder.final
    return {
        "id": res.spec.id,
        "name": res.spec.name,
        "architecture": res.envelope.architecture,
        "rationale": res.spec.rationale,
        "as_found": {"racks": res.envelope.max_racks, "binding": res.envelope.binding.id,
                     "binding_name": res.envelope.binding.name},
        "after_ladder": {"racks": res.unlocked_racks,
                         "binding": final.binding.id if final else None,
                         "binding_name": final.binding.name if final else None,
                         "it_load_kW": _q(final.it_load_kW if final else res.envelope.it_load_kW)},
        "time_to_power": {**date, "lead_times": lead_times},
        "economics": {"capex_total_eur": econ["capex_total_eur"], "capex_complete": econ["capex_complete"],
                      "unpriced_components": econ["unpriced_components"],
                      "cost_basis_mix": econ["cost_basis_mix"], "decision_grade": econ["decision_grade"],
                      "basis": econ["basis"], "limitations": econ["limitations"]},
        "weakest_lead_time_evidence": _cls(weakest.name) if weakest is not None else None,
        "grade": ("indicative" if weakest is None or weakest <= EvidenceClass.E0_ASSUMPTION else "screening"),
        "missing_inputs": missing,
    }


def _vs(base: dict, s: dict) -> dict:
    """How a scenario differs from the baseline -- and, where a difference needs a figure we lack, why there is none."""
    bd, sd = base["time_to_power"], s["time_to_power"]
    weeks = None if bd["weeks"] is None or sd["weeks"] is None else round(sd["weeks"] - bd["weeks"], 1)
    be, se = base["economics"], s["economics"]
    capex = None
    if be["capex_complete"] and se["capex_complete"] and be["capex_total_eur"] and se["capex_total_eur"]:
        capex = round(se["capex_total_eur"]["value"] - be["capex_total_eur"]["value"])
    racks = s["after_ladder"]["racks"] - base["after_ladder"]["racks"]
    why = []
    if s["after_ladder"]["binding_name"] != base["after_ladder"]["binding_name"]:
        why.append(f"the limit moves from {base['after_ladder']['binding_name']} "
                   f"to {s['after_ladder']['binding_name']}")
    if racks:
        why.append(f"{abs(racks)} {'more' if racks > 0 else 'fewer'} racks deployable")
    if sd["sets_the_date"] and sd["sets_the_date"] != bd["sets_the_date"]:
        why.append(f"the date is set by {sd['sets_the_date']}")
    return {"racks_delta": racks,
            "weeks_delta": weeks,
            "weeks_delta_unknown_reason": None if weeks is not None else (sd["reason"] or bd["reason"]),
            "capex_delta_eur": capex,
            "capex_delta_unknown_reason": None if capex is not None else "capex is incomplete in one of the two",
            "why": why or ["no difference in the limit, the date or the racks"]}


def _rank(rows: list[dict], objective: Objective) -> dict:
    order, excluded, sortkey = [], [], None
    if objective is Objective.FASTEST_TO_POWER:
        for r in rows:
            if r["time_to_power"]["weeks"] is None:
                excluded.append({"id": r["id"], "reason": r["time_to_power"]["reason"]})
        keyed = [(r["time_to_power"]["weeks"], -r["after_ladder"]["racks"], r) for r in rows
                 if r["time_to_power"]["weeks"] is not None]
        keyed.sort(key=lambda k: (k[0], k[1]))
        order = [k[2]["id"] for k in keyed]
        metric = {k[2]["id"]: k[0] for k in keyed}
        sortkey = {k[2]["id"]: (k[0], k[1]) for k in keyed}      # level only if racks are level too
        unit = "weeks to full capacity"
    elif objective is Objective.MIN_COST_PER_RACK:
        keyed = []
        for r in rows:
            e = r["economics"]
            if r["after_ladder"]["racks"] <= 0:
                excluded.append({"id": r["id"], "reason": "no deployable racks"})
            elif not e["capex_complete"]:
                excluded.append({"id": r["id"], "reason": "capex is incomplete; a partial cost is not ranked"})
            else:
                keyed.append((e["capex_total_eur"]["value"] / r["after_ladder"]["racks"], r))
        keyed.sort(key=lambda k: k[0])
        order = [k[1]["id"] for k in keyed]
        metric = {k[1]["id"]: round(k[0]) for k in keyed}
        unit = "EUR capex per deployable rack"
    else:
        keyed = [(r["after_ladder"]["racks"], r) for r in rows if r["after_ladder"]["racks"] > 0]
        for r in rows:
            if r["after_ladder"]["racks"] <= 0:
                excluded.append({"id": r["id"], "reason": "no deployable racks"})
        keyed.sort(key=lambda k: -k[0])
        order = [k[1]["id"] for k in keyed]
        metric = {k[1]["id"]: k[0] for k in keyed}
        unit = "deployable racks"
    key = sortkey or metric
    tie = len(order) > 1 and key[order[0]] == key[order[1]]
    return {"objective": objective.value, "metric": unit, "order": order,
            "values": {i: metric[i] for i in order}, "excluded": excluded,
            "leader": None if not order or tie else order[0],
            "tie": tie,
            "note": ("Nothing can be ranked on this objective with the inputs supplied." if not order else
                     "The top two are level; no leader is named." if tie else None)}


def compare_payload(document: dict, results: list[ScenarioResult], *, objective: Objective,
                    baseline: str | None, notes: list[str] | None = None) -> dict:
    if len(results) < 2:
        raise CompareError("a comparison needs at least two scenarios", available=[r.spec.id for r in results])
    ids = [r.spec.id for r in results]
    base_id = baseline or ids[0]
    if base_id not in ids:
        raise CompareError(f"baseline {base_id!r} is not one of the compared scenarios", available=ids)
    rows = [_scenario(r) for r in results]
    base = next(r for r in rows if r["id"] == base_id)
    for r in rows:
        r["vs_baseline"] = None if r["id"] == base_id else _vs(base, r)
    ranking = _rank(rows, objective)
    indicative = any(r["grade"] == "indicative" for r in rows)
    caveats = list(notes or [])
    if indicative:
        caveats.append("At least one date rests on an assumed lead time (E0). Treat this comparison as indicative: "
                       "it shows which inputs decide the answer, not a commitment to any date.")
    caveats.append("Grid reinforcement is not dated here: a connection date needs the network operator's offer.")
    return {
        "schema": SCHEMA,
        "objective": objective.value,
        "baseline": base_id,
        "scenarios": rows,
        "ranking": ranking,
        "grade": "indicative" if indicative else "screening",
        "caveats": caveats,
        "request_digest": request_digest(document, ids, objective, base_id),
    }
