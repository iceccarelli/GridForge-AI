"""Turning a handful of observations into a statement we can defend.

The temptation with a small n is to report a mean and call it calibration. Five
halls do not give you a mean worth quoting, so this module reports what the data
actually supports and refuses to dress it up: a state, a count, a median ratio and
an observed spread. Nothing here smooths, fits or extrapolates.
"""
from __future__ import annotations

from dataclasses import dataclass
from enum import Enum

from .schema import Observation

# n < INDICATIVE_MIN      : we know nothing
# INDICATIVE_MIN <= n < CALIBRATED_MIN : we have signals, not statistics
# n >= CALIBRATED_MIN     : a spread worth printing next to a number
INDICATIVE_MIN = 1
CALIBRATED_MIN = 5


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


@dataclass(frozen=True)
class Calibration:
    key: str
    n: int
    sites: int
    state: CalibrationState
    median_ratio: float | None      # observed / predicted
    low_ratio: float | None
    high_ratio: float | None
    last_observed_on: str | None
    observations: tuple[Observation, ...] = ()

    @property
    def bias_pct(self) -> float | None:
        if self.median_ratio is None:
            return None
        return (self.median_ratio - 1.0) * 100.0

    @property
    def conservative(self) -> bool | None:
        """True when sites have come in above what the model permitted."""
        if self.median_ratio is None:
            return None
        return self.median_ratio > 1.0

    def sentence(self) -> str:
        if self.state is CalibrationState.UNCALIBRATED:
            return f"{self.key}: uncalibrated (n=0)."
        direction = "conservative" if self.conservative else "optimistic"
        base = (f"{self.key}: n={self.n} across {self.sites} site(s); "
                f"the model runs {abs(self.bias_pct):.0f}% {direction} at the median")
        if self.state is CalibrationState.CALIBRATED:
            return (base + f", observed range {self.low_ratio:.2f}–{self.high_ratio:.2f}× "
                           f"(last {self.last_observed_on}).")
        return base + f" (last {self.last_observed_on}). Indicative only."

    def to_dict(self) -> dict:
        return {
            "key": self.key, "n": self.n, "sites": self.sites, "state": self.state.value,
            "median_ratio": None if self.median_ratio is None else round(self.median_ratio, 4),
            "bias_pct": None if self.bias_pct is None else round(self.bias_pct, 1),
            "observed_range": (None if self.low_ratio is None
                               else [round(self.low_ratio, 4), round(self.high_ratio, 4)]),
            "last_observed_on": self.last_observed_on,
            "statement": self.sentence(),
            "basis": self.state.sentence,
        }


def uncalibrated(key: str) -> Calibration:
    return Calibration(key=key, n=0, sites=0, state=CalibrationState.UNCALIBRATED,
                       median_ratio=None, low_ratio=None, high_ratio=None,
                       last_observed_on=None)


def calibration_for(key: str, observations: list[Observation]) -> Calibration:
    obs = [o for o in observations if o.key == key]
    if not obs:
        return uncalibrated(key)
    ratios = [o.ratio for o in obs]
    n = len(obs)
    state = (CalibrationState.CALIBRATED if n >= CALIBRATED_MIN
             else CalibrationState.INDICATIVE if n >= INDICATIVE_MIN
             else CalibrationState.UNCALIBRATED)
    return Calibration(
        key=key, n=n, sites=len({o.site_ref for o in obs}), state=state,
        median_ratio=_median(ratios),
        low_ratio=_quantile(ratios, 0.1) if state is CalibrationState.CALIBRATED else None,
        high_ratio=_quantile(ratios, 0.9) if state is CalibrationState.CALIBRATED else None,
        last_observed_on=max(o.observed_on for o in obs),
        observations=tuple(sorted(obs, key=lambda o: o.observed_on)))


def summarise(observations: list[Observation]) -> dict[str, Calibration]:
    return {k: calibration_for(k, observations)
            for k in sorted({o.key for o in observations})}


def coverage(observations: list[Observation], keys: list[str]) -> dict:
    """What fraction of the things we assert have ever been checked against a site.

    Published as-is, including when it is zero. A coverage figure that only appears
    once it is flattering is a marketing number, and the whole point of this ledger
    is that it is not one.
    """
    summary = summarise(observations)
    checked = [k for k in keys if summary.get(k) and summary[k].n > 0]
    return {
        "keys_asserted": len(keys),
        "keys_with_site_observations": len(checked),
        "coverage": round(len(checked) / len(keys), 3) if keys else 0.0,
        "sites": len({o.site_ref for o in observations}),
        "observations": len(observations),
    }
