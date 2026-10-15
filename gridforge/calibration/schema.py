"""One reconciled observation: what the model said, what the site turned out to be."""
from __future__ import annotations

import hashlib
import math
import re
from dataclasses import dataclass, asdict
from datetime import date

from ..clock import report_date
from ..validation.evidence import EvidenceClass

# An observation weaker than E5 is not an observation, it is another model run.
# Admitting one would let the ledger validate the engine against itself, which is
# the single most attractive lie available to this business.
MINIMUM_EVIDENCE = EvidenceClass.E5_CUSTOMER_DATA

KEY_RE = re.compile(r"^[a-z0-9_]+\.[a-z0-9_.]+$")


class ObservationError(ValueError):
    pass


def site_ref(site_name: str, hall_id: str) -> str:
    """A stable, non-reversible reference for a client site.

    Client names never enter the ledger. The ledger is the asset we intend to
    publish aggregate statistics from, and an asset that cannot be published
    without a confidentiality review is worth much less than one that can.
    """
    h = hashlib.sha256(f"{site_name.strip().lower()}|{hall_id.strip().lower()}".encode())
    return "site_" + h.hexdigest()[:12]


@dataclass(frozen=True)
class Observation:
    key: str                 # what was reconciled, e.g. "constraint.rack_feed_tapoff.racks"
    site_ref: str            # hashed; never a client name
    predicted: float         # what the engine said, before the site was instrumented
    observed: float          # what the site turned out to be
    unit: str
    observed_on: str         # ISO date the site data covers
    evidence: EvidenceClass
    method: str              # how it was obtained — metering, BMS trend, commissioning record
    platform: str = ""
    note: str = ""

    def __post_init__(self) -> None:
        if not KEY_RE.match(self.key or ""):
            raise ObservationError(
                f"key {self.key!r} must be dotted lowercase, e.g. "
                f"'constraint.rack_feed_tapoff.racks' or 'thermal.pue'")
        if not self.site_ref.startswith("site_"):
            raise ObservationError(
                "site_ref must come from site_ref(); raw client names are not stored")
        if not (math.isfinite(self.predicted) and math.isfinite(self.observed)):
            raise ObservationError("predicted and observed must be finite numbers")
        if self.predicted <= 0:
            raise ObservationError("predicted must be positive — a ratio needs a denominator")
        if self.observed < 0:
            raise ObservationError("observed cannot be negative")
        if self.evidence < MINIMUM_EVIDENCE:
            raise ObservationError(
                f"{self.evidence.name} is below {MINIMUM_EVIDENCE.name}: an observation must "
                f"come from site data, not from another run of our own model")
        try:
            on = date.fromisoformat(self.observed_on)
        except ValueError:
            raise ObservationError(f"observed_on {self.observed_on!r} is not an ISO date")
        if on > report_date():
            raise ObservationError(
                f"observed_on {self.observed_on} is in the future; a site cannot have been observed yet")
        from .keys import expected_unit
        want = expected_unit(self.key)
        if want is not None and self.unit != want:
            raise ObservationError(
                f"{self.key} is recorded in {want!r}, not {self.unit!r}; convert before recording")
        if not self.method.strip():
            raise ObservationError(
                "method is required — an observation nobody can trace is not evidence")

    @property
    def ratio(self) -> float:
        """observed / predicted. Whether >1 is conservative or optimistic depends on the key:
        see ``keys.HIGHER_OBSERVED_IS_OPTIMISTIC``."""
        return self.observed / self.predicted

    @property
    def error_pct(self) -> float:
        return (self.ratio - 1.0) * 100.0

    def to_dict(self) -> dict:
        d = asdict(self)
        d["evidence"] = self.evidence.name
        return d

    @staticmethod
    def from_dict(d: dict) -> "Observation":
        ev = d.get("evidence")
        if isinstance(ev, str):
            ev = EvidenceClass[ev]
        elif isinstance(ev, int):
            ev = EvidenceClass(ev)
        else:
            raise ObservationError("evidence is required on every observation")
        return Observation(
            key=str(d["key"]), site_ref=str(d["site_ref"]),
            predicted=float(d["predicted"]), observed=float(d["observed"]),
            unit=str(d.get("unit") or ""), observed_on=str(d["observed_on"]),
            evidence=ev, method=str(d.get("method") or ""),
            platform=str(d.get("platform") or ""), note=str(d.get("note") or ""))
