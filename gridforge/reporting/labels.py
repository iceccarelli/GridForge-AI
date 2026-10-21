"""Honest labels for the figures a buyer reads first: rack counts, weeks, and the rungs between them.

Three rules the report layer used to break by writing ``V(x, ..., ESTIMATED)`` directly:

1. **Provenance is a min-operator** (docs/01 §6): a rack count cannot carry a higher evidence class than the
   weakest constraint it was derived from. ``V()`` is for declaring an INPUT; using it for a derived rack
   count asserted "engineering estimate" over a model whose cooling, UPS and cost inputs are library
   defaults. ``rack_class`` takes the weakest class among the constraints the scenario evaluated.
2. **A band is a derivation, not a multiplier.** Time to full capacity used ×0.7/×1.6 around the point
   value, which contradicted the lead time of the very item that sets the date (160 [80-210] weeks printed
   next to 160 [112-256]). ``elapsed_band`` takes the band from the lead times that actually bind.
3. **A rung that adds no racks must say why.** It is charged because another constraint limits the hall to
   the same figure, so it relieves one of several tied constraints; ``tests/test_study_honesty.py`` proves on
   the reference hall that dropping any such rung lowers the final answer.
"""
from __future__ import annotations

import math

from ..common import V
from ..envelope.solver import HeadroomLadder, rack_evidence
from ..envelope.time_to_power import (  # noqa: F401  (re-exported for the report modules)
    ASSUMED_DATE_LABEL, DateBasis, date_basis, date_basis_of, elapsed_bands, full_capacity_band, schedule_complete)
from ..scenario.run import ScenarioResult
from ..validation import EvidenceClass, Quantity

INF = float("inf")


def rack_class(result: ScenarioResult) -> EvidenceClass:
    """Weakest evidence class among the constraints this architecture was evaluated against."""
    classes = [rack_evidence(result.envelope)]
    if result.ladder.final is not None:
        classes.append(rack_evidence(result.ladder.final))
    return min(classes)


def racks_q(value: float, label: str, result: ScenarioResult) -> Quantity:
    """A derived rack count, labelled with the weakest class that determines it (never a higher one)."""
    return V(float(value), "racks", label, rack_class(result))


def lead_class(ladder: HeadroomLadder) -> EvidenceClass:
    classes = [s.lead_time_weeks.evidence for s in ladder.taken_steps if s.lead_time_weeks is not None]
    return min(classes) if classes else EvidenceClass.E0_ASSUMPTION


def weeks_q(weeks: float, lo: float, hi: float, cls: EvidenceClass, label: str) -> Quantity:
    return V(weeks, "weeks", label, cls, band=(lo, hi) if hi > lo else None)


def is_zero_gain(step) -> bool:
    return bool(step.taken and step.racks_after <= step.racks_before)


ZERO_GAIN_NOTE = ("adds no racks on its own: another constraint limits the hall to the same figure, "
                  "so this relieves one of several tied constraints")


def relief_text(step, *, with_note: bool = True) -> str:
    text = step.relief_description or "no relief available"
    if not step.taken:
        text += "  — NOT TAKEN: " + (step.not_taken_reason or "this relief cannot be obtained in the decision horizon")
    elif with_note and is_zero_gain(step):
        text += "  — " + ZERO_GAIN_NOTE
    return text


def full_capacity_q(ladder: HeadroomLadder, ttp, label: str) -> Quantity | None:
    """Time to full capacity, banded from the lead times that set it (None when nothing is deployable or
    a relief taken has no lead time)."""
    got = full_capacity_band(ladder, ttp)
    return None if got is None else weeks_q(got[0], got[1], got[2], got[3], label)


def date_title(base: str, db: DateBasis) -> str:
    """A heading or row label for a time figure: never the bare words "Time to full capacity" while the lead time
    behind it is an assumption."""
    return f"{base} ({ASSUMED_DATE_LABEL})" if db.assumed else base


def date_basis_text(db: DateBasis, basis: str = "") -> str:
    """The caption under a time figure: what it rests on, then whatever else the renderer says about it."""
    if db.basis == "none":
        return basis
    return f"{db.caption}" + (f" · {basis}" if basis else "")


def dominant_sensitivity(sensitivities, base: int):
    """The (label, racks) that moves the answer furthest, or None."""
    rows = [(l, n) for l, n in (sensitivities or [])]
    return max(rows, key=lambda r: abs(r[1] - base), default=None)


def critical_path_q(ladder: HeadroomLadder, label: str) -> Quantity:
    """Longest lead time over every taken rung, with the range of the rungs that reach it."""
    leads = [s.lead_time_weeks for s in ladder.taken_steps if s.lead_time_weeks is not None]
    if len(leads) < len(ladder.taken_steps):
        label += " (lower bound: a relief on the path has no lead time)"
    if not leads:
        return V(0.0, "weeks", label, EvidenceClass.E0_ASSUMPTION)
    top = max(leads, key=lambda q: q.value)
    lo, hi = max(q.band[0] for q in leads), max(q.band[1] for q in leads)
    return weeks_q(top.value, lo, hi, min(q.evidence for q in leads), label)


def capex_per_rack_q(result: ScenarioResult, label: str) -> Quantity | None:
    """Total capex over the racks it enables, banded by the division (None when no rack is deployable: the
    figure is undefined, not capex divided by a made-up single rack)."""
    capex = result.economics.capex_total_eur
    if result.unlocked_racks <= 0 or not math.isfinite(capex.value):
        return None
    n = V(float(result.unlocked_racks), "racks", f"{label}: racks enabled", rack_class(result))
    return (capex / n).relabel(label, "economics.capex_per_rack", step_evidence=capex.evidence)


_KIND_TEXT = {
    "per_unit": "unit price x quantity added",
    "quoted_scaled": "a supplier quotation scaled in proportion to this step",
    "quoted_allocation": "a supplier quotation allocated across the steps it covers",
    "quoted_job_lump": "a supplier quotation, priced as quoted",
    "quoted_lump_unstated_quantity": "a quoted lump of unstated scope, used once per step",
    "per_rack": "unit price x racks fitted out",
    "quoted_job_lump": "a quoted price for this job",
    "fixed_site": "fixed lump, not scaled to size",
    "client_declared": "the client's own declared figure",
}


def step_basis_text(step) -> str:
    """How a ladder step was priced, in one line: what it buys, how the price was formed, what it rests on."""
    from ..costs import BASIS_LABEL
    if step.cost_key in ("client-supplied", "not-capital"):
        return "the client's own declared figure" if step.cost_key == "client-supplied" else "not a capital purchase"
    parts = []
    if step.scope:
        parts.append(step.scope)
    if step.cost_kind:
        parts.append(_KIND_TEXT.get(step.cost_kind, step.cost_kind))
    if step.cost_basis:
        parts.append(BASIS_LABEL.get(step.cost_basis, step.cost_basis.replace("_", " ")))
    if step.basis_note:
        parts.append(step.basis_note)
    if step.unpriced:
        parts.append("NOT PRICED: " + "; ".join(w for _k, w, _u, _q in step.unpriced))
    return " · ".join(parts)


def economics_limitations(econ, *, include_horizon: bool = False) -> list[str]:
    """Why the economics are not decision-grade, as sentences; empty when they are."""
    return [x for x in econ.limitations if include_horizon or not x.startswith("no lifecycle horizon")]
