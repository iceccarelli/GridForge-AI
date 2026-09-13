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
        for p in self.points:
            if p.racks > 0:
                return p.weeks
        return None

    @property
    def weeks_to_full(self) -> float | None:
        for p in self.points:
            if p.racks >= self.max_racks and self.max_racks > 0:
                return p.weeks
        return None

    critical_item: str = "—"
    critical_weeks: float = 0.0


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
        lead = st.lead_time_weeks.value if st.lead_time_weeks is not None else 0.0
        if lead > elapsed:
            elapsed = lead
            out.critical_item = st.binding_name
            out.critical_weeks = lead
        if st.racks_after > seen_racks:
            seen_racks = st.racks_after
            out.points.append(EnergisationPoint(elapsed, seen_racks, st.binding_name, st.domain))
    return out


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
