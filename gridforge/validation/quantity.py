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
        o = self._as_q(other)
        blo, bhi = o.band
        if o.value != 0 and not (blo <= 0.0 <= bhi):
            return self._op(other, lambda a, b: a / b, "/", "/")
        return self._divide_by_zero_reachable(o)

    def _divide_by_zero_reachable(self, o: "Quantity") -> "Quantity":
        """The divisor is zero, or its band reaches zero. The old rule returned +inf for EVERY such quotient, so a
        negative headroom divided by zero came out as unlimited capacity. Here the sign of the numerator is kept
        (x/0 is +inf for x > 0, -inf for x < 0), 0/0 is NaN (undetermined: callers floor it to zero racks), and a
        divisor band that straddles zero makes the quotient band unbounded rather than a finite interval that
        pretends the pole is not there."""
        inf = float("inf")
        if o.value == 0:
            val = float("nan") if self.value == 0 else math.copysign(inf, self.value)
        else:
            val = self.value / o.value
        alo, ahi = self.band
        blo, bhi = o.band
        if blo == bhi == 0.0 and (alo > 0 or ahi < 0):
            lo = hi = math.copysign(inf, alo)
        elif blo == bhi == 0.0 and alo == ahi == 0.0:
            lo = hi = float("nan")
        else:
            lo, hi = -inf, inf
        p = Provenance.derive(
            f"({self.prov.label} / {o.prov.label})", "arith:/", [self.prov, o.prov],
            step_evidence=EvidenceClass.E7_DEPLOYED)
        return Quantity(val, _combine_units(self.unit, o.unit, "/"), p, lo, hi)

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
            s += f" {_display_unit(self.unit)}"
        if with_class:
            s += f" ({self.evidence.short})"
        return s

    def __str__(self) -> str:  # pragma: no cover - convenience
        return self.render()


def _display_unit(unit: str) -> str:
    """Presentation only: the algebra keeps ``m*m``; a reader should see ``m2`` (kg/m*m reads as a typo)."""
    return unit.replace("m*m*m", "m3").replace("m*m", "m2")


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


def _lineage_key(q: Quantity) -> tuple:
    """A total order over quantities that does not depend on where a caller listed them: provenance first, then the numbers."""
    p = q.prov
    return (p.label, p.model_id, int(p.evidence), q.unit, q.value, q.band)


def qsum(qs: Iterable[Quantity]) -> Quantity:
    """The sum of quantities, the same whatever order they are given in.

    Adding floats one at a time (``a + b + c``) rounds after every addition, so ``(a + b) + c`` and ``(b + c) + a`` can differ in the last bit.
    A capacity built from a LIST (UPS blocks, transformer banks, CDU banks) therefore changed with the order the customer happened to write it
    in, and at an exact boundary one bit is a whole rack. Here the value and each end of the band are added with ``math.fsum`` (the correctly
    rounded sum, which has no order), and the provenance is built from the inputs in a fixed order (label, then number), so neither the figure
    nor its lineage depends on the listing. The band is the interval sum, as ``+`` computes it. One input is returned as it is. A non-finite
    term (or a sum too large for ``fsum``) falls back to adding in that fixed order: still deterministic, with ``+``'s own treatment of infinities."""
    items = sorted(qs, key=_lineage_key)
    if not items:
        raise ValueError("qsum() needs at least one quantity")
    if len(items) == 1:
        return items[0]
    unit = items[0].unit
    for q in items[1:]:
        nxt = _addable(unit, q.unit)
        if nxt is None:
            raise ValueError(f"unit mismatch: {unit} + {q.unit}")
        unit = nxt
    ends = [(min(q.band[0], q.value, q.band[1]), q.value, max(q.band[0], q.value, q.band[1])) for q in items]
    try:
        if not all(math.isfinite(x) for e in ends for x in e):
            raise ValueError("non-finite term")
        lo = math.fsum(e[0] for e in ends)
        val = math.fsum(e[1] for e in ends)
        hi = math.fsum(e[2] for e in ends)
    except (ValueError, OverflowError):
        total = items[0]
        for q in items[1:]:
            total = total + q
        return total
    prov = Provenance.derive("(" + " + ".join(q.prov.label for q in items) + ")", "arith:+", [q.prov for q in items],
                             step_evidence=EvidenceClass.E7_DEPLOYED)
    return Quantity(val, unit, prov, lo, hi)


def qmin(*qs: Quantity) -> Quantity:
    """The smallest of the quantities, carrying the evidence and the interval of ALL of them.

    The value is the smallest value (the first of equals, as before; an undetermined NaN makes the result NaN rather than being skipped by
    argument order). The old version returned the WINNER itself, so its provenance was the winner's alone: "the ceiling is the contracted
    figure" kept the contracted figure's class when the firm figure that was found to be higher was only an assumption, and the true minimum
    could fall below the winner's own band. Now the provenance is derived from every input (the result is no better evidenced than the weakest
    of them, a min being a conclusion drawn from all of them) and the band is the lower of each end, the interval minimum."""
    if not qs:
        raise ValueError("qmin() needs at least one quantity")
    best = qs[0]
    for q in qs[1:]:
        if q.value < best.value:
            best = q
    if len(qs) == 1:
        return best
    value = float("nan") if any(math.isnan(q.value) for q in qs) else best.value
    lo = min(q.band[0] for q in qs)
    hi = min(q.band[1] for q in qs)
    prov = Provenance.derive("min(" + ", ".join(q.prov.label for q in qs) + ")", "arith:min", [q.prov for q in qs],
                             step_evidence=EvidenceClass.E7_DEPLOYED)
    return Quantity(value, best.unit, prov, lo, hi)
