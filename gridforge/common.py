"""Shared construction helpers. Kept dependency-free on purpose."""
from __future__ import annotations

from typing import Iterable

from .validation import EvidenceClass, Quantity, Source


def V(value: float, unit: str, label: str, evidence: EvidenceClass,
      band: float | tuple[float, float] | None = None,
      assumptions: Iterable[str] = (), sources: Iterable[Source] = ()) -> Quantity:
    """Declare an input quantity with its evidence class. There is no other way in."""
    return Quantity.given(value, unit, label, evidence, band=band,
                          assumptions=assumptions, sources=sources)


ASSUMED = EvidenceClass.E0_ASSUMPTION
MODELLED = EvidenceClass.E1_MODEL
SIMULATED = EvidenceClass.E2_SIMULATION
ESTIMATED = EvidenceClass.E3_ENGINEERING_ESTIMATE
TESTED = EvidenceClass.E4_EXPERIMENTAL
CUSTOMER = EvidenceClass.E5_CUSTOMER_DATA
FIELD = EvidenceClass.E6_FIELD_VALIDATED
DEPLOYED = EvidenceClass.E7_DEPLOYED
