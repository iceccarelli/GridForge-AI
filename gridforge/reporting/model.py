"""Report model. A typed tree that cannot carry a number without its provenance."""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Iterable, Union

from ..validation import Quantity

@dataclass(frozen=True)
class Lit:
    """A deliberate non-quantity literal: an ordinal, an identifier, a count that
    is structural rather than measured. Using it is an explicit statement that the
    value needs no provenance. Everything else must be a Quantity."""
    text: str

    def __str__(self) -> str:  # pragma: no cover - trivial
        return self.text


Cell = Union[str, int, Quantity, Lit]
_BARE_NUMBER = re.compile(r"^\s*[-+]?\d[\d,\s]*\.?\d*\s*(kW|MW|EUR|%|racks|K|degC|A|weeks)?\s*$")


class ProvenanceError(ValueError):
    """Raised when a number reaches the report without a provenance chain."""


@dataclass
class Para:
    text: str


@dataclass
class Bullets:
    items: list[str]


@dataclass
class Callout:
    kind: str          # "warning" | "note" | "answer"
    text: str


@dataclass
class Statement:
    """A headline number plus the one sentence that explains what limits it."""
    label: str
    value: Quantity
    basis: str = ""


@dataclass
class Table:
    headers: list[str]
    rows: list[list[Cell]]
    caption: str = ""

    def __post_init__(self) -> None:
        for r in self.rows:
            for c in r:
                if isinstance(c, Lit):
                    continue
                if isinstance(c, (str, int)) and _BARE_NUMBER.match(str(c)) and c.strip() not in ("", "-", "—"):
                    raise ProvenanceError(
                        f"bare number {c!r} in a report table: wrap it in a Quantity so it carries "
                        "its provenance and evidence class"
                    )


Block = Union[Para, Bullets, Callout, Statement, Table]


@dataclass
class Section:
    heading: str
    blocks: list[Block] = field(default_factory=list)
    level: int = 2


@dataclass
class Report:
    title: str
    subtitle: str
    watermark: str
    sections: list[Section] = field(default_factory=list)
    footer: str = ""
    meta: list[tuple[str, str]] = field(default_factory=list)   # title-block fields
    status: str = "Screening study"

    def quantities(self) -> list[Quantity]:
        out: list[Quantity] = []
        for s in self.sections:
            for b in s.blocks:
                if isinstance(b, Statement):
                    out.append(b.value)
                elif isinstance(b, Table):
                    for r in b.rows:
                        out.extend(c for c in r if isinstance(c, Quantity))
        return out

    def assumptions(self) -> list[str]:
        seen: list[str] = []
        for q in self.quantities():
            for a in q.prov.all_assumptions():
                if a not in seen:
                    seen.append(a)
        return seen

    def sources(self) -> list:
        seen = []
        for q in self.quantities():
            for s in q.prov.all_sources():
                if s not in seen:
                    seen.append(s)
        return seen
