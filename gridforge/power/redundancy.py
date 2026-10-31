"""How many of a bank's units count as USABLE capacity under a redundancy scheme.

One rule, named once. Transformer banks, UPS blocks and CDU banks each carry `units` and `redundancy` and have always been credited
`usable_units` of `units`; a generation option was credited its whole nameplate, as if no unit could ever be out (see
`btm.firm_contribution_kW`). This is the same arithmetic those banks use, so a generator plant and the transformers that carry its output
cannot be held to different definitions of N+1.

    N, N+0   every unit is needed and counted
    N+1      the largest unit may be out: units - 1
    N+2      two may be out: units - 2
    2N, N+N  two matched halves, one may fail whole: units // 2 (an odd unit out is not counted: conservative)

Never negative: a single unit under N+1 is 0 usable, which is the point.
"""
from __future__ import annotations

#: The schemes a customer may declare (the loader refuses anything else by name rather than falling back to N).
SCHEMES = ("N", "N+1", "N+2", "2N")

#: What a generation option is held to when its unit count is declared and its scheme is not: the convention for every other bank in the
#: envelope (the loader defaults transformers, UPS and CDUs to it). Conservative, and only reached by a customer who declared units.
DEFAULT_GENERATION_REDUNDANCY = "N+1"


def usable_units(units: int, redundancy: str) -> int:
    r = redundancy.upper().replace(" ", "")
    if r in ("N", "N+0"):
        return units
    if r == "N+1":
        return max(units - 1, 0)
    if r in ("2N", "N+N"):
        return units // 2
    if r == "N+2":
        return max(units - 2, 0)
    raise ValueError(f"unknown redundancy {redundancy!r}; expected N, N+1, N+2 or 2N")
