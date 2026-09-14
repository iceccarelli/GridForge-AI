"""What a specification is made of.

Every requirement carries the constraint it came from. That link is the whole
argument for buying this from us rather than writing it in Word: a requirement
nobody can trace back to a physical limit is a requirement somebody invented, and
those are how a tender ends up specifying equipment the hall does not need.
"""
from __future__ import annotations

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
    notes: list[str] = field(default_factory=list)

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


def _numeric(raw: dict) -> dict[str, float]:
    out: dict[str, float] = {}
    for k, v in raw.items():
        if v is None or (isinstance(v, str) and not v.strip()):
            continue
        try:
            out[str(k)] = float(v)
        except (TypeError, ValueError):
            raise ProcurementError(
                f"response field {k!r} is {v!r}, which is not a number. If the supplier "
                f"gave a range or a caveat, put the figure here and the caveat in 'text'.")
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

    def get(self, key: str) -> float | None:
        v = self.values.get(key)
        return None if v is None else float(v)

    @staticmethod
    def from_dict(d: dict) -> "SupplierResponse":
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
            values=_numeric(d.get("values") or {}),
            text={str(k): str(v) for k, v in (d.get("text") or {}).items()},
            compliance={str(k): str(v).upper()
                        for k, v in (d.get("compliance") or {}).items()
                        if str(v).strip()},
            reference=str(d.get("reference") or ""),
            valid_until=str(d.get("valid_until") or ""))
