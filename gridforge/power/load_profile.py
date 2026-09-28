"""A load is a time series, not one MW number.

Every BTM sizing exercise this repository has done so far reduces a load to a
single `current_it_load_MW` figure. That is enough to solve which electrical
constraint binds first; it is not enough to size a generator's ramp rate or a
battery's duration, both of which depend on how the load actually moves, not on
its peak. A generator sized to a peak that occurs for four minutes a day and a
generator sized to a peak that is sustained for six hours are different
purchases, and nothing in the constraint engine has ever been asked to tell them
apart.

This module ingests a real interval series (a CSV a customer's BMS or metering
system actually exports), validates it honestly, and derives the handful of
summary figures the rest of the BTM engineering — generation ramp sizing, battery
duration sizing, contingency analysis — actually needs. It never interpolates a
gap and calls the result data: a gap is reported as a gap.
"""
from __future__ import annotations

import csv
import io
from dataclasses import dataclass
from datetime import datetime

from ..common import ASSUMED, CUSTOMER, V
from ..validation import EvidenceClass, Quantity


class LoadProfileError(ValueError):
    pass


@dataclass(frozen=True)
class LoadSample:
    timestamp: datetime
    kW: float
    kVAR: float | None = None

    @property
    def power_factor(self) -> float | None:
        if self.kVAR is None or self.kW == 0:
            return None
        kVA = (self.kW ** 2 + self.kVAR ** 2) ** 0.5
        return self.kW / kVA if kVA else None


@dataclass(frozen=True)
class Gap:
    after: datetime
    before: datetime
    missing_intervals: int


@dataclass(frozen=True)
class StepEvent:
    at: datetime
    from_kW: float
    to_kW: float

    @property
    def delta_kW(self) -> float:
        return self.to_kW - self.from_kW


@dataclass
class LoadProfile:
    """An interval series, plus what it takes to trust it.

    `evidence` is set once at construction, from where the series came from — a
    customer's own metering export is E5_CUSTOMER_DATA; a single MW figure
    expanded into a flat profile for a screening-level exercise (`flat()` below)
    is E0_ASSUMPTION and says so on every derived quantity. Nothing here upgrades
    that evidence class by computing on it — arithmetic on an E0 series produces
    E0 conclusions, the same rule the rest of the engine already enforces.
    """
    samples: list[LoadSample]
    interval_minutes: float
    evidence: EvidenceClass
    source: str = ""  # free text: filename, "flat assumption from qualifier", etc.

    def __post_init__(self) -> None:
        if not self.samples:
            raise LoadProfileError("a load profile with no samples is not a profile")
        if any(s.kW < 0 for s in self.samples):
            raise LoadProfileError(
                "negative kW in the load profile — a sign convention error, not a real load")

    # --- summary statistics -------------------------------------------------

    def _q(self, value: float, label: str) -> Quantity:
        return V(value, "kW", f"{self.source or 'load profile'}: {label}", self.evidence)

    def peak_kW(self) -> Quantity:
        return self._q(max(s.kW for s in self.samples), "peak")

    def min_kW(self) -> Quantity:
        return self._q(min(s.kW for s in self.samples), "minimum")

    def mean_kW(self) -> Quantity:
        values = [s.kW for s in self.samples]
        return self._q(sum(values) / len(values), "mean")

    def load_factor(self) -> float:
        """Mean over peak — how much of the peak-driven capacity is actually
        used. A load factor near 1.0 means the peak IS the design point; a load
        factor near 0.3 means most of a peak-sized architecture sits idle, which
        is exactly the case for a BESS-covered step load rather than a generator
        sized to the peak continuously."""
        peak = self.peak_kW().value
        return self.mean_kW().value / peak if peak else 0.0

    def ramp_rate_kW_per_min(self) -> Quantity:
        """The steepest observed step, normalised to per-minute — what a
        generator's ramp rate and a battery's power rating actually have to be
        sized against, not the peak alone. A site that sits flat at 40 MW and one
        that swings from 10 MW to 40 MW in ninety seconds need very different
        architectures even with an identical peak."""
        if len(self.samples) < 2:
            return self._q(0.0, "ramp rate (single sample)")
        worst = 0.0
        for a, b in zip(self.samples, self.samples[1:]):
            minutes = (b.timestamp - a.timestamp).total_seconds() / 60.0
            if minutes <= 0:
                continue
            rate = abs(b.kW - a.kW) / minutes
            worst = max(worst, rate)
        q = self._q(worst, "steepest observed ramp")
        return Quantity(q.value, "kW/min", q.prov, q.lo, q.hi)

    def step_events(self, threshold_fraction: float = 0.10) -> list[StepEvent]:
        """Jumps between consecutive samples exceeding `threshold_fraction` of the
        profile's own peak. This is what a UPS step-load spec and a generator's
        transient response actually have to survive — GPU training loads step
        far harder than general IT, and a threshold tied to THIS site's peak
        (not an assumed constant) is what makes the detector mean something on
        both a 2 MW hall and a 200 MW campus."""
        peak = self.peak_kW().value
        if peak <= 0:
            return []
        threshold = peak * threshold_fraction
        events = []
        for a, b in zip(self.samples, self.samples[1:]):
            if abs(b.kW - a.kW) >= threshold:
                events.append(StepEvent(b.timestamp, a.kW, b.kW))
        return events

    def gaps(self) -> list[Gap]:
        """Missing intervals, detected from the declared sampling interval — never
        filled, only reported. A generator sized against a profile with silently
        interpolated gaps is a generator sized against data nobody measured."""
        out: list[Gap] = []
        expected = self.interval_minutes * 60
        for a, b in zip(self.samples, self.samples[1:]):
            actual = (b.timestamp - a.timestamp).total_seconds()
            if actual > expected * 1.5:
                missing = round(actual / expected) - 1
                out.append(Gap(a.timestamp, b.timestamp, missing))
        return out

    def duplicate_timestamps(self) -> list[datetime]:
        seen: dict[datetime, int] = {}
        for s in self.samples:
            seen[s.timestamp] = seen.get(s.timestamp, 0) + 1
        return [t for t, n in seen.items() if n > 1]

    def validate(self) -> "LoadProfileReport":
        warnings: list[str] = []
        gaps = self.gaps()
        if gaps:
            total_missing = sum(g.missing_intervals for g in gaps)
            warnings.append(
                f"{len(gaps)} gap(s) totalling {total_missing} missing interval(s) — "
                f"not interpolated; sizing figures below cover only the samples present.")
        dupes = self.duplicate_timestamps()
        if dupes:
            warnings.append(f"{len(dupes)} duplicate timestamp(s) — check the export for "
                            f"overlapping meters or a DST fold.")
        if len(self.samples) < 96:  # under 24h at 15-minute resolution
            warnings.append(
                f"only {len(self.samples)} sample(s) supplied — a full daily cycle needs at "
                f"least 96 at 15-minute resolution; sizing figures are directional, not final.")
        if self.evidence < CUSTOMER:
            warnings.append(
                "this profile is not customer-measured data — every figure derived from it "
                "is an assumption about shape, not a measurement of this load.")
        return LoadProfileReport(
            samples=len(self.samples), interval_minutes=self.interval_minutes,
            gaps=gaps, duplicate_timestamps=dupes, warnings=warnings,
            evidence=self.evidence)


@dataclass
class LoadProfileReport:
    samples: int
    interval_minutes: float
    gaps: list[Gap]
    duplicate_timestamps: list[datetime]
    warnings: list[str]
    evidence: EvidenceClass

    @property
    def usable(self) -> bool:
        """A profile with duplicate timestamps is not sizeable — ramp and step
        detection would be comparing samples that do not have a real order. Gaps
        alone do not block use; they just mean the summary covers less than the
        full window."""
        return not self.duplicate_timestamps


# --- construction ------------------------------------------------------------

def from_csv(text: str, *, source: str = "customer CSV",
            evidence: EvidenceClass = CUSTOMER) -> LoadProfile:
    """Parse `timestamp,kW[,kVAR]` rows. Any other shape is refused, named, rather
    than guessed at — a misread column is a fabricated load profile with extra
    steps."""
    reader = csv.reader(io.StringIO(text))
    rows = [r for r in reader if r and not r[0].strip().startswith("#")]
    if not rows:
        raise LoadProfileError("empty CSV — no rows to build a load profile from")
    header = [c.strip().lower() for c in rows[0]]
    if header[:2] != ["timestamp", "kw"]:
        raise LoadProfileError(
            f"expected columns starting 'timestamp,kW[,kVAR]', got {rows[0]!r}")
    has_kvar = len(header) > 2 and header[2] == "kvar"
    samples: list[LoadSample] = []
    for i, row in enumerate(rows[1:], start=2):
        if len(row) < 2:
            raise LoadProfileError(f"row {i}: expected at least timestamp,kW — got {row!r}")
        try:
            ts = datetime.fromisoformat(row[0].strip())
        except ValueError as exc:
            raise LoadProfileError(f"row {i}: unparseable timestamp {row[0]!r}") from exc
        try:
            kW = float(row[1])
        except ValueError as exc:
            raise LoadProfileError(f"row {i}: unparseable kW {row[1]!r}") from exc
        kVAR = None
        if has_kvar and len(row) > 2 and row[2].strip():
            try:
                kVAR = float(row[2])
            except ValueError as exc:
                raise LoadProfileError(f"row {i}: unparseable kVAR {row[2]!r}") from exc
        samples.append(LoadSample(ts, kW, kVAR))
    samples.sort(key=lambda s: s.timestamp)
    interval = _infer_interval_minutes(samples)
    return LoadProfile(samples=samples, interval_minutes=interval, evidence=evidence,
                       source=source)


def _infer_interval_minutes(samples: list[LoadSample]) -> float:
    if len(samples) < 2:
        return 15.0
    deltas = [(b.timestamp - a.timestamp).total_seconds() / 60.0
             for a, b in zip(samples, samples[1:])]
    deltas.sort()
    return deltas[len(deltas) // 2]  # median — robust to one gap or one duplicate


def flat(kW: float, *, hours: float = 24.0, interval_minutes: float = 15.0,
        label: str = "flat assumption") -> LoadProfile:
    """A constant profile from a single MW figure — what the free qualifier and
    any screening-level exercise without a real export fall back to. Explicitly
    E0: a flat line is a declared assumption about shape, never a measurement,
    and every downstream ramp-rate and step-event figure computed from it will
    correctly read zero, which is itself the honest answer to "how much does a
    flat assumption tell you about transients."""
    from datetime import timedelta
    n = max(int(hours * 60 / interval_minutes), 1)
    start = datetime(2000, 1, 1)
    samples = [LoadSample(start + timedelta(minutes=interval_minutes * i), kW)
              for i in range(n)]
    return LoadProfile(samples=samples, interval_minutes=interval_minutes,
                       evidence=ASSUMED, source=label)
