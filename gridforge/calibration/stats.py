"""Turning a handful of observations into a statement we can defend.

The temptation with a small n is to report a mean and call it calibration. Five
halls do not give you a mean worth quoting, so this module reports what the data
actually supports and refuses to dress it up: a state, a count, and, with enough
sites, a mean over sites with an interval. Nothing here smooths, fits or extrapolates.

Rules that keep a small or lopsided record from passing for more than it is (the thresholds are named in ``publication.py``):

  * CALIBRATED needs enough observations from enough SITES, and no one site may supply more than ``MAX_SINGLE_SITE_SHARE`` of them. Five
    readings from one hall are one hall; so are forty-eight of fifty.
  * Figures are taken over SITES (each site's own mean first). ``n`` (readings) and ``sites`` are separate.
  * Observations made against different engine builds (``model_digest``) are never pooled. The headline is the build answering the request
    when there are observations of it, else the build with the most sites; observations against other builds are counted and not mixed in.
    Observations that carry no digest are one group, labelled "pooled across unrecorded model versions". Every statement says whether the
    headline is the running build: a calibration of another build is not a calibration of this one.

``Calibration.to_dict()`` is the operator's view (median, range, exact dates). ``Calibration.public_dict()`` is what leaves the process and
follows the publication rules: no median, no extreme, no quantile (with a handful of sites those are individual sites), no day. Below
``PUBLIC_MIN_SITES`` sites it publishes counts only and the state reads INDICATIVE; from there it publishes the mean over sites and the
interval over sites. A published state is CALIBRATED only when the figures it promises are published.
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
        """The operator's wording (the median and the observed spread are in the operator view)."""
        return _SENTENCE[self]

    @property
    def public_sentence(self) -> str:
        """The wording that leaves the process: it promises only what ``Calibration.public_dict`` publishes."""
        return _PUBLIC_SENTENCE[self]


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

_PUBLIC_SENTENCE = {
    CalibrationState.UNCALIBRATED: _SENTENCE[CalibrationState.UNCALIBRATED],
    CalibrationState.INDICATIVE: (
        "Too few reconciled sites, or too lopsided a record, to quote a figure with confidence. Counts are published; no individual "
        "site's observation is. Read this as a signal, not a statistic."),
    CalibrationState.CALIBRATED: (
        "Reconciled against instrumented sites. The mean ratio over sites and an interval over sites are reported; the interval is for the "
        "average site and is not a guarantee for any given hall."),
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


def _conservative(key: str, ratio: float) -> bool:
    return ratio < 1.0 if key in HIGHER_OBSERVED_IS_OPTIMISTIC else ratio > 1.0


@dataclass(frozen=True)
class Calibration:
    key: str
    n: int                          # readings behind the headline (the headline build's observations)
    sites: int                      # distinct SITES: every hall of one site is one site
    state: CalibrationState
    median_ratio: float | None      # operator view: observed / predicted, the median over the sites' own mean ratios
    low_ratio: float | None         # operator view
    high_ratio: float | None        # operator view
    last_observed_on: str | None    # operator view
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
    #: The mean over the sites' own mean ratios: the one central figure that is published.
    mean_ratio: float | None = None
    #: How the headline build relates to the one answering: 'running', 'other', 'unrecorded' or 'unknown' (publication.build_relation).
    build_relation: str = "unknown"

    @property
    def bias_pct(self) -> float | None:
        if self.median_ratio is None:
            return None
        return (self.median_ratio - 1.0) * 100.0

    @property
    def mean_bias_pct(self) -> float | None:
        return None if self.mean_ratio is None else (self.mean_ratio - 1.0) * 100.0

    @property
    def conservative(self) -> bool | None:
        """True when sites came in better than the model said: more capacity than it permitted, or
        less cost, time or overhead than it predicted."""
        if self.median_ratio is None:
            return None
        return _conservative(self.key, self.median_ratio)

    @property
    def published_state(self) -> CalibrationState:
        """The state as it is published: CALIBRATED only if the figures that state promises can be published (``PUBLIC_MIN_SITES`` sites).
        Internally three sites and five observations are enough (``state``); the published reading of the same record is INDICATIVE."""
        if self.state is CalibrationState.CALIBRATED and self.sites < pub.PUBLIC_MIN_SITES:
            return CalibrationState.INDICATIVE
        return self.state

    def _builds_sentence(self) -> str:
        if self.state is CalibrationState.UNCALIBRATED:
            return ""
        rel = self.build_relation
        text = {"running": "Recorded against the build answering this request.",
                "other": f"Recorded against {pub.BUILD_RELATION_TEXT['other']}.",
                "unrecorded": (f"No build is recorded for these observations ({pub.POOLED_UNRECORDED}): it cannot be shown that they "
                               "describe the build answering this request."),
                "unknown": ("The build answering this request could not be determined, so it cannot be shown whether these "
                            "observations describe it.")}[rel]
        if self.other_build_observations:
            text += (f" {self.other_build_observations} further observation(s) were made against other model builds and are not pooled "
                     "into this figure.")
        return " " + text

    def sentence(self, *, public: bool = False) -> str:
        """The statement. ``public`` is what may leave the process: below PUBLIC_MIN_SITES sites no figure and no date; from there the mean over
        sites with its interval; never a median, an extreme or a day."""
        if self.state is CalibrationState.UNCALIBRATED:
            return f"{self.key}: uncalibrated (n=0)."
        if public:
            if self.sites < pub.PUBLIC_MIN_SITES:
                return (f"{self.key}: n={self.n} across {self.sites} site(s); fewer than {pub.PUBLIC_MIN_SITES} sites, so no figure and "
                        f"no date is published. Indicative only." + self._builds_sentence())
            mean = pub.round_sig(self.mean_ratio)
            direction = "conservative" if _conservative(self.key, mean) else "optimistic"
            iv = self.interval or {}
            interval = (f" with a {round(100 * iv['confidence'])}% interval over sites of {iv['low']:.3g}–{iv['high']:.3g}× "
                        f"(assumes sites are exchangeable; not a guarantee for any given hall)") if iv.get("published") else ""
            base = (f"{self.key}: n={self.n} across {self.sites} site(s); the mean ratio over sites is {mean:.3g}×, so the model runs "
                    f"{abs((mean - 1.0) * 100.0):.0f}% {direction} on average{interval}")
            tail = "." if self.state is CalibrationState.CALIBRATED else f". Indicative only: {self.state_reason}"
            return base + tail + self._builds_sentence()
        direction = "conservative" if self.conservative else "optimistic"
        base = (f"{self.key}: n={self.n} across {self.sites} site(s); "
                f"the model runs {abs(self.bias_pct):.0f}% {direction} at the median")
        if self.state is CalibrationState.CALIBRATED:
            return (base + f", observed range {self.low_ratio:.2f}–{self.high_ratio:.2f}× (last {self.last_observed_on})."
                    + self._builds_sentence())
        return base + f" (last {self.last_observed_on}). Indicative only." + self._builds_sentence()

    def model_builds(self) -> dict:
        return {"basis": pub.POOLED_UNRECORDED if not self.build else f"model build {self.build[:12]}",
                "n_builds": self.n_builds, "pooled_across_builds": False,
                "relation_to_running_build": self.build_relation,
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
        """What may leave the process (publication.py): counts, the published state, and from PUBLIC_MIN_SITES sites the mean ratio over
        sites with its interval over sites. No median, no range, no quantile, no date: with a handful of sites those are individual sites."""
        state = self.published_state
        out: dict = {"key": self.key, "n": self.n, "sites": self.sites, "halls": self.halls, "state": state.value,
                     "statement": self.sentence(public=True), "basis": state.public_sentence, "model_builds": self.model_builds()}
        if self.state is CalibrationState.UNCALIBRATED:
            return out
        if self.sites < pub.PUBLIC_MIN_SITES:
            out["withheld"] = f"fewer than {pub.PUBLIC_MIN_SITES} sites: a figure or a date from so few sites identifies them"
            out["interval_over_sites"] = self.interval or {"published": False, "label": pub.INTERVAL_LABEL,
                                                           "reason": f"fewer than {pub.PUBLIC_MIN_SITES} sites: no interval over sites is published"}
        else:
            mean = pub.round_sig(self.mean_ratio)
            out["mean_ratio"] = mean
            out["mean_bias_pct"] = round((mean - 1.0) * 100.0, 1)
            out["interval_over_sites"] = self.interval
        if self.state_reason and state is not CalibrationState.CALIBRATED:
            out["state_reason"] = self.state_reason
        return out


def uncalibrated(key: str) -> Calibration:
    return Calibration(key=key, n=0, sites=0, state=CalibrationState.UNCALIBRATED,
                       median_ratio=None, low_ratio=None, high_ratio=None,
                       last_observed_on=None, n_builds=0)


def _headline_build(obs: list[Observation]) -> tuple[str, list[Observation], int]:
    """(digest, observations, number of builds). The build answering the request when there are observations of it; otherwise the build
    with the most sites, then the most observations, then the later digest. Observations with no digest are one group (""). Builds are
    never pooled."""
    by_build: dict[str, list[Observation]] = {}
    for o in obs:
        by_build.setdefault(o.model_digest, []).append(o)
    running = {d: rs for d, rs in by_build.items() if pub.build_relation(d) == "running"}
    pool = running or by_build
    digest, use = max(pool.items(), key=lambda kv: (len({o.site for o in kv[1]}), len(kv[1]), kv[0]))
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
        max_site_share=round(pub.largest_share(counts), 4), state_reason=reason, interval=pub.site_interval(site_means),
        mean_ratio=math.fsum(ratios) / len(ratios), build_relation=pub.build_relation(build))


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
    calibrated = [k for k in keys if summary.get(k) and summary[k].published_state is CalibrationState.CALIBRATED]
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
