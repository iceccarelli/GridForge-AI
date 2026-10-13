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
from ..validation import EvidenceClass, Quantity

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


def rack_evidence(res: EnvelopeResult) -> EvidenceClass:
    """Weakest evidence class among the constraints that cap this result's rack count.

    A rack count is the minimum over constraints, each built from its own inputs, so it can be no better
    evidenced than the weakest of them (docs/01 §6). Constraints that do not limit the hall (infinite
    headroom) assert nothing and are skipped."""
    classes = [c.max_racks.evidence for c in res.constraints if c.max_racks.value != math.inf]
    return min(classes) if classes else EvidenceClass.E0_ASSUMPTION


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
    cost_key: str | None = None
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
    def cost_keys(self) -> list[str]:
        """Which cost-library lines this ladder's price rests on.

        Sentinels ("client-supplied", "not-capital") are real answers to "where did
        this number come from" but they are not library lines, so they are returned
        here and filtered by whoever is counting placeholders."""
        return [s.cost_key for s in self.taken_steps if s.cost_key]

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


def _absolute_capex(relief, racks_after: int, evidence: EvidenceClass = ESTIMATED) -> "Quantity":
    """A relief quoted per rack only costs what the racks it enables cost (EUR/rack x racks = EUR).

    ``evidence`` is the class of that rack count: it comes from the constraints that cap it, not from a
    blanket claim, so a firm per-rack quotation is not dragged down -- or up -- by a number we asserted."""
    if not relief.per_rack:
        return relief.capex_eur
    n = max(racks_after, 1)
    return (relief.capex_eur * V(float(n), "racks", f"racks fitted out ({n})", evidence)).relabel(
        relief.description + f" for {n} racks", "envelope.relief_capex", step_evidence=evidence)


class LadderDidNotConverge(RuntimeError):
    """The ladder was still finding reliefs when the step budget ran out. Reporting
    the rung it happened to stop on would publish a capacity that is not the ceiling."""


def ladder(ctx: EnvelopeContext, max_steps: int = 200) -> HeadroomLadder:
    out = HeadroomLadder()
    cur = ctx
    res = solve(cur)
    out.initial = res
    out.final_context = cur
    converged = False
    reliefs: dict[int, object] = {}
    for i in range(1, max_steps + 1):
        binding = res.binding
        if binding.relief is None:
            converged = True
            break
        nxt_ctx = binding.relief.apply(cur)
        if nxt_ctx is cur:          # relief that cannot actually be bought
            out.steps.append(LadderStep(
                i, binding.id, binding.name, binding.domain, res.max_racks, res.max_racks,
                binding.basis, binding.relief.description,
                _absolute_capex(binding.relief, res.max_racks, rack_evidence(res)),
                binding.relief.lead_time_weeks, binding.relief.risk, binding.gate,
                binding.relief.cost_key, taken=False))
            converged = True
            break
        nxt = solve(nxt_ctx)
        reliefs[i] = binding.relief
        out.steps.append(LadderStep(
            i, binding.id, binding.name, binding.domain, res.max_racks, nxt.max_racks,
            binding.basis, binding.relief.description,
            _absolute_capex(binding.relief, nxt.max_racks, rack_evidence(nxt)),
            binding.relief.lead_time_weeks, binding.relief.risk, binding.gate,
            binding.relief.cost_key))
        if nxt.max_racks <= res.max_racks and nxt.binding.id == binding.id:
            converged = True
            break
        cur, res = nxt_ctx, nxt
    if not converged:
        raise LadderDidNotConverge(
            f"the headroom ladder was still finding reliefs after {max_steps} steps")
    out.final = res
    out.final_context = cur
    # A per-rack relief costs the racks finally fitted out, not the count that happened to
    # exist when its rung was reached (early rungs often sit at 0 racks and were priced for 1).
    n_final = res.max_racks
    ev_final = rack_evidence(res)
    for st in out.taken_steps:
        relief = reliefs.get(st.step)
        if relief is not None and relief.per_rack and st.capex_eur is not None:
            st.capex_eur = _absolute_capex(relief, n_final, ev_final)
    # A path that never reaches a single deployable rack buys nothing: its reliefs are not a plan.
    if n_final <= 0:
        for st in out.steps:
            st.taken = False
    return out
