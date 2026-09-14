"""Cost library — the asset the physics is not.

Every relief on the headroom ladder needs a price. Today most of those prices are
library defaults with a -50%/+100% band, and a study that rests on them says so.
The moment a real quotation lands, that line gets replaced and **the evidence class
of every number derived from it rises**. The deliverable literally gets stronger as
the business accumulates quotations, and the report states which lines are still
guesses.

That is the mechanism worth owning. A competent engineer can rebuild the constraint
physics from public sources in a month. A priced, dated, regional library of what
these interventions actually cost — built from quotations obtained on real projects —
cannot be rebuilt from anything public, and it compounds with every engagement.

Cost evidence maps onto the same ladder as everything else:

    library_default      E0  a placeholder; a band, not a price
    published_benchmark  E1  a public figure, correctly attributed
    budgetary_quote      E3  a supplier's indicative number, reviewed
    firm_quote           E5  a written quotation with a validity date
    contracted           E7  what was actually paid on a delivered project
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path

from .common import V
from .validation import EvidenceClass, Quantity, Source

# Two files, and the distinction matters commercially and legally.
#
# BUNDLED is shipped in the repository and the Docker image. It may hold only
# placeholders and published benchmarks — figures anyone may read. A supplier's
# quotation is confidential, frequently NDA'd, and must never be committed.
#
# PRIVATE is where your own quotations live: gitignored, never in the image,
# overlaid on top of the seed at runtime. Point GRIDFORGE_COST_LIBRARY at a shared
# location if more than one person needs it.
BUNDLED_PATH = Path(__file__).resolve().parent / "data" / "cost_library.json"
PRIVATE_FILENAME = "cost_library.local.json"

#: Bases that may appear in the bundled, version-controlled seed.
PUBLISHABLE_BASES = frozenset({"library_default", "published_benchmark"})


def private_path() -> Path:
    env = os.environ.get("GRIDFORGE_COST_LIBRARY")
    return Path(env) if env else Path.cwd() / PRIVATE_FILENAME

COST_EVIDENCE: dict[str, EvidenceClass] = {
    "library_default": EvidenceClass.E0_ASSUMPTION,
    "published_benchmark": EvidenceClass.E1_MODEL,
    "budgetary_quote": EvidenceClass.E3_ENGINEERING_ESTIMATE,
    "firm_quote": EvidenceClass.E5_CUSTOMER_DATA,
    "contracted": EvidenceClass.E7_DEPLOYED,
}

# AACE class follows the evidence, not the other way round. Quoting Class 3
# accuracy off library defaults is the most common way these numbers mislead.
AACE_BY_EVIDENCE: dict[EvidenceClass, str] = {
    EvidenceClass.E0_ASSUMPTION: "Class 5 (order of magnitude): -50% / +100%",
    EvidenceClass.E1_MODEL: "Class 5 (order of magnitude): -50% / +100%",
    EvidenceClass.E2_SIMULATION: "Class 4 (study): -30% / +50%",
    EvidenceClass.E3_ENGINEERING_ESTIMATE: "Class 4 (study): -30% / +50%",
    EvidenceClass.E4_EXPERIMENTAL: "Class 3 (budget authorisation): -20% / +30%",
    EvidenceClass.E5_CUSTOMER_DATA: "Class 3 (budget authorisation): -20% / +30%",
    EvidenceClass.E6_FIELD_VALIDATED: "Class 2 (control): -15% / +20%",
    EvidenceClass.E7_DEPLOYED: "Class 1 (check estimate): -10% / +15%",
}

BAND_BY_EVIDENCE: dict[EvidenceClass, tuple[float, float]] = {
    EvidenceClass.E0_ASSUMPTION: (0.5, 2.0),
    EvidenceClass.E1_MODEL: (0.5, 2.0),
    EvidenceClass.E2_SIMULATION: (0.7, 1.5),
    EvidenceClass.E3_ENGINEERING_ESTIMATE: (0.7, 1.5),
    EvidenceClass.E4_EXPERIMENTAL: (0.8, 1.3),
    EvidenceClass.E5_CUSTOMER_DATA: (0.8, 1.3),
    EvidenceClass.E6_FIELD_VALIDATED: (0.85, 1.2),
    EvidenceClass.E7_DEPLOYED: (0.9, 1.15),
}


@dataclass(frozen=True)
class CostEntry:
    key: str
    label: str
    unit: str                 # "EUR", "EUR/kW", "EUR/rack"
    value: float
    basis: str = "library_default"
    supplier: str | None = None
    quoted_on: str | None = None      # ISO date of the quotation
    valid_until: str | None = None
    region: str | None = None
    project: str | None = None
    note: str | None = None
    source: str | None = None

    @property
    def evidence(self) -> EvidenceClass:
        return COST_EVIDENCE.get(self.basis, EvidenceClass.E0_ASSUMPTION)

    @property
    def stale(self) -> bool:
        """A quotation with an expired validity date is not a quotation any more."""
        if not self.valid_until:
            return False
        try:
            return date.fromisoformat(self.valid_until) < date.today()
        except ValueError:
            return False

    def quantity(self) -> Quantity:
        ev = EvidenceClass.E1_MODEL if (self.stale and self.evidence > EvidenceClass.E1_MODEL) \
            else self.evidence
        lo, hi = BAND_BY_EVIDENCE[ev]
        assumptions = []
        if self.note:
            assumptions.append(self.note)
        if self.basis == "library_default":
            assumptions.append(
                "Library default, not a price. Replace with a quotation before this figure "
                "supports a capital decision.")
        if self.supplier and self.quoted_on:
            assumptions.append(f"Quoted by {self.supplier} on {self.quoted_on}"
                               + (f", valid to {self.valid_until}" if self.valid_until else "")
                               + (f" ({self.region})" if self.region else "") + ".")
        if self.stale:
            assumptions.append(
                f"Quotation expired on {self.valid_until}; downgraded to a modelled figure "
                "until it is refreshed.")
        sources = [Source(self.source)] if self.source else []
        return V(self.value, self.unit, self.label, ev,
                 band=(self.value * lo, self.value * hi),
                 assumptions=assumptions, sources=sources)


@dataclass
class CostLibrary:
    entries: dict[str, CostEntry] = field(default_factory=dict)
    path: Path | None = None

    @staticmethod
    def load(path: str | Path | None = None) -> "CostLibrary":
        p = Path(path) if path else private_path()
        if not p.exists():
            return CostLibrary(entries={}, path=p)
        raw = json.loads(p.read_text())
        rows = raw.get("entries", raw) if isinstance(raw, dict) else raw
        entries = {}
        for r in rows:
            e = CostEntry(**r)
            entries[e.key] = e
        return CostLibrary(entries=entries, path=p)

    @staticmethod
    def resolved(private: str | Path | None = None) -> "CostLibrary":
        """The seed, overlaid by your own quotations. This is what a study uses."""
        lib = CostLibrary.load(BUNDLED_PATH)
        lib.entries = dict(lib.entries)
        priv = CostLibrary.load(private)
        lib.entries.update(priv.entries)
        lib.path = priv.path
        return lib

    def publishable_violations(self) -> list[str]:
        """Entries that must not be committed. A quotation is confidential."""
        return [e.key for e in self.entries.values() if e.basis not in PUBLISHABLE_BASES]

    def save(self, path: str | Path | None = None) -> Path:
        p = Path(path) if path else (self.path or private_path())
        p.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "schema": "gridforge/cost-library/1",
            "updated": date.today().isoformat(),
            "note": ("Every line carries its basis. library_default is a placeholder, not a "
                     "price. Replacing a line with a quotation raises the evidence class of "
                     "every number derived from it."),
            "entries": [e.__dict__ for e in sorted(self.entries.values(), key=lambda x: x.key)],
        }
        p.write_text(json.dumps(payload, indent=2))
        return p

    def get(self, key: str) -> CostEntry | None:
        return self.entries.get(key)

    def put(self, entry: CostEntry) -> None:
        self.entries[entry.key] = entry

    def lookup(self, key: str, fallback_value: float, unit: str, label: str,
               note: str | None = None) -> Quantity:
        """The price for a relief. Falls back to the caller's placeholder, recorded
        as a library default so the report can count how many of them it rests on."""
        entry = self.entries.get(key)
        if entry is None:
            entry = CostEntry(key=key, label=label, unit=unit, value=fallback_value,
                              basis="library_default", note=note)
        return entry.quantity()

    # --- what the report needs to say about itself -------------------------
    def basis_mix(self, keys: list[str]) -> dict[str, int]:
        mix: dict[str, int] = {}
        for k in keys:
            basis = self.entries[k].basis if k in self.entries else "library_default"
            mix[basis] = mix.get(basis, 0) + 1
        return mix

    def weakest(self, keys: list[str]) -> EvidenceClass:
        worst = EvidenceClass.E7_DEPLOYED
        for k in keys:
            e = self.entries[k].quantity().evidence if k in self.entries \
                else EvidenceClass.E0_ASSUMPTION
            if e < worst:
                worst = e
        return worst

    def aace_class(self, keys: list[str]) -> str:
        return AACE_BY_EVIDENCE[self.weakest(keys)]


_LIBRARY: CostLibrary | None = None


def library() -> CostLibrary:
    global _LIBRARY
    if _LIBRARY is None:
        _LIBRARY = CostLibrary.resolved()
    return _LIBRARY


def reload_library(path: str | Path | None = None) -> CostLibrary:
    global _LIBRARY
    _LIBRARY = CostLibrary.resolved(path)
    return _LIBRARY


def cost(key: str, fallback_value: float, unit: str, label: str,
         note: str | None = None) -> Quantity:
    return library().lookup(key, fallback_value, unit, label, note)
