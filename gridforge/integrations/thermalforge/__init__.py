"""ThermalForge-derived capabilities.

EXTRACTION POLICY (docs/03 §6): extract calculations, not applications. Each
extraction lands as its own PR with a parity test against the ThermalForge
original and an explicit evidence class. A ThermalForge calculation is E1 until
a check exists that makes it E3.

DO NOT import: UI, auth, portal, demo fixtures, or any dependency the extracted
calculation does not need.

Nothing is extracted yet: the source repository has not been audited.
"""
from ..ports import HydraulicModel, NotWired, ThermalNetworkModel  # noqa: F401

EXTRACTION_CANDIDATES = [
    "liquid cooling calculations",
    "thermal network / heat-split model",
    "rack-density analysis",
    "thermal constraint expressions",
    "hydraulic calculations (flow, pressure drop, pump head)",
    "cooling architecture comparison",
    "scenario modelling",
    "thermal report generation",
]
