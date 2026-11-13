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
from ..intake.loader import PLAUSIBLE_MAX
from .schema import (BOUND_MIN, MANDATORY, EvaluationCriterion, ProcurementError, Requirement,
                     SpecPackage, SupplierResponse, figure_text)

#: Compliance codes, as used in every tender response schedule in the industry.
COMPLIANT = "C"
COMPLIES_WITH_DEVIATION = "CD"
NON_COMPLIANT = "N"

#: What a score is, said wherever one is shown. The price and programme criteria are scaled across the bids in THIS comparison (best = full marks,
#: worst = none, a lone bid = full marks), so the same bid scores 85 against one set of peers and 35 against another.
SCORE_BASIS = ("Scores are relative, not absolute: price and programme are scaled linearly from the best bid in this comparison (full marks) "
               "to the worst (none), and a lone bid gets full marks on both. The same bid scores differently against different competitors, "
               "so compare scores only within one comparison, never across comparisons.")


@dataclass(frozen=True)
class FigureContradiction:
    """A bid's own number set against a numeric 'shall' it is held to: the requirement, the figure asked for and the figure offered."""
    requirement_id: str
    clause: str
    response_key: str             # the response field the figure was read from ("duty_at_site_conditions")
    bound: str                    # BOUND_MIN or BOUND_MAX
    asked: float
    offered: float
    unit: str
    declared: str                 # the code the bidder returned for the requirement ("" when none)
    path: str = ""                # where that field sits in the request, when it has a place there

    @property
    def asked_text(self) -> str:
        return f"{'not less than' if self.bound == BOUND_MIN else 'not more than'} {figure_text(self.asked)} {self.unit}".strip()

    @property
    def offered_text(self) -> str:
        return f"{figure_text(self.offered)} {self.unit}".strip()

    def message(self) -> str:
        where = self.path or self.response_key
        head = (f"{self.requirement_id} ({self.clause}) is a 'shall' {self.asked_text}, but {where} offers {self.offered_text}")
        if self.declared == COMPLIANT:
            return (f"{head}. The bid declared C, and its own figure contradicts it, so it is treated as NOT compliant on {self.requirement_id}. "
                    f"If the figure is in another unit, or at a reference condition rather than the site conditions, the supplier must restate it as "
                    f"asked ({self.asked_text}) and resubmit.")
        if self.declared == COMPLIES_WITH_DEVIATION:
            return (f"{head}. The bid declared a deviation on {self.requirement_id}; the figure is that deviation, and the engineer must "
                    f"accept it in writing before award.")
        return f"{head}."

    def to_dict(self) -> dict:
        return {"requirement": self.requirement_id, "clause": self.clause, "field": self.path or self.response_key,
                "must_be": "at_least" if self.bound == BOUND_MIN else "at_most", "asked": self.asked, "offered": self.offered,
                "unit": self.unit, "declared": self.declared or None}


def numeric_requirements(pkg) -> list[Requirement]:
    """The package's 'shall' clauses that hold a bid's own figure to a number (not the ones that only ask for a declaration)."""
    return [q for q in pkg.mandatory() if q.response_key and q.figure_limit is not None]


def _is_short(q: Requirement, offered: float) -> bool:
    asked = q.figure_limit
    if asked is None or math.isclose(offered, asked, rel_tol=1e-9, abs_tol=0.0):
        return False
    return offered < asked if q.bound == BOUND_MIN else offered > asked


def figure_contradictions(pkg, r: SupplierResponse) -> list[FigureContradiction]:
    """Every numeric 'shall' the bid's own figure contradicts, whatever code the bidder returned for it. A figure that is not stated is not a
    contradiction (it is reported separately as unchecked), and a figure that is not positive is refused in ``_check_response``: neither is
    ever read as zero or as a pass."""
    out: list[FigureContradiction] = []
    for q in numeric_requirements(pkg):
        offered = r.get(q.response_key)
        if offered is None or offered <= 0 or not _is_short(q, offered):
            continue
        out.append(FigureContradiction(
            requirement_id=q.id, clause=q.clause, response_key=q.response_key, bound=q.bound, asked=float(q.figure_limit), offered=offered,
            unit=q.unit, declared=r.compliance.get(q.id, "").upper(), path=r.where(f"values.{q.response_key}")))
    return out


def unchecked_figures(pkg, r: SupplierResponse) -> list[Requirement]:
    """Numeric 'shall' clauses the bidder answered C or CD without stating the figure they are held to: the declaration stands on the supplier's
    word alone, and the report says so."""
    return [q for q in numeric_requirements(pkg)
            if r.get(q.response_key) is None and r.compliance.get(q.id, "").upper() in (COMPLIANT, COMPLIES_WITH_DEVIATION)]


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
    #: The bid's own figures that contradict a numeric 'shall' (E-10's ampacity, C-02's validity). A contradicted requirement the bidder
    #: declared C on is in ``mandatory_failed``: the bid is not compliant on it, whatever it declared.
    contradictions: list[FigureContradiction] = field(default_factory=list)
    #: Numeric 'shall' clauses answered C or CD with no figure stated: declared, not checked.
    unchecked: list[str] = field(default_factory=list)
    #: How many bids were evaluated together. Price and programme are scored relative to that set (``SCORE_BASIS``).
    cohort: int = 0

    @property
    def score_basis(self) -> str:
        """What this bid's score is relative to, in words, for every place a score is shown."""
        if self.disqualified:
            return "Not scored: the response was not evaluated (see notes)."
        n = f"the {self.cohort} bids evaluated together" if self.cohort != 1 else "the only bid evaluated"
        return f"Scored against {n}. {SCORE_BASIS}"

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
        """Every mandatory requirement answered, none answered 'N', and no figure of the bid's own contradicting one it declared C. A bid that is
        silent on a mandatory requirement has not said it complies. A response that was not evaluated (disqualified) has shown nothing, so it
        is never compliant: reporting it as compliant would put a bid that could not be read next to the ones that were."""
        return not self.disqualified and not self.mandatory_failed and not self.unanswered

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
        return f"{self.supplier}: {price}, {weeks}, score {self.total_score:.0f}/100 (relative to the bids compared){flag}"


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

#: The longest lead time or installation a bid may state, in weeks: the intake loader's own ceiling for a lead time (ten years). A figure beyond it
#: is a unit slip or an attack, and 1e308 + 1e308 is infinity, which turned every score in the comparison into NaN.
MAX_WEEKS = PLAUSIBLE_MAX["btm_options.lead_time_weeks"]
#: The shortest a purchased item is delivered, and the shortest it takes to install and energise it. Below these a figure is not a schedule
#: (days quoted as weeks, or a placeholder zero), and it must not rank first as a genuine fast bid; the supplier is asked to confirm.
#: Judgement constants, not engineering ones: a skid-mounted unit can be energised within days of delivery, which is why the installation
#: floor is half a week, and a figure under it goes to review instead of to the top of the ranking.
MIN_LEAD_TIME_WEEKS = 1.0
MIN_INSTALL_WEEKS = 0.5

#: A price this far from the modelled budget is answering a different question —
#: most often a supplier quoting in thousands, or for a different scope.
BUDGET_PLAUSIBILITY_FACTOR = 10.0


def currency_problem(currency: str) -> str:
    """Why a price cannot be compared when the response names no currency (or not EUR in the evidence path). One wording for both paths:
    the comparison here and the cost evidence in ``evidence.py`` used to disagree about a bid with no currency (ranked, and INVALID)."""
    return (f"currency {currency or 'not stated'}: the specification requires EUR (C-01) and the engine holds no exchange rate, "
            f"so the price cannot be compared")


def _iso(raw: str, what: str, supplier: str) -> date:
    """``what`` is the path of the field (``responses[1].received_on``), so the refusal says which field to fix."""
    try:
        return date.fromisoformat(raw)
    except ValueError:
        raise ProcurementError(
            f"{what}: {raw!r} is not an ISO date (YYYY-MM-DD) (response from {supplier})") from None


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
                    f"{r.where('specification.' + key)}: {r.supplier}'s response was written for {key} {spec[key]!r}, "
                    f"but the current specification has {key} {mine!r}. The requirements "
                    f"have changed or the response belongs to another tender; ask the "
                    f"supplier to re-price against the current specification.")
    if _iso(r.received_on, r.where("received_on"), r.supplier) > today:
        raise ProcurementError(
            f"{r.where('received_on')}: {r.received_on} is in the future (response from {r.supplier}).")
    for rid, code in r.compliance.items():
        if code not in VALID_CODES:
            raise ProcurementError(
                f"{r.where('compliance.' + rid)}: {r.supplier}'s compliance code {code!r} is not one of "
                f"C, CD or N.")
    problems: list[str] = []
    if r.valid_until and _iso(r.valid_until, r.where("valid_until"), r.supplier) < today:
        problems.append(f"{r.where('valid_until')}: offer expired on {r.valid_until}")
    if not r.currency:
        # A price with no currency was ranked as if it were euros ("capex_eur is euros by contract"), so 30 thousand and 30 million, one
        # of them perhaps in another currency, could both lead. A priced response names its currency; a response with no price needs none.
        if r.get("capex_eur") is not None:
            problems.append(f"{r.path + '.currency: ' if r.path else ''}{currency_problem('')}")
    elif r.currency != "EUR":
        # The price is read from capex_eur and ranked against EUR bids, and the engine holds no exchange rate: a JPY or USD figure
        # in that field would rank as if it were euros (800,000 JPY as the cheapest compliant bid). Disqualify, say why, keep the others.
        problems.append(f"{r.path + '.currency: ' if r.path else ''}quoted in {r.currency}, but the specification requires EUR (C-01) and the engine holds no "
                        f"exchange rate; re-quote in EUR so it can be compared")
    capex, lead, install = r.get("capex_eur"), r.get("lead_time_weeks"), r.get("install_weeks")
    at_capex, at_lead, at_install = (r.where(f"values.{k}") for k in ("capex_eur", "lead_time_weeks", "install_weeks"))
    if capex is not None and capex <= 0:
        problems.append(f"{at_capex}: price {capex:,.0f} is not a positive amount")
    if lead is not None and lead <= 0:
        problems.append(f"{at_lead}: lead time {lead:g} weeks is not positive")
    elif lead is not None and lead < MIN_LEAD_TIME_WEEKS:
        problems.append(f"{at_lead}: lead time {lead:g} weeks is under {MIN_LEAD_TIME_WEEKS:g} week: no purchased item is delivered that fast; "
                        f"confirm the unit (days or weeks) and resubmit")
    elif lead is not None and lead > MAX_WEEKS:
        problems.append(f"{at_lead}: lead time {lead:g} weeks is above the {MAX_WEEKS:g} weeks (ten years) a bid may state; "
                        f"confirm the unit and resubmit")
    if install is not None and install < 0:
        problems.append(f"{at_install}: installation duration {install:g} weeks is negative")
    elif install is not None and install < MIN_INSTALL_WEEKS:
        problems.append(f"{at_install}: installation duration {install:g} weeks is under {MIN_INSTALL_WEEKS:g} week: a unit is not energised "
                        f"on delivery; confirm the figure and resubmit")
    elif install is not None and install > MAX_WEEKS:
        problems.append(f"{at_install}: installation duration {install:g} weeks is above the {MAX_WEEKS:g} weeks (ten years) a bid may state; "
                        f"confirm the unit and resubmit")
    # A figure the specification holds the bid to (the duty, the validity) that is not a positive number is not a quotation: zero is what a
    # placeholder or an unread field looks like, and as a duty it would otherwise sail past a floor of zero. Below a positive floor it is a
    # contradiction of the clause (figure_contradictions); here it is refused outright, because there is nothing to compare.
    for q in numeric_requirements(pkg):
        figure = r.get(q.response_key)
        if figure is not None and figure <= 0:
            problems.append(f"{r.where('values.' + q.response_key)}: {figure_text(figure)} {q.unit} is not a positive figure; it is held to "
                            f"{q.id} ({q.clause}), which asks for {_asks(q)}. State the figure at the site conditions or leave it blank")
    budget = getattr(pkg, "budget_eur", None)
    if capex is not None and capex > 0 and budget is not None and budget.value > 0:
        ratio = capex / budget.value
        if ratio > BUDGET_PLAUSIBILITY_FACTOR or ratio < 1 / BUDGET_PLAUSIBILITY_FACTOR:
            what = getattr(pkg, "budget_label", "modelled budget")      # a BTM package's is the declared capex of its units
            problems.append(
                f"{at_capex}: price EUR {capex:,.0f} is {ratio:.2g}x the {what} of "
                f"EUR {budget.value:,.0f}; confirm the units and scope and resubmit")
    return problems


def _asks(q: Requirement) -> str:
    """What a numeric clause asks of the bid's figure, as a phrase: 'not less than 1,990 A'."""
    return f"{'not less than' if q.bound == BOUND_MIN else 'not more than'} {figure_text(q.figure_limit or 0.0)} {q.unit}".strip()


def assess(pkg: SpecPackage, responses: list[SupplierResponse]) -> list[BidAssessment]:
    if not responses:
        raise ProcurementError("no responses to assess")
    seen: dict[str, SupplierResponse] = {}
    for r in responses:
        key = r.supplier.strip().lower()
        if key in seen:
            first = seen[key]
            raise ProcurementError(
                f"{r.where('supplier')}: two responses from {r.supplier!r}"
                + (f" (the other is {first.where('supplier')})" if first.path else "")
                + ". Supply one current response per supplier; a superseded quotation must not compete with its replacement.")
        seen[key] = r
    today = report_date()
    mandatory = pkg.mandatory()
    required_fields = [f for f in pkg.response_fields if f.required]

    out: list[BidAssessment] = []
    for r in responses:
        problems = _check_response(pkg, r, today)
        # A bid's own figure is held to the number of every 'shall' that states one. A requirement the bidder declared C on whose figure
        # contradicts it is failed exactly as an N is: it is not a second mechanism, it feeds the same list, count and score.
        contradictions = figure_contradictions(pkg, r)
        contradicted = {c.requirement_id for c in contradictions}
        failed = [q.id for q in mandatory
                  if r.compliance.get(q.id, "").upper() == NON_COMPLIANT
                  or (q.id in contradicted and r.compliance.get(q.id, "").upper() == COMPLIANT)]
        unanswered = [q.id for q in mandatory if q.id not in r.compliance]
        missing_fields = [f.label for f in required_fields if r.get(f.key) is None]

        capex = r.get("capex_eur")
        lead = r.get("lead_time_weeks")
        install = r.get("install_weeks")
        # A missing installation time is missing, not zero: the figure below is then the lead time alone and says so.
        weeks = None if lead is None else lead + (install if install is not None else 0.0)
        if weeks is not None and not math.isfinite(weeks):      # never a non-finite figure in a score or in the response body
            problems.append("lead time plus installation is not a finite number of weeks")
            weeks = None
        install_missing = lead is not None and install is None

        a = BidAssessment(
            supplier=r.supplier, received_on=r.received_on,
            capex_eur=capex, lead_time_weeks=lead, install_weeks=install,
            # Against what the package was SIZED for, not the rung's own delta.
            # The supplier priced the end state; dividing by the marginal racks
            # produces a per-rack figure several times too large and makes every
            # bid look absurd next to the study's own economics.
            weeks_to_energised=weeks, racks_unlocked=pkg.sized_for_racks,
            eur_per_rack=(None if capex is None or pkg.sized_for_racks == 0 or not math.isfinite(capex / pkg.sized_for_racks)
                          else capex / pkg.sized_for_racks),
            mandatory_total=len(mandatory),
            mandatory_met=len(mandatory) - len(failed) - len(unanswered),
            mandatory_failed=failed, unanswered=unanswered, install_weeks_missing=install_missing,
            contradictions=contradictions, unchecked=[q.id for q in unchecked_figures(pkg, r)])

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
        for c in contradictions:
            a.notes.append(c.message())
        for q in unchecked_figures(pkg, r):
            a.notes.append(
                f"{q.id} ({q.clause}) is declared {r.compliance[q.id]} but {r.where('values.' + q.response_key)} is not stated, so the "
                f"declaration is not checked against its figure ({_asks(q)}); it stands on the supplier's word alone.")
        if failed:
            declared_n = [i for i in failed if r.compliance.get(i, "").upper() == NON_COMPLIANT]
            if declared_n:       # the others in `failed` are named, with their figures, by the contradiction notes above
                a.notes.append(f"mandatory requirements marked non-compliant: {', '.join(declared_n)}")
        if unanswered:
            a.notes.append(
                f"mandatory requirements with no compliance statement: "
                f"{', '.join(unanswered)}")
        out.append(a)

    live = [a for a in out if not a.disqualified]
    for a in out:
        a.cohort = len(live)
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
    if a.disqualified:
        # Its programme figure may be the very figure that disqualified it (a lead time of 0 weeks is "36 weeks earlier"): no effect on the
        # date is stated for a response that was set aside.
        return "Not evaluated: the response was set aside (see notes), so no effect on the energisation date is stated."
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
