"""Provenance DAG. Every number a customer sees can be walked back to its inputs."""
from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from typing import Iterable, Sequence

from .evidence import EvidenceClass


@dataclass(frozen=True)
class Source:
    """A citation. `vendor=True` marks a marketing claim, which can never lift a
    number above E0 on its own (docs/02_ENGINEERING_REFERENCE)."""
    ref: str
    year: int | None = None
    vendor: bool = False
    url: str | None = None

    def __str__(self) -> str:  # pragma: no cover - trivial
        y = f", {self.year}" if self.year else ""
        v = " [V]" if self.vendor else ""
        return f"{self.ref}{y}{v}"


@dataclass(frozen=True)
class Provenance:
    label: str
    model_id: str
    model_version: str = "0.1"
    evidence: EvidenceClass = EvidenceClass.E0_ASSUMPTION
    assumptions: tuple[str, ...] = ()
    sources: tuple[Source, ...] = ()
    inputs: tuple["Provenance", ...] = field(default=(), repr=False)

    # ---- construction -------------------------------------------------
    @staticmethod
    def input_datum(
        label: str,
        evidence: EvidenceClass,
        *,
        assumptions: Sequence[str] = (),
        sources: Sequence[Source] = (),
    ) -> "Provenance":
        """A leaf: something asserted rather than computed."""
        return Provenance(
            label=label,
            model_id="input",
            evidence=evidence,
            assumptions=tuple(assumptions),
            sources=tuple(sources),
        )

    @staticmethod
    def derive(
        label: str,
        model_id: str,
        inputs: Iterable["Provenance"],
        *,
        step_evidence: EvidenceClass = EvidenceClass.E1_MODEL,
        model_version: str = "0.1",
        assumptions: Sequence[str] = (),
        sources: Sequence[Source] = (),
    ) -> "Provenance":
        """Derived quantity.

        THE RULE: the result is never stronger than its weakest input, and never
        stronger than the step that produced it. A model applied to measured data
        yields a modelled number, not a measurement.
        """
        ins = tuple(inputs)
        ev = step_evidence
        for p in ins:
            if p.evidence < ev:
                ev = p.evidence
        return Provenance(
            label=label,
            model_id=model_id,
            model_version=model_version,
            evidence=ev,
            assumptions=tuple(assumptions),
            sources=tuple(sources),
            inputs=ins,
        )

    # ---- inspection ---------------------------------------------------
    @property
    def digest(self) -> str:
        h = hashlib.sha256()
        h.update(f"{self.label}|{self.model_id}|{self.model_version}|{int(self.evidence)}".encode())
        for p in self.inputs:
            h.update(p.digest.encode())
        return h.hexdigest()[:12]

    def walk(self) -> list["Provenance"]:
        """Depth-first list of this node and every ancestor, de-duplicated."""
        seen: dict[str, Provenance] = {}

        def rec(p: Provenance) -> None:
            key = f"{p.label}|{p.model_id}|{p.digest}"
            if key in seen:
                return
            seen[key] = p
            for q in p.inputs:
                rec(q)

        rec(self)
        return list(seen.values())

    def all_assumptions(self) -> list[str]:
        out: list[str] = []
        for p in self.walk():
            for a in p.assumptions:
                if a not in out:
                    out.append(a)
        return out

    def all_sources(self) -> list[Source]:
        out: list[Source] = []
        for p in self.walk():
            for s in p.sources:
                if s not in out:
                    out.append(s)
        return out

    def has_vendor_only_support(self) -> bool:
        srcs = self.all_sources()
        return bool(srcs) and all(s.vendor for s in srcs)

    def to_dict(self) -> dict:
        return {
            "label": self.label,
            "model": f"{self.model_id}@{self.model_version}",
            "evidence": self.evidence.name,
            "digest": self.digest,
            "assumptions": list(self.assumptions),
            "sources": [str(s) for s in self.sources],
            "inputs": [p.to_dict() for p in self.inputs],
        }
