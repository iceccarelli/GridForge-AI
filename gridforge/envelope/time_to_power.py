"""Time to power.

A capacity number alone does not close a deal. The buyer's question is *when*:
how many weeks until the first rack draws power, and how many until the site is
full. In a market where the grid answer is measured in years, weeks are the
product.

The schedule falls out of the Headroom Ladder for free. Each relief has a lead
time; reliefs run in parallel; so the racks unlocked by the first N steps become
available at the longest lead time among those N steps. Plotting that gives an
energisation curve, and the difference between two curves - grid-wait versus
behind-the-meter - is the commercial argument in one number.
"""
from __future__ import annotations

from dataclasses import dataclass, field

from ..validation import EvidenceClass
from .solver import HeadroomLadder


@dataclass
class EnergisationPoint:
    weeks: float
    racks: int
    unlocked_by: str
    domain: str


@dataclass
class TimeToPower:
    points: list[EnergisationPoint] = field(default_factory=list)
    racks_now: int = 0
    max_racks: int = 0

    @property
    def weeks_to_first_rack(self) -> float | None:
        if self.racks_now > 0:
            return 0.0
        if not self.complete:
            return None
        for p in self.points:
            if p.racks > 0:
                return p.weeks
        return None

    @property
    def weeks_to_full(self) -> float | None:
        if not self.complete:
            return None        # a relief with no lead time is unknown, not zero weeks: there is no date to give
        for p in self.points:
            if p.racks >= self.max_racks and self.max_racks > 0:
                return p.weeks
        return None

    critical_item: str = "—"
    critical_weeks: float = 0.0
    #: False when a relief that was taken has no lead time. ``points`` then understate elapsed time (the missing
    #: step contributes nothing), so ``weeks_to_first_rack`` / ``weeks_to_full`` return None rather than a date,
    #: and ``critical_weeks`` is a lower bound only.
    complete: bool = True


def schedule(lad: HeadroomLadder) -> TimeToPower:
    """Energisation curve for a ladder: (weeks elapsed, racks energised)."""
    out = TimeToPower(racks_now=lad.initial.max_racks if lad.initial else 0,
                      max_racks=lad.final.max_racks if lad.final else 0)
    elapsed = 0.0
    seen_racks = out.racks_now
    if out.racks_now > 0:
        out.points.append(EnergisationPoint(0.0, out.racks_now, "available as found", "—"))
    for st in lad.steps:
        if not st.taken:
            continue
        if st.lead_time_weeks is None:
            out.complete = False
        lead = st.lead_time_weeks.value if st.lead_time_weeks is not None else 0.0
        if lead > elapsed:
            elapsed = lead
            out.critical_item = st.binding_name
            out.critical_weeks = lead
        if st.racks_after > seen_racks:
            seen_racks = st.racks_after
            out.points.append(EnergisationPoint(elapsed, seen_racks, st.binding_name, st.domain))
    return out


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


def schedule_complete(ladder: HeadroomLadder) -> bool:
    """True when every relief taken has a lead time. A missing one is not 'zero weeks': ``schedule`` would
    treat it as such and understate the date, so an incomplete schedule yields no date at all."""
    return all(s.lead_time_weeks is not None for s in ladder.taken_steps)


def full_capacity_band(ladder: HeadroomLadder, ttp: TimeToPower
                       ) -> tuple[float, float, float, EvidenceClass] | None:
    """(weeks, low, high, class) to reach the full envelope, from the lead times that set it.

    None when no rack is deployable or the schedule is incomplete: there is then no defensible date."""
    if not ttp.max_racks or not schedule_complete(ladder):
        return None
    for p, (w, lo, hi, cls) in zip(ttp.points, elapsed_bands(ladder)):
        if p.racks >= ttp.max_racks:
            return (p.weeks, lo, hi, cls)
    return None


@dataclass
class TimeToPowerComparison:
    baseline_label: str
    option_label: str
    baseline: TimeToPower
    option: TimeToPower

    @property
    def weeks_saved(self) -> float | None:
        a, b = self.baseline.weeks_to_full, self.option.weeks_to_full
        if a is None or b is None:
            return None
        return a - b

    @property
    def racks_gained(self) -> int:
        return self.option.max_racks - self.baseline.max_racks


def compare(baseline_label: str, baseline: HeadroomLadder,
            option_label: str, option: HeadroomLadder) -> TimeToPowerComparison:
    return TimeToPowerComparison(baseline_label, option_label,
                                 schedule(baseline), schedule(option))
