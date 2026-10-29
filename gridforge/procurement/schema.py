"""What a specification is made of.

Every requirement carries the constraint it came from. That link is the whole
argument for buying this from us rather than writing it in Word: a requirement
nobody can trace back to a physical limit is a requirement somebody invented, and
those are how a tender ends up specifying equipment the hall does not need.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

from ..validation import EvidenceClass, Quantity


class ProcurementError(ValueError):
    pass


#: Requirement classes, in the order a tender document uses them.
MANDATORY = "shall"      # non-compliance disqualifies
PREFERRED = "should"     # scored, not disqualifying
INFORMATIVE = "may"      # stated for context


@dataclass(frozen=True)
class Requirement:
    id: str                       # "E-03"
    clause: str                   # "Secondary rating"
    statement: str                # the sentence a supplier reads
    obligation: str = MANDATORY
    value: Quantity | None = None
    unit: str = ""
    #: The constraint id this came from. Empty only for commercial/interface clauses.
    derived_from: str = ""
    basis: str = ""               # why this number, in engineering terms
    verification: str = ""        # how compliance will be demonstrated

    def __post_init__(self) -> None:
        if self.obligation not in (MANDATORY, PREFERRED, INFORMATIVE):
            raise ProcurementError(f"unknown obligation {self.obligation!r}")
        if not self.statement.strip():
            raise ProcurementError(f"{self.id}: a requirement with no statement")

    @property
    def evidence(self) -> EvidenceClass | None:
        return self.value.evidence if self.value else None


@dataclass(frozen=True)
class ScopeItem:
    id: str
    title: str
    detail: str
    by_supplier: bool = True      # False -> explicitly by others, stated to stop a gap


@dataclass(frozen=True)
class EvaluationCriterion:
    """How a bid is scored.

    Weights must total 100. Not a formality: an evaluation matrix that does not sum
    is one a losing bidder can challenge, and in a regulated operator's procurement
    that challenge lands on the client, not on us.
    """
    id: str
    name: str
    weight: int
    how: str                      # what evidence moves this score


@dataclass(frozen=True)
class ResponseField:
    """A number the supplier must return, in the unit we will read it in.

    This is the half of the document that pays us back. A free-text quotation is a
    price; a completed response schedule is a dated, attributable, structured
    figure that goes straight into the cost library and lifts the evidence class of
    every study that touches it.
    """
    key: str                      # "capex_eur" | "lead_time_weeks" | "secondary_rating_A"
    label: str
    unit: str
    required: bool = True
    #: Cost-library key this field feeds, if any.
    cost_key: str = ""
    #: The unit that library key is held in — EUR, EUR/rack or EUR/kW. A supplier
    #: quotes a lump sum; the library holds whichever basis the relief uses, and
    #: converting between them wrongly poisons every future study on that line.
    cost_unit: str = ""
    note: str = ""


#: How a site condition reached the specification.
SC_SUPPLIED = "supplied"            # the client declared it
SC_ASSUMED = "assumed"              # not supplied: the model used a default, shown with its class (E0)
SC_LIBRARY = "library"              # a platform / library figure, never a client declaration
SC_NOT_MODELLED = "not_modelled"    # not supplied and the engine has no input for it: nothing derated for it


@dataclass(frozen=True)
class SiteCondition:
    """One condition the duties are quoted at. Either a quantity (value, unit and evidence class travel with it)
    or, for a scheme such as a redundancy level, a text. A condition that was not supplied says so; it is
    never presented as though it had been."""
    id: str
    label: str
    status: str
    statement: str
    value: Quantity | None = None
    text: str = ""
    unit: str = ""
    path: str = ""                # the intake path this condition comes from, where it has one

    def to_dict(self) -> dict:
        q = self.value
        return {"id": self.id, "label": self.label, "path": self.path or None, "status": self.status,
                "value": None if q is None else q.rounded(),
                "text": self.text or None, "unit": (q.unit if q is not None else self.unit) or None,
                "evidence": None if q is None else q.evidence.short, "statement": self.statement}


@dataclass(frozen=True)
class AssumedInput:
    """An intake input that was not supplied and was filled from the library or a stated assumption."""
    path: str
    label: str
    unit: str
    fallback: str                 # what was used, as rendered with its evidence class

    def to_dict(self) -> dict:
        return {"path": self.path, "label": self.label, "unit": self.unit, "assumed": self.fallback}


@dataclass
class SpecPackage:
    project: str
    hall: str
    relief_title: str
    constraint_id: str
    constraint_name: str
    racks_before: int
    racks_after: int
    #: What the duties are sized for — the hall's end state, not this rung's delta.
    sized_for_racks: int = 0
    #: The IT load those racks represent, for converting a lump-sum bid into a
    #: EUR/kW library line.
    sized_for_kW: float = 0.0
    scope: list[ScopeItem] = field(default_factory=list)
    requirements: list[Requirement] = field(default_factory=list)
    criteria: list[EvaluationCriterion] = field(default_factory=list)
    response_fields: list[ResponseField] = field(default_factory=list)
    lead_time_weeks: Quantity | None = None
    budget_eur: Quantity | None = None
    #: What the package asks suppliers to price, in the unit the engine prices the line in: the total the ladder
    #: adds for this constraint across every step ("23.4 MVA"). A lump quote is recorded against it, so it is
    #: used in proportion to what each step needs and never charged again per step.
    scope_quantity: float | None = None
    scope_quantity_unit: str = ""
    notes: list[str] = field(default_factory=list)
    #: The conditions every duty is quoted at, and every intake input that was assumed rather than supplied.
    site_conditions: list[SiteCondition] = field(default_factory=list)
    assumed_inputs: list[AssumedInput] = field(default_factory=list)

    @property
    def racks_unlocked(self) -> int:
        return max(self.racks_after - self.racks_before, 0)

    def validate(self) -> None:
        if not self.requirements:
            raise ProcurementError("a specification with no requirements is a letter")
        total = sum(c.weight for c in self.criteria)
        if self.criteria and total != 100:
            raise ProcurementError(
                f"evaluation weights total {total}, not 100 — a matrix that does not "
                f"sum is one a losing bidder can challenge")
        ids = [r.id for r in self.requirements]
        if len(set(ids)) != len(ids):
            raise ProcurementError("duplicate requirement ids")
        orphans = [r.id for r in self.requirements
                   if r.obligation == MANDATORY and r.value is not None
                   and not r.derived_from]
        if orphans:
            raise ProcurementError(
                f"mandatory numeric requirements with no constraint behind them: "
                f"{', '.join(orphans)}. A number nobody can trace is a number somebody "
                f"invented.")

    def mandatory(self) -> list[Requirement]:
        return [r for r in self.requirements if r.obligation == MANDATORY]


def _section(d: dict, name: str) -> dict:
    """A response section: absent or empty means unanswered, anything else must be an object. Without the check a string or a
    number here was an AttributeError on `.items()`, which the HTTP layer reports as a 500 engine error for the caller's mistake."""
    raw = d.get(name) or {}
    if not isinstance(raw, dict):
        raise ProcurementError(f"response field {name!r} must be an object, not {type(raw).__name__}")
    return raw


def _numeric(raw: dict) -> dict[str, float]:
    out: dict[str, float] = {}
    for k, v in raw.items():
        if v is None or (isinstance(v, str) and not v.strip()):
            continue
        try:
            num = float(v)
        except (TypeError, ValueError):
            raise ProcurementError(
                f"response field {k!r} is {v!r}, which is not a number. If the supplier "
                f"gave a range or a caveat, put the figure here and the caveat in 'text'.")
        if not math.isfinite(num):
            raise ProcurementError(
                f"response field {k!r} is {v!r}: a quotation figure must be a finite number.")
        out[str(k)] = num
    return out


@dataclass
class SupplierResponse:
    """A completed response schedule. Deliberately dumb: values keyed by field."""
    supplier: str
    received_on: str              # ISO date
    values: dict[str, float] = field(default_factory=dict)
    text: dict[str, str] = field(default_factory=dict)
    compliance: dict[str, str] = field(default_factory=dict)   # requirement id -> C/CD/N
    reference: str = ""
    valid_until: str = ""
    currency: str = ""
    #: The specification this response was written against, copied from the response
    #: template. Without it a response for another hall, another constraint or an
    #: earlier sizing is indistinguishable from a current one.
    specification: dict = field(default_factory=dict)

    def get(self, key: str) -> float | None:
        v = self.values.get(key)
        return None if v is None else float(v)

    @staticmethod
    def from_dict(d: dict) -> "SupplierResponse":
        if not isinstance(d, dict):
            raise ProcurementError(
                f"a response must be an object, not {type(d).__name__}")
        if not d.get("supplier"):
            raise ProcurementError("a response must name the supplier")
        if not d.get("received_on"):
            raise ProcurementError(
                "a response must carry the date it was received — an undated price "
                "cannot become a dated cost-library entry")
        return SupplierResponse(
            supplier=str(d["supplier"]), received_on=str(d["received_on"]),
            # Nulls are the template's own placeholders — an unanswered optional
            # field, not an error. A value that is present but not a number IS an
            # error, and it is named, because "this response failed to load" is
            # useless to whoever has to go back to the supplier.
            values=_numeric(_section(d, "values")),
            text={str(k): str(v) for k, v in _section(d, "text").items()},
            compliance={str(k): str(v).upper()
                        for k, v in _section(d, "compliance").items()
                        if str(v).strip()},
            reference=str(d.get("reference") or ""),
            valid_until=str(d.get("valid_until") or ""),
            currency=str(d.get("currency") or "").strip().upper(),
            specification=dict(_section(d, "specification")))
