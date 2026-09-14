"""Comparing bids in racks and weeks, not only in euros.

Procurement compares price. That is the wrong axis for this purchase: the item
being bought exists to unlock compute on a date, and the bid that is 12% cheaper
and 14 weeks slower is the expensive one. So every bid is scored against what it
does to the capacity model — racks unlocked, and the week the envelope energises —
alongside its price.

Scoring is transparent on purpose. Each criterion's contribution is reported, not
just the total, because an evaluation a losing bidder cannot follow is one they can
challenge, and that challenge lands on the client.
"""
from __future__ import annotations

from dataclasses import dataclass, field

from .schema import (MANDATORY, EvaluationCriterion, ProcurementError, Requirement,
                     SpecPackage, SupplierResponse)

#: Compliance codes, as used in every tender response schedule in the industry.
COMPLIANT = "C"
COMPLIES_WITH_DEVIATION = "CD"
NON_COMPLIANT = "N"


@dataclass
class BidAssessment:
    supplier: str
    received_on: str
    capex_eur: float | None
    lead_time_weeks: float | None
    install_weeks: float | None
    weeks_to_energised: float | None
    racks_unlocked: int
    eur_per_rack: float | None
    mandatory_total: int
    mandatory_met: int
    mandatory_failed: list[str] = field(default_factory=list)
    unanswered: list[str] = field(default_factory=list)
    scores: dict[str, float] = field(default_factory=dict)
    total_score: float = 0.0
    disqualified: bool = False
    notes: list[str] = field(default_factory=list)

    @property
    def compliant(self) -> bool:
        return not self.mandatory_failed

    def headline(self) -> str:
        if self.disqualified:
            return (f"{self.supplier}: not evaluated — "
                    f"{'; '.join(self.notes[:2]) or 'incomplete response'}")
        price = f"EUR {self.capex_eur:,.0f}" if self.capex_eur is not None else "no price"
        weeks = (f"{self.weeks_to_energised:.0f} weeks to energised"
                 if self.weeks_to_energised is not None else "no programme")
        flag = "" if self.compliant else f" — {len(self.mandatory_failed)} mandatory not met"
        return f"{self.supplier}: {price}, {weeks}, score {self.total_score:.0f}/100{flag}"


def _score_lower_is_better(values: list[float], v: float) -> float:
    """Linear, best gets 1.0, worst gets 0.0. With one bid, everything scores 1.0.

    Deliberately not a ratio of the cheapest to each bid: that quietly rewards an
    outlier low price far out of proportion to the difference it makes, which is
    how a tender gets won by an exclusion nobody read.
    """
    lo, hi = min(values), max(values)
    if hi == lo:
        return 1.0
    return (hi - v) / (hi - lo)


def assess(pkg: SpecPackage, responses: list[SupplierResponse]) -> list[BidAssessment]:
    if not responses:
        raise ProcurementError("no responses to assess")
    mandatory = pkg.mandatory()
    required_fields = [f for f in pkg.response_fields if f.required]

    out: list[BidAssessment] = []
    for r in responses:
        failed = [q.id for q in mandatory
                  if r.compliance.get(q.id, "").upper() == NON_COMPLIANT]
        unanswered = [q.id for q in mandatory if q.id not in r.compliance]
        missing_fields = [f.label for f in required_fields if r.get(f.key) is None]

        capex = r.get("capex_eur")
        lead = r.get("lead_time_weeks")
        install = r.get("install_weeks")
        weeks = None if lead is None else lead + (install or 0.0)

        a = BidAssessment(
            supplier=r.supplier, received_on=r.received_on,
            capex_eur=capex, lead_time_weeks=lead, install_weeks=install,
            # Against what the package was SIZED for, not the rung's own delta.
            # The supplier priced the end state; dividing by the marginal racks
            # produces a per-rack figure several times too large and makes every
            # bid look absurd next to the study's own economics.
            weeks_to_energised=weeks, racks_unlocked=pkg.sized_for_racks,
            eur_per_rack=(None if capex is None or pkg.sized_for_racks == 0
                          else capex / pkg.sized_for_racks),
            mandatory_total=len(mandatory),
            mandatory_met=len(mandatory) - len(failed) - len(unanswered),
            mandatory_failed=failed, unanswered=unanswered)

        if missing_fields:
            a.disqualified = True
            a.notes.append(
                "required response fields left blank: " + ", ".join(missing_fields))
        if failed:
            a.notes.append(
                f"mandatory requirements marked non-compliant: {', '.join(failed)}")
        if unanswered:
            a.notes.append(
                f"mandatory requirements with no compliance statement: "
                f"{', '.join(unanswered)}")
        out.append(a)

    live = [a for a in out if not a.disqualified]
    prices = [a.capex_eur for a in live if a.capex_eur is not None]
    programmes = [a.weeks_to_energised for a in live if a.weeks_to_energised is not None]

    for a in live:
        by_id = {c.id: c for c in pkg.criteria}
        compliance_fraction = (a.mandatory_met / a.mandatory_total) if a.mandatory_total else 1.0
        a.scores["C1"] = compliance_fraction * by_id["C1"].weight if "C1" in by_id else 0.0
        a.scores["C2"] = (
            _score_lower_is_better(programmes, a.weeks_to_energised) * by_id["C2"].weight
            if "C2" in by_id and a.weeks_to_energised is not None and programmes else 0.0)
        a.scores["C3"] = (
            _score_lower_is_better(prices, a.capex_eur) * by_id["C3"].weight
            if "C3" in by_id and a.capex_eur is not None and prices else 0.0)
        # Outage and evidence are judged, not computed. They are scored zero here
        # and the report says so, rather than inventing a number to fill the column.
        a.scores["C4"] = 0.0
        a.scores["C5"] = 0.0
        a.total_score = sum(a.scores.values())
        if a.scores.get("C4") == 0.0 and "C4" in by_id:
            a.notes.append(
                "Installation method and evidence quality are scored by the engineer, "
                "not by this tool — 15 points are unallocated until they are.")

    return out


def rank_bids(pkg: SpecPackage, responses: list[SupplierResponse]) -> list[BidAssessment]:
    """Compliant bids first, then by score. A non-compliant bid is never ranked above
    a compliant one however cheap it is — that ordering is the point of a mandatory
    requirement."""
    assessed = assess(pkg, responses)
    return sorted(
        assessed,
        key=lambda a: (a.disqualified, not a.compliant, -a.total_score,
                       a.capex_eur if a.capex_eur is not None else float("inf")))


def schedule_impact(pkg: SpecPackage, a: BidAssessment) -> str:
    """What this bid does to the date, against the modelled lead time."""
    if a.weeks_to_energised is None or pkg.lead_time_weeks is None:
        return "No programme stated; the effect on the energisation date is unknown."
    modelled = pkg.lead_time_weeks.value
    delta = a.weeks_to_energised - modelled
    if abs(delta) < 1:
        return f"In line with the modelled {modelled:.0f} weeks."
    direction = "later" if delta > 0 else "earlier"
    return (f"{abs(delta):.0f} weeks {direction} than the modelled {modelled:.0f}. "
            f"Re-run the study with this figure before committing: if this relief sets "
            f"the date, the whole envelope moves with it.")
