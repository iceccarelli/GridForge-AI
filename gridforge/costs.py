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
    published_benchmark  E1  a public figure, correctly attributed (source, date, region, unit)
    engineering_estimate E3  our own reasoned estimate with its basis written down (private library)
    budgetary_quote      E3  a supplier's indicative number, reviewed
    firm_quote           E5  a written quotation with a validity date
    contracted           E7  what was actually paid on a delivered project

A price that is not in the library is not zero and not free: where a component has no price at all,
the relief says so (``unpriced``) and every total that includes it is a lower bound.
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path

from .clock import report_date, report_date_iso
from .common import ESTIMATED, V
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


#: What each basis is, in the words a report uses.
BASIS_LABEL: dict[str, str] = {
    "library_default": "library placeholder (not a price)",
    "published_benchmark": "published benchmark",
    "engineering_estimate": "engineering estimate",
    "budgetary_quote": "budgetary supplier quote",
    "firm_quote": "firm supplier quote",
    "contracted": "contracted / paid cost",
}

#: Library lines that are priced per unit of capacity ADDED by the relief. A supplier quotes the job, not
#: the unit, so a quotation for one of these is recorded as a lump in EUR and used as-is (it is not
#: scaled), and procurement ingest must not divide it by an unrelated quantity.
CAPACITY_SCALED_KEYS = frozenset({
    "transformer.replacement", "plant.uprate", "pump.uprate", "busway.replacement",
    "floor.load_spreading", "cdu.addition",
})


def private_path() -> Path:
    env = os.environ.get("GRIDFORGE_COST_LIBRARY")
    return Path(env) if env else Path.cwd() / PRIVATE_FILENAME

COST_EVIDENCE: dict[str, EvidenceClass] = {
    "library_default": EvidenceClass.E0_ASSUMPTION,
    "published_benchmark": EvidenceClass.E1_MODEL,
    "engineering_estimate": EvidenceClass.E3_ENGINEERING_ESTIMATE,
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
            return date.fromisoformat(self.valid_until) < report_date()
        except ValueError:
            return False

    def __post_init__(self) -> None:
        import math
        if not (isinstance(self.value, (int, float)) and math.isfinite(self.value)):
            raise ValueError(f"cost entry {self.key!r} has a non-numeric or non-finite value")
        if self.basis not in COST_EVIDENCE:
            raise ValueError(f"cost entry {self.key!r}: unknown basis {self.basis!r}; "
                             f"one of {', '.join(sorted(COST_EVIDENCE))}")
        if self.basis == "published_benchmark":
            missing = [n for n, v in (("source", self.source), ("quoted_on", self.quoted_on),
                                      ("region", self.region)) if not v]
            if missing:
                raise ValueError(
                    f"cost entry {self.key!r}: a published benchmark must be traceable; missing "
                    f"{', '.join(missing)}. A figure that cannot name its source, date and geography "
                    f"is a placeholder.")
        if self.basis == "engineering_estimate" and not (self.note or "").strip():
            raise ValueError(f"cost entry {self.key!r}: an engineering estimate must state its basis in `note`")
        if self.value < 0 or (self.value == 0 and self.basis != "library_default"):
            raise ValueError(
                f"cost entry {self.key!r}: a {self.basis} price of {self.value:g} is not a price. "
                f"A zero quotation would be recorded as a free, high-evidence line.")

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
            "updated": report_date_iso(),
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
        # Record the basis the constraint prices this key on. A supplier quotes one
        # delivered number; the library holds EUR, EUR/rack or EUR/kW depending on
        # the line, and procurement ingest needs to know which without guessing from
        # a step's already-multiplied total.
        DECLARED_UNITS.setdefault(key, unit)
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


#: key -> the unit the constraint that prices it declared. Populated on first
#: lookup, which always happens during a solve, before anything procures.
DECLARED_UNITS: dict[str, str] = {}


def declared_unit(key: str, fallback: str = "EUR") -> str:
    """The unit a QUOTATION for this line should be entered in. Capacity-scaled lines are priced per unit of
    capacity added by the engine, but a supplier prices the job, so a quote for them is a EUR lump."""
    if key in CAPACITY_SCALED_KEYS:
        return "EUR"
    return DECLARED_UNITS.get(key, fallback)


def cost(key: str, fallback_value: float, unit: str, label: str,
         note: str | None = None) -> Quantity:
    return library().lookup(key, fallback_value, unit, label, note)


# --- pricing a relief by what it actually buys ---------------------------------------------------------------------
@dataclass(frozen=True)
class ScaledPrice:
    """A relief price together with the basis it rests on, so a report can say what was bought and how it was priced."""
    capex: Quantity
    kind: str          # "per_unit" | "quoted_job_lump" | "fixed_site"
    scope: str         # what the step buys, in the unit the price is expressed in
    basis: str         # the library basis of the line used


def basis_of(key: str | None) -> str:
    """The basis a priced line rests on: a library basis, 'library_default' when the library has no entry,
    or a sentinel for client-supplied and non-capital reliefs."""
    if not key:
        return "library_default"
    if "." not in key:
        return key.replace("-", "_")                  # client-supplied / not-capital
    e = library().entries.get(key)
    return e.basis if e is not None else "library_default"


def basis_label(key: str | None) -> str:
    b = basis_of(key)
    base = BASIS_LABEL.get(b, b.replace("_", " "))
    e = library().entries.get(key) if key and "." in key else None
    return base + (" (expired)" if e is not None and e.stale else "")


def component_cost(key: str, unit: str, label: str, quantity: float, quantity_unit: str) -> Quantity | None:
    """The library's price for ``quantity`` of a component, or None when the library has NO line for it.

    Unlike cost(), there is no placeholder: a component nobody has priced is reported as unpriced rather than
    filled with a number, because a made-up figure turns a missing cost into a confident total. A line held
    per unit is multiplied by the quantity; a line held as a EUR lump is the price of this job as it stands."""
    DECLARED_UNITS.setdefault(key, unit)
    e = library().entries.get(key)
    if e is None:
        return None
    if e.unit == "EUR":
        return e.quantity().relabel(label + " (job lump as quoted)", "costs.component")
    if e.unit != unit:
        raise ValueError(f"cost line {key!r} is held in {e.unit!r}; this component is priced in {unit!r} or as a EUR lump")
    return (e.quantity() * V(float(quantity), quantity_unit, f"{quantity_unit} of {label}", ESTIMATED)).relabel(
        label, "costs.component")


def scaled_cost(key: str, placeholder_per_unit: float, unit: str, quantity: float, quantity_unit: str,
                label: str, *, note: str | None = None, scope_unit: str | None = None) -> ScaledPrice:
    """Price an intervention by the capacity it actually adds.

    * a library line held per unit (``unit``) is multiplied by the quantity added;
    * a library line held as a lump in EUR is a supplier's price for THIS job and is used as it stands;
    * with no library line, the placeholder per unit is multiplied by the quantity added.

    A zero quantity is a zero-cost step only because nothing was bought; it is never a free purchase of
    something, and the caller should not have taken the step at all.
    """
    import math
    if not (math.isfinite(quantity) and quantity >= 0):
        raise ValueError(f"{key}: quantity added must be a finite number, zero or more (got {quantity!r})")
    DECLARED_UNITS.setdefault(key, unit)
    e = library().entries.get(key)
    scope = f"{quantity:,.4g} {scope_unit or quantity_unit} added"
    if e is not None and e.unit == "EUR":
        q = e.quantity().relabel(label + " (job lump as quoted)", "costs.job_lump")
        return ScaledPrice(q, "quoted_job_lump", scope + "; priced as one quoted job, not scaled", e.basis)
    if e is not None and e.unit != unit:
        raise ValueError(f"cost line {key!r} is held in {e.unit!r}; the engine prices it in {unit!r} or as a EUR lump")
    unit_price = library().lookup(key, placeholder_per_unit, unit, label, note)
    q = (unit_price * V(float(quantity), quantity_unit, f"{quantity_unit} added by this relief", ESTIMATED)).relabel(
        label, "costs.scaled_relief")
    return ScaledPrice(q, "per_unit", scope, e.basis if e is not None else "library_default")


# --- the CDU: priced completely, or reported as incomplete ---------------------------------------------------------
#: Components of a CDU purchase beyond supply and mechanical installation. The library placeholder for a CDU
#: covers the unit supplied and mechanically installed ONLY; these are priced when the library has a line and
#: reported as unpriced when it does not. (key, what it is)
CDU_COMPONENTS = (
    ("cdu.integration", "CDU hydraulic integration and controls"),
    ("cdu.commissioning", "CDU commissioning and flushing"),
)


def cdu_cost(units: int, label: str):
    """Price ``units`` CDUs completely or say what is missing. Returns (capex, kind, scope, unpriced, extra_keys).

    The one place a CDU is priced, shared by the ladder relief and the initial kit, so the same unit is never
    priced twice or priced two ways."""
    sp = scaled_cost("cdu.addition", 180_000, "EUR/unit", float(units), "unit",
                     f"{label}: supplied and mechanically installed", scope_unit="CDU unit(s)",
                     note="Placeholder covering the unit supplied and mechanically installed only. Hydraulic "
                          "integration, controls and commissioning are separate components.")
    capex, unpriced, extra = sp.capex, [], []
    for key, what in CDU_COMPONENTS:
        q = component_cost(key, "EUR/unit", f"{label}: {what}", float(units), "unit")
        if q is None:
            unpriced.append((key, what, "EUR/unit", float(units)))
        else:
            capex = capex + q
            extra.append(key)
    return capex, sp.kind, sp.scope, tuple(unpriced), tuple(extra)


