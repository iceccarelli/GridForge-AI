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
    # The rack count is the minimum over the constraints, so it is no better evidenced than the weakest of them
    # (see rack_evidence). Asserting a flat E3 here let the IT and facility load claim more than the inputs behind
    # the count supported whenever the platform figure was stronger than the hall data.
    classes = [c.max_racks.evidence for c in results if c.max_racks.value != math.inf]
    count_evidence = min([ESTIMATED, *classes]) if classes else EvidenceClass.E0_ASSUMPTION
    nq = V(float(n), "1", "deployable rack count", count_evidence)
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
    #: How the price was formed and what it rests on (see ReliefOption); filled from the relief.
    cost_kind: str = ""
    scope: str = ""
    cost_basis: str = ""           # basis of the library line: library_default, firm_quote, ...
    unpriced: tuple = ()           # ((key, what, unit), ...) components with no price at all
    basis_note: str = ""
    #: Why a relief on the path was NOT counted although it is physically a step ("no deployable capacity
    #: is added by this relief or by anything after it").
    not_taken_reason: str = ""
    extra_cost_keys: tuple = ()
    quantity: float | None = None
    quantity_unit: str = ""
    limited: bool = False

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
    initial_context: EnvelopeContext | None = None

    @property
    def cost_keys(self) -> list[str]:
        """Which cost-library lines this ladder's price rests on.

        Sentinels ("client-supplied", "not-capital") are real answers to "where did
        this number come from" but they are not library lines, so they are returned
        here and filtered by whoever is counting placeholders."""
        keys = [s.cost_key for s in self.taken_steps if s.cost_key]
        for s in self.taken_steps:
            keys.extend(s.extra_cost_keys)
        return keys

    @property
    def taken_steps(self) -> list["LadderStep"]:
        return [s for s in self.steps if s.taken]

    @property
    def cumulative_capex_eur(self) -> float:
        return sum(s.capex_eur.value for s in self.taken_steps if s.capex_eur is not None)

    @property
    def critical_path_complete(self) -> bool:
        """False when a relief that is taken has no lead time: the critical path is then a LOWER BOUND (the
        longest KNOWN lead time), not the path."""
        return all(s.lead_time_weeks is not None for s in self.taken_steps)

    @property
    def critical_path_weeks(self) -> float:
        """Reliefs are assumed to run in parallel; the longest lead time governs. When a taken relief has no
        lead time this is only the longest known one: check ``critical_path_complete`` before quoting it as the
        path (consumers publish None, not this number, for an incomplete path)."""
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


def _step(i: int, binding, res: "EnvelopeResult", racks_after: int, evidence, *, taken: bool = True) -> LadderStep:
    from ..costs import basis_of
    rl = binding.relief
    key = rl.cost_key
    return LadderStep(
        i, binding.id, binding.name, binding.domain, res.max_racks, racks_after,
        binding.basis, rl.description, _absolute_capex(rl, racks_after, evidence),
        rl.lead_time_weeks, rl.risk, binding.gate, key, taken=taken,
        cost_kind="per_rack" if rl.per_rack else rl.cost_kind, scope=rl.scope,
        cost_basis=basis_of(key) if key else "library_default",
        unpriced=tuple(rl.unpriced), basis_note=rl.basis_note,
        extra_cost_keys=tuple(rl.extra_cost_keys), quantity=rl.quantity, quantity_unit=rl.quantity_unit,
        limited=rl.limited)


def ladder(ctx: EnvelopeContext, max_steps: int = 200) -> HeadroomLadder:
    out = HeadroomLadder()
    cur = ctx
    res = solve(cur)
    out.initial = res
    out.initial_context = ctx
    out.final_context = cur
    converged = False
    reliefs: dict[int, object] = {}
    #: the context and result AFTER each step, so the plan can be cut back to the last step that earned anything
    states: dict[int, tuple[EnvelopeContext, "EnvelopeResult"]] = {0: (cur, res)}
    for i in range(1, max_steps + 1):
        binding = res.binding
        if binding.relief is None:
            converged = True
            break
        nxt_ctx = binding.relief.apply(cur)
        if nxt_ctx is cur:          # relief that cannot actually be bought
            st = _step(i, binding, res, res.max_racks, rack_evidence(res), taken=False)
            st.not_taken_reason = "this relief cannot be obtained inside the model's horizon"
            out.steps.append(st)
            converged = True
            break
        nxt = solve(nxt_ctx)
        reliefs[i] = binding.relief
        out.steps.append(_step(i, binding, res, nxt.max_racks, rack_evidence(nxt)))
        states[i] = (nxt_ctx, nxt)
        if nxt.max_racks <= res.max_racks and nxt.binding.id == binding.id:
            converged = True
            break
        cur, res = nxt_ctx, nxt
    if not converged:
        raise LadderDidNotConverge(
            f"the headroom ladder was still finding reliefs after {max_steps} steps")
    # A relief that earns no deployable capacity, and is not followed by one that does, is spending with no
    # return: the plan ends at the last step that added racks. (A zero-gain step BEFORE a gaining one is a
    # tied constraint and stays: relieving one of two limits at the same count changes nothing alone.)
    taken_idx = [s_.step for s_ in out.steps if s_.taken]
    last_gain = max((s_.step for s_ in out.steps if s_.taken and s_.racks_after > s_.racks_before), default=0)
    for st in out.steps:
        if st.taken and st.step > last_gain:
            st.taken = False
            st.not_taken_reason = ("adds no deployable capacity, here or in any later step; "
                                   "not part of the plan and not costed")
    if taken_idx and res.max_racks > 0:
        # Cut the plan back to the last step that earned capacity. (When the hall hosts nothing at the end,
        # the end state is kept: it is the answer to "what still binds".)
        cur, res = states[last_gain]
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
            if st.taken:
                st.not_taken_reason = "the hall still hosts no rack after this plan, so nothing is bought"
            st.taken = False
    return out
