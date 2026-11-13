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
from ..thermal.schema import Architecture


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
    #: False only for a ladder handed back by ``ladder(..., allow_partial=True)`` after its step budget ran out: it is then NOT the ceiling
    #: (reliefs were still being found), ``non_convergence_reason`` says so, and no date or cost built on it is complete.
    converged: bool = True
    non_convergence_reason: str = ""

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
    def unassessed_banks(self) -> tuple[str, ...]:
        """Equipment banks the client did not declare, by name ("transformers", "UPS").

        An undeclared bank evaluates as "not limiting" (unbounded racks), so the ladder never prices or
        times the relief it would have needed. That is not an assessment of the bank, it is the absence of
        one: the rack figure stands as a screening answer, but any date, critical path or cost built on this
        ladder is a LOWER BOUND and must not be presented as complete.

        CDUs are deliberately NOT here: a hall being converted from air to liquid has no CDUs, and that is the normal state, not a gap in
        the intake. The scenario assumes a kit (``installed=False``), prices it, and the schedule dates the racks that depend on it
        (``time_to_power.schedule``)."""
        ctx = self.initial_context
        if ctx is None:
            return ()
        out = []
        if not ctx.power.transformers:
            out.append("transformers")
        if not ctx.power.ups:
            out.append("UPS")
        return tuple(out)

    @property
    def assumed_cdu_kit(self) -> bool:
        """True when this ladder starts from a CDU kit the engine ASSUMED (``installed=False``) in a liquid architecture: the racks as
        found run on cooling that has still to be bought, delivered and commissioned."""
        ctx = self.initial_context
        return bool(ctx is not None and ctx.architecture in (Architecture.HYBRID_DLC, Architecture.FULL_DLC)
                    and any(not c.installed for c in ctx.thermal.cdus))

    @property
    def cdu_kit_lead_time(self) -> Quantity | None:
        """The library lead time of the CDU relief (the very object ``cdu_capacity`` carries), or None when there is none."""
        res = self.initial
        if res is None:
            return None
        for c in res.constraints:
            if c.id == "cdu_capacity" and c.relief is not None:
                return c.relief.lead_time_weeks
        return None

    @property
    def incomplete_reason(self) -> str:
        """Why the path is not complete, in words a reader can act on; "" when it is complete."""
        parts = []
        if self.unassessed_banks:
            parts.append("not declared: " + ", ".join(self.unassessed_banks)
                         + " (reliefs they would need are neither priced nor timed)")
        if self.non_convergence_reason:
            parts.append(self.non_convergence_reason)
        gaps = [s.binding_name for s in self.taken_steps if s.lead_time_weeks is None]
        if gaps:
            parts.append("no lead time is known for " + ", ".join(gaps))
        return "; ".join(parts)

    @property
    def critical_path_complete(self) -> bool:
        """False when a relief that is taken has no lead time, or an equipment bank was not declared: the
        critical path is then a LOWER BOUND (the longest KNOWN lead time), not the path."""
        return self.converged and not self.unassessed_banks and all(s.lead_time_weeks is not None for s in self.taken_steps)

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


class LadderDidNotConverge(RuntimeError, ValueError):
    """The ladder was still finding reliefs when the step budget ran out. Reporting
    the rung it happened to stop on would publish a capacity that is not the ceiling.

    It is also a ValueError: the cause is the input (a hall so large the ladder cannot be finished inside the work one request may ask
    for), so the API answers a NAMED 422 (the message below, with the figures as keys) and refunds the call, rather than a 500 that blames the
    engine or a 422 that says only "could not be processed as given". The message names the intake fields that set the size of the hall, the
    rungs taken, the limit, the hard cap and about how many rungs the hall needs.

    The figures are attributes too, for the API layer to carry as keys: ``rungs_taken``, ``step_limit`` (the budget this ladder ran with),
    ``step_cap`` (the most any request may take), ``rungs_needed_estimate`` (an ESTIMATE, None when it cannot be made), ``racks_reached`` and
    ``racks_ceiling`` (what the supply and the free positions could carry, None when not known) and ``supported_MW``."""

    def __init__(self, message: str, *, rungs_taken: int | None = None, step_limit: int | None = None, step_cap: int | None = None,
                 rungs_needed_estimate: int | None = None, racks_reached: int | None = None, racks_ceiling: int | None = None,
                 supported_MW: int | None = None):
        super().__init__(message)
        self.rungs_taken, self.step_limit, self.step_cap = rungs_taken, step_limit, step_cap
        self.rungs_needed_estimate, self.racks_reached, self.racks_ceiling, self.supported_MW = rungs_needed_estimate, racks_reached, racks_ceiling, supported_MW

    def detail(self) -> dict:
        """The figures that are known, as the keys an API answer carries (None entries left out)."""
        keys = {"rungs_taken": self.rungs_taken, "step_limit": self.step_limit, "step_cap": self.step_cap,
                "rungs_needed_estimate": self.rungs_needed_estimate, "racks_reached": self.racks_reached, "racks_ceiling": self.racks_ceiling,
                "supported_MW": self.supported_MW}
        return {k: v for k, v in keys.items() if v is not None}


#: The fewest rungs the ladder may use, whatever the size of the hall (the historical fixed budget; ordinary halls never come near it).
LADDER_STEP_FLOOR = 200
#: Rungs allowed per MW of hall size (see ``ladder_step_budget``). The measured need is at most ``LADDER_STEPS_PER_MW_MEASURED`` (1.75 per MW,
#: below), so 3 per MW is about 1.7 times what the library-sized equipment needs: a plant with smaller modules than the library's needs
#: proportionally more rungs, and the budget says so by name when it runs out.
LADDER_STEPS_PER_MW = 3.0
#: The most rungs one request may demand: a deterministic bound on the work (no clock is read: the engine stays reproducible). Measured on the
#: largest hall the loader admits (50,000 positions, 5,000 MVA, 5,000 MW of behind-the-meter capacity; Python 3.13, one core), a rung costs
#: 1.2 to 2 ms and 0.1 MB, growing with depth:
#:     rungs   200    400    600    800    1,200  2,000   4,000
#:     CPU s   0.36   0.70   1.20   1.63   2.49   4.25    9.80     (full_dlc_btm, the widest scenario; hybrid/full DLC run ~10% quicker)
#:     RSS MB  33     48     62     77     106    165     312
#: A request runs up to three liquid ladders. The provenance chain deepens by about one level per rung (the capex total adds each rung's price
#: to the last), and its digest is recursive: /v1/screen, /study and /compare raised RecursionError (a 500) at about 1,000 rungs, so the cap
#: must stay well under the interpreter's recursion limit: tests/test_ladder_convergence.py pins it at no more than two thirds of it (666).
#: 660 is the largest round figure under that pin. It was 600 under a rule in which a rung bought two UPS modules in EVERY block; a rung now
#: buys two modules in ONE block (so how a plant is listed cannot change its price), which takes about 1.7 rungs per MW instead of 1.3, and 600
#: would have refused halls of 400 MW that were answered before. 660 answers halls up to about 370 MW of firm supply plus behind-the-meter
#: capacity in the widest scenario (660 / 1.75); a hall that needs more is refused by name (LadderDidNotConverge, a 422 that says how many rungs
#: it took, the limit and about how many it needs) and must be split into one request per hall. Raising it further needs the digest not to
#: recurse once per rung (the capex total built in one step), which is outside the solver.
LADDER_STEP_CAP = 660
#: Rungs per MW of hall size actually needed, measured worst case: the supported scale the refusal states. MEASURED, not chosen: the seeded
#: corpus of tests/test_ladder_rungs_per_mw.py (every shipped hall's own equipment under a supply of 400 MW, the plant small beside the supply so
#: that the ladder must buy almost everything, hybrid / full DLC / full DLC with behind-the-meter supply) needs at most 1.70 rungs per MW of
#: ``ladder_size_MW`` (1.19 at 100 MW, 1.57 at 200, 1.68 at 300, 1.70 at 400 and beyond, where it stops growing); this is that figure rounded
#: up by 0.05. The test fails if a rung rule changes the measurement past it, and if the measurement falls so far below it that the supported
#: scale in the refusal would understate what the engine now does. Re-measure with ``python tests/test_ladder_rungs_per_mw.py``.
LADDER_STEPS_PER_MW_MEASURED = 1.75

#: The intake fields that set how many rungs a hall needs, named in the refusal so the caller knows what to split or re-check.
_SIZE_FIELDS = "hall.positions_available, grid.firm_capacity_MVA, grid.contracted_MW and btm_options.capacity_MW"


def _finite_positive(x: float) -> float:
    return x if isinstance(x, (int, float)) and math.isfinite(x) and x > 0 else 0.0


def ladder_size_MW(ctx: EnvelopeContext) -> float:
    """The size of the hall as far as the number of rungs goes, in MW: the smaller of what the supply could carry (the lesser of the firm connection
    and the contract, plus every behind-the-meter option) and what the free positions could hold at the platform's rack power. Non-finite or
    non-positive figures count as zero (they cannot enlarge it). The one figure the budget, the supported scale and the measurement of rungs per MW
    (tests/test_ladder_rungs_per_mw.py) all read."""
    g = ctx.power.grid
    supply_MW = min(_finite_positive(g.firm_capacity_MVA.value * g.power_factor.value), _finite_positive(g.contracted_MW.value))
    btm_MW = sum(_finite_positive(o.capacity_MW.value) for o in ctx.power.options)
    hall_MW = _finite_positive(float(ctx.hall.positions_available) * ctx.cluster.platform.rack_kW.value / 1000.0)
    return min(supply_MW + btm_MW, hall_MW)


def supported_scale_MW() -> int:
    """The size, in MW of firm supply plus behind-the-meter capacity, up to which the cap answers a hall in the widest scenario: the cap over the measured
    rungs per MW, rounded down to ten (370 MW at 660 rungs and 1.75 per MW). The figure the refusal and the README state."""
    return int(LADDER_STEP_CAP / LADDER_STEPS_PER_MW_MEASURED // 10 * 10)


def ladder_step_budget(ctx: EnvelopeContext) -> int:
    """How many rungs the ladder may take for this hall: LADDER_STEP_FLOOR plus LADDER_STEPS_PER_MW for every MW of the hall's size
    (``ladder_size_MW``), never more than LADDER_STEP_CAP.

    Every relief adds a fixed increment (two busway runs, one further CDU unit, two UPS modules: each in total, not per bank or block, so how a plant is listed does not change the number of rungs), so the rungs needed grow with how
    much capacity there is to unlock. A fixed 200 rungs refused ordinary halls above roughly 150 MVA."""
    return int(min(LADDER_STEP_CAP, LADDER_STEP_FLOOR + math.ceil(LADDER_STEPS_PER_MW * ladder_size_MW(ctx))))


def _rungs_needed_estimate(res: "EnvelopeResult", taken: int) -> tuple[int | None, int | None]:
    """(estimate of the rungs the hall needs in all, racks its supply and free positions could carry), or (None, None) when it cannot be made.

    An ESTIMATE, labelled so wherever it is shown: the ladder was cut off, so the real figure is not known. It scales the rungs taken by the share of
    the ceiling still to unlock, the ceiling being the lesser of the free rack positions (no relief adds one) and the supply's own headroom in racks
    (``grid_firm_capacity.margin_racks``, which counts the behind-the-meter options already taken: another one raises it, so the estimate is a lower
    bound where options remain)."""
    ceilings = []
    for c in res.constraints:
        if c.id == "floor_space" and math.isfinite(c.racks):
            ceilings.append(c.racks)
        if c.id == "grid_firm_capacity" and c.margin_racks is not None and math.isfinite(c.margin_racks):
            ceilings.append(max(c.margin_racks, 0.0))
    if len(ceilings) < 2 or res.max_racks <= 0:
        return None, None
    ceiling = int(min(ceilings))
    if ceiling <= res.max_racks:
        return None, ceiling or None
    return int(math.ceil(taken * ceiling / res.max_racks)), ceiling


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


def _relief_moved_the_binding_constraint(before: EnvelopeResult, after: EnvelopeResult, constraint_id: str) -> bool:
    """True when a relief that did not yet earn a rack still RAISED the binding constraint's own capacity, with the hall still holding no rack.

    A relief is a fixed increment (two UPS modules in one block, one CDU unit, a 60% transformer uprate), and a hall whose protected load exceeds
    the usable UPS by more than one increment has a negative headroom that the first rung only shrinks: ``max_racks`` stays 0 and the binding
    constraint stays the same, which the stop rule below reads as "this relief earns nothing, the ladder has converged". The plan was then lost: a
    4 x 2 module plant under a 9 MW protected load went from 8 / 9 / 43 racks (when a rung bought modules in every block at once) to 0 / 0 / 0 once
    a rung bought two in one block. The relief had earned something, only not yet in whole racks: ``ConstraintResult.margin_racks`` (the capacity
    before it is floored and clamped at zero) went from -31.1 to -13.3 racks, and the next rung to +4.4. So the ladder keeps climbing while the binding constraint's own capacity
    strictly rises and the hall is still at zero racks. It is not a licence to loop: the capacity rises by a fixed increment per rung, so the
    shortfall is closed in a bounded number of rungs, and the step budget (``ladder_step_budget``, never above LADDER_STEP_CAP) is the only
    backstop, as it is for every other ladder. A constraint that reports no margin (a gate, an unlimited constraint) never extends the ladder."""
    if after.max_racks != 0 or before.max_racks != 0:
        return False
    was = next((c for c in before.constraints if c.id == constraint_id), None)
    now = next((c for c in after.constraints if c.id == constraint_id), None)
    if was is None or now is None or was.margin_racks is None or now.margin_racks is None:
        return False
    if not (math.isfinite(was.margin_racks) and math.isfinite(now.margin_racks)):
        return False
    return now.margin_racks > was.margin_racks


def ladder(ctx: EnvelopeContext, max_steps: int | None = None, *, allow_partial: bool = False) -> HeadroomLadder:
    """The Headroom Ladder: relieve the binding constraint, solve again, repeat until a relief earns nothing.

    ``max_steps`` None (the default) takes the budget the hall's size calls for (``ladder_step_budget``); an explicit number is honoured
    exactly. When the budget runs out while reliefs are still being found, the ladder is NOT the ceiling: ``LadderDidNotConverge`` is
    raised, naming the fields that set the hall's size. With ``allow_partial=True`` the rungs taken so far come back instead, in a ladder
    with ``converged=False`` and a ``non_convergence_reason`` that says so (and that withholds the date and the complete critical path)."""
    if max_steps is None:
        max_steps = ladder_step_budget(ctx)
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
        if nxt.max_racks < res.max_racks:
            # A relief that leaves the hall with FEWER racks than it had is not a relief, whatever it was written to do
            # (a replacement part that is weaker than the installed one, for example). It is shown, not taken, and the plan stops here:
            # the next rung would only relieve the constraint this one made worse.
            st = _step(i, binding, res, res.max_racks, rack_evidence(res), taken=False)
            st.not_taken_reason = (f"applying this relief would lower the hall from {res.max_racks} to {nxt.max_racks} rack(s), "
                                   "so it is not taken and not costed")
            out.steps.append(st)
            converged = True
            break
        reliefs[i] = binding.relief
        out.steps.append(_step(i, binding, res, nxt.max_racks, rack_evidence(nxt)))
        states[i] = (nxt_ctx, nxt)
        if nxt.max_racks <= res.max_racks and nxt.binding.id == binding.id and not _relief_moved_the_binding_constraint(res, nxt, binding.id):
            converged = True
            break
        cur, res = nxt_ctx, nxt
    if not converged:
        estimate, ceiling = _rungs_needed_estimate(res, max_steps)
        needs = (f"This hall needs about {estimate:,} steps (an estimate: the {max_steps} taken reached {res.max_racks:,} of the {ceiling:,} racks its "
                 f"supply and free positions could carry); "
                 if estimate is not None else f"This hall needs more than {max_steps} steps; ")
        if max_steps >= LADDER_STEP_CAP:
            limit = f"one request may take at most {max_steps} (the most any request may take: LADDER_STEP_CAP)"
        elif max_steps == ladder_step_budget(ctx):
            limit = (f"the limit for a hall of this size is {max_steps} steps ({LADDER_STEP_FLOOR} plus {LADDER_STEPS_PER_MW:g} per MW of its size), "
                     f"and no request may take more than {LADDER_STEP_CAP}")
        else:
            limit = f"this ladder was given a limit of {max_steps} steps, and no request may take more than {LADDER_STEP_CAP}"
        why = (f"the headroom ladder was still finding reliefs after {max_steps} steps, at {res.max_racks} rack(s) "
               f"(from {out.initial.max_racks} as found), so the capacity reached is not the ceiling. {needs}{limit}. The size of the hall sets the number of "
               f"steps: check {_SIZE_FIELDS}, or split the site into one request per hall. "
               f"Supported scale: a hall that needs at most {LADDER_STEP_CAP} steps, which is about "
               f"{supported_scale_MW()} MW of firm supply plus behind-the-meter capacity "
               f"(measured: up to {LADDER_STEPS_PER_MW_MEASURED:g} steps per MW)")
        if not allow_partial:
            raise LadderDidNotConverge(why, rungs_taken=max_steps, step_limit=max_steps, step_cap=LADDER_STEP_CAP, rungs_needed_estimate=estimate,
                                       racks_reached=res.max_racks, racks_ceiling=ceiling, supported_MW=supported_scale_MW())
        out.converged = False
        out.non_convergence_reason = why
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
