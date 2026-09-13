"""The envelope solver and the Headroom Ladder.

    solve(ctx)  -> EnvelopeResult   : one architecture, one answer, one binding constraint
    ladder(ctx) -> HeadroomLadder   : relieve the binding constraint, solve again, repeat

The ladder is the commercial artefact. A customer does not buy "your hall does
47 kW/rack"; they buy the ordered list of what stops them, what each step costs,
and how long each step takes.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

from ..common import ESTIMATED, V
from ..constraints import ConstraintResult, EnvelopeContext, all_constraints
from ..validation import Quantity

# Importing the constraint modules registers them.
from ..power import constraints as _p  # noqa: F401
from ..site import constraints as _s  # noqa: F401
from ..thermal import constraints as _t  # noqa: F401


@dataclass
class EnvelopeResult:
    max_racks: int
    binding: ConstraintResult
    constraints: list[ConstraintResult]
    it_load_kW: Quantity
    facility_load_kW: Quantity
    rack_kW: Quantity
    gpus: int
    architecture: str

    @property
    def achieved_kW_per_rack(self) -> Quantity:
        return self.rack_kW

    def sorted_constraints(self) -> list[ConstraintResult]:
        return sorted(self.constraints, key=lambda c: (c.racks, 0 if c.gate else 1))


def solve(ctx: EnvelopeContext) -> EnvelopeResult:
    results = [fn(ctx) for fn in all_constraints()]
    binding = min(results, key=lambda c: c.racks)
    n = int(min(c.racks for c in results))
    if math.isinf(n) or n < 0:
        n = 0
    nq = V(float(n), "1", "deployable rack count", ESTIMATED)
    it_kW = (nq * ctx.cluster.platform.rack_kW).relabel(
        "deployable IT load", "envelope.it_load", step_evidence=ESTIMATED)
    fac_kW = (it_kW * ctx.pue).relabel("total facility load", "envelope.facility_load",
                                       step_evidence=ESTIMATED)
    return EnvelopeResult(
        max_racks=n, binding=binding, constraints=results,
        it_load_kW=it_kW, facility_load_kW=fac_kW,
        rack_kW=ctx.cluster.platform.rack_kW,
        gpus=n * ctx.cluster.platform.gpus_per_rack,
        architecture=ctx.architecture.value,
    )


@dataclass
class LadderStep:
    step: int
    binding_id: str
    binding_name: str
    domain: str
    racks_before: int
    racks_after: int
    basis: str
    relief_description: str | None
    capex_eur: Quantity | None
    lead_time_weeks: Quantity | None
    risk: str = ""
    gate: bool = False
    taken: bool = True     # False -> relief exists on paper but cannot actually be bought

    @property
    def racks_unlocked(self) -> int:
        return max(self.racks_after - self.racks_before, 0)

    def eur_per_kW_unlocked(self, rack_kW: float) -> float | None:
        if self.capex_eur is None or self.racks_unlocked == 0:
            return None
        return self.capex_eur.value / (self.racks_unlocked * rack_kW)


@dataclass
class HeadroomLadder:
    steps: list[LadderStep] = field(default_factory=list)
    final: EnvelopeResult | None = None
    initial: EnvelopeResult | None = None
    final_context: EnvelopeContext | None = None

    @property
    def taken_steps(self) -> list["LadderStep"]:
        return [s for s in self.steps if s.taken]

    @property
    def cumulative_capex_eur(self) -> float:
        return sum(s.capex_eur.value for s in self.taken_steps if s.capex_eur is not None)

    @property
    def critical_path_weeks(self) -> float:
        """Reliefs are assumed to run in parallel; the longest lead time governs."""
        return max((s.lead_time_weeks.value for s in self.taken_steps
                    if s.lead_time_weeks is not None), default=0.0)


def _absolute_capex(relief, racks_after: int) -> "Quantity":
    """A relief quoted per rack only costs what the racks it enables cost."""
    if not relief.per_rack:
        return relief.capex_eur
    n = max(racks_after, 1)
    return (relief.capex_eur * V(float(n), "1", f"racks fitted out ({n})", ESTIMATED)).relabel(
        relief.description + f" for {n} racks", "envelope.relief_capex", step_evidence=ESTIMATED)


def ladder(ctx: EnvelopeContext, max_steps: int = 12) -> HeadroomLadder:
    out = HeadroomLadder()
    cur = ctx
    res = solve(cur)
    out.initial = res
    out.final_context = cur
    for i in range(1, max_steps + 1):
        binding = res.binding
        if binding.relief is None:
            break
        nxt_ctx = binding.relief.apply(cur)
        if nxt_ctx is cur:          # relief that cannot actually be bought
            out.steps.append(LadderStep(
                i, binding.id, binding.name, binding.domain, res.max_racks, res.max_racks,
                binding.basis, binding.relief.description,
                _absolute_capex(binding.relief, res.max_racks),
                binding.relief.lead_time_weeks, binding.relief.risk, binding.gate, taken=False))
            break
        nxt = solve(nxt_ctx)
        out.steps.append(LadderStep(
            i, binding.id, binding.name, binding.domain, res.max_racks, nxt.max_racks,
            binding.basis, binding.relief.description,
            _absolute_capex(binding.relief, nxt.max_racks),
            binding.relief.lead_time_weeks, binding.relief.risk, binding.gate))
        if nxt.max_racks <= res.max_racks and nxt.binding.id == binding.id:
            break
        cur, res = nxt_ctx, nxt
    out.final = res
    out.final_context = cur
    return out
