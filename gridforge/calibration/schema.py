"""One reconciled observation: what the model said, what the site turned out to be."""
from __future__ import annotations

import hashlib
import math
import re
from dataclasses import dataclass, asdict
from datetime import date, datetime

from ..clock import report_date
from ..validation.evidence import EvidenceClass

# An observation weaker than E5 is not an observation, it is another model run.
# Admitting one would let the ledger validate the engine against itself, which is
# the single most attractive lie available to this business.
MINIMUM_EVIDENCE = EvidenceClass.E5_CUSTOMER_DATA

KEY_RE = re.compile(r"^[a-z0-9_]+\.[A-Za-z0-9_.]+$")
#: "site_" + 12 hex of the site alone, optionally "-" + 8 hex of site+hall. The part before "-" is the SITE.
SITE_REF_RE = re.compile(r"^site_[0-9a-f]{12}(-[0-9a-f]{8})?$")
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
#: observation id + ":" + the sha256 of the evidence artifact it was reviewed against.
SOURCE_REF_RE = re.compile(r"^[A-Za-z0-9_-]{8,64}:[0-9a-f]{64}$")

#: What a ledger row may be. A vendor quote and a declared/assumed value are different things from a measurement and
#: are never calibration data, whatever else is true of them.
KINDS = ("measured", "quoted", "declared")


class ObservationError(ValueError):
    pass


def site_only_ref(site_name: str) -> str:
    """A stable, non-reversible reference for a client SITE (every hall of it).

    The independence requirement for calibration is about sites. Five readings from three halls of one site are
    one site, so the site part of every reference must be derivable on its own. The website stores this exact
    value (site label only) and the database computes it with the same algorithm.
    """
    h = hashlib.sha256(site_name.strip().lower().encode())
    return "site_" + h.hexdigest()[:12]


def site_ref(site_name: str, hall_id: str) -> str:
    """A stable, non-reversible reference for one hall of a client site: the site reference, then a hall suffix.

    Client names never enter the ledger. The ledger is the asset we intend to publish aggregate statistics from,
    and an asset that cannot be published without a confidentiality review is worth much less than one that can.
    """
    h = hashlib.sha256(f"{site_name.strip().lower()}|{hall_id.strip().lower()}".encode())
    return f"{site_only_ref(site_name)}-{h.hexdigest()[:8]}"


def site_of(ref: str) -> str:
    """The site part of a site or hall reference."""
    return ref.split("-", 1)[0]


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
    #: Only 'measured' is accepted. 'quoted' (a vendor's promise) and 'declared' (an assumed or customer-stated
    #: value) are other things and are refused rather than quietly recorded as observations.
    kind: str = "measured"
    #: Traceability: "<observation id>:<evidence sha256>". Empty only for hand-entered fixtures (source 'cli').
    source_ref: str = ""
    #: The engine provenance digest of the build that made the prediction being checked.
    model_digest: str = ""
    reviewed_by: str = ""        # self-asserted until per-person identity exists
    reviewed_at: str = ""
    #: How it reached the ledger: 'cli' (typed by hand), 'import' (a verified admin export), or '' (library use).
    source: str = ""
    #: May this entry appear in the published ledger. False for anything without a source_ref.
    published: bool = False

    def __post_init__(self) -> None:
        if not KEY_RE.match(self.key or ""):
            raise ObservationError(
                f"key {self.key!r} must be dotted (e.g. "
                f"'constraint.rack_feed_tapoff.racks' or 'thermal.pue'), a name from the vocabulary")
        from .keys import known
        if not known(self.key):
            raise ObservationError(
                f"key {self.key!r} is not in the calibration vocabulary (`gridforge calibrate keys`). An "
                f"observation under an unknown key would be counted nowhere and could hide that a model "
                f"output has never been checked.")
        if self.kind in ("quoted", "declared"):
            what = "a vendor quote" if self.kind == "quoted" else "a declared or assumed value"
            raise ObservationError(
                f"kind {self.kind!r} is refused: {what} is not a measurement of what was built. Only "
                f"'measured' observations enter the ledger.")
        if self.kind != "measured":
            raise ObservationError(f"kind {self.kind!r} is not recognised; expected one of {KINDS}")
        if not SITE_REF_RE.match(self.site_ref or ""):
            raise ObservationError(
                "site_ref must come from site_ref() or site_only_ref(); raw client names are not stored")
        if self.source_ref:
            if not SOURCE_REF_RE.match(self.source_ref):
                raise ObservationError(
                    "source_ref must be '<observation id>:<evidence sha256>' (64 hex characters)")
            if not SHA256_RE.match(self.model_digest or ""):
                raise ObservationError(
                    "a sourced observation must carry the engine provenance digest (64 hex) of the "
                    "prediction it checks")
            if not (self.reviewed_by or "").strip():
                raise ObservationError("a sourced observation must name its reviewer")
            try:
                datetime.fromisoformat((self.reviewed_at or "").replace("Z", "+00:00"))
            except ValueError:
                raise ObservationError(f"reviewed_at {self.reviewed_at!r} is not an ISO date or timestamp")
        elif self.model_digest and not SHA256_RE.match(self.model_digest):
            raise ObservationError("model_digest must be a 64-character sha256 hex digest")
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
    def site(self) -> str:
        """The site this observation belongs to (every hall of one site is one site)."""
        return site_of(self.site_ref)

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
            platform=str(d.get("platform") or ""), note=str(d.get("note") or ""),
            kind=str(d.get("kind") if d.get("kind") is not None else "measured"),
            source_ref=str(d.get("source_ref") or ""), model_digest=str(d.get("model_digest") or ""),
            reviewed_by=str(d.get("reviewed_by") or ""), reviewed_at=str(d.get("reviewed_at") or ""),
            source=str(d.get("source") or ""), published=bool(d.get("published", False)))
