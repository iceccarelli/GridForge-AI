"""The calibration observation record: one predicted/measured pair with its provenance.

This is the intake type for the residual framework (``residuals.py``). It is deliberately strict:
a record that cannot be defended is refused at the door, never repaired. Nothing here does I/O,
and the clock is only read when the caller does not pass ``now``.

Distinct from ``schema.Observation`` (the hash-chained ratio ledger): this record carries the
detail needed to explain WHERE the model is wrong (variable, configuration, capacity, lead time,
interval) and an explicit review gate. Only ``approved`` records ever reach a statistic.
"""
from __future__ import annotations

import hashlib
import json
import math
import re
from dataclasses import dataclass, fields
from datetime import timedelta, datetime, timezone
from typing import Any, Iterable

from ..validation.evidence import EvidenceClass
from .schema import MINIMUM_EVIDENCE

SCHEMA = "gridforge.calibration.record/1"

#: variable -> (subsystem, canonical unit, minimum physically possible value or None for no lower bound)
#: Closed vocabulary. Add variables; never rename (a renamed variable orphans its history).
VARIABLES: dict[str, tuple[str, str, float | None]] = {
    "it_load_kW": ("envelope", "kW", 0.0),
    "facility_load_kW": ("envelope", "kW", 0.0),
    "racks": ("envelope", "racks", 0.0),
    "pue": ("thermal", "ratio", 1.0),
    "heat_rejection_kW": ("thermal", "kW", 0.0),
    "coolant_flow_lps": ("thermal", "L/s", 0.0),
    "coolant_supply_temp_C": ("thermal", "degC", None),
    "transformer_load_kVA": ("power", "kVA", 0.0),
    "ups_load_kW": ("power", "kW", 0.0),
    "btm_firm_MW": ("power", "MW", 0.0),
    "grid_firm_MW": ("grid", "MW", 0.0),
    "weeks_to_full": ("schedule", "weeks", 0.0),
    "capex_total_eur": ("economics", "EUR", 0.0),
}
SUBSYSTEMS: tuple[str, ...] = tuple(sorted({v[0] for v in VARIABLES.values()}))

MEASUREMENT_SOURCES = ("metered", "sub_metered", "bms_trend", "commissioning_test", "manual_reading")
QUALITIES = ("high", "medium", "low")
APPROVAL_STATUSES = ("draft", "approved", "rejected")
COOLING_MODES = ("air", "rear_door", "direct_to_chip", "immersion", "hybrid")

#: Beyond this a number is a unit error or an attack, not a measurement.
MAX_ABS_VALUE = 1e15

_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{2,95}\Z")
_SITE_RE = re.compile(r"^site_[0-9a-f]{12}\Z")
_HALL_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}\Z")
_VERSION_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.+-]{0,63}\Z")
_CTRL_RE = re.compile(r"[\x00-\x1f\x7f]")


#: How far ahead of the reading clock a measurement timestamp may be before it is treated as a wrong date and not as clock skew.
CLOCK_SKEW = timedelta(minutes=5)


class RecordError(ValueError):
    """A record that must not enter the framework."""


def _text(name: str, v: Any, *, max_len: int, optional: bool = False) -> str | None:
    if v is None and optional:
        return None
    if not isinstance(v, str):
        raise RecordError(f"{name}: must be a string, got {type(v).__name__}")
    s = v.strip()
    if not s:
        raise RecordError(f"{name}: must not be blank")
    if len(s) > max_len or _CTRL_RE.search(s):
        raise RecordError(f"{name}: too long or contains control characters")
    return s


def _number(name: str, v: Any, *, lo: float | None = None, hi: float | None = None,
            lo_open: bool = False, optional: bool = False) -> float | None:
    if v is None and optional:
        return None
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        raise RecordError(f"{name}: must be a number, got {type(v).__name__}")
    try:
        x = float(v)
    except OverflowError as e:
        raise RecordError(f"{name}: too large") from e
    if not math.isfinite(x):
        raise RecordError(f"{name}: must be finite")
    if abs(x) > MAX_ABS_VALUE:
        raise RecordError(f"{name}: magnitude beyond {MAX_ABS_VALUE:g} is not a measurement")
    if lo is not None and (x <= lo if lo_open else x < lo):
        raise RecordError(f"{name}: {x:g} is below the allowed minimum {lo:g}")
    if hi is not None and x > hi:
        raise RecordError(f"{name}: {x:g} is above the allowed maximum {hi:g}")
    return x


def _utc(name: str, v: Any, *, optional: bool = False) -> datetime | None:
    if v is None and optional:
        return None
    if isinstance(v, datetime):
        dt = v
    elif isinstance(v, str):
        try:
            dt = datetime.fromisoformat(v.strip())
        except ValueError as e:
            raise RecordError(f"{name}: not an ISO-8601 timestamp") from e
    else:
        raise RecordError(f"{name}: must be an ISO-8601 string or datetime")
    if dt.tzinfo is None or dt.utcoffset() is None:
        raise RecordError(f"{name}: must carry a timezone (stored as UTC)")
    try:
        return dt.astimezone(timezone.utc)
    except (OverflowError, ValueError) as e:
        raise RecordError(f"{name}: out of range") from e


def _iso(dt: datetime | None) -> str | None:
    return None if dt is None else dt.isoformat().replace("+00:00", "Z")


def _choice(name: str, v: Any, allowed: tuple[str, ...]) -> str:
    if not isinstance(v, str) or v not in allowed:
        raise RecordError(f"{name}: must be one of {list(allowed)}")
    return v


def _version(v: Any) -> str:
    s = _text("model_version", v, max_len=64)
    if s is None or not _VERSION_RE.match(s):
        raise RecordError("model_version: letters, digits and _ . + - only")
    return s


@dataclass(frozen=True)
class ObservationRecord:
    observation_id: str
    site_id: str                      # site_<12 hex>: a hash, never a client name
    hall_id: str
    measured_at: datetime             # UTC
    variable: str
    predicted: float
    measured: float
    unit: str
    measurement_source: str
    quality: str
    model_version: str
    evidence: EvidenceClass
    approval_status: str = "draft"
    reviewer: str | None = None
    instrument_qualification: str | None = None
    # typed, optional context
    configuration: str | None = None
    capacity_mw: float | None = None
    ambient_temp_c: float | None = None
    it_load_fraction: float | None = None
    cooling_mode: str | None = None
    # optional forecast metadata
    forecast_issued_at: datetime | None = None
    predicted_low: float | None = None
    predicted_high: float | None = None
    interval_nominal_coverage: float | None = None

    # --- construction -----------------------------------------------------

    @classmethod
    def from_dict(cls, d: Any, *, now: datetime | None = None) -> "ObservationRecord":
        if not isinstance(d, dict):
            raise RecordError("record must be an object")
        names = {f.name for f in fields(cls)}
        unknown = sorted(str(k) for k in d if k not in names)
        if unknown:
            raise RecordError(f"unknown field(s): {unknown}")
        required = ("observation_id", "site_id", "hall_id", "measured_at", "variable", "predicted",
                    "measured", "unit", "measurement_source", "quality", "model_version", "evidence")
        missing = [k for k in required if k not in d]
        if missing:
            raise RecordError(f"missing field(s): {missing}")
        kw = dict(d)
        ev = kw["evidence"]
        if isinstance(ev, str):
            if ev not in EvidenceClass.__members__:
                raise RecordError("evidence: unknown evidence class name")
            kw["evidence"] = EvidenceClass[ev]
        elif isinstance(ev, int) and not isinstance(ev, bool):
            try:
                kw["evidence"] = EvidenceClass(ev)
            except ValueError as e:
                raise RecordError("evidence: unknown evidence class") from e
        return cls(**kw).validated(now=now)

    def validated(self, *, now: datetime | None = None) -> "ObservationRecord":
        """Return a normalised copy, or raise RecordError. Never mutates, never repairs silently."""
        clock = now if now is not None else datetime.now(timezone.utc)
        if clock.tzinfo is None:
            raise RecordError("now must be timezone-aware")
        oid = _text("observation_id", self.observation_id, max_len=96)
        if oid is None or not _ID_RE.match(oid):
            raise RecordError("observation_id: 3-96 chars of letters, digits and _ . : -")
        site = _text("site_id", self.site_id, max_len=32)
        if site is None or not _SITE_RE.match(site):
            raise RecordError("site_id: must be a hashed site reference (site_ + 12 hex), never a client name")
        hall = _text("hall_id", self.hall_id, max_len=64)
        if hall is None or not _HALL_RE.match(hall):
            raise RecordError("hall_id: letters, digits and _ . - only")
        var = self.variable
        if not isinstance(var, str) or var not in VARIABLES:
            raise RecordError(f"variable: not in the closed vocabulary {sorted(VARIABLES)}")
        _sub, unit_canon, vmin = VARIABLES[var]
        unit = _text("unit", self.unit, max_len=16)
        if unit != unit_canon:
            raise RecordError(f"unit: {var} is recorded in {unit_canon!r}, got {unit!r} (no silent conversion)")
        pred = _number("predicted", self.predicted, lo=vmin)
        meas = _number("measured", self.measured, lo=vmin)
        at = _utc("measured_at", self.measured_at)
        assert at is not None and pred is not None and meas is not None
        # Five minutes of tolerance for the clock of an instrument or edge device that runs slightly ahead; anything beyond that is a wrong
        # date, not skew, and is refused.
        if at > clock.astimezone(timezone.utc) + CLOCK_SKEW:
            raise RecordError("measured_at: lies in the future")
        issued = _utc("forecast_issued_at", self.forecast_issued_at, optional=True)
        if issued is not None and issued > at:
            raise RecordError("forecast_issued_at: must not be after measured_at")
        lo = _number("predicted_low", self.predicted_low, lo=vmin, optional=True)
        hi = _number("predicted_high", self.predicted_high, lo=vmin, optional=True)
        if (lo is None) != (hi is None):
            raise RecordError("predicted_low and predicted_high must be given together")
        if lo is not None and hi is not None and not lo <= pred <= hi:
            raise RecordError("predicted interval must satisfy low <= predicted <= high")
        nominal = _number("interval_nominal_coverage", self.interval_nominal_coverage,
                          lo=0.0, hi=1.0, lo_open=True, optional=True)
        if nominal is not None and lo is None:
            raise RecordError("interval_nominal_coverage given without an interval")
        source = _choice("measurement_source", self.measurement_source, MEASUREMENT_SOURCES)
        quality = _choice("quality", self.quality, QUALITIES)
        status = _choice("approval_status", self.approval_status, APPROVAL_STATUSES)
        ev = self.evidence
        if isinstance(ev, bool) or not isinstance(ev, EvidenceClass):
            raise RecordError("evidence: must be an EvidenceClass")
        if ev < MINIMUM_EVIDENCE:
            raise RecordError(f"evidence: {ev.short} is below {MINIMUM_EVIDENCE.short}; "
                              "a model run cannot validate the model")
        reviewer = _text("reviewer", self.reviewer, max_len=120, optional=True)
        if status == "approved" and reviewer is None:
            raise RecordError("approved requires a named reviewer")
        cooling = self.cooling_mode
        if cooling is not None:
            cooling = _choice("cooling_mode", cooling, COOLING_MODES)
        assert unit is not None
        return ObservationRecord(
            observation_id=oid, site_id=site, hall_id=hall, measured_at=at, variable=var,
            predicted=pred, measured=meas, unit=unit, measurement_source=source,
            quality=quality, model_version=_version(self.model_version), evidence=ev,
            approval_status=status, reviewer=reviewer,
            instrument_qualification=_text("instrument_qualification", self.instrument_qualification,
                                           max_len=200, optional=True),
            configuration=_text("configuration", self.configuration, max_len=80, optional=True),
            capacity_mw=_number("capacity_mw", self.capacity_mw, lo=0.0, lo_open=True, optional=True),
            ambient_temp_c=_number("ambient_temp_c", self.ambient_temp_c, lo=-90.0, hi=70.0, optional=True),
            it_load_fraction=_number("it_load_fraction", self.it_load_fraction, lo=0.0, hi=1.0,
                                     optional=True),
            cooling_mode=cooling, forecast_issued_at=issued, predicted_low=lo, predicted_high=hi,
            interval_nominal_coverage=nominal)

    # --- derived ----------------------------------------------------------

    @property
    def subsystem(self) -> str:
        return VARIABLES[self.variable][0]

    @property
    def lead_time_hours(self) -> float | None:
        if self.forecast_issued_at is None:
            return None
        return (self.measured_at - self.forecast_issued_at).total_seconds() / 3600.0

    def to_dict(self) -> dict:
        out: dict[str, Any] = {}
        for f in fields(self):
            v = getattr(self, f.name)
            if isinstance(v, datetime):
                v = _iso(v)
            elif isinstance(v, EvidenceClass):
                v = v.name
            out[f.name] = v
        return out

    def content_hash(self) -> str:
        """sha256 over the canonical JSON of every field. Same content, same hash, on any machine."""
        blob = json.dumps({"schema": SCHEMA, **self.to_dict()}, sort_keys=True,
                          separators=(",", ":"), ensure_ascii=True, allow_nan=False)
        return hashlib.sha256(blob.encode("ascii")).hexdigest()


@dataclass(frozen=True)
class BatchResult:
    accepted: tuple[ObservationRecord, ...]
    rejected: tuple[tuple[int, str], ...]      # (input index, reason)


def load_batch(rows: Iterable[Any], *, now: datetime | None = None) -> BatchResult:
    """Validate many raw rows. Never raises on a bad row; reports it.

    A duplicate observation_id refuses EVERY row carrying that id (first-wins would make the result depend on
    input order, and two rows disagreeing about one observation is itself a data-integrity finding).
    The accepted tuple is sorted by observation_id so the result is order-independent.
    """
    clock = now if now is not None else datetime.now(timezone.utc)
    good: list[tuple[int, ObservationRecord]] = []
    bad: list[tuple[int, str]] = []
    for i, row in enumerate(rows):
        try:
            if isinstance(row, ObservationRecord):
                good.append((i, row.validated(now=clock)))
            else:
                good.append((i, ObservationRecord.from_dict(row, now=clock)))
        except RecordError as e:
            bad.append((i, str(e)))
        except (TypeError, ValueError, OverflowError) as e:   # hostile shapes must not escape as crashes
            bad.append((i, f"malformed record: {type(e).__name__}"))
    counts: dict[str, int] = {}
    for _, r in good:
        counts[r.observation_id] = counts.get(r.observation_id, 0) + 1
    kept: list[ObservationRecord] = []
    for i, r in good:
        if counts[r.observation_id] > 1:
            bad.append((i, f"duplicate observation_id {r.observation_id!r}: all copies refused"))
        else:
            kept.append(r)
    kept.sort(key=lambda r: r.observation_id)
    return BatchResult(tuple(kept), tuple(sorted(bad)))
