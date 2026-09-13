"""What each caller is allowed to see. The commercial gate, written down once.

The free tier has to be genuinely useful or nobody fills the form in; it must not
be the paid product or nobody pays. The line we draw is the one the site's own AI
analyst already draws: a real directional read, never a bankable number.

PUBLIC gets: the binding constraint and why, deployable racks as found and after
relief, which item sets the date, and the list of inputs nobody has measured.
PUBLIC never gets: capex, lead times in weeks, energy economics, the full ladder,
or the scenario comparison. Those are the deliverable.
"""
from __future__ import annotations

from enum import Enum


class Tier(str, Enum):
    PUBLIC = "public"       # the website qualifier: no key
    CLIENT = "client"       # a paying engagement: API key
    INTERNAL = "internal"   # us


# Keys stripped from any payload served to a PUBLIC caller, at any depth.
PUBLIC_REDACTED_KEYS = frozenset({
    "capex_eur", "capex_total_eur", "capex_per_kW_it", "capex_eur_per_kW",
    "lead_time_weeks", "critical_path_weeks", "weeks_to_full", "weeks_to_first_rack",
    "annual_energy_cost_eur", "energy_cost_per_gpu_hour_eur", "economics",
    "ladder", "curve", "constraints", "sensitivity", "document",
})

PUBLIC_NOTICE = (
    "Directional screening read. Modelled from the inputs supplied, against library "
    "defaults for everything not supplied. It is not a bankable number, not a design, "
    "and not a measurement of this asset. Capital cost, programme duration, the full "
    "constraint ladder and the scenario comparison are part of the paid engagement."
)


def redact(value, tier: Tier):
    """Strip paid content from a payload. Recursive, key-based, and deliberately
    blunt: a new field is hidden by default only if it is named in the list, so
    adding a paid figure means adding its key here. The test suite fails if a
    public payload ever carries a euro figure."""
    if tier is not Tier.PUBLIC:
        return value
    if isinstance(value, dict):
        return {k: redact(v, tier) for k, v in value.items() if k not in PUBLIC_REDACTED_KEYS}
    if isinstance(value, list):
        return [redact(v, tier) for v in value]
    return value
