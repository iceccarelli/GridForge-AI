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

import math
from dataclasses import dataclass, field
from datetime import date

from ..clock import report_date
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

    deviations: list[str] = field(default_factory=list)
    #: True when the supplier quoted a lead time but no installation time. ``weeks_to_energised`` is then the lead time
    #: ALONE (delivery to site, not energisation): a lower bound, never a complete programme.
    install_weeks_missing: bool = False

    @property
    def programme_basis(self) -> str:
        """What ``weeks_to_energised`` measures: 'complete' (lead + install), 'lead_only' (install time not quoted)
        or 'none' (no lead time)."""
        if self.weeks_to_energised is None:
            return "none"
        return "lead_only" if self.install_weeks_missing else "complete"

    @property
    def needs_engineering_review(self) -> bool:
        """A bid that cannot be compared on programme as quoted: the engineer must obtain the missing time first."""
        return self.install_weeks_missing

    @property
    def compliant(self) -> bool:
        """Every mandatory requirement answered, and none answered 'N'. A bid that is
        silent on a mandatory requirement has not said it complies."""
        return not self.mandatory_failed and not self.unanswered

    def headline(self) -> str:
        if self.disqualified:
            return (f"{self.supplier}: not evaluated — "
                    f"{'; '.join(self.notes[:2]) or 'incomplete response'}")
        price = f"EUR {self.capex_eur:,.0f}" if self.capex_eur is not None else "no price"
        weeks = ("no programme" if self.weeks_to_energised is None else
                 f"{self.weeks_to_energised:.0f} weeks to delivered (install time not quoted)"
                 if self.install_weeks_missing else f"{self.weeks_to_energised:.0f} weeks to energised")
        flag = ("" if self.compliant else
                f" — {len(self.mandatory_failed) + len(self.unanswered)} mandatory not met")
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


VALID_CODES = {COMPLIANT, COMPLIES_WITH_DEVIATION, NON_COMPLIANT}

#: A price this far from the modelled budget is answering a different question —
#: most often a supplier quoting in thousands, or for a different scope.
BUDGET_PLAUSIBILITY_FACTOR = 10.0


def _iso(raw: str, what: str, supplier: str) -> date:
    try:
        return date.fromisoformat(raw)
    except ValueError:
        raise ProcurementError(
            f"{supplier}: {what} {raw!r} is not an ISO date (YYYY-MM-DD)") from None


def _check_response(pkg: SpecPackage, r: SupplierResponse, today: date) -> list[str]:
    """Hard errors raise (the response is not this tender's); soft problems are returned
    and disqualify the bid from ranking without discarding the others."""
    spec = r.specification
    if spec:
        for key, attr in (("project", "project"), ("hall", "hall"),
                          ("constraint", "constraint_id"),
                          ("sized_for_racks", "sized_for_racks")):
            if not hasattr(pkg, attr):
                continue
            mine = getattr(pkg, attr)
            if key in spec and str(spec[key]) != str(mine):
                raise ProcurementError(
                    f"{r.supplier}: this response was written for {key} {spec[key]!r}, "
                    f"but the current specification has {key} {mine!r}. The requirements "
                    f"have changed or the response belongs to another tender; ask the "
                    f"supplier to re-price against the current specification.")
    if _iso(r.received_on, "received_on", r.supplier) > today:
        raise ProcurementError(
            f"{r.supplier}: received_on {r.received_on} is in the future.")
    for rid, code in r.compliance.items():
        if code not in VALID_CODES:
            raise ProcurementError(
                f"{r.supplier}: compliance code {code!r} for {rid} is not one of "
                f"C, CD or N.")
    problems: list[str] = []
    if r.valid_until and _iso(r.valid_until, "valid_until", r.supplier) < today:
        problems.append(f"offer expired on {r.valid_until}")
    if r.currency and r.currency != "EUR":
        # The price is read from capex_eur and ranked against EUR bids, and the engine holds no exchange rate: a JPY or USD figure
        # in that field would rank as if it were euros (800,000 JPY as the cheapest compliant bid). Disqualify, say why, keep the others.
        problems.append(f"quoted in {r.currency}, but the specification requires EUR (C-01) and the engine holds no exchange rate; "
                        f"re-quote in EUR so it can be compared")
    capex, lead, install = r.get("capex_eur"), r.get("lead_time_weeks"), r.get("install_weeks")
    if capex is not None and capex <= 0:
        problems.append(f"price {capex:,.0f} is not a positive amount")
    if lead is not None and lead <= 0:
        problems.append(f"lead time {lead:g} weeks is not positive")
    if install is not None and install < 0:
        problems.append(f"installation duration {install:g} weeks is negative")
    budget = getattr(pkg, "budget_eur", None)
    if capex is not None and capex > 0 and budget is not None and budget.value > 0:
        ratio = capex / budget.value
        if ratio > BUDGET_PLAUSIBILITY_FACTOR or ratio < 1 / BUDGET_PLAUSIBILITY_FACTOR:
            problems.append(
                f"price EUR {capex:,.0f} is {ratio:.2g}x the modelled budget of "
                f"EUR {budget.value:,.0f}; confirm the units and scope and resubmit")
    return problems


def assess(pkg: SpecPackage, responses: list[SupplierResponse]) -> list[BidAssessment]:
    if not responses:
        raise ProcurementError("no responses to assess")
    seen: set[str] = set()
    for r in responses:
        key = r.supplier.strip().lower()
        if key in seen:
            raise ProcurementError(
                f"two responses from {r.supplier!r}. Supply one current response per "
                f"supplier; a superseded quotation must not compete with its replacement.")
        seen.add(key)
    today = report_date()
    mandatory = pkg.mandatory()
    required_fields = [f for f in pkg.response_fields if f.required]

    out: list[BidAssessment] = []
    for r in responses:
        problems = _check_response(pkg, r, today)
        failed = [q.id for q in mandatory
                  if r.compliance.get(q.id, "").upper() == NON_COMPLIANT]
        unanswered = [q.id for q in mandatory if q.id not in r.compliance]
        missing_fields = [f.label for f in required_fields if r.get(f.key) is None]

        capex = r.get("capex_eur")
        lead = r.get("lead_time_weeks")
        install = r.get("install_weeks")
        # A missing installation time is missing, not zero: the figure below is then the lead time alone and says so.
        weeks = None if lead is None else lead + (install if install is not None else 0.0)
        install_missing = lead is not None and install is None

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
            mandatory_failed=failed, unanswered=unanswered, install_weeks_missing=install_missing)

        a.deviations = [q.id for q in mandatory
                        if r.compliance.get(q.id, "").upper() == COMPLIES_WITH_DEVIATION]
        if problems:
            a.disqualified = True
            a.notes.append("response not evaluated: " + "; ".join(problems))
        if install_missing:
            a.notes.append(
                "install time not quoted: the programme shown is the lead time alone (delivery to site), a lower "
                "bound on the energised date. The bid is not scored on programme and ranks after bids that quoted "
                "an installation time; the engineer must obtain weeks from delivery to energised before comparing it.")
        if a.deviations:
            a.notes.append(
                f"complies with deviation on {', '.join(a.deviations)}: the engineer must "
                f"accept each deviation in writing before award.")
        if not r.specification:
            a.notes.append(
                "response is not tied to a specification (no 'specification' block); it "
                "cannot be checked against the current revision.")
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
    # Only complete programmes set the scale: a lead-only figure is a lower bound and must not become the 'best' week.
    programmes = [a.weeks_to_energised for a in live
                  if a.weeks_to_energised is not None and not a.install_weeks_missing]

    for a in live:
        by_id = {c.id: c for c in pkg.criteria}
        compliance_fraction = (
            (a.mandatory_met - 0.5 * len(a.deviations)) / a.mandatory_total
            if a.mandatory_total else 1.0)
        a.scores["C1"] = compliance_fraction * by_id["C1"].weight if "C1" in by_id else 0.0
        a.scores["C2"] = (
            _score_lower_is_better(programmes, a.weeks_to_energised) * by_id["C2"].weight
            if "C2" in by_id and a.weeks_to_energised is not None and not a.install_weeks_missing and programmes
            else 0.0)
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
        key=lambda a: (a.disqualified, not a.compliant, a.install_weeks_missing, -a.total_score,
                       a.capex_eur if a.capex_eur is not None else float("inf")))


def schedule_impact(pkg: SpecPackage, a: BidAssessment) -> str:
    """What this bid does to the date, against the modelled lead time."""
    if a.weeks_to_energised is None or pkg.lead_time_weeks is None:
        return "No programme stated; the effect on the energisation date is unknown."
    if a.install_weeks_missing:
        return (f"Install time not quoted: {a.weeks_to_energised:.0f} weeks is delivery to site only, a lower bound on "
                f"the energised date, so the effect on the date against the modelled "
                f"{pkg.lead_time_weeks.value:.0f} weeks is unknown until the installation time is stated.")
    modelled = pkg.lead_time_weeks.value
    delta = a.weeks_to_energised - modelled
    if abs(delta) < 1:
        return f"In line with the modelled {modelled:.0f} weeks."
    direction = "later" if delta > 0 else "earlier"
    return (f"{abs(delta):.0f} weeks {direction} than the modelled {modelled:.0f}. "
            f"Re-run the study with this figure before committing: if this relief sets "
            f"the date, the whole envelope moves with it.")
