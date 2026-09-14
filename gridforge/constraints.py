"""Shared constraint kernel.

Every constraint is an independent function over a common context returning a
limit expressed in RACKS OF THE TARGET PLATFORM, plus how much it costs and how
long it takes to move that limit. The envelope is the minimum; the binding
constraint is the argmin; the Headroom Ladder is what you get by relieving the
binding constraint and solving again.

This shape is deliberate: it makes the answer explainable, and the explanation
is the product.
"""
from __future__ import annotations

import copy
import math
from dataclasses import dataclass, field
from typing import Callable, Optional

from .compute.schema import ClusterSpec
from .power.schema import PowerInput
from .site.schema import HallSpec, SiteSpec
from .thermal.schema import Architecture, ThermalInput
from .validation import Quantity


@dataclass
class EnvelopeContext:
    site: SiteSpec
    hall: HallSpec
    power: PowerInput
    thermal: ThermalInput
    cluster: ClusterSpec
    architecture: Architecture
    pue: Quantity
    capex_budget_eur: Quantity | None = None

    def copy(self) -> "EnvelopeContext":
        return copy.deepcopy(self)


@dataclass
class ReliefOption:
    """What it costs to move a constraint. `apply` returns a NEW context."""
    description: str
    capex_eur: Quantity
    lead_time_weeks: Quantity
    apply: Callable[[EnvelopeContext], EnvelopeContext] = field(repr=False)
    risk: str = ""
    # Where this price came from. A cost-library key, or one of the sentinels:
    #   "client-supplied"  the intake declared it (a client's own quote beats our library)
    #   "not-capital"      the relief is commercial or contractual, not a purchase
    cost_key: str | None = None
    per_rack: bool = False        # capex quoted per rack rather than as a lump sum
    customer_funded: bool = True  # capital rule: we never fund physical deployment


@dataclass
class ConstraintResult:
    id: str
    domain: str            # electrical | thermal | physical | economic
    name: str
    max_racks: Quantity    # racks of the target platform this constraint permits
    basis: str             # one sentence: what physically limits, in what units
    relief: Optional[ReliefOption] = None
    gate: bool = False     # True -> a pass/fail feasibility gate, not a capacity ceiling
    notes: tuple[str, ...] = ()

    @property
    def racks(self) -> float:
        v = self.max_racks.value
        return 0.0 if v < 0 else v


Constraint = Callable[[EnvelopeContext], ConstraintResult]

_REGISTRY: dict[str, Constraint] = {}


def constraint(fn: Constraint) -> Constraint:
    """Register a constraint function. Order of registration is irrelevant."""
    _REGISTRY[fn.__name__] = fn
    return fn


def all_constraints() -> list[Constraint]:
    return list(_REGISTRY.values())


def floor_racks(q: Quantity) -> Quantity:
    """Racks are integers. Rounding down is the only honest direction."""
    from .validation import Provenance
    v = 0.0 if q.value < 0 else math.floor(q.value)
    lo, hi = q.band
    return Quantity(
        v, "racks",
        Provenance.derive(q.prov.label + " (floored to whole racks)", "constraints.floor_racks", [q.prov],
                          step_evidence=q.evidence),
        math.floor(max(lo, 0)), math.floor(max(hi, 0)),
    )
