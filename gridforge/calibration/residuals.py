"""Residuals: where, and by how much, the model's predictions missed what the site measured.

Pure functions over a list of ``ObservationRecord``. No I/O, no clock, no randomness.

Rules that shape the output:

  * Only ``approved`` records are ever read. A draft or rejected record changes nothing in the report,
    not even a count; ``pending_counts`` reports them separately for the review queue.
  * There is NO global accuracy number. Errors are in the variable's own unit, so they are reported per
    variable, rolled up to a per-subsystem *state*, and never averaged across subsystems.
  * Percentage error is undefined (``None``), never zero, when the measured value is zero.
  * A variable is CALIBRATED only with at least ``MIN_APPROVED_OBSERVATIONS`` approved, non-low-quality
    observations from at least ``MIN_DISTINCT_SITES`` distinct sites. A subsystem is CALIBRATED only when
    every variable in it is. Below that the state is INDICATIVE (some data) or UNCALIBRATED, with the count.
  * Sums use ``math.fsum`` and inputs are sorted by id first, so the result does not depend on input order.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Iterable

from .records import SUBSYSTEMS, VARIABLES, ObservationRecord

SCHEMA = "gridforge.calibration.residuals/1"

#: Deliberately more conservative than the ratio ledger (stats.CALIBRATED_MIN = 5): this framework backs a
#: per-variable claim, and a spread from ten readings is still thin. A test pins both, and that these are
#: never lower than the ledger's.
MIN_APPROVED_OBSERVATIONS = 10
MIN_DISTINCT_SITES = 3

UNCALIBRATED = "UNCALIBRATED"
INDICATIVE = "INDICATIVE"
CALIBRATED = "CALIBRATED"

CAPACITY_BUCKETS = ("<1 MW", "1-5 MW", "5-20 MW", "20-100 MW", ">=100 MW", "unspecified")
LEAD_TIME_BUCKETS = ("<=1 h", "1-6 h", "6-24 h", "24-168 h", ">168 h")


@dataclass(frozen=True)
class Residual:
    observation_id: str
    signed_error: float             # predicted - measured, in the variable's unit
    absolute_error: float
    percentage_error: float | None  # 100 * |error| / |measured|; None when measured == 0


def residual(rec: ObservationRecord) -> Residual:
    err = rec.predicted - rec.measured
    pct = None if rec.measured == 0 else 100.0 * abs(err) / abs(rec.measured)
    return Residual(rec.observation_id, err, abs(err), pct)


# --- helpers ---------------------------------------------------------------

def _r(x: float | None) -> float | None:
    return None if x is None else round(x, 6) + 0.0


def _median(xs: list[float]) -> float | None:
    if not xs:
        return None
    s = sorted(xs)
    m = len(s) // 2
    return s[m] if len(s) % 2 else (s[m - 1] + s[m]) / 2.0


def _mean(xs: list[float]) -> float | None:
    return math.fsum(xs) / len(xs) if xs else None


def capacity_bucket(capacity_mw: float | None) -> str:
    if capacity_mw is None:
        return "unspecified"
    for limit, name in ((1.0, "<1 MW"), (5.0, "1-5 MW"), (20.0, "5-20 MW"), (100.0, "20-100 MW")):
        if capacity_mw < limit:
            return name
    return ">=100 MW"


def lead_time_bucket(hours: float) -> str:
    for limit, name in ((1.0, "<=1 h"), (6.0, "1-6 h"), (24.0, "6-24 h"), (168.0, "24-168 h")):
        if hours <= limit:
            return name
    return ">168 h"


def approved(records: Iterable[ObservationRecord]) -> list[ObservationRecord]:
    """Approved records only, duplicates of an id refused entirely, sorted by id."""
    recs = list(records)
    counts: dict[str, int] = {}
    for r in recs:
        counts[r.observation_id] = counts.get(r.observation_id, 0) + 1
    return sorted((r for r in recs if r.approval_status == "approved" and counts[r.observation_id] == 1),
                  key=lambda r: r.observation_id)


def _stats(recs: list[ObservationRecord]) -> dict:
    res = [residual(r) for r in recs]
    absolute = [x.absolute_error for x in res]
    pcts = [x.percentage_error for x in res if x.percentage_error is not None]
    return {
        "n": len(recs),
        "sites": len({r.site_id for r in recs}),
        "mean_abs_error": _r(_mean(absolute)),
        "median_abs_error": _r(_median(absolute)),
        "max_abs_error": _r(max(absolute) if absolute else None),
        "mean_signed_error": _r(_mean([x.signed_error for x in res])),   # + means the model over-predicts
        "median_pct_error": _r(_median(pcts)),
        "pct_error_defined_n": len(pcts),
        "pct_error_undefined_n": len(res) - len(pcts),                   # measured == 0
    }


def _grouped(recs: list[ObservationRecord], keyfn, order: tuple[str, ...] | None = None) -> dict:
    groups: dict[str, list[ObservationRecord]] = {}
    for r in recs:
        k = keyfn(r)
        if k is not None:
            groups.setdefault(k, []).append(r)
    keys = ([k for k in order if k in groups] if order else sorted(groups))
    return {k: _stats(groups[k]) for k in keys}


def interval_coverage(recs: list[ObservationRecord]) -> dict:
    """Share of measured values that fell inside the model's own [low, high]. Confidence calibration only."""
    with_iv = [r for r in recs if r.predicted_low is not None and r.predicted_high is not None]
    n = len(with_iv)
    hits = sum(1 for r in with_iv if r.predicted_low <= r.measured <= r.predicted_high)  # type: ignore[operator]
    nominals = {r.interval_nominal_coverage for r in with_iv}
    nominal = next(iter(nominals)) if len(nominals) == 1 and None not in nominals else None
    assessed = n >= MIN_APPROVED_OBSERVATIONS
    cov = hits / n if n else None
    return {
        "n_intervals": n,
        "hits": hits,
        "observed_coverage": _r(cov),
        "nominal_coverage": nominal,
        "coverage_minus_nominal": _r(cov - nominal) if (assessed and cov is not None and nominal is not None) else None,
        "assessed": assessed,
        "note": ("observed share of measurements inside the stated interval; compare with the nominal level"
                 if assessed else f"not assessed: fewer than {MIN_APPROVED_OBSERVATIONS} intervals"),
    }


def variable_state(recs: list[ObservationRecord]) -> str:
    eligible = [r for r in recs if r.quality != "low"]
    if (len(eligible) >= MIN_APPROVED_OBSERVATIONS
            and len({r.site_id for r in eligible}) >= MIN_DISTINCT_SITES):
        return CALIBRATED
    return INDICATIVE if recs else UNCALIBRATED


def _variable_block(variable: str, recs: list[ObservationRecord]) -> dict:
    state = variable_state(recs)
    eligible = [r for r in recs if r.quality != "low"]
    block: dict = {
        "unit": VARIABLES[variable][1],
        "state": state,
        "approved_observations": len(recs),
        "counting_toward_calibration": len(eligible),
        "distinct_sites": len({r.site_id for r in eligible}),
        "still_needed": {
            "observations": max(0, MIN_APPROVED_OBSERVATIONS - len(eligible)),
            "sites": max(0, MIN_DISTINCT_SITES - len({r.site_id for r in eligible})),
        },
    }
    if recs:
        block["residuals"] = _stats(recs)
        block["by_configuration"] = _grouped(recs, lambda r: r.configuration or "unspecified")
        block["by_capacity_bucket"] = _grouped(recs, lambda r: capacity_bucket(r.capacity_mw), CAPACITY_BUCKETS)
        block["by_evidence_class"] = _grouped(recs, lambda r: r.evidence.short)
        block["lead_time_error"] = _grouped(
            recs, lambda r: None if r.lead_time_hours is None else lead_time_bucket(r.lead_time_hours),
            LEAD_TIME_BUCKETS)
        block["interval_coverage"] = interval_coverage(recs)
    return block


def subsystem_statement(name: str, state: str, n: int, n_sites: int) -> str:
    if state == UNCALIBRATED:
        return f"{name}: UNCALIBRATED (n={n} approved observations). Figures are modelled; accuracy is unquantified."
    if state == INDICATIVE:
        return (f"{name}: INDICATIVE (n={n} approved observations from {n_sites} site(s)); at least "
                f"{MIN_APPROVED_OBSERVATIONS} per variable from {MIN_DISTINCT_SITES} distinct sites is "
                "required before any variable here is called calibrated.")
    return (f"{name}: CALIBRATED (n={n} approved observations from {n_sites} site(s)); every variable met "
            f"the minimum of {MIN_APPROVED_OBSERVATIONS} observations from {MIN_DISTINCT_SITES} sites.")


def residual_report(records: Iterable[ObservationRecord]) -> dict:
    """The per-subsystem calibration report. Deliberately has no single overall accuracy field."""
    recs = approved(records)
    by_var: dict[str, list[ObservationRecord]] = {v: [] for v in VARIABLES}
    for r in recs:
        by_var[r.variable].append(r)
    subsystems: dict[str, dict] = {}
    for sub in SUBSYSTEMS:
        names = sorted(v for v, spec in VARIABLES.items() if spec[0] == sub)
        blocks = {v: _variable_block(v, by_var[v]) for v in names}
        sub_recs = [r for v in names for r in by_var[v]]
        states = [b["state"] for b in blocks.values()]
        state = (CALIBRATED if all(s == CALIBRATED for s in states)
                 else INDICATIVE if sub_recs else UNCALIBRATED)
        n_sites = len({r.site_id for r in sub_recs})
        subsystems[sub] = {
            "state": state,
            "approved_observations": len(sub_recs),
            "distinct_sites": n_sites,
            "statement": subsystem_statement(sub, state, len(sub_recs), n_sites),
            "variables": blocks,
        }
    states = {s: v["state"] for s, v in subsystems.items()}
    headline = ("Calibration is reported per subsystem; no single accuracy figure is produced. "
                + " ".join(f"{s}: {subsystems[s]['state']} (n={subsystems[s]['approved_observations']})."
                           for s in SUBSYSTEMS))
    return {
        "schema": SCHEMA,
        "headline": headline,
        "requirements": {"min_approved_observations_per_variable": MIN_APPROVED_OBSERVATIONS,
                         "min_distinct_sites_per_variable": MIN_DISTINCT_SITES,
                         "low_quality_counts_toward_calibration": False},
        "subsystem_states": states,
        "subsystems": subsystems,
    }


def pending_counts(records: Iterable[ObservationRecord]) -> dict[str, int]:
    """Review-queue view: how many records are in each approval status. Kept apart from the report."""
    out = {"draft": 0, "approved": 0, "rejected": 0}
    for r in records:
        out[r.approval_status] += 1
    return out
