"""What the client is optimising, and which scenario wins under it.

A selection policy is not a reporting concern — the change engine needs it too,
and reporting must not become a dependency of the thing it reports on.
"""
from __future__ import annotations

from dataclasses import dataclass
from enum import Enum

from ..numerics import leq
from .run import ScenarioResult


class Objective(str, Enum):
    """What the customer is actually optimising.

    There is no universally correct recommendation, and a study that pretends
    otherwise is hiding a judgement call inside a formula. State the objective,
    show the others, let the buyer overrule.
    """
    MAX_COMPUTE = "max_compute"          # most racks; capex is secondary
    MIN_COST_PER_RACK = "min_cost"       # cheapest capacity
    FASTEST_TO_POWER = "fastest"         # earliest full energisation


OBJECTIVE_RATIONALE = {
    Objective.MAX_COMPUTE:
        "Maximum deployable compute. On an AI site the revenue attached to a rack "
        "dominates the capital cost of enabling it, so capacity is ranked first and "
        "capex is the tie-break.",
    Objective.MIN_COST_PER_RACK:
        "Lowest capital cost per rack enabled. Appropriate where capital, not "
        "demand, is the binding constraint.",
    Objective.FASTEST_TO_POWER:
        "Earliest full energisation. Appropriate where a tenant commitment has a "
        "date attached and capacity delivered late is worth nothing.",
}


@dataclass(frozen=True)
class Recommendation:
    """The scenario an objective selects, and whether the objective itself could tell it apart from others.

    ``tied_with`` names (by scenario id, sorted) the OTHER scenarios the objective ranked level with the chosen one. When there are none the
    choice was decided by the objective and ``note`` is empty. When there are some, the objective did not decide: the simpler option did (see
    ``pick_with_reason``), and ``note`` says so in the words a reader is shown."""
    result: ScenarioResult
    tied_with: tuple[str, ...] = ()
    #: "" (no tie), "behind_the_meter" (the tied scenarios differ in behind-the-meter equipment: the one without won) or "scenario_id"
    #: (they do not differ in it: the first by scenario id won).
    decided_by: str = ""
    note: str = ""


def _sid(r) -> str:
    """The scenario id, for ordering only. A result without one (a bare stand-in) sorts as "" and keeps the caller's order among its own kind."""
    return str(getattr(getattr(r, "spec", None), "id", ""))


def _btm_dependence(r) -> int:
    """How much behind-the-meter equipment this scenario's PLAN rests on: 2 = the plan installs some, 1 = the scenario keeps behind-the-meter
    options in play (they are on offer, though the plan did not need them), 0 = none. Lower is simpler: equipment that does not have to be
    bought, permitted, fuelled and operated is the cheaper risk at the same racks, the same capex and the same date."""
    lad = getattr(r, "ladder", None)
    ctx = getattr(lad, "final_context", None) or getattr(r, "context", None)
    options = getattr(getattr(ctx, "power", None), "options", None) or []
    if any(getattr(o, "installed", False) for o in options):
        return 2
    return 1 if options else 0


def _cmp(a: tuple, b: tuple) -> int:
    """-1, 0 or 1 comparing two keys term by term; two floats within ``numerics.LIMIT_REL_TOL`` of each other are level (a capex or a date that
    differs by the rounding of a sum is not a difference), anything else is compared exactly."""
    for x, y in zip(a, b):
        if isinstance(x, float) or isinstance(y, float):
            fx, fy = float(x), float(y)
            if leq(fx, fy) and leq(fy, fx):
                continue
            return -1 if fx < fy else 1
        if x != y:
            return -1 if x < y else 1
    return 0


def _tie_sentence(chosen_id: str, tied: list[str], objective: Objective, decided_by: str) -> str:
    others = ", ".join(tied)
    if decided_by == "behind_the_meter":
        return (f"Tied with {others} on {objective.value}; chose the one without behind-the-meter equipment ({chosen_id}). "
                f"The objective could not separate them.")
    return (f"Tied with {others} on {objective.value}, and none of them differs in behind-the-meter equipment; chose {chosen_id}, "
            f"the first by scenario id. The objective could not separate them.")


def pick_with_reason(results: list[ScenarioResult], objective: Objective = Objective.MAX_COMPUTE) -> Recommendation:
    """The scenario ``objective`` selects, and a statement of any tie that decided it.

    The ranking is the objective's own (below). Scenarios it ranks LEVEL are tied, and a tie is broken the same way whatever order the
    scenarios were listed in: first on the simpler option (the one with less behind-the-meter equipment, ``_btm_dependence``), then on the scenario
    id. Before this, the first of the tied scenarios in the caller's own order won, so ``[full_dlc, full_dlc_btm]`` and its reverse recommended
    different scenarios at identical racks and identical capex, for all three objectives.

    The answer is a function of the SET of scenarios: the candidates are put in scenario-id order before anything is compared."""
    if not results:
        raise ValueError("pick_recommended() needs at least one scenario result")
    viable = [r for r in results if r.unlocked_racks > 0] or list(results)
    cands = sorted(viable, key=_sid)                      # stable: results with the same id keep the caller's relative order
    keys: dict[int, tuple]

    if objective is Objective.MIN_COST_PER_RACK:
        # An incomplete capex is a LOWER BOUND (a component has no price). It cannot beat a complete figure by being
        # smaller: the missing price is what makes it small. Complete scenarios rank first; among incomplete ones the
        # lower bounds are the only thing left to order by.
        keys = {id(r): (not r.economics.capex_complete,
                        float(r.economics.capex_total_eur.value / max(r.unlocked_racks, 1))) for r in cands}
    elif objective is Objective.FASTEST_TO_POWER:
        from ..envelope.time_to_power import schedule

        def weeks(r: ScenarioResult) -> float:
            t = schedule(r.ladder)
            return t.weeks_to_full if t.weeks_to_full is not None else float("inf")
        wk = {id(r): weeks(r) for r in cands}
        dated = [r for r in cands if wk[id(r)] != float("inf")]
        if dated:
            # Among dated candidates the date decides; more racks only breaks an exact tie in the date, as a recommendation to open with. It
            # is not a claim that one is faster (the comparison names no leader on a tie).
            cands = dated
            keys = {id(r): (float(wk[id(r)]), -r.unlocked_racks) for r in cands}
        else:
            # Nothing is dated, so nothing is fastest, and capacity is a different objective: it must not decide here. Every candidate is level,
            # so the simpler option opens (then the scenario id): a study needs a scenario to open with, not a winner.
            keys = {id(r): () for r in cands}
    else:
        keys = {id(r): (-r.unlocked_racks, not r.economics.capex_complete, float(r.economics.capex_total_eur.value)) for r in cands}

    best = cands[0]
    for r in cands[1:]:
        if _cmp(keys[id(r)], keys[id(best)]) < 0:
            best = r
    tied = [r for r in cands if _cmp(keys[id(r)], keys[id(best)]) == 0]
    chosen = min(tied, key=lambda r: (_btm_dependence(r), _sid(r)))
    if len(tied) == 1:
        return Recommendation(chosen)
    differ = len({_btm_dependence(r) for r in tied}) > 1
    decided_by = "behind_the_meter" if differ else "scenario_id"
    others = sorted(_sid(r) for r in tied if r is not chosen)
    return Recommendation(chosen, tuple(others), decided_by, _tie_sentence(_sid(chosen), others, objective, decided_by))


def pick_recommended(results: list[ScenarioResult],
                      objective: Objective = Objective.MAX_COMPUTE) -> ScenarioResult:
    return pick_with_reason(results, objective).result


def recommendation_rationale(results: list[ScenarioResult], objective: Objective = Objective.MAX_COMPUTE) -> str:
    """The objective's own rationale, followed by the statement of the tie when one decided the recommendation (and nothing more otherwise)."""
    note = pick_with_reason(results, objective).note
    return OBJECTIVE_RATIONALE[objective] + (" " + note if note else "")
