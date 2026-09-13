"""Portfolio Screen — N halls, one methodology, one ranking (docs/00 §5, product #2).

The highest revenue per founder-hour in the ladder, because the engine, the
libraries and the report are already paid for: only the inputs change. It is also
the product an operator with a roll-up of older halls, or a tenant hunting for a
home for GB300 racks, actually needs — nobody sells "rank my twelve buildings by
deliverable compute" as a single comparable artefact.
"""
from __future__ import annotations

from dataclasses import dataclass

from ..common import ASSUMED, ESTIMATED, V
from ..envelope.time_to_power import schedule
from ..intake.loader import Intake
from ..scenario.run import ScenarioResult
from .gates import DISCLOSURE_MARKER, claims_below_floor
from .model import Bullets, Callout, Lit, Para, Report, Section, Statement, Table
from .study import Objective, _pick_recommended, collect_claims


@dataclass
class SiteEntry:
    intake: Intake
    results: list[ScenarioResult]

    @property
    def best(self) -> ScenarioResult:
        return _pick_recommended(self.results, Objective.MAX_COMPUTE)

    @property
    def racks(self) -> int:
        return self.best.unlocked_racks

    @property
    def weeks(self) -> float:
        t = schedule(self.best.ladder)
        return t.weeks_to_full if t.weeks_to_full is not None else float("inf")

    @property
    def capex(self) -> float:
        return self.best.economics.capex_total_eur.value

    @property
    def capex_per_rack(self) -> float:
        return self.capex / max(self.racks, 1)


def rank(entries: list[SiteEntry], objective: Objective = Objective.MAX_COMPUTE) -> list[SiteEntry]:
    if objective is Objective.FASTEST_TO_POWER:
        return sorted(entries, key=lambda e: (e.weeks, -e.racks))
    if objective is Objective.MIN_COST_PER_RACK:
        return sorted(entries, key=lambda e: e.capex_per_rack)
    return sorted(entries, key=lambda e: (-e.racks, e.weeks))


def build(entries: list[SiteEntry], *, client: str = "Portfolio",
          objective: Objective = Objective.MAX_COMPUTE) -> Report:
    ordered = rank(entries, objective)
    total_racks = sum(e.racks for e in ordered)
    deliverable = [e for e in ordered if e.racks > 0]
    r = Report(
        title=f"Portfolio Screen — {len(entries)} halls ranked by deliverable compute",
        subtitle=(f"{client} · one methodology applied to every hall · "
                  f"ranked by {objective.value.replace('_', ' ')}"),
        watermark=("SCREENING OPINION — modelled from the inputs supplied for each hall. "
                   "Not a design package, and not a measurement of any asset."),
        status="Portfolio Screen",
        meta=[("Client", client), ("Halls screened", str(len(entries))),
              ("Halls that can take the platform", str(len(deliverable))),
              ("Ranking objective", objective.value.replace("_", " "))],
        footer=("Every hall was screened with the identical model, library and assumptions, so the "
                "ranking is comparable even where the individual inputs are not equally complete."),
    )

    s = Section("1. The ranking")
    s.blocks.append(Statement(
        "Total deployable racks across the portfolio",
        V(float(total_racks), "racks", "portfolio deployable racks", ESTIMATED),
        f"{len(deliverable)} of {len(entries)} halls can take the platform at all"))
    rows = []
    for i, e in enumerate(ordered, 1):
        rows.append([
            Lit(str(i)),
            f"{e.intake.context.site.name} / {e.intake.context.hall.id}",
            e.intake.context.site.metro,
            V(float(e.racks), "racks", f"{e.intake.context.hall.id}: deployable racks", ESTIMATED),
            V(e.weeks, "weeks", f"{e.intake.context.hall.id}: time to full capacity", ESTIMATED)
            if e.weeks != float("inf") else "—",
            V(e.capex, "EUR", f"{e.intake.context.hall.id}: indicative capex", ASSUMED,
              band=(e.capex * 0.5, e.capex * 2.0)),
            V(e.capex_per_rack, "EUR/rack", f"{e.intake.context.hall.id}: capex per rack", ASSUMED,
              band=(e.capex_per_rack * 0.5, e.capex_per_rack * 2.0)),
            e.best.envelope.binding.name,
        ])
    s.blocks.append(Table(["#", "Hall", "Metro", "Racks", "Time to power", "Capex",
                           "Capex per rack", "Binds first"], rows,
                          caption="Ranked portfolio. Capex excludes IT hardware, migration and "
                                  "lost tenancy revenue."))
    r.sections.append(s)

    s = Section("2. Where the portfolio is constrained")
    counts: dict[str, int] = {}
    for e in ordered:
        counts[e.best.envelope.binding.name] = counts.get(e.best.envelope.binding.name, 0) + 1
    rows = [[k, V(float(v), "halls", f"halls bound by {k}", ESTIMATED)]
            for k, v in sorted(counts.items(), key=lambda kv: -kv[1])]
    s.blocks.append(Table(["Binding constraint", "Halls"], rows,
                          caption="A constraint that binds across several halls is a portfolio "
                                  "programme, not a site problem — and it is usually cheaper to "
                                  "solve once."))
    r.sections.append(s)

    s = Section("3. Where to start")
    if deliverable:
        first = deliverable[0]
        s.blocks.append(Para(
            f"Start with {first.intake.context.site.name} / {first.intake.context.hall.id}: "
            f"{first.racks} racks, "
            f"{'no schedule available' if first.weeks == float('inf') else f'{first.weeks:.0f} weeks'} "
            f"to full capacity, binding first on {first.best.envelope.binding.name.lower()}."))
    else:
        s.blocks.append(Callout("warning",
            "No hall in this portfolio can take the target platform on the inputs supplied. That "
            "is a finding, not a failure of the analysis — the cheapest next step is to close the "
            "data gaps listed per hall before assuming the answer is no."))
    s.blocks.append(Bullets([
        "Rank is by deliverable compute; the same table re-sorts by time to power or by capex per "
        "rack, and the three orderings rarely agree. Pick the objective before reading the rank.",
        "Halls with low intake completeness are ranked on assumptions. Close those gaps before "
        "committing capital to the ordering.",
        "A constraint shared across halls is worth a single portfolio-level programme.",
    ]))
    rows = [[f"{e.intake.context.site.name} / {e.intake.context.hall.id}",
             V(e.intake.report.completeness * 100, "%", "intake completeness", ESTIMATED),
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
            "The ranking is robust to this where halls differ by a wide margin and is not where "
            "they are close; close the per-hall data gaps before committing capital to the order."))
    r.sections.append(s)
    return r
