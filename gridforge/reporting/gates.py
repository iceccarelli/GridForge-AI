"""CI gates. These exist so that a tired engineer at 23:00 cannot ship a modelled
number described as a measurement."""
from __future__ import annotations

import re

from enum import Enum

from ..validation import CLAIM_FLOOR, EvidenceClass, Quantity
from .model import Callout, Report


class ReportMode(str, Enum):
    """SCREENING: a study built on library defaults and assumed inputs. Claims below
    their evidence floor are permitted only if the report discloses them explicitly.
    ISSUED: a deliverable resting on customer data. Claims below their floor fail.

    The distinction is the honest one. An engineering estimate built on assumed
    inputs is still an assumption; saying so in the report is what makes selling it
    defensible. Hiding it is what makes it fraud."""
    SCREENING = "screening"
    ISSUED = "issued"


DISCLOSURE_MARKER = "EVIDENCE DISCLOSURE:"

# Language that asserts measurement or certainty. Allowed only where every
# quantity in the report is E5 or above, which for a feasibility study is never.
BANNED_PHRASES = [
    r"\bthe hall'?s capacity is\b",
    r"\bmeasured capacity\b",
    r"\bproven\b",
    r"\bguaranteed\b",
    r"\bwill deliver\b",
    r"\bactual performance\b",
    r"\bverified performance\b",
    r"\bcertified\b",
]


class GateFailure(AssertionError):
    pass


def check_provenance(report: Report) -> None:
    for q in report.quantities():
        if q.prov is None:
            raise GateFailure(f"quantity without provenance: {q}")
        if not q.prov.label:
            raise GateFailure(f"quantity with empty provenance label: {q}")


def check_evidence_monotonicity(report: Report) -> None:
    for q in report.quantities():
        for parent in q.prov.inputs:
            if q.prov.evidence > parent.evidence and q.prov.model_id != "input":
                raise GateFailure(
                    f"{q.prov.label!r} claims {q.prov.evidence.name} but input "
                    f"{parent.label!r} is only {parent.evidence.name}"
                )


def check_language(rendered_text: str, report: Report) -> None:
    strongest_floor = min((q.evidence for q in report.quantities()),
                          default=EvidenceClass.E0_ASSUMPTION)
    if strongest_floor >= EvidenceClass.E5_CUSTOMER_DATA:
        return
    low = rendered_text.lower()
    for pat in BANNED_PHRASES:
        m = re.search(pat, low)
        if m:
            raise GateFailure(
                f"report asserts measurement/certainty ({m.group(0)!r}) but the weakest quantity "
                f"is {strongest_floor.name}"
            )


def claims_below_floor(claims: dict[str, list[Quantity]]) -> dict[str, tuple[EvidenceClass, EvidenceClass]]:
    """Which claim kinds do not meet their evidence floor, and by how much."""
    out: dict[str, tuple[EvidenceClass, EvidenceClass]] = {}
    for kind, qs in claims.items():
        floor = CLAIM_FLOOR.get(kind)
        if floor is None or not qs:
            continue
        weakest = min(q.evidence for q in qs)
        if weakest < floor:
            out[kind] = (weakest, floor)
    return out


def check_claim_floor(report: Report, claims: dict[str, list],
                      mode: ReportMode = ReportMode.SCREENING) -> None:
    """`claims` maps a claim kind (see validation.CLAIM_FLOOR) to quantities."""
    below = claims_below_floor(claims)
    if not below:
        return
    if mode is ReportMode.ISSUED:
        kind, (weakest, floor) = next(iter(below.items()))
        raise GateFailure(
            f"{kind} claims are {weakest.name}, below the required {floor.name} for an issued "
            f"deliverable. Obtain the evidence or remove the claim."
        )
    texts = [b.text for s in report.sections for b in s.blocks if isinstance(b, Callout)]
    disclosure = next((t for t in texts if DISCLOSURE_MARKER in t), None)
    if disclosure is None:
        raise GateFailure(
            f"claims below their evidence floor ({', '.join(below)}) with no "
            f"{DISCLOSURE_MARKER!r} callout in the report."
        )
    missing = [k for k in below if k.replace("_", " ") not in disclosure.lower()]
    if missing:
        raise GateFailure(
            f"evidence disclosure does not name: {', '.join(missing)}"
        )


def run_all_gates(report: Report, rendered_text: str, claims: dict | None = None,
                  mode: ReportMode = ReportMode.SCREENING) -> None:
    check_provenance(report)
    check_evidence_monotonicity(report)
    check_language(rendered_text, report)
    if claims:
        check_claim_floor(report, claims, mode)
