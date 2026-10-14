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
class EconomicsInput:
    """Economic inputs the CLIENT may declare. Absent means absent: nothing here has a hidden default."""
    #: Contracted or expected all-in grid electricity price. None -> the engine's labelled placeholder is used
    #: and the gap ledger says so.
    electricity_eur_per_MWh: Quantity | None = None
    #: Years over which a lifecycle cost is stated. None -> no lifecycle value is computed (never a made-up horizon).
    horizon_years: int | None = None
    #: Annual discount rate for the lifecycle value. None -> the lifecycle value is stated UNDISCOUNTED, and says so.
    discount_rate: Quantity | None = None


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
    economics: EconomicsInput = field(default_factory=EconomicsInput)

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
    #: How the price was formed: "fixed_site" (one cost for the site, not scaled by size),
    #: "per_unit" (unit price x what this step adds), "quoted_job_lump" (a supplier's price for this job),
    #: "per_rack" (unit price x racks finally fitted out), "client_declared" (the intake's own figure).
    cost_kind: str = "fixed_site"
    #: What this step buys, in the unit it is priced in ("9 MVA added"). Empty for a fixed-site lump.
    scope: str = ""
    #: Cost components the library has no price for. The capex above is then a lower bound, and the step is
    #: reported as incompletely priced rather than as a smaller number. Each: (library key, what it is, unit, quantity it would apply to).
    unpriced: tuple[tuple[str, str, str, float], ...] = ()
    #: A caveat about the basis that must travel with the price (e.g. a lump that does not scale with size).
    basis_note: str = ""
    #: Further library lines this price includes (priced components), so the basis mix and the weakest-evidence
    #: class cover every line the total rests on, not only ``cost_key``.
    extra_cost_keys: tuple[str, ...] = ()


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
