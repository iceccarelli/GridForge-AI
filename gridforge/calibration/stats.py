"""Turning a handful of observations into a statement we can defend.

The temptation with a small n is to report a mean and call it calibration. Five
halls do not give you a mean worth quoting, so this module reports what the data
actually supports and refuses to dress it up: a state, a count, a median ratio and
an observed spread. Nothing here smooths, fits or extrapolates.

Three rules keep a small or lopsided record from passing for more than it is (the thresholds are named in ``publication.py``):

  * CALIBRATED needs enough observations from enough SITES, and no one site may supply more than ``MAX_SINGLE_SITE_SHARE`` of them. Five
    readings from one hall are one hall; so are forty-eight of fifty.
  * The ratio, the spread and the interval are taken over SITES (each site's own mean first). ``n`` (readings) and ``sites`` are separate.
  * Observations made against different engine builds (``model_digest``) are never pooled. The headline is the build with the most sites;
    observations against other builds are counted, and not mixed in. Observations that carry no digest are one group, and are labelled
    "pooled across unrecorded model versions" wherever they headline a figure.

``Calibration.public_dict()`` is what leaves the process: below ``PUBLIC_MIN_SITES`` sites it prints no ratio, range or date (a single
site's exact ratio and the day it was measured identify it), and above it the ratio carries an interval over sites and a month, not a day.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from enum import Enum

from . import publication as pub
from .keys import HIGHER_OBSERVED_IS_OPTIMISTIC
from .schema import Observation

# n < INDICATIVE_MIN      : we know nothing
# INDICATIVE_MIN <= n < CALIBRATED_MIN : we have signals, not statistics
# n >= CALIBRATED_MIN     : a spread worth printing next to a number
INDICATIVE_MIN = 1
CALIBRATED_MIN = 5
#: Five readings from one hall are one hall. A spread is only a spread across sites.
CALIBRATED_MIN_SITES = 3


class CalibrationState(Enum):
    UNCALIBRATED = "uncalibrated"
    INDICATIVE = "indicative"
    CALIBRATED = "calibrated"

    @property
    def sentence(self) -> str:
        return _SENTENCE[self]


_SENTENCE = {
    CalibrationState.UNCALIBRATED: (
        "No site observations have been reconciled against this model output. The figure "
        "is modelled and its accuracy is unquantified."),
    CalibrationState.INDICATIVE: (
        "Too few reconciled sites to quote a spread. The observations to date are reported "
        "individually and should be read as signals, not statistics."),
    CalibrationState.CALIBRATED: (
        "Reconciled against instrumented sites. The median ratio and the observed spread "
        "are reported; the spread is what has been seen, not a confidence interval."),
}


def _median(xs: list[float]) -> float:
    s = sorted(xs)
    n = len(s)
    if n == 0:
        return 0.0
    mid = n // 2
    return s[mid] if n % 2 else (s[mid - 1] + s[mid]) / 2.0


def _quantile(xs: list[float], q: float) -> float:
    """Nearest-rank. With n in single digits, interpolation invents precision."""
    s = sorted(xs)
    if not s:
        return 0.0
    idx = max(0, min(len(s) - 1, int(round(q * (len(s) - 1)))))
    return s[idx]


def _month(iso: str | None) -> str | None:
    """YYYY-MM of an ISO date: the day a site was measured identifies the visit."""
    return iso[:7] if iso else None


@dataclass(frozen=True)
class Calibration:
    key: str
    n: int                          # readings behind the headline (the headline build's observations)
    sites: int                      # distinct SITES: every hall of one site is one site
    state: CalibrationState
    median_ratio: float | None      # observed / predicted: the median over the sites' own mean ratios
    low_ratio: float | None
    high_ratio: float | None
    last_observed_on: str | None
    observations: tuple[Observation, ...] = ()
    halls: int = 0                  # distinct halls: reported next to sites, never used for independence
    #: Observations of this key made against OTHER engine builds than the headline's: counted, never pooled in.
    other_build_observations: int = 0
    n_builds: int = 1
    #: The headline build's digest; "" when its observations carry none (they are then pooled across unrecorded model versions).
    build: str = ""
    max_site_share: float | None = None
    #: Why the state is not CALIBRATED, when it is not (the count, the sites, or one site supplying too much).
    state_reason: str = ""
    #: The Student-t interval over the site means (publication.site_interval): published only with enough sites, else the reason there is none.
    interval: dict | None = None

    @property
    def bias_pct(self) -> float | None:
        if self.median_ratio is None:
            return None
        return (self.median_ratio - 1.0) * 100.0

    @property
    def conservative(self) -> bool | None:
        """True when sites came in better than the model said: more capacity than it permitted, or
        less cost, time or overhead than it predicted."""
        if self.median_ratio is None:
            return None
        if self.key in HIGHER_OBSERVED_IS_OPTIMISTIC:
            return self.median_ratio < 1.0
        return self.median_ratio > 1.0

    def _builds_sentence(self) -> str:
        if not self.other_build_observations:
            return ""
        return (f" {self.other_build_observations} further observation(s) were made against other model builds and are not pooled "
                "into this figure.")

    def sentence(self, *, public: bool = False) -> str:
        """The statement. ``public`` is what may leave the process: no ratio, range or day below PUBLIC_MIN_SITES sites, and a month, not a day."""
        if self.state is CalibrationState.UNCALIBRATED:
            return f"{self.key}: uncalibrated (n=0)."
        if public and self.sites < pub.PUBLIC_MIN_SITES:
            return (f"{self.key}: n={self.n} across {self.sites} site(s); fewer than {pub.PUBLIC_MIN_SITES} sites, so no ratio, range or "
                    f"date is published. Indicative only." + self._builds_sentence())
        median = pub.round_sig(self.median_ratio) if public else self.median_ratio
        bias = (median - 1.0) * 100.0
        direction = "conservative" if self.conservative else "optimistic"
        when = _month(self.last_observed_on) if public else self.last_observed_on
        base = (f"{self.key}: n={self.n} across {self.sites} site(s); "
                f"the model runs {abs(bias):.0f}% {direction} at the median")
        if self.state is CalibrationState.CALIBRATED:
            low, high = (pub.round_sig(self.low_ratio), pub.round_sig(self.high_ratio)) if public else (self.low_ratio, self.high_ratio)
            return (base + f", observed range {low:.2f}–{high:.2f}× (last {when})." + self._builds_sentence())
        return base + f" (last {when}). Indicative only." + self._builds_sentence()

    def model_builds(self) -> dict:
        return {"basis": pub.POOLED_UNRECORDED if not self.build else f"model build {self.build[:12]}",
                "n_builds": self.n_builds, "pooled_across_builds": False,
                "other_build_observations": self.other_build_observations}

    def to_dict(self) -> dict:
        """The operator's view: every figure as it was observed. What a deliverable or the API says is ``public_dict``."""
        return {
            "key": self.key, "n": self.n, "sites": self.sites, "halls": self.halls, "state": self.state.value,
            "median_ratio": None if self.median_ratio is None else round(self.median_ratio, 4),
            "bias_pct": None if self.bias_pct is None else round(self.bias_pct, 1),
            "observed_range": (None if self.low_ratio is None
                               else [round(self.low_ratio, 4), round(self.high_ratio, 4)]),
            "last_observed_on": self.last_observed_on,
            "statement": self.sentence(),
            "basis": self.state.sentence,
            "model_builds": self.model_builds(),
            "interval_over_sites": self.interval,
            **({"state_reason": self.state_reason} if self.state_reason else {}),
        }

    def public_dict(self) -> dict:
        """What may leave the process (publication.py). Below PUBLIC_MIN_SITES sites the ratio, the range and the date are withheld, with
        the reason; above it they are rounded, the date is the month, and the ratio has its interval over sites."""
        d = self.to_dict()
        d["statement"] = self.sentence(public=True)
        if self.state is CalibrationState.UNCALIBRATED:
            return d
        if self.sites < pub.PUBLIC_MIN_SITES:
            d.update(median_ratio=None, bias_pct=None, observed_range=None, last_observed_on=None,
                     withheld=f"fewer than {pub.PUBLIC_MIN_SITES} sites: a ratio, a range and a date from so few sites identify them")
            d["interval_over_sites"] = self.interval or {"published": False, "label": pub.INTERVAL_LABEL,
                                                         "reason": f"fewer than {pub.PUBLIC_MIN_SITES} sites: no interval over sites is published"}
            return d
        median = pub.round_sig(self.median_ratio)
        d.update(median_ratio=median, bias_pct=round((median - 1.0) * 100.0, 1), last_observed_on=_month(self.last_observed_on),
                 observed_range=(None if self.low_ratio is None else [pub.round_sig(self.low_ratio), pub.round_sig(self.high_ratio)]))
        return d


def uncalibrated(key: str) -> Calibration:
    return Calibration(key=key, n=0, sites=0, state=CalibrationState.UNCALIBRATED,
                       median_ratio=None, low_ratio=None, high_ratio=None,
                       last_observed_on=None, n_builds=0)


def _headline_build(obs: list[Observation]) -> tuple[str, list[Observation], int]:
    """(digest, observations, number of builds): the build with the most sites, then the most observations, then the later digest.
    Observations with no digest are one group (""). Builds are never pooled."""
    by_build: dict[str, list[Observation]] = {}
    for o in obs:
        by_build.setdefault(o.model_digest, []).append(o)
    digest, use = max(by_build.items(), key=lambda kv: (len({o.site for o in kv[1]}), len(kv[1]), kv[0]))
    return digest, use, len(by_build)


def calibration_for(key: str, observations: list[Observation]) -> Calibration:
    obs = [o for o in observations if o.key == key]
    if not obs:
        return uncalibrated(key)
    build, use, n_builds = _headline_build(obs)
    # Independence is counted across SITES. site_ref hashes site+hall, so counting it would let five readings from
    # three halls of one site pass for three sites.
    by_site: dict[str, list[float]] = {}
    for o in use:
        by_site.setdefault(o.site, []).append(o.ratio)
    site_means = {s: math.fsum(v) / len(v) for s, v in sorted(by_site.items())}     # each site's own mean first
    counts = [len(v) for v in by_site.values()]
    n, n_sites = len(use), len(by_site)
    n_halls = len({o.site_ref for o in use})
    spread_ok = pub.share_ok(counts)
    calibrated = n >= CALIBRATED_MIN and n_sites >= CALIBRATED_MIN_SITES and spread_ok
    state = (CalibrationState.CALIBRATED if calibrated
             else CalibrationState.INDICATIVE if n >= INDICATIVE_MIN
             else CalibrationState.UNCALIBRATED)
    reason = ""
    if not calibrated:
        parts = []
        if n < CALIBRATED_MIN:
            parts.append(f"{n} of the {CALIBRATED_MIN} observations needed")
        if n_sites < CALIBRATED_MIN_SITES:
            parts.append(f"{n_sites} of the {CALIBRATED_MIN_SITES} sites needed")
        if not spread_ok:
            parts.append(f"one site supplies {round(100 * pub.largest_share(counts))}% of the observations, above the "
                         f"{round(100 * pub.MAX_SINGLE_SITE_SHARE)}% any one site may supply")
        reason = "; ".join(parts) + "."
    ratios = list(site_means.values())
    return Calibration(
        key=key, n=n, sites=n_sites, halls=n_halls, state=state,
        median_ratio=_median(ratios),
        low_ratio=_quantile(ratios, 0.1) if state is CalibrationState.CALIBRATED else None,
        high_ratio=_quantile(ratios, 0.9) if state is CalibrationState.CALIBRATED else None,
        last_observed_on=max(o.observed_on for o in use),
        observations=tuple(sorted(obs, key=lambda o: o.observed_on)),
        other_build_observations=len(obs) - n, n_builds=n_builds, build=build,
        max_site_share=round(pub.largest_share(counts), 4), state_reason=reason, interval=pub.site_interval(site_means))


def summarise(observations: list[Observation]) -> dict[str, Calibration]:
    return {k: calibration_for(k, observations)
            for k in sorted({o.key for o in observations})}


def coverage(observations: list[Observation], keys: list[str]) -> dict:
    """What fraction of the things we assert have ever been checked against a site.

    Published as-is, including when it is zero. A coverage figure that only appears
    once it is flattering is a marketing number, and the whole point of this ledger
    is that it is not one.
    """
    asserted = set(keys)
    # Only observations of the outputs being asserted count towards them. An observation of any other key is
    # not coverage of these, and counting it would suppress the n=0 sentence for outputs never checked.
    scoped = [o for o in observations if o.key in asserted]
    summary = summarise(scoped)
    checked = [k for k in keys if summary.get(k) and summary[k].n > 0]
    calibrated = [k for k in keys if summary.get(k) and summary[k].state is CalibrationState.CALIBRATED]
    return {
        "keys_asserted": len(keys),
        "keys_with_site_observations": len(checked),
        "keys_calibrated": len(calibrated),
        "coverage": round(len(checked) / len(keys), 3) if keys else 0.0,
        "sites": len({o.site for o in scoped}),
        "halls": len({o.site_ref for o in scoped}),
        "observations": len(scoped),
        "observations_total": len(observations),
        "observations_without_source_ref": sum(1 for o in scoped if not o.source_ref),
    }
