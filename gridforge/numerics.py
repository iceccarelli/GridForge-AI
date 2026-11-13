"""Comparison helpers shared by the constraint modules (kernel level: imports nothing from the domains)."""
from __future__ import annotations

import math

#: Relative tolerance of a limit comparison.
#:
#: A hall exactly AT a gate limit must pass it. Binary floating point cannot always say so: ``100 * (1 - 0.85)`` is
#: 15.000000000000002, so a hall that removes exactly 15 kW of air per position failed a 15 kW gate by one unit in the last place, and a
#: facility-water limit written as ``27.9 - 5.1`` is 22.799999999999997 for a plant at 22.8 degC. Each such operation carries a relative
#: error of at most 2.2e-16 (one rounding of a double); a limit is the result of a handful of them, so the noise is below 1e-14. 1e-9
#: sits five orders of magnitude above that noise and many orders below anything an input can express (intake figures are given to a few
#: significant figures: one part in a million is already a different number, 22.8 versus 22.800023). It is RELATIVE so that it scales
#: with the quantity: on a 45 degC limit it is 4.5e-8 K, on a 150 kW limit 0.15 microwatt, and never an absolute allowance that could
#: swallow a small limit. A value that is genuinely over the limit by 1e-6 (relative) still fails.
LIMIT_REL_TOL = 1e-9


def leq(a: float, b: float) -> bool:
    """``a <= b``, allowing for floating-point noise at an exact limit (see ``LIMIT_REL_TOL``).

    Never admits a genuinely larger value: the allowance is relative to the larger magnitude, so against a limit of 0 only an exact 0
    passes. Infinite and non-finite values follow IEEE rules: ``leq(inf, inf)`` is True, anything compared with NaN is False (a gate on
    an undetermined number fails closed)."""
    return a <= b or math.isclose(a, b, rel_tol=LIMIT_REL_TOL, abs_tol=0.0)


def floor_whole(x: float) -> int:
    """``floor(x)`` of a FINITE figure, counting a value within ``LIMIT_REL_TOL`` below a whole number as that whole number.

    Racks are whole, and rounding down is the honest direction, but a plain ``floor`` rounds float noise down as well: a hall whose spare power
    is exactly 16 racks of 135 kW (2160 kW) comes out of a few additions and a division as 15.999999999999998 and floors to 15, and the same hall
    listed in another order sums to 16.000000000000002 and floors to 16. At about 55 kEUR a rack that is a money defect, and a number that
    changes with the order of a list. The allowance is ``LIMIT_REL_TOL * max(1, |x|)``: relative like ``leq`` (so a limit comparison and a floor
    agree on what "exactly at the limit" means), and never smaller than ``LIMIT_REL_TOL`` itself, so a figure of 0.9999999995 racks is one rack
    (it is 5e-10 short of it, which no input can express) while 0.999 is none. A figure genuinely short of a whole number by more than the
    tolerance (15.99999 racks) still floors down.

    Callers handle NaN and infinities first (``constraints._floor_whole``); this function is for finite input."""
    return math.floor(x + LIMIT_REL_TOL * max(1.0, abs(x)))
