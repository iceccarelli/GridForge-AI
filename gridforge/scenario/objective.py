"""What the client is optimising, and which scenario wins under it.

A selection policy is not a reporting concern — the change engine needs it too,
and reporting must not become a dependency of the thing it reports on.
"""
from __future__ import annotations

from enum import Enum

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


def pick_recommended(results: list[ScenarioResult],
                      objective: Objective = Objective.MAX_COMPUTE) -> ScenarioResult:
    viable = [r for r in results if r.unlocked_racks > 0] or list(results)
    if objective is Objective.MIN_COST_PER_RACK:
        return min(viable, key=lambda r: r.economics.capex_total_eur.value /
                   max(r.unlocked_racks, 1))
    if objective is Objective.FASTEST_TO_POWER:
        def weeks(r: ScenarioResult) -> float:
            from ..envelope.time_to_power import schedule
            t = schedule(r.ladder)
            return t.weeks_to_full if t.weeks_to_full is not None else float("inf")
        return min(viable, key=lambda r: (weeks(r), -r.unlocked_racks))
    return max(viable, key=lambda r: (r.unlocked_racks, -r.economics.capex_total_eur.value))


