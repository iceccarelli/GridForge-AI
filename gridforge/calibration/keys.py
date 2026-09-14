"""The vocabulary. What may be reconciled against a site, and what it is called.

Fixed names matter more than they look. A ledger whose keys drift cannot be
aggregated across years, and the entire value of the ledger is in the aggregate.
So the list is written out here rather than derived from the constraint registry:
renaming a constraint function must not silently orphan four years of observations.
A test asserts this list still covers every constraint the engine evaluates.

Add keys. Do not rename them.
"""
from __future__ import annotations

#: Whole-model outputs, independent of which constraint bound.
MODEL_KEYS: dict[str, str] = {
    "envelope.it_load_kW": "Deployable IT load in the hall",
    "envelope.racks": "Racks of the target platform actually deployed",
    "envelope.facility_load_kW": "Total facility load at the meter",
    "thermal.pue": "Annualised PUE after the works",
    "schedule.weeks_to_full": "Weeks from go-ahead to full capacity",
    "economics.capex_total_eur": "Delivered capex for the works",
}

#: Every constraint the engine is willing to be held to, by stable id.
CONSTRAINT_IDS: tuple[str, ...] = (
    "architecture_capability",
    "busway_ampacity",
    "cdu_capacity",
    "floor_loading",
    "floor_space",
    "grid_firm_capacity",
    "hydraulic_flow",
    "plant_capacity",
    "rack_feed_tapoff",
    "residual_air_removal",
    "tcs_supply_achievable",
    "transformer_capacity",
    "ups_capacity",
)

CONSTRAINT_KEY_SUFFIX = "racks"


def constraint_key(constraint_id: str) -> str:
    return f"constraint.{constraint_id}.{CONSTRAINT_KEY_SUFFIX}"


def constraint_id_of(key: str) -> str | None:
    parts = key.split(".")
    if len(parts) == 3 and parts[0] == "constraint" and parts[2] == CONSTRAINT_KEY_SUFFIX:
        return parts[1]
    return None


def all_keys() -> list[str]:
    return sorted(list(MODEL_KEYS) + [constraint_key(i) for i in CONSTRAINT_IDS])


def known(key: str) -> bool:
    return key in MODEL_KEYS or constraint_id_of(key) in CONSTRAINT_IDS


def label(key: str) -> str:
    if key in MODEL_KEYS:
        return MODEL_KEYS[key]
    cid = constraint_id_of(key)
    return f"Racks permitted by {cid.replace('_', ' ')}" if cid else key
