"""What may leave the building about calibration, and how it is allowed to be stated.

Pure functions and constants, shared by the ratio ledger (``stats`` / ``disclosure``) and the residual framework (``residuals``), so the two
cannot publish by different rules. Nothing here does I/O.

THE RULES (each is a constant below; each is tested at its boundary in tests/test_calibration_disclosure_hardening.py)

  1. A statistic is published only when it rests on at least ``PUBLIC_MIN_SITES`` distinct SITES (not halls, not readings). Below that
     the cell shows its counts and says why. This is separate from, and higher than, the floor for the CALIBRATED label
     (``residuals.MIN_DISTINCT_SITES``): a variable can be called calibrated from three sites and still publish no number.
  2. A published cell carries means only, taken over SITES (each site's own mean first), never a median, a maximum, a minimum or a
     percentile. With a handful of sites those order statistics ARE individual sites: a mean, a median and a maximum over three sites
     name all three.
  3. A cell may not be recoverable by subtraction (see ``residuals`` for the layout it applies to):
       * complementary suppression: when a cell is withheld, the cells that remain published must leave at least ``PUBLIC_MIN_SITES``
         sites unaccounted for, or a published total minus the published cells isolates the withheld one. More cells are withheld,
         smallest first, until they do;
       * at most ``MAX_PUBLISHED_BREAKDOWNS`` breakdown (capacity, evidence class, lead time) is published per variable, because two
         overlapping breakdowns subtract from one another (a cell inside another, differing by one site, gives that site).
  4. Published figures are rounded to ``PUBLIC_SIG_FIGS`` significant figures. This is a second defence, not the rule: it turns an exact
     recovery into an approximate one, and it blunts the difference between two releases.
  5. A figure that claims to describe the model is stated with an interval over sites where there are enough sites for one, and with
     none, and the reason, where there are not.

HARD PRECONDITION FOR PUBLISHING ANY REAL OBSERVATION (review R4, not solved here)

  The public report is unauthenticated and recomputed on every request. A reader who records it before and after one site is added
  computes N' x mean' - N x mean and gets that site's signed error (253 of 254 seeded trials had the right sign, median relative error 0.16%
  even with three-figure rounding). Nothing in a pure function can stop that: it needs successive releases to be a policy decision, i.e.
  the report served from a snapshot refreshed on a fixed cadence and only when at least ``PUBLIC_MIN_SITES`` new sites have joined since the
  last one (so a release difference is an aggregate of five sites, never one), or no public statistic at all. The shipped ledger holds
  0 observations, so nothing is exposed today; DO NOT put a real observation into the ledger or the record store, or serve the report
  over one, before that exists. The report states this in ``requirements.release_precondition`` once it has any record.

WHAT ELSE THIS DOES NOT DEFEND AGAINST: a reader who already knows every other site's figures can solve for the last, and the rounding
above only blunts a difference, it does not remove it.
"""
from __future__ import annotations

import math
from typing import Iterable, Sequence

#: Distinct sites a published statistic must rest on. Five, because the interval over sites needs a handful to mean anything and because
#: three sites with any two order statistics is all three sites.
PUBLIC_MIN_SITES = 5
#: The most one site may contribute of the observations a CALIBRATED claim rests on. A site that supplies 48 of 50 readings is one site
#: however many halls or days it has: the claim is about sites. 0.4 with a floor of three sites means each of three must supply at least a
#: fifth; the line itself is allowed (4 of 10 passes, 5 of 10 does not).
MAX_SINGLE_SITE_SHARE = 0.4
#: Breakdowns published per variable, besides its total (see rule 3).
MAX_PUBLISHED_BREAKDOWNS = 1
#: Rule 3, first half. A switch only so a test can prove the attacker in tests/ finds something when it is off; production never sets it.
COMPLEMENTARY_SUPPRESSION = True
#: Significant figures of a published statistic. None switches the rounding off (tests only).
PUBLIC_SIG_FIGS: int | None = 3
INTERVAL_CONFIDENCE = 0.95
INTERVAL_LABEL = "interval over sites, assumes sites are exchangeable; not a guarantee for any given hall"
POOLED_UNRECORDED = "pooled across unrecorded model versions"
RELEASE_PRECONDITION = ("Successive releases of this report differ by the sites added between them, and the difference of two releases is "
                        "that site's contribution. Real observations are published only from a snapshot refreshed on a fixed cadence and "
                        f"only after at least {PUBLIC_MIN_SITES} new sites have joined since the last release.")

#: Labels that name no build. A record carrying one is "unrecorded", never "the one build recorded".
UNRECORDED_BUILD_LABELS = frozenset({"", "unknown", "unrecorded", "none", "null", "n/a", "na", "unspecified", "tbd", "?", "-", "unversioned"})
_RUNNING_LABELS: list[str] = []


def register_running_build(label: str) -> None:
    """The API layer names the engine that is answering (its version label), so a record made against that label is recognised as this build."""
    if label and label not in _RUNNING_LABELS:
        _RUNNING_LABELS.append(label)


def running_build_ids() -> tuple[str, ...]:
    """Everything the running engine is called by: the labels registered with ``register_running_build`` and the sha256 of its own code
    (``gridforge.provenance.code_sha256``). Empty when neither can be had."""
    ids = list(_RUNNING_LABELS)
    try:
        from ..provenance import code_sha256
        ids.append(code_sha256())
    except Exception:           # the digest is unavailable (an unreadable package directory): the relation is then "unknown", not a guess
        pass
    return tuple(ids)


def build_relation(identifier: str | None) -> str:
    """How a recorded build relates to the one answering: 'running', 'other', 'unrecorded' (names no build) or 'unknown' (the running
    build cannot be determined, so nothing can be said). A digest of twelve characters or more matches by prefix."""
    ident = (identifier or "").strip()
    if ident.lower() in UNRECORDED_BUILD_LABELS:
        return "unrecorded"
    ids = running_build_ids()
    if not ids:
        return "unknown"
    return "running" if any(ident == i or (len(ident) >= 12 and i.startswith(ident)) for i in ids) else "other"


BUILD_RELATION_TEXT = {
    "running": "the build answering this request",
    "other": ("a build other than the one answering this request: a calibration of another build is not a calibration of this one"),
    "unrecorded": ("no build recorded (" + POOLED_UNRECORDED + "): it cannot be shown to be the build answering this request"),
    "unknown": "the build answering this request could not be determined, so it cannot be shown whether this is it",
}

#: Two-sided 95% Student-t quantiles, df = 1..30 (the 0.975 point of the t distribution). The standard tabulated values; the standard
#: library has no t quantile and the engine takes no dependencies.
_T_975 = (12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228,
          2.201, 2.179, 2.160, 2.145, 2.131, 2.120, 2.110, 2.101, 2.093, 2.086,
          2.080, 2.074, 2.069, 2.064, 2.060, 2.056, 2.052, 2.048, 2.045, 2.042)


def t_quantile_975(df: int) -> float:
    """The 97.5th percentile of Student's t with ``df`` degrees of freedom. Above 30 the df=30 value is used: slightly wider than the exact
    quantile (2.000 at 60, 1.980 at 120), so an interval is never narrower than it should be."""
    if isinstance(df, bool) or not isinstance(df, int) or df < 1:
        raise ValueError(f"degrees of freedom must be a whole number of at least 1, not {df!r}")
    return _T_975[min(df, len(_T_975)) - 1]


def round_sig(x: float | None, sig: int | None = None) -> float | None:
    """``x`` to ``sig`` significant figures (the module's ``PUBLIC_SIG_FIGS`` when not given; None leaves it as it is)."""
    sig = PUBLIC_SIG_FIGS if sig is None else sig
    if x is None or sig is None or x == 0 or not math.isfinite(x):
        return x
    return round(x, sig - 1 - int(math.floor(math.log10(abs(x))))) + 0.0


def share_ok(counts: Iterable[int], limit: float | None = None) -> bool:
    """Does the largest of ``counts`` stay within ``limit`` (default MAX_SINGLE_SITE_SHARE) of their total? Whole-number arithmetic on the
    limit read to a thousandth, not floating point: 4 of 10 against 0.4 is on the line and passes."""
    xs = [c for c in counts if c > 0]
    if not xs:
        return True
    permille = round((MAX_SINGLE_SITE_SHARE if limit is None else limit) * 1000)
    return max(xs) * 1000 <= permille * sum(xs)


def largest_share(counts: Iterable[int]) -> float:
    xs = [c for c in counts if c > 0]
    return max(xs) / sum(xs) if xs else 0.0


def mean(xs: Sequence[float]) -> float | None:
    return math.fsum(xs) / len(xs) if xs else None


def median(xs: Sequence[float]) -> float | None:
    if not xs:
        return None
    s = sorted(xs)
    m = len(s) // 2
    return s[m] if len(s) % 2 else (s[m - 1] + s[m]) / 2.0


def site_interval(site_values: dict[str, Sequence[float]] | dict[str, float]) -> dict:
    """A Student-t interval for the mean of the SITES' own means.

    ``site_values`` maps each site to its own figure (a number) or to the readings of that site (averaged first). Returns
    ``{"published": False, "reason": ...}`` when there are fewer than ``PUBLIC_MIN_SITES`` sites, otherwise the interval, its degrees of
    freedom and the label that says what it is and is not. It is an interval for the average site, assuming sites are exchangeable draws;
    it says nothing about any one hall."""
    means = [float(v) if isinstance(v, (int, float)) else mean(list(v)) for v in site_values.values()]
    means = [m for m in means if m is not None]
    n = len(means)
    if n < PUBLIC_MIN_SITES:
        return {"published": False,
                "reason": f"fewer than {PUBLIC_MIN_SITES} sites (n_sites={n}): no interval over sites is published, because an interval "
                          "from so few sites would describe those sites rather than the model",
                "label": INTERVAL_LABEL}
    m = math.fsum(means) / n
    sd = math.sqrt(math.fsum((x - m) ** 2 for x in means) / (n - 1))
    half = t_quantile_975(n - 1) * sd / math.sqrt(n)
    return {"published": True, "confidence": INTERVAL_CONFIDENCE, "df": n - 1,
            "method": "Student-t interval on the means of the sites",
            "low": round_sig(m - half), "high": round_sig(m + half), "label": INTERVAL_LABEL}
