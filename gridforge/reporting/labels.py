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

from ..common import V
from ..envelope.solver import HeadroomLadder
from ..scenario.run import ScenarioResult
from ..validation import EvidenceClass, Quantity

INF = float("inf")


def rack_class(result: ScenarioResult) -> EvidenceClass:
    """Weakest evidence class among the constraints this architecture was evaluated against."""
    classes = [c.max_racks.evidence for c in result.envelope.constraints if c.max_racks.value != INF]
    if result.ladder.final is not None:
        classes += [c.max_racks.evidence for c in result.ladder.final.constraints if c.max_racks.value != INF]
    return min(classes) if classes else EvidenceClass.E0_ASSUMPTION


def racks_q(value: float, label: str, result: ScenarioResult) -> Quantity:
    """A derived rack count, labelled with the weakest class that determines it (never a higher one)."""
    return V(float(value), "racks", label, rack_class(result))


def lead_class(ladder: HeadroomLadder) -> EvidenceClass:
    classes = [s.lead_time_weeks.evidence for s in ladder.taken_steps if s.lead_time_weeks is not None]
    return min(classes) if classes else EvidenceClass.E0_ASSUMPTION


def elapsed_bands(ladder: HeadroomLadder) -> list[tuple[float, float, float, EvidenceClass]]:
    """For each energisation point (same order as ``schedule(ladder).points``): (weeks, low, high, class).

    Reliefs run in parallel, so elapsed time is the longest lead time among the steps taken so far, and its
    band is the longest LOW and longest HIGH among them -- the lead times' own bands, not a multiplier."""
    out: list[tuple[float, float, float, EvidenceClass]] = []
    elapsed = lo = hi = 0.0
    cls: EvidenceClass | None = None
    seen = ladder.initial.max_racks if ladder.initial else 0
    if seen > 0:
        out.append((0.0, 0.0, 0.0, EvidenceClass.E0_ASSUMPTION))
    for st in ladder.steps:
        if not st.taken:
            continue
        lt = st.lead_time_weeks
        if lt is not None:
            elapsed = max(elapsed, lt.value)
            lo, hi = max(lo, lt.band[0]), max(hi, lt.band[1])
            cls = lt.evidence if cls is None else min(cls, lt.evidence)
        if st.racks_after > seen:
            seen = st.racks_after
            out.append((elapsed, lo, hi, cls if cls is not None else EvidenceClass.E0_ASSUMPTION))
    return out


def weeks_q(weeks: float, lo: float, hi: float, cls: EvidenceClass, label: str) -> Quantity:
    return V(weeks, "weeks", label, cls, band=(lo, hi) if hi > lo else None)


def is_zero_gain(step) -> bool:
    return bool(step.taken and step.racks_after <= step.racks_before)


ZERO_GAIN_NOTE = ("adds no racks on its own: another constraint limits the hall to the same figure, "
                  "so this relieves one of several tied constraints")


def relief_text(step, *, with_note: bool = True) -> str:
    text = step.relief_description or "no relief available"
    if not step.taken:
        text += "  — NOT TAKEN: this relief cannot be obtained in the decision horizon"
    elif with_note and is_zero_gain(step):
        text += "  — " + ZERO_GAIN_NOTE
    return text


def full_capacity_q(ladder: HeadroomLadder, ttp, label: str) -> Quantity | None:
    """Time to full capacity, banded from the lead times that set it (None when nothing is deployable)."""
    if not ttp.max_racks:
        return None
    for p, (w, lo, hi, cls) in zip(ttp.points, elapsed_bands(ladder)):
        if p.racks >= ttp.max_racks:
            return weeks_q(p.weeks, lo, hi, cls, label)
    return None


def dominant_sensitivity(sensitivities, base: int):
    """The (label, racks) that moves the answer furthest, or None."""
    rows = [(l, n) for l, n in (sensitivities or [])]
    return max(rows, key=lambda r: abs(r[1] - base), default=None)


def critical_path_q(ladder: HeadroomLadder, label: str) -> Quantity:
    """Longest lead time over every taken rung, with the range of the rungs that reach it."""
    leads = [s.lead_time_weeks for s in ladder.taken_steps if s.lead_time_weeks is not None]
    if not leads:
        return V(0.0, "weeks", label, EvidenceClass.E0_ASSUMPTION)
    top = max(leads, key=lambda q: q.value)
    lo, hi = max(q.band[0] for q in leads), max(q.band[1] for q in leads)
    return weeks_q(top.value, lo, hi, min(q.evidence for q in leads), label)
