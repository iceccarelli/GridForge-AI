"""GridOS-derived capabilities — DORMANT.

No migration. The port exists so that when a customer-facing workflow needs
telemetry, digital-twin state or grid-state models, the seam is already there.
Implementing this before a customer pays for it is forbidden by docs/00 §11.
"""
from ..ports import NotWired, TelemetrySource  # noqa: F401

EXTRACTION_CANDIDATES = [
    "telemetry representation",
    "digital-twin concepts",
    "grid-state models",
    "scenario analysis",
    "visualisation",
    "control / state abstractions",
]
