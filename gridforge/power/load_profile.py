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
import math
import re
from dataclasses import dataclass, field
from datetime import datetime
from typing import Callable

from ..common import ASSUMED, CUSTOMER, V
from ..validation import EvidenceClass, Quantity


class LoadProfileError(ValueError):
    pass


#: Input sanity, in step with the intake loader's ceiling for a hall's load (PLAUSIBLE_MAX["lv.existing_busway_load_kW"], 5,000,000 kW) and
#: change._STATE_MAX_KW: a load above it is a unit slip or an overflow, not a hall. `nan` and `inf` parse as floats and would reach the response as
#: the literals NaN / Infinity, which are not JSON.
LOAD_PROFILE_MAX_kW = 5_000_000.0
#: The longest flat profile one request may ask for (a leap year of hours): `flat` builds one sample per interval, so an unbounded duration is an unbounded allocation.
LOAD_PROFILE_MAX_HOURS = 8_784.0


def _sane_kW(raw: float, what: str) -> float:
    if not math.isfinite(raw):
        raise LoadProfileError(f"{what} is {raw!r}; it must be a finite number of kW")
    if abs(raw) > LOAD_PROFILE_MAX_kW:
        raise LoadProfileError(f"{what} is {raw:g} kW, above {LOAD_PROFILE_MAX_kW:g} kW, the most this tool will model for one site. "
                               f"Check the unit (W versus kW) and for a stray digit.")
    return raw


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
    #: What the reader did that the customer should know about (the file was semicolon-separated; numbers with a decimal comma were read as decimal
    #: points). Surfaced as warnings by ``validate()``: a reading of the file that was a choice is never silent.
    import_notes: list[str] = field(default_factory=list)

    def __post_init__(self) -> None:
        if not self.samples:
            raise LoadProfileError("a load profile with no samples is not a profile")
        if not math.isfinite(self.interval_minutes) or self.interval_minutes <= 0:
            # gaps() divides by the interval: zero (every inferred interval of a profile whose readings repeat an instant) used to be a
            # ZeroDivisionError reported as a generic 422, and the real cause, duplicate timestamps, was never named.
            raise LoadProfileError(f"the sampling interval is {self.interval_minutes!r} minutes; it must be a finite number above zero. "
                                   f"If the readings repeat a timestamp, remove the repeats: a profile needs one reading per instant")
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
        if expected <= 0:        # unreachable through the constructor; a profile mutated into it reports no gaps rather than divide by it
            return out
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
        warnings: list[str] = list(self.import_notes)
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

#: The delimiters a customer file may use, by name, for messages.
_DELIMITER_NAMES = {",": "comma", ";": "semicolon", "\t": "tab"}


@dataclass(frozen=True)
class CsvRows:
    """A file as a dialect reader hands it over: its records as ``(file row, cells)``, header first, and the delimiter it found. The file row is the
    physical line the record starts on, so a refusal names the row the customer sees in their spreadsheet."""
    rows: list[tuple[int, list[str]]]
    delimiter: str = ","


#: Reads text into rows. `from_csv` has a comma-only reader of its own; the BTM request path hands it the equipment-schedule importer's dialect reader
#: (reporting/load_profile_csv.py), because `power` may not import `intake` (tests/test_architecture.py) and the one reader must not be written twice.
CsvReader = Callable[[str], CsvRows]


def _comma_reader(text: str) -> CsvRows:
    reader = csv.reader(io.StringIO(text))
    rows: list[tuple[int, list[str]]] = []
    for cells in reader:
        if not cells or not any(c.strip() for c in cells) or cells[0].strip().startswith("#"):
            continue
        rows.append((reader.line_num, cells))
    return CsvRows(rows, ",")


#: A decimal comma, `1234,5`; and the shape that could equally be a thousands separator, `1,234` / `12,345` / `123,456`.
_DECIMAL_COMMA = re.compile(r"[+-]?[0-9]+,[0-9]+")
_COMMA_OR_THOUSANDS = re.compile(r"[+-]?[1-9][0-9]{0,2},[0-9]{3}")
_DAY_FIRST_DATE = re.compile(r"\s*[0-9]{1,4}[./-][0-9]{1,2}[./-][0-9]{1,4}")


def _number(cell: str, where: str, delimiter: str, decimal_commas: list[str]) -> float:
    """A cell as a float. A decimal point is always read. A decimal comma (`1234,5`) is read ONLY in a semicolon-separated file, where a comma cannot
    be a column separator and the file is plainly a regional export; in a comma- or tab-separated file it is refused and the reason given. A cell that
    could be a decimal comma or a thousands separator (`1,234`) is refused in every file, and so is one that mixes a point and a comma: this reader
    never decides silently which a number meant. Every number it did read with a decimal comma is counted into ``decimal_commas``, for the warning."""
    text = cell.strip()
    if "_" in text or not text.isascii():          # float("1_000") and float("٣") are numbers to Python, not to a meter export
        raise LoadProfileError(f"{where}: unparseable number {cell[:24]!r}")
    if "," in text:
        name = _DELIMITER_NAMES.get(delimiter, repr(delimiter))
        if "." in text:
            raise LoadProfileError(f"{where}: {text[:24]!r} mixes a decimal point and a comma. A thousands separator is not read; write the number "
                                   f"plainly (1234.5{' or 1234,5' if delimiter == ';' else ''})")
        if delimiter != ";":
            raise LoadProfileError(f"{where}: {text[:24]!r} has a comma inside the number. A decimal comma is read only in a semicolon-separated file, "
                                   f"where a comma cannot be a column separator; this file is {name}-separated, so it is refused rather than guessed "
                                   f"at (1,234 could be 1.234 or 1234). Write the number with a decimal point, or re-export the file with semicolons")
        if _COMMA_OR_THOUSANDS.fullmatch(text):
            raise LoadProfileError(f"{where}: {text[:24]!r} could be a decimal comma (read as {text.replace(',', '.')}) or a thousands separator "
                                   f"(read as {text.replace(',', '')}); this tool will not choose. Write it with a decimal point and no thousands separator")
        if not _DECIMAL_COMMA.fullmatch(text):
            raise LoadProfileError(f"{where}: {text[:24]!r} is not a number")
        decimal_commas.append(text)
        text = text.replace(",", ".")
    try:
        return float(text)
    except ValueError as exc:
        raise LoadProfileError(f"{where}: unparseable number {cell[:24]!r}") from exc


def _timestamp(cell: str, row: int) -> datetime:
    try:
        return datetime.fromisoformat(cell.strip())
    except ValueError as exc:
        hint = ""
        if _DAY_FIRST_DATE.match(cell) and not re.match(r"\s*[0-9]{4}-[0-9]{2}-[0-9]{2}", cell):
            hint = (". Timestamps must be ISO 8601 (2026-01-01T00:15:00 or 2026-01-01 00:15:00): a date written day-first or month-first "
                    "(01/02/2026) is not guessed, because it can be read two ways")
        raise LoadProfileError(f"row {row}: unparseable timestamp {cell!r}{hint}") from exc


def from_csv(text: str, *, source: str = "customer CSV", evidence: EvidenceClass = CUSTOMER,
             reader: CsvReader | None = None) -> LoadProfile:
    """Parse `timestamp,kW[,kVAR]` rows. Any other shape is refused, named, rather than guessed at — a misread column is a fabricated load profile
    with extra steps.

    A leading byte-order mark is dropped (a file read as UTF-8 keeps it as the character U+FEFF, which stuck to the first header). With no ``reader`` the
    file must be comma-separated; the BTM assessment passes a reader that also takes semicolons and tabs (see ``CsvReader``)."""
    if text.startswith("﻿"):
        text = text[1:]
    return from_rows((reader or _comma_reader)(text), source=source, evidence=evidence)


def from_rows(parsed: CsvRows, *, source: str = "customer CSV", evidence: EvidenceClass = CUSTOMER) -> LoadProfile:
    rows, delimiter = parsed.rows, parsed.delimiter
    if not rows:
        raise LoadProfileError("empty CSV — no rows to build a load profile from")
    header_row, header_cells = rows[0]
    header = [c.strip().lstrip("﻿").lower() for c in header_cells]
    if header[:2] != ["timestamp", "kw"]:
        got = [c.strip() for c in header_cells]
        if len(got) == 1:
            other = [d for d in (";", "\t") if d in got[0] and d != delimiter]
            cause = (f"the header is a single cell, so the columns are not separated by {'a ' + _DELIMITER_NAMES[delimiter] if delimiter in _DELIMITER_NAMES else 'the delimiter'} "
                     f"as this reader read them" + (f"; it contains a {_DELIMITER_NAMES[other[0]]}, so this looks like a {_DELIMITER_NAMES[other[0]]}-separated file "
                                                    f"(a BTM assessment request reads commas, semicolons and tabs; the library's from_csv alone reads commas)"
                                                    if other else
                                                    " (a comma, semicolon or tab; any other separator, or a file that is not a CSV, cannot be read)"))
            raise LoadProfileError(f"row {header_row}: expected columns starting 'timestamp,kW[,kVAR]', got {got!r}: {cause}")
        raise LoadProfileError(f"row {header_row}: expected columns starting 'timestamp,kW[,kVAR]', got {got!r}")
    has_kvar = len(header) > 2 and header[2] == "kvar"
    samples: list[LoadSample] = []
    decimal_commas: list[str] = []
    first_seen: dict[datetime, int] = {}          # timestamp -> the first row that carried it
    repeats: list[tuple[int, int]] = []           # (row, the earlier row it repeats)
    first_aware: tuple[int, bool] | None = None   # (row, has a UTC offset) of the first timestamp
    for i, row in rows[1:]:
        if len(row) < 2:
            raise LoadProfileError(f"row {i}: expected at least timestamp,kW — got {row!r}")
        ts = _timestamp(row[0], i)
        aware = ts.tzinfo is not None
        if first_aware is None:
            first_aware = (i, aware)
        elif aware != first_aware[1]:
            # Sorting and differencing a mix of local and offset timestamps is a TypeError, and guessing the zone of the local ones is a fabricated clock.
            raise LoadProfileError(
                f"row {i}: timestamp {row[0].strip()!r} {'has' if aware else 'has no'} UTC offset, but row {first_aware[0]}'s "
                f"{'has' if first_aware[1] else 'has not'}. Give every timestamp the same form (all with an offset such as +01:00 or Z, or all without)")
        if ts in first_seen:
            repeats.append((i, first_seen[ts]))
        else:
            first_seen[ts] = i
        kW = _number(row[1], f"row {i}: kW", delimiter, decimal_commas)
        kW = _sane_kW(kW, f"row {i}: kW {row[1].strip()[:24]!r}")
        kVAR = None
        if has_kvar and len(row) > 2 and row[2].strip():
            kVAR = _number(row[2], f"row {i}: kVAR", delimiter, decimal_commas)
            kVAR = _sane_kW(kVAR, f"row {i}: kVAR {row[2].strip()[:24]!r}")
        samples.append(LoadSample(ts, kW, kVAR))
    if repeats:
        # Refused BEFORE the sampling interval is inferred from the gaps between readings: a repeated instant is a zero-length step, and a
        # median that lands on it is an interval of zero.
        shown = "; ".join(f"row {i} repeats the timestamp of row {j}" for i, j in repeats[:5])
        more = f" (and {len(repeats) - 5} more)" if len(repeats) > 5 else ""
        raise LoadProfileError(
            f"{len(repeats)} row(s) repeat an earlier timestamp: {shown}{more}. A profile needs exactly one reading per instant; remove the "
            f"repeats, or combine overlapping meters into one series yourself (this tool will not sum or pick between them), and for a DST "
            f"fold give the timestamps an offset")
    samples.sort(key=lambda s: s.timestamp)
    interval = _infer_interval_minutes(samples)
    notes: list[str] = []
    if delimiter != ",":
        notes.append(f"the file was read as {_DELIMITER_NAMES.get(delimiter, delimiter)}-separated.")
    if decimal_commas:
        notes.append(f"{len(decimal_commas)} number(s) were written with a decimal comma (first: {decimal_commas[0]!r}) and were read as decimal points, "
                     f"because the file is semicolon-separated; check one against the source before relying on the profile.")
    return LoadProfile(samples=samples, interval_minutes=interval, evidence=evidence, source=source, import_notes=notes)


def _infer_interval_minutes(samples: list[LoadSample]) -> float:
    if len(samples) < 2:
        return 15.0
    deltas = [(b.timestamp - a.timestamp).total_seconds() / 60.0
             for a, b in zip(samples, samples[1:])]
    deltas.sort()
    median = deltas[len(deltas) // 2]  # median — robust to one gap
    if not math.isfinite(median) or median <= 0:
        raise LoadProfileError("the sampling interval cannot be inferred: the readings do not advance in time (repeated timestamps)")
    return median


def flat(kW: float, *, hours: float = 24.0, interval_minutes: float = 15.0,
        label: str = "flat assumption") -> LoadProfile:
    """A constant profile from a single MW figure — what the free qualifier and
    any screening-level exercise without a real export fall back to. Explicitly
    E0: a flat line is a declared assumption about shape, never a measurement,
    and every downstream ramp-rate and step-event figure computed from it will
    correctly read zero, which is itself the honest answer to "how much does a
    flat assumption tell you about transients."""
    from datetime import timedelta
    kW = _sane_kW(float(kW), "flat kW")
    if not math.isfinite(interval_minutes) or interval_minutes <= 0:
        raise LoadProfileError(f"flat interval_minutes is {interval_minutes!r}; it must be a finite number above 0")
    if not math.isfinite(hours) or not 0 < hours <= LOAD_PROFILE_MAX_HOURS:
        raise LoadProfileError(f"flat hours is {hours!r}; it must be a finite number above 0 and at most {LOAD_PROFILE_MAX_HOURS:g}")
    n = max(int(hours * 60 / interval_minutes), 1)
    start = datetime(2000, 1, 1)
    samples = [LoadSample(start + timedelta(minutes=interval_minutes * i), kW)
              for i in range(n)]
    return LoadProfile(samples=samples, interval_minutes=interval_minutes,
                       evidence=ASSUMED, source=label)
