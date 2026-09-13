"""DERIM-derived capabilities — ADAPTER ONLY.

KILL SWITCH (docs/03 §6): if any module under gridforge/power ever imports a
DERIM type directly, the product is turning into another DER platform. Revert.
"""
from ..ports import DERDispatchModel, NotWired, PowerFlowModel  # noqa: F401

EXTRACTION_CANDIDATES = [
    "power-system modelling",
    "energy-flow models",
    "DER models",
    "forecasting",
    "optimisation",
    "protocol ingestion (only where a customer needs it)",
    "scenario analysis",
]
