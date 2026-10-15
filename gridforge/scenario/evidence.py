"""What accepted cost evidence changed in a result.

A run that uses accepted supplier evidence must say which evidence it used and what that did to the answer. The
comparison is a second run of the SAME physics against the library without the evidence: nothing about racks, schedule
or constraints can differ, so every difference is a difference in cost, completeness or evidence class. Neither run
mutates anything the other reads.
"""
from __future__ import annotations

from ..costs import cost_overlay, without_overlay
from .run import run_all


def _row(r) -> dict:
    e = r.economics
    return {"capex_eur": e.capex_total_eur.value, "capex_complete": e.capex_complete,
            "decision_grade": e.decision_grade, "unpriced": len(e.unpriced),
            "rests_on_placeholders": e.rests_on_placeholders, "limited_lines": len(e.limited),
            "evidence_class": e.capex_total_eur.evidence.name, "racks": r.unlocked_racks,
            "steps": {s.step: {"constraint": s.binding_id, "capex_eur": s.capex_eur.value if s.capex_eur else None,
                               "basis": s.cost_basis, "kind": s.cost_kind} for s in r.ladder.taken_steps}}


def evidence_effect(context, specs, entries) -> dict:
    """Per scenario: before (no evidence) and after (the accepted evidence), and which ladder steps changed price."""
    with without_overlay():
        before = {r.spec.id: _row(r) for r in run_all(context, specs)}
    with cost_overlay(entries) as report:
        after = {r.spec.id: _row(r) for r in run_all(context, specs)}
    out = []
    for sid, b in before.items():
        a = after[sid]
        changed = []
        for n, sb in b["steps"].items():
            sa = a["steps"].get(n)
            if sa and (sa["capex_eur"] != sb["capex_eur"] or sa["basis"] != sb["basis"] or sa["kind"] != sb["kind"]):
                changed.append({"step": n, "constraint": sb["constraint"], "capex_before_eur": sb["capex_eur"],
                                "capex_after_eur": sa["capex_eur"], "basis_before": sb["basis"],
                                "basis_after": sa["basis"], "price_kind_after": sa["kind"]})
        out.append({
            "scenario": sid, "racks_before": b["racks"], "racks_after": a["racks"],
            "capex_before_eur": b["capex_eur"], "capex_after_eur": a["capex_eur"],
            "capex_delta_eur": a["capex_eur"] - b["capex_eur"],
            "capex_complete_before": b["capex_complete"], "capex_complete_after": a["capex_complete"],
            "decision_grade_before": b["decision_grade"], "decision_grade_after": a["decision_grade"],
            "unpriced_before": b["unpriced"], "unpriced_after": a["unpriced"],
            "placeholder_lines_before": b["rests_on_placeholders"], "placeholder_lines_after": a["rests_on_placeholders"],
            "limited_lines_after": a["limited_lines"], "steps_changed": changed})
    return {"scenarios": out, "used": [e.evidence_id or e.key for e in report.used]}
