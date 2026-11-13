"""Residuals: where, and by how much, the model's predictions missed what the site measured.

Pure functions over a list of ``ObservationRecord``. No I/O, no clock, no randomness.

Rules that shape the output:

  * Only ``approved`` records are ever read. A draft or rejected record changes nothing in the report,
    not even a count; ``pending_counts`` reports them separately for the review queue.
  * There is NO global accuracy number. Errors are in the variable's own unit, so they are reported per
    variable, rolled up to a per-subsystem *state*, and never averaged across subsystems.
  * Percentage error is undefined (``None``), never zero, when the measured value is zero.
  * A variable is CALIBRATED only with at least ``MIN_APPROVED_OBSERVATIONS`` approved, non-low-quality
    observations from at least ``MIN_DISTINCT_SITES`` distinct sites, with no one site supplying more than
    ``publication.MAX_SINGLE_SITE_SHARE`` of them (fifty readings from one hall are one hall). A subsystem is
    CALIBRATED only when every variable in it is. Below that the state is INDICATIVE (some data) or
    UNCALIBRATED, with the count and, when it is not the count, the reason.
  * Statistics are taken over SITES: each site's own mean first, then the mean (or median) of those, so a
    site that reports often counts once. ``n`` / ``n_readings`` and ``sites`` / ``n_sites`` are reported apart.
  * Records of different ``model_version`` are never pooled into one headline. The headline of a variable is
    the build with the most contributing sites; the others are counted (``by_model_version``, private report
    only) and not mixed in.
  * Sums use ``math.fsum`` and inputs are sorted by id first, so the result does not depend on input order.

What leaves the process (``public_report``) is held to the publication rules in ``publication.py``:

  * a cell is published only if it rests on ``PUBLIC_MIN_SITES`` (5) distinct sites, otherwise it is reduced to its counts. The sites whose
    errors run in one direction must also be absent or at least that many: a mean error and a mean absolute error together are the mean
    positive part and the mean negative part, and one site off the other way from four would be the second of them;
  * a published cell carries means over sites only: no median, maximum, minimum or percentile (with three sites a mean, a median and a
    maximum are all three sites);
  * COMPLEMENTARY SUPPRESSION. A published total minus the published cells of a breakdown is the cells that were withheld. So when any
    cell of a breakdown is withheld, published cells are withheld too, fewest sites first, until the withheld cells together span at
    least ``PUBLIC_MIN_SITES`` sites (the lead-time breakdown also counts the readings that carry no lead time, which it never lists).
    Then the difference is an aggregate of five or more sites, never a small group;
  * a breakdown is published only if every site lies wholly inside one of its cells. Statistics are over sites, so a site with readings in
    two cells is a different entry in each and in the total; the total minus the cells is then that site (equal readings in both cells
    give its mean exactly). Otherwise its cells show counts only;
  * at most ``MAX_PUBLISHED_BREAKDOWNS`` (1) breakdown is published per variable, the one with most published cells (ties: capacity,
    evidence class, lead time). Two overlapping breakdowns subtract from each other (a cell inside another, one site short of it, gives
    that site), and checking every pair is not enough, so only one is shown;
  * every published figure is rounded to three significant figures.
  tests/test_calibration_disclosure_hardening.py runs the subtraction attack over 400 seeded random ledgers (and shows the same attacker
  wins when these rules are switched off).
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Iterable

from . import publication as pub
from .records import SUBSYSTEMS, VARIABLES, ObservationRecord

SCHEMA = "gridforge.calibration.residuals/1"

#: Deliberately more conservative than the ratio ledger (stats.CALIBRATED_MIN = 5): this framework backs a
#: per-variable claim, and a spread from ten readings is still thin. A test pins both, and that these are
#: never lower than the ledger's. (The share one site may supply, and the sites a statistic needs to be PUBLISHED, are in publication.py.)
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


def _site_table(recs: list[ObservationRecord]) -> dict[str, tuple]:
    """Each site's own figures first, in site-id order: site -> (mean signed error, mean absolute error, median percentage error or
    None, number of readings). Every statistic below is taken over these rows, so a site that reports often counts once."""
    by_site: dict[str, list[Residual]] = {}
    for r in recs:
        by_site.setdefault(r.site_id, []).append(residual(r))
    table: dict[str, tuple] = {}
    for site in sorted(by_site):
        xs = by_site[site]
        pcts = [x.percentage_error for x in xs if x.percentage_error is not None]
        table[site] = (_mean([x.signed_error for x in xs]), _mean([x.absolute_error for x in xs]), _median(pcts), len(xs))
    return table


def _interval_over_sites(table: dict) -> dict:
    """The Student-t interval over the sites' means for the signed and the absolute error, or the reason there is none (publication.py)."""
    signed = pub.site_interval({s: t[0] for s, t in table.items()})
    if not signed["published"]:
        return signed
    absolute = pub.site_interval({s: t[1] for s, t in table.items()})
    return {"published": True, "confidence": signed["confidence"], "df": signed["df"], "method": signed["method"],
            "mean_signed_error": {"low": signed["low"], "high": signed["high"]},
            "mean_abs_error": {"low": absolute["low"], "high": absolute["high"]},
            "label": signed["label"]}


def _cell_extras(table: dict, n_readings: int) -> dict:
    counts = [t[3] for t in table.values()]
    return dict(n_readings=n_readings, n_sites=len(table), max_site_share=_r(pub.largest_share(counts)),
                interval_over_sites=_interval_over_sites(table))


def _stats(recs: list[ObservationRecord]) -> dict:
    res = [residual(r) for r in recs]
    table = _site_table(recs)
    site_abs = [t[1] for t in table.values()]
    site_signed = [t[0] for t in table.values()]
    site_pct = [t[2] for t in table.values() if t[2] is not None]
    pcts = [x.percentage_error for x in res if x.percentage_error is not None]
    cell = {
        "n": len(recs),
        "sites": len(table),
        "mean_abs_error": _r(_mean(site_abs)),                              # over sites: each site's own mean first
        "median_abs_error": _r(_median(site_abs)),                          # median of the site means
        "max_abs_error": _r(max(x.absolute_error for x in res) if res else None),   # the worst single reading: operator view, never published
        "mean_signed_error": _r(_mean(site_signed)),                        # + means the model over-predicts
        "median_pct_error": _r(_median(site_pct)),                          # median of the sites' median percentage errors
        "pct_error_defined_n": len(pcts),
        "pct_error_undefined_n": len(res) - len(pcts),                      # measured == 0
    }
    cell.update(_cell_extras(table, len(recs)))
    return cell


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
        "sites": len({r.site_id for r in with_iv}),
        "hits": hits,
        "observed_coverage": _r(cov),
        "nominal_coverage": nominal,
        "coverage_minus_nominal": _r(cov - nominal) if (assessed and cov is not None and nominal is not None) else None,
        "assessed": assessed,
        "note": ("observed share of measurements inside the stated interval; compare with the nominal level"
                 if assessed else f"not assessed: fewer than {MIN_APPROVED_OBSERVATIONS} intervals"),
    }


def _distinct_measurements(recs: list[ObservationRecord]) -> list[ObservationRecord]:
    """One record per physical measurement. Records that carry the same variable, instant, predicted and measured values are the same
    measurement entered more than once (under different ids or site references), and counting them separately would let replication
    stand in for evidence."""
    seen: set[tuple] = set()
    out: list[ObservationRecord] = []
    for r in recs:
        key = (r.variable, r.measured_at, r.predicted, r.measured)
        if key not in seen:
            seen.add(key)
            out.append(r)
    return out


def _eligible(recs: list[ObservationRecord]) -> list[ObservationRecord]:
    """The records that count toward a calibration claim: distinct measurements of acceptable quality."""
    return [r for r in _distinct_measurements(recs) if r.quality != "low"]


def _headline_records(recs: list[ObservationRecord]) -> list[ObservationRecord]:
    """The records of ONE engine build: never a pool across builds. With several ``model_version`` values it is the build with the most
    contributing sites (then the most observations, then the later version string, so the choice is deterministic and does not depend on
    input order); the others are counted apart and not mixed in."""
    by_version: dict[str, list[ObservationRecord]] = {}
    for r in recs:
        by_version.setdefault(r.model_version, []).append(r)
    if len(by_version) <= 1:
        return list(recs)

    def weight(item: tuple[str, list[ObservationRecord]]) -> tuple:
        version, rs = item
        el = _eligible(rs)
        return (len({r.site_id for r in el}), len(el), len(rs), version)

    return max(by_version.items(), key=weight)[1]


def _spread_ok(eligible: list[ObservationRecord]) -> bool:
    counts: dict[str, int] = {}
    for r in eligible:
        counts[r.site_id] = counts.get(r.site_id, 0) + 1
    return pub.share_ok(counts.values())


def variable_state(recs: list[ObservationRecord]) -> str:
    eligible = _eligible(_headline_records(recs))
    if (len(eligible) >= MIN_APPROVED_OBSERVATIONS
            and len({r.site_id for r in eligible}) >= MIN_DISTINCT_SITES
            and _spread_ok(eligible)):
        return CALIBRATED
    return INDICATIVE if recs else UNCALIBRATED


def _state_reason(eligible: list[ObservationRecord]) -> str:
    """Why a variable with records is not CALIBRATED: the count, the sites, or one site supplying too much of it."""
    sites = {r.site_id for r in eligible}
    counts: dict[str, int] = {}
    for r in eligible:
        counts[r.site_id] = counts.get(r.site_id, 0) + 1
    parts = []
    if len(eligible) < MIN_APPROVED_OBSERVATIONS:
        parts.append(f"{len(eligible)} of the {MIN_APPROVED_OBSERVATIONS} distinct non-low-quality observations needed")
    if len(sites) < MIN_DISTINCT_SITES:
        parts.append(f"{len(sites)} of the {MIN_DISTINCT_SITES} distinct sites needed")
    if not _spread_ok(eligible):
        parts.append(f"one site supplies {round(100 * pub.largest_share(counts.values()))}% of the observations, above the "
                     f"{round(100 * pub.MAX_SINGLE_SITE_SHARE)}% any one site may supply")
    return "; ".join(parts) + "."


def _capacity_key(r: ObservationRecord) -> str:
    return capacity_bucket(r.capacity_mw)


def _evidence_key(r: ObservationRecord) -> str:
    return r.evidence.short


def _lead_key(r: ObservationRecord) -> str | None:
    return None if r.lead_time_hours is None else lead_time_bucket(r.lead_time_hours)


#: The breakdowns of a variable, in the order that settles a tie when only one is published (see ``_public_breakdowns``).
_FAMILIES = (("by_capacity_bucket", _capacity_key, CAPACITY_BUCKETS),
             ("by_evidence_class", _evidence_key, None),
             ("lead_time_error", _lead_key, LEAD_TIME_BUCKETS))


def _basis_fields(recs: list[ObservationRecord], state: str, eligible: list[ObservationRecord]) -> dict:
    """What the headline of a variable rests on: that its statistics are over sites, which builds it spans, and why it is not CALIBRATED."""
    versions: dict[str, list[ObservationRecord]] = {}
    for r in recs:
        versions.setdefault(r.model_version, []).append(r)
    out: dict = {
        "statistics_basis": ("Statistics are taken over sites: each site's own mean first, then the mean of those, so a site that reports "
                             "often counts once. n_readings and n_sites are reported separately."),
        "model_versions": {"n_versions": len(versions), "pooled": False,
                           "headline": ("the build with the most contributing sites; other builds are not pooled into it"
                                        if len(versions) > 1 else "the one build recorded")},
    }
    if len(versions) > 1:
        # Version strings are typed by the submitter: they appear in the private report only, never in the public one.
        out["by_model_version"] = {v: {"n": len(rs), "sites": len({r.site_id for r in rs}), "state": variable_state(rs)}
                                   for v, rs in sorted(versions.items())}
    if state != CALIBRATED:
        out["state_reason"] = _state_reason(eligible)
    return out


def _variable_block(variable: str, recs: list[ObservationRecord]) -> dict:
    state = variable_state(recs)
    headline = _headline_records(recs)
    eligible = _eligible(headline)
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
        block["residuals"] = _stats(headline)
        block["by_configuration"] = _grouped(headline, lambda r: r.configuration or "unspecified")
        block["by_capacity_bucket"] = _grouped(headline, _capacity_key, CAPACITY_BUCKETS)
        block["by_evidence_class"] = _grouped(headline, _evidence_key)
        block["lead_time_error"] = _grouped(headline, _lead_key, LEAD_TIME_BUCKETS)
        block["interval_coverage"] = interval_coverage(headline)
        block.update(_basis_fields(recs, state, eligible))
    return block


def subsystem_statement(name: str, state: str, n: int, n_sites: int) -> str:
    if state == UNCALIBRATED:
        return f"{name}: UNCALIBRATED (n={n} approved observations). Figures are modelled; accuracy is unquantified."
    if state == INDICATIVE:
        return (f"{name}: INDICATIVE (n={n} approved observations from {n_sites} site(s)); at least "
                f"{MIN_APPROVED_OBSERVATIONS} per variable from {MIN_DISTINCT_SITES} distinct sites, no one site supplying more than "
                f"{round(100 * pub.MAX_SINGLE_SITE_SHARE)}% of them, is required before any variable here is called calibrated.")
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
    requirements = {"min_approved_observations_per_variable": MIN_APPROVED_OBSERVATIONS,
                    "min_distinct_sites_per_variable": MIN_DISTINCT_SITES,
                    "low_quality_counts_toward_calibration": False}
    if recs:        # with no record the report is exactly what it was before these rules existed
        requirements.update(max_single_site_share=pub.MAX_SINGLE_SITE_SHARE, min_sites_to_publish_statistics=pub.PUBLIC_MIN_SITES)
    return {
        "schema": SCHEMA,
        "headline": headline,
        "requirements": requirements,
        "subsystem_states": states,
        "subsystems": subsystems,
    }


def pending_counts(records: Iterable[ObservationRecord]) -> dict[str, int]:
    """Review-queue view: how many records are in each approval status. Kept apart from the report."""
    out = {"draft": 0, "approved": 0, "rejected": 0}
    for r in records:
        out[r.approval_status] += 1
    return out


# --- the aggregate views that leave the process -------------------------------

PUBLIC_SCHEMA = "gridforge.calibration.residuals.public/1"


def _eligible_records(records: Iterable[ObservationRecord]) -> list[ObservationRecord]:
    """Approved records that also meet the ledger's evidence floor. The record type already refuses anything below
    it; this is the second lock, so no path can put a model-run number into a statistic."""
    from .schema import MINIMUM_EVIDENCE
    return [r for r in approved(records) if r.evidence >= MINIMUM_EVIDENCE]


def _few_sites_reason() -> str:
    return f"fewer than {pub.PUBLIC_MIN_SITES} sites: no statistic and no interval over sites is published"


def _complementary_reason() -> str:
    return ("withheld so that the cell withheld beside it cannot be recovered by subtracting the published cells from the total "
            "(published cells are withheld, fewest sites first, until the withheld ones span "
            f"{pub.PUBLIC_MIN_SITES} sites)")


def _one_breakdown_reason() -> str:
    return (f"withheld: {pub.MAX_PUBLISHED_BREAKDOWNS} breakdown per variable is published, because overlapping breakdowns "
            "can be subtracted from one another to recover a small group")


def _straddle_reason() -> str:
    return ("withheld: some sites have readings in more than one cell of this breakdown, so subtracting its cells from the total "
            "would isolate those sites")


def _one_sided_reason() -> str:
    return (f"the errors of fewer than {pub.PUBLIC_MIN_SITES} sites run in one direction, and the mean error with the mean absolute error "
            "would isolate them: no statistic is published")


def _sides_ok(recs: list[ObservationRecord]) -> bool:
    """The mean error and the mean absolute error together give the mean over sites of the positive parts and of the negative parts
    separately (error = positive - negative, absolute = positive + negative). If the errors of just one site (or four) run the other
    way from the rest, that second figure IS those sites. So each direction must be absent or carried by at least PUBLIC_MIN_SITES sites."""
    pos = {r.site_id for r in recs if r.predicted > r.measured}
    neg = {r.site_id for r in recs if r.predicted < r.measured}
    return all(len(side) == 0 or len(side) >= pub.PUBLIC_MIN_SITES for side in (pos, neg))


def _publishable(recs: list[ObservationRecord]) -> bool:
    return len({r.site_id for r in recs}) >= pub.PUBLIC_MIN_SITES and _sides_ok(recs)


def _why_not(recs: list[ObservationRecord]) -> str:
    return _few_sites_reason() if len({r.site_id for r in recs}) < pub.PUBLIC_MIN_SITES else _one_sided_reason()


def _suppressed(recs: list[ObservationRecord], reason: str) -> dict:
    return {"n": len(recs), "sites": len({r.site_id for r in recs}), "suppressed": reason}


def _public_cell(recs: list[ObservationRecord], *, with_interval: bool = False) -> dict:
    """A published cell: means over sites, rounded, with counts. Never a median, maximum, minimum or percentile; those are the readings of
    individual sites when the sites are few. Built from the records, not from the private cell, so nothing private rides along."""
    table = _site_table(recs)
    pcts = sum(1 for r in recs if residual(r).percentage_error is not None)
    cell = {
        "n": len(recs),
        "sites": len(table),
        "n_readings": len(recs),
        "n_sites": len(table),
        "mean_abs_error": pub.round_sig(_mean([t[1] for t in table.values()])),
        "mean_signed_error": pub.round_sig(_mean([t[0] for t in table.values()])),
        "pct_error_defined_n": pcts,
        "pct_error_undefined_n": len(recs) - pcts,
    }
    if with_interval:
        cell["interval_over_sites"] = _interval_over_sites(table)
    return cell


def _public_breakdowns(recs: list[ObservationRecord], total_published: bool) -> dict[str, dict]:
    """The breakdowns of one variable as they may be published: complementary suppression within each, and one breakdown at most (see the
    module docstring). ``recs`` are the headline records, i.e. exactly what the variable's total is made of."""
    plans = []
    for name, keyfn, order in _FAMILIES:
        groups: dict[str, list[ObservationRecord]] = {}
        unlisted: list[ObservationRecord] = []             # records this breakdown never lists (a reading with no lead time)
        for r in recs:
            g = keyfn(r)
            if g is None:
                unlisted.append(r)
            else:
                groups.setdefault(g, []).append(r)
        names = [g for g in order if g in groups] if order else sorted(groups)
        sites = {g: {r.site_id for r in groups[g]} for g in names}
        cells_of_site: dict[str, set] = {}
        for r in recs:
            cells_of_site.setdefault(r.site_id, set()).add(keyfn(r))     # None is "not listed": a cell the breakdown never shows
        reasons = {g: _why_not(groups[g]) for g in names if not _publishable(groups[g])}
        if any(len(cells) > 1 for cells in cells_of_site.values()):
            # A site with readings in two cells is not one entry in either: each cell's mean over sites then differs from the total's
            # by that site's share in a way the other cells do not account for, and subtracting the cells from the total isolates it.
            reasons = {g: _straddle_reason() for g in names}
        elif pub.COMPLEMENTARY_SUPPRESSION and (reasons or unlisted):
            hidden = list(unlisted) + [r for g in reasons for r in groups[g]]
            while not _publishable(hidden):
                open_cells = [g for g in names if g not in reasons]
                if not open_cells:
                    break
                g = min(open_cells, key=lambda c: (len(sites[c]), c))
                reasons[g] = _complementary_reason()
                hidden += groups[g]
        plans.append((name, groups, names, reasons, [g for g in names if g not in reasons]))
    order_by_cells = sorted(range(len(plans)), key=lambda i: (-len(plans[i][4]), i))
    chosen = {plans[i][0] for i in order_by_cells[:pub.MAX_PUBLISHED_BREAKDOWNS] if plans[i][4]} if total_published else set()
    out: dict[str, dict] = {}
    for name, groups, names, reasons, published in plans:
        out[name] = {g: (_public_cell(groups[g]) if (name in chosen and g in published)
                         else _suppressed(groups[g], reasons.get(g) or _one_breakdown_reason()))
                     for g in names}
    return out


def _public_variable(block: dict, recs: list[ObservationRecord]) -> dict:
    """One variable as it may be published. ``recs`` are all its approved records (the headline build is picked from them exactly as the
    private block picked it)."""
    out = {k: v for k, v in block.items()
           if k not in ("residuals", "by_configuration", "by_model_version", "by_capacity_bucket", "by_evidence_class",
                        "lead_time_error", "interval_coverage")}
    if "residuals" in block:
        headline = _headline_records(recs)
        total_published = _publishable(headline)
        # by_configuration is keyed by free text a submitter typed: never published. Nor is any model_version string.
        out["residuals"] = _public_cell(headline, with_interval=True) if total_published else _suppressed(headline, _why_not(headline))
        out.update(_public_breakdowns(headline, total_published))
        iv = block["interval_coverage"]
        if iv["assessed"] and iv["sites"] >= pub.PUBLIC_MIN_SITES:
            out["interval_coverage"] = iv
        else:
            out["interval_coverage"] = {
                "n_intervals": iv["n_intervals"], "assessed": False,
                "note": (iv["note"] if not iv["assessed"]
                         else f"not published: the intervals rest on fewer than {pub.PUBLIC_MIN_SITES} sites")}
    return out


#: Variables the PUBLIC tier already redacts elsewhere as paid content (see gridforge/api/tiers.py: capex and schedule figures). Their residual
#: statistics are held to the same rule: they stay in the private report and the CLI and are not published, so the public route never shows
#: more about money or dates than the rest of the public tier does. Everything the public report says is computed WITHOUT these records.
WITHHELD_FROM_PUBLIC: frozenset[str] = frozenset({"capex_total_eur", "weeks_to_full"})


def public_report(records: Iterable[ObservationRecord]) -> dict:
    """``residual_report`` over approved records, reduced to what may be published: aggregate statistics only.

    No site id, hall id, observation id, model version, free text (the per-configuration breakdown is dropped) or individual
    measurement appears. A cell resting on fewer than ``PUBLIC_MIN_SITES`` sites shows counts only; so may others, to stop a withheld cell
    being recovered by subtraction; and only one breakdown per variable is shown (see the module docstring and ``publication.py``).
    Variables in ``WITHHELD_FROM_PUBLIC`` are not published and are named as withheld; every count, state and the
    headline are derived from the published variables only, so nothing about a withheld one leaks through them.
    With no approved record the state is ``uncalibrated`` and ``n_records`` is 0.
    """
    recs = [r for r in _eligible_records(records) if r.variable not in WITHHELD_FROM_PUBLIC]
    rep = residual_report(recs)
    by_var: dict[str, list[ObservationRecord]] = {v: [] for v in VARIABLES}
    for r in recs:
        by_var[r.variable].append(r)
    published = [s for s in SUBSYSTEMS
                 if any(spec[0] == s and v not in WITHHELD_FROM_PUBLIC for v, spec in VARIABLES.items())]
    states = {s: rep["subsystem_states"][s] for s in published}
    state = ("calibrated" if published and all(v == CALIBRATED for v in states.values())
             else "indicative" if recs else "uncalibrated")
    subsystems = {}
    for name in published:
        sub = rep["subsystems"][name]
        subsystems[name] = {**{k: v for k, v in sub.items() if k != "variables"},
                            "variables": {v: _public_variable(b, by_var[v]) for v, b in sub["variables"].items()
                                          if v not in WITHHELD_FROM_PUBLIC}}
    headline = ("Calibration is reported per subsystem; no single accuracy figure is produced. "
                + " ".join(f"{s}: {subsystems[s]['state']} (n={subsystems[s]['approved_observations']})." for s in published))
    return {
        "schema": PUBLIC_SCHEMA,
        "state": state,
        "n_records": len(recs),
        "n_sites": len({r.site_id for r in recs}),
        "headline": headline,
        "requirements": rep["requirements"],
        "subsystem_states": states,
        "subsystems": subsystems,
        "withheld_variables": sorted(WITHHELD_FROM_PUBLIC),
        "note": ("Aggregate statistics over human-approved site observations only. Errors are in each variable's own "
                 "unit and are never combined into one accuracy figure. A measured-versus-predicted residual describes "
                 "this engine's past error at the contributing sites; it is not a guarantee for any other site. "
                 "Capex and schedule residuals are withheld from the public report, as those figures are elsewhere on "
                 "the public tier."),
    }


def disclosure_summary(records: Iterable[ObservationRecord]) -> dict | None:
    """What the deliverables say about approved records, in the same vocabulary as ``residual_report``.

    None when there are no approved records, so a caller can leave its output exactly as it was.
    """
    recs = _eligible_records(records)
    if not recs:
        return None
    by_var: dict[str, list[ObservationRecord]] = {}
    for r in recs:
        by_var.setdefault(r.variable, []).append(r)
    variables = {}
    for v in sorted(by_var):
        rs = by_var[v]
        eligible = _eligible(_headline_records(rs))
        variables[v] = {"state": variable_state(rs), "approved_observations": len(rs),
                        "distinct_sites": len({r.site_id for r in eligible})}
    n_sites = len({r.site_id for r in recs})
    parts = "; ".join(f"{v} {b['state']} (n={b['approved_observations']}, {b['distinct_sites']} site(s))"
                      for v, b in variables.items())
    unrecorded = len(VARIABLES) - len(variables)
    statement = (
        f"Residual records: {len(recs)} approved site observation(s) across {n_sites} site(s). Per variable: {parts}."
        + (f" {unrecorded} other variable(s) have no approved record and remain UNCALIBRATED." if unrecorded else "")
        + f" A variable is called CALIBRATED only with at least {MIN_APPROVED_OBSERVATIONS} approved, non-low-quality "
          f"observations from {MIN_DISTINCT_SITES} distinct sites, no one site supplying more than "
          f"{round(100 * pub.MAX_SINGLE_SITE_SHARE)}% of them; no single accuracy figure is produced.")
    return {"n_records": len(recs), "n_sites": n_sites, "variables": variables,
            "variables_without_records": unrecorded, "statement": statement}
