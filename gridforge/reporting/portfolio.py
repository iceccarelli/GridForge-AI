"""Portfolio Screen — N halls, one methodology, one ranking (docs/00 §5, product #2).

The highest revenue per founder-hour in the ladder, because the engine, the
libraries and the report are already paid for: only the inputs change. It is also
the product an operator with a roll-up of older halls, or a tenant hunting for a
home for GB300 racks, actually needs — nobody sells "rank my twelve buildings by
deliverable compute" as a single comparable artefact.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, replace

from ..common import V
from ..envelope.time_to_power import schedule
from ..intake.loader import Intake
from ..scenario.run import ScenarioResult
from .gates import DISCLOSURE_MARKER, claims_below_floor
from .model import Bullets, Callout, Lit, Para, Report, Section, Statement, Table
from ..validation import EvidenceClass, Quantity
from .labels import capex_per_rack_q, full_capacity_q, rack_class, schedule_complete
from .study import Objective, _pick_recommended, collect_claims

INF = math.inf

_OBJECTIVE_PHRASE = {
    Objective.MAX_COMPUTE: "deliverable compute",
    Objective.FASTEST_TO_POWER: "time to power",
    Objective.MIN_COST_PER_RACK: "capex per rack",
}


@dataclass
class SiteEntry:
    """One hall. Every figure is read from the scenario the hall's OWN objective selects, so the number shown
    for a hall is the one the ranking used (it used to be picked for compute whatever the objective was)."""
    intake: Intake
    results: list[ScenarioResult]
    objective: Objective = Objective.MAX_COMPUTE

    @property
    def best(self) -> ScenarioResult:
        return _pick_recommended(self.results, self.objective)

    @property
    def ident(self) -> tuple[str, str]:
        return (self.intake.context.site.id, self.intake.context.hall.id)

    @property
    def name(self) -> str:
        return f"{self.intake.context.site.name} / {self.intake.context.hall.id}"

    @property
    def racks(self) -> int:
        return self.best.unlocked_racks

    @property
    def rack_class(self) -> EvidenceClass:
        return rack_class(self.best)

    @property
    def weeks_q(self) -> Quantity | None:
        """Time to full capacity, banded by the lead times that set it. None when no rack is deployable or a
        relief taken has no lead time (a missing lead time is unknown, not zero)."""
        return full_capacity_q(self.best.ladder, schedule(self.best.ladder),
                               f"{self.intake.context.hall.id}: time to full capacity")

    @property
    def weeks(self) -> float:
        q = self.weeks_q
        return q.value if q is not None else INF

    @property
    def required_gaps(self) -> list[str]:
        """Required inputs this hall did not supply. A constraint whose input is missing is not evaluated,
        so its figures describe a hall with fewer limits than the real one."""
        return [g.label for g in self.intake.report.required_gaps]

    @property
    def schedule_complete(self) -> bool:
        return schedule_complete(self.best.ladder)

    @property
    def capex_q(self) -> Quantity:
        return self.best.economics.capex_total_eur

    @property
    def capex(self) -> float:
        return self.capex_q.value

    @property
    def capex_per_rack_q(self) -> Quantity | None:
        return capex_per_rack_q(self.best, f"{self.intake.context.hall.id}: capex per rack")

    @property
    def capex_per_rack(self) -> float:
        """Undefined (infinite, so it sorts last) when no rack is deployable -- never capex over a made-up rack."""
        q = self.capex_per_rack_q
        return q.value if q is not None else INF


def _metric(e: SiteEntry, objective: Objective) -> tuple[float, float, float] | None:
    """(value, low, high) of what the ranking objective compares, or None when this hall has none."""
    if e.racks <= 0 or e.required_gaps:
        return None
    if objective is Objective.FASTEST_TO_POWER:
        q = e.weeks_q
    elif objective is Objective.MIN_COST_PER_RACK:
        q = e.capex_per_rack_q
    else:
        return (float(e.racks),) * 3
    return None if q is None else (q.value, *q.band)


def _sort_key(e: SiteEntry, objective: Objective):
    # Hall identity is the last key, so the order never depends on the order the intakes were supplied in.
    # comparable, then unrankable (missing required input or lead time), then empty
    group = 2 if e.racks <= 0 else (1 if e.required_gaps or _metric(e, objective) is None else 0)
    if objective is Objective.MAX_COMPUTE:
        return (group, -e.racks, e.weeks, e.capex, e.ident)
    m = _metric(e, objective)
    if objective is Objective.FASTEST_TO_POWER:
        return (group, e.weeks, -e.racks, e.ident)
    return (group, e.capex_per_rack, -e.racks, e.ident)


def rank(entries: list[SiteEntry], objective: Objective = Objective.MAX_COMPUTE) -> list[SiteEntry]:
    """Order halls by the objective, applied to the scenario that objective selects for each hall.

    A hall whose figure for the objective is undefined (no deployable rack, or a relief with no lead time) is
    placed after every hall that has one rather than being ranked on a number that does not exist."""
    return sorted((replace(e, objective=objective) for e in entries), key=lambda e: _sort_key(e, objective))


def rank_notes(ordered: list[SiteEntry], objective: Objective) -> list[str]:
    """Why each position can or cannot be relied on, from the figures themselves (not from a label)."""
    notes: list[list[str]] = [[] for _ in ordered]
    unit = {Objective.MAX_COMPUTE: "racks", Objective.FASTEST_TO_POWER: "weeks",
            Objective.MIN_COST_PER_RACK: "EUR/rack"}[objective]
    for i, e in enumerate(ordered):
        if e.racks <= 0:
            notes[i].append("no deployable racks on these inputs; not ranked on a figure")
        elif e.required_gaps:
            notes[i].append("required inputs not supplied (" + ", ".join(e.required_gaps)
                            + "): those constraints were not evaluated, so this hall is not "
                            "ranked on a figure against halls that supplied them")
        elif _metric(e, objective) is None:
            notes[i].append("a relief on the path has no lead time, so no date is given; ranked after halls with one")
        if e.racks > 0 and not e.best.economics.capex_complete:
            gone = [g["component"] for g in e.best.economics.unpriced_summary()]
            notes[i].append("capex is a lower bound; unpriced: "
                            + ("; ".join(gone) if gone else "a relief on the path"))
    for i in range(len(ordered) - 1):
        a, b = _metric(ordered[i], objective), _metric(ordered[i + 1], objective)
        if a is None or b is None:
            continue
        if a[0] == b[0]:
            notes[i].append(f"ties #{i + 2} on {unit}; ordered by the next criterion, then by name")
            notes[i + 1].append(f"ties #{i + 1} on {unit}; ordered by the next criterion, then by name")
        elif a[1] <= b[2] and b[1] <= a[2]:
            notes[i].append(f"{unit} band overlaps #{i + 2}; order not established")
            notes[i + 1].append(f"{unit} band overlaps #{i + 1}; order not established")
    return ["; ".join(n) if n else "—" for n in notes]


def _weeks_cell(e: SiteEntry):
    q = e.weeks_q
    if q is not None:
        return q
    if e.racks <= 0:
        return "— (no deployable racks)"
    return "— (a lead time is missing)"


def _weeks_text(e: SiteEntry) -> str:
    q = e.weeks_q
    if q is None:
        return "no schedule available"
    lo, hi = q.band
    return f"{q.value:.0f} weeks" + (f" ({lo:.0f}–{hi:.0f})" if hi > lo else "")


def portfolio_rows(entries: list[SiteEntry], objective: Objective = Objective.MAX_COMPUTE) -> list[dict]:
    """The ranked table as plain data, with the evidence class and band of every figure. One source for the
    report and the API, so the two cannot disagree about a hall."""
    ordered = rank(entries, objective)
    notes = rank_notes(ordered, objective)
    rows = []
    for i, (e, note) in enumerate(zip(ordered, notes), 1):
        w, c, cpr = e.weeks_q, e.capex_q, e.capex_per_rack_q
        rows.append({
            "rank": i, "site": e.intake.context.site.name, "hall": e.intake.context.hall.id,
            "metro": e.intake.context.site.metro,
            "racks": e.racks, "racks_evidence": e.rack_class.name,
            "weeks_to_full": None if w is None else w.value,
            "weeks_band": None if w is None else list(w.band),
            "weeks_evidence": None if w is None else w.evidence.name,
            "schedule_complete": e.schedule_complete,
            "capex_eur": c.value, "capex_band_eur": list(c.band), "capex_evidence": c.evidence.name,
            "capex_complete": e.best.economics.capex_complete,
            "decision_grade": e.best.economics.decision_grade,
            "economics_limitations": e.best.economics.limitations,
            "capex_per_rack_eur": None if cpr is None else cpr.value,
            "capex_per_rack_band_eur": None if cpr is None else list(cpr.band),
            "binds_first": e.best.envelope.binding.name,
            "intake_completeness": round(e.intake.report.completeness, 3),
            "rank_note": note,
        })
    return rows


def build(entries: list[SiteEntry], *, client: str = "Portfolio",
          objective: Objective = Objective.MAX_COMPUTE) -> Report:
    ordered = rank(entries, objective)
    notes = rank_notes(ordered, objective)
    phrase = _OBJECTIVE_PHRASE[objective]
    total_racks = sum(e.racks for e in ordered)
    deliverable = [e for e in ordered if e.racks > 0]
    r = Report(
        title=f"Portfolio Screen — {len(entries)} halls ranked by {phrase}",
        subtitle=(f"{client} · one methodology applied to every hall · "
                  f"ranked by {objective.value.replace('_', ' ')}"),
        watermark=("SCREENING OPINION — modelled from the inputs supplied for each hall. "
                   "Not a design package, and not a measurement of any asset."),
        status="Portfolio Screen",
        meta=[("Client", client), ("Halls screened", str(len(entries))),
              ("Halls that can take the platform", str(len(deliverable))),
              ("Ranking objective", objective.value.replace("_", " "))],
        footer=("Every hall was screened with the identical model, library and assumptions, so a difference "
                "in the ranking comes from the halls, not the method. The inputs are not equally complete or "
                "equally evidenced across halls: the evidence class on each figure and the ranking note on "
                "each row say where an order cannot be relied on."),
    )

    s = Section("1. The ranking")
    # A sum of rack counts is no better evidenced than the weakest hall in it.
    weakest = min((e.rack_class for e in ordered), default=EvidenceClass.E0_ASSUMPTION)
    s.blocks.append(Statement(
        "Total deployable racks across the portfolio",
        V(float(total_racks), "racks", "portfolio deployable racks", weakest),
        f"{len(deliverable)} of {len(entries)} halls can take the platform at all"))
    rows = []
    for i, (e, note) in enumerate(zip(ordered, notes), 1):
        hid = e.intake.context.hall.id
        cpr = e.capex_per_rack_q
        rows.append([
            Lit(str(i)),
            e.name,
            e.intake.context.site.metro,
            V(float(e.racks), "racks", f"{hid}: deployable racks", e.rack_class),
            _weeks_cell(e),
            e.capex_q,
            cpr if cpr is not None else "— (no deployable racks)",
            e.best.envelope.binding.name,
            note,
        ])
    s.blocks.append(Table(["#", "Hall", "Metro", "Racks", "Time to power", "Capex",
                           "Capex per rack", "Binds first", "Ranking note"], rows,
                          caption="Ranked portfolio. Each figure carries the evidence class of the weakest "
                                  "input that determines it. Time to power and capex are bounded by the lead "
                                  "times and prices on each hall's relief path, not by a fixed multiplier. "
                                  "Capex excludes IT hardware, migration and lost tenancy revenue."))
    r.sections.append(s)

    s = Section("2. Where the portfolio is constrained")
    counts: dict[str, list[SiteEntry]] = {}
    for e in ordered:
        counts.setdefault(e.best.envelope.binding.name, []).append(e)
    rows = [[k, V(float(len(v)), "halls", f"halls bound by {k}", min(x.rack_class for x in v))]
            for k, v in sorted(counts.items(), key=lambda kv: (-len(kv[1]), kv[0]))]
    s.blocks.append(Table(["Binding constraint", "Halls"], rows,
                          caption="A constraint that binds across several halls is a portfolio "
                                  "programme, not a site problem — and it is usually cheaper to "
                                  "solve once."))
    r.sections.append(s)

    s = Section("3. Where to start")
    if deliverable:
        first = deliverable[0]
        s.blocks.append(Para(
            f"Start with {first.name}: {first.racks} racks, {_weeks_text(first)} to full capacity, "
            f"binding first on {first.best.envelope.binding.name.lower()}."))
    else:
        s.blocks.append(Callout("warning",
            "No hall in this portfolio can take the target platform on the inputs supplied. That "
            "is a finding, not a failure of the analysis — the cheapest next step is to close the "
            "data gaps listed per hall before assuming the answer is no."))
    s.blocks.append(Bullets([
        f"Rank is by {phrase}; the same table re-sorts by the other objectives, and the orderings rarely "
        "agree. Pick the objective before reading the rank.",
        "A hall with no figure for the objective (no deployable rack, or a relief with no lead time) is "
        "placed after every hall that has one, and its row says why.",
        "Halls with low intake completeness are ranked on assumptions. Close those gaps before "
        "committing capital to the ordering.",
        "A constraint shared across halls is worth a single portfolio-level programme.",
    ]))
    rows = [[e.name,
             Lit(f"{e.intake.report.completeness * 100:.0f}%"),
             Lit(str(len(e.intake.report.required_gaps))),
             Lit(e.intake.report.engagement_recommendation)] for e in ordered]
    s.blocks.append(Table(["Hall", "Intake completeness", "Required inputs missing",
                           "Recommended engagement"], rows))
    below = claims_below_floor(collect_claims([x for e in ordered for x in e.results]))
    detail = "; ".join(
        f"{k.replace('_', ' ')} is {w.name.split('_', 1)[0]} where an issued deliverable requires "
        f"{f.name.split('_', 1)[0]}" for k, (w, f) in below.items())
    if detail:
        s.blocks.append(Callout("warning",
            f"{DISCLOSURE_MARKER} this portfolio was screened partly on library defaults. {detail}. "
            "The ranking notes in section 1 mark every position that is tied or lies inside the "
            "uncertainty of the figures; close the per-hall data gaps before committing capital to the "
            "order."))
    r.sections.append(s)
    return r
