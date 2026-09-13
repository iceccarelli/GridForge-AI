"""Quantity: a number that cannot be separated from how it was obtained.

Arithmetic propagates provenance (minimum evidence class) and an uncertainty
interval. Intervals are propagated with interval arithmetic, which is crude but
monotone, explainable and impossible to overstate — the right trade for E1-E3 work.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Iterable

from .evidence import EvidenceClass
from .provenance import Provenance


# ---------------------------------------------------------------------------
# Minimal unit algebra. Not a units library: just enough to cancel terms so that
# racks * EUR/rack is EUR, and to refuse to add kilowatts to euros.
# ---------------------------------------------------------------------------
_ALIAS = {"racks": "rack", "positions": "position", "hours": "h", "weeks": "week"}


def _tokens(unit: str) -> tuple[tuple[str, ...], tuple[str, ...]]:
    if not unit or unit == "1":
        return ((), ())
    parts = unit.split("/")
    num = [t for t in parts[0].split("*") if t and t != "1"]
    den: list[str] = []
    for chunk in parts[1:]:
        den += [t for t in chunk.split("*") if t and t != "1"]
    num = [_ALIAS.get(t, t) for t in num]
    den = [_ALIAS.get(t, t) for t in den]
    for t in list(num):
        if t in den:
            num.remove(t)
            den.remove(t)
    return (tuple(sorted(num)), tuple(sorted(den)))


def _render_unit(num: tuple[str, ...], den: tuple[str, ...]) -> str:
    n = "*".join(num) if num else "1"
    return f"{n}/{'*'.join(den)}" if den else n


def _normalise(unit: str) -> str:
    return _render_unit(*_tokens(unit))


# Temperature differences (K) may be added to or subtracted from temperatures (degC).
_ADDITIVE_COMPAT = {frozenset(("degC", "K")): "degC"}


def _addable(a: str, b: str) -> str | None:
    na, nb = _normalise(a), _normalise(b)
    if na == nb or nb == "1":
        return a
    if na == "1":
        return b
    return _ADDITIVE_COMPAT.get(frozenset((na, nb)))


def _combine_units(a: str, b: str, op: str) -> str:
    an, ad = _tokens(a)
    bn, bd = _tokens(b)
    if op == "*":
        num, den = list(an) + list(bn), list(ad) + list(bd)
    else:
        num, den = list(an) + list(bd), list(ad) + list(bn)
    for t in list(num):
        if t in den:
            num.remove(t)
            den.remove(t)
    return _render_unit(tuple(sorted(num)), tuple(sorted(den)))


@dataclass(frozen=True)
class Quantity:
    value: float
    unit: str
    prov: Provenance
    lo: float | None = None
    hi: float | None = None

    # ---- construction -------------------------------------------------
    @staticmethod
    def given(
        value: float,
        unit: str,
        label: str,
        evidence: EvidenceClass,
        *,
        band: float | tuple[float, float] | None = None,
        assumptions: Iterable[str] = (),
        sources: Iterable = (),
    ) -> "Quantity":
        """A leaf quantity. `band` is a relative tolerance (0.1 -> +/-10%) or (lo, hi) absolute."""
        p = Provenance.input_datum(label, evidence, assumptions=tuple(assumptions), sources=tuple(sources))
        if band is None:
            lo = hi = value
        elif isinstance(band, tuple):
            lo, hi = band
        else:
            lo, hi = value * (1 - band), value * (1 + band)
        return Quantity(value, unit, p, lo, hi)

    @property
    def band(self) -> tuple[float, float]:
        return (self.value if self.lo is None else self.lo,
                self.value if self.hi is None else self.hi)

    @property
    def evidence(self) -> EvidenceClass:
        return self.prov.evidence

    def relabel(self, label: str, model_id: str, *, step_evidence: EvidenceClass | None = None,
                assumptions: Iterable[str] = (), sources: Iterable = ()) -> "Quantity":
        p = Provenance.derive(
            label, model_id, [self.prov],
            step_evidence=step_evidence if step_evidence is not None else self.prov.evidence,
            assumptions=tuple(assumptions), sources=tuple(sources),
        )
        return Quantity(self.value, self.unit, p, self.lo, self.hi)

    # ---- arithmetic ---------------------------------------------------
    def _as_q(self, other) -> "Quantity":
        if isinstance(other, Quantity):
            return other
        return Quantity.given(float(other), "1", f"constant {other}", EvidenceClass.E7_DEPLOYED)

    def _op(self, other, fn, unit_op: str, symbol: str) -> "Quantity":
        o = self._as_q(other)
        alo, ahi = self.band
        blo, bhi = o.band
        cands = [fn(x, y) for x in (alo, self.value, ahi) for y in (blo, o.value, bhi)]
        cands = [c for c in cands if not (math.isnan(c) or math.isinf(c))]
        val = fn(self.value, o.value)
        if unit_op == "same":
            unit = _addable(self.unit, o.unit) or self.unit
        else:
            unit = _combine_units(self.unit, o.unit, unit_op)
        p = Provenance.derive(
            f"({self.prov.label} {symbol} {o.prov.label})", f"arith:{symbol}", [self.prov, o.prov],
            step_evidence=EvidenceClass.E7_DEPLOYED,  # arithmetic adds no weakness of its own
        )
        return Quantity(val, unit, p, min(cands) if cands else val, max(cands) if cands else val)

    def __add__(self, other):
        o = self._as_q(other)
        if _addable(self.unit, o.unit) is None:
            raise ValueError(f"unit mismatch: {self.unit} + {o.unit}")
        return self._op(other, lambda a, b: a + b, "same", "+")

    def __sub__(self, other):
        o = self._as_q(other)
        if _addable(self.unit, o.unit) is None:
            raise ValueError(f"unit mismatch: {self.unit} - {o.unit}")
        return self._op(other, lambda a, b: a - b, "same", "-")

    def __mul__(self, other):
        return self._op(other, lambda a, b: a * b, "*", "*")

    def __truediv__(self, other):
        return self._op(other, lambda a, b: a / b if b else float("inf"), "/", "/")

    __radd__ = __add__
    __rmul__ = __mul__

    def __rsub__(self, other):
        return self._as_q(other).__sub__(self)

    def __rtruediv__(self, other):
        return self._as_q(other).__truediv__(self)

    def __lt__(self, other):
        return self.value < self._as_q(other).value

    def __le__(self, other):
        return self.value <= self._as_q(other).value

    def convert(self, factor: float, unit: str, label: str) -> "Quantity":
        q = self * Quantity.given(factor, "1", f"unit factor {factor}", EvidenceClass.E7_DEPLOYED)
        return Quantity(q.value, unit, Provenance.derive(label, "convert", [self.prov],
                                                         step_evidence=EvidenceClass.E7_DEPLOYED),
                        q.lo, q.hi)

    # ---- rendering ----------------------------------------------------
    def sigfigs(self) -> int:
        """No fake precision. Weak evidence gets few significant figures."""
        return 3 if self.evidence < EvidenceClass.E4_EXPERIMENTAL else 4

    def rounded(self) -> float:
        return _round_sig(self.value, self.sigfigs())

    def render(self, *, with_band: bool = True, with_class: bool = True) -> str:
        n = self.sigfigs()
        s = _fmt(self.value, n)
        lo, hi = self.band
        if with_band and (abs(hi - lo) > 1e-12):
            s += f" [{_fmt(lo, n)}–{_fmt(hi, n)}]"
        if self.unit not in ("1", ""):
            s += f" {self.unit}"
        if with_class:
            s += f" ({self.evidence.short})"
        return s

    def __str__(self) -> str:  # pragma: no cover - convenience
        return self.render()


def _round_sig(x: float, n: int) -> float:
    if x == 0 or math.isnan(x) or math.isinf(x):
        return x
    return round(x, -int(math.floor(math.log10(abs(x)))) + (n - 1))


def _fmt(x: float, n: int) -> str:
    if math.isinf(x):
        return "∞"
    r = _round_sig(x, n)
    if abs(r) >= 1000:
        return f"{r:,.0f}"
    if abs(r) >= 100:
        return f"{r:.0f}"
    if abs(r) >= 10:
        return f"{r:.1f}".rstrip("0").rstrip(".")
    return f"{r:.3g}"


def qmin(*qs: Quantity) -> Quantity:
    """Minimum of quantities, preserving the provenance of the winner."""
    best = qs[0]
    for q in qs[1:]:
        if q.value < best.value:
            best = q
    return best
