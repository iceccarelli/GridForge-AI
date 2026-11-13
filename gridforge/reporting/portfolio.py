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
from .gates import DISCLOSURE_MARKER, claim_label, claims_below_floor
from .portfolio_guard import grid_fingerprint, site_key
from .model import Bullets, Callout, Lit, Para, Report, Section, Statement, Table
from ..validation import EvidenceClass, Quantity
from .labels import (ASSUMED_DATE_LABEL, capex_per_rack_q, date_basis, full_capacity_q, rack_class,
                     schedule_complete)
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
    #: Filled in by ``rank`` (never by the caller): the hall ids of the OTHER halls in the same ranking that declare the same site.id, and
    #: of those whose grid block is identical under a different site.id. They are read from the documents, not solved: the engine has no
    #: model of a connection shared between halls.
    site_siblings: tuple[str, ...] = ()
    likely_siblings: tuple[str, ...] = ()

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
    def date_basis(self):
        """What the time-to-power figure rests on (assumed lead time, supported, or none)."""
        return date_basis(self.best.ladder, schedule(self.best.ladder))

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
    def required_gap_paths(self) -> list[str]:
        return [g.path for g in self.intake.report.required_gaps]

    @property
    def unassessed_banks(self) -> list[str]:
        """Equipment banks (transformers, UPS) the hall did not declare. An undeclared bank evaluates as "not limiting", so the hall's racks
        describe a building with fewer limits than the real one."""
        return list(self.best.ladder.unassessed_banks)

    @property
    def rankable(self) -> bool:
        """Comparable with other halls on rack counts: every required input supplied and every equipment bank declared. Anything less
        means a constraint was never evaluated, and a figure from fewer constraints is not the same kind of number as one from all of them."""
        return not self.required_gaps and not self.unassessed_banks

    @property
    def what_is_missing(self) -> str:
        """The inputs that would make this hall rankable, named; "" when it is."""
        parts = []
        if self.required_gaps:
            parts.append("required inputs not supplied (" + ", ".join(self.required_gaps) + ")")
        if self.unassessed_banks:
            parts.append("equipment banks not declared (" + ", ".join(self.unassessed_banks) + ")")
        return "; ".join(parts)

    @property
    def rankable_reason(self) -> str:
        if self.rankable:
            return "all required inputs supplied and every equipment bank declared"
        return self.what_is_missing + ": those constraints were not evaluated, so the racks describe a hall with fewer limits than the real one"

    @property
    def after_relief_binding(self):
        """What binds once every relief on the ladder is taken (the as-found binding is ``best.envelope.binding``)."""
        return (self.best.ladder.final or self.best.envelope).binding

    @property
    def hall_id(self) -> str:
        return self.intake.context.hall.id

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
    if e.racks <= 0 or not e.rankable:
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
    # A hall that is not rankable (a required input missing, or an equipment bank undeclared) is never placed above one that is, whatever
    # its rack count; within each side: comparable, then no figure for the objective (no lead time), then empty
    side = 0 if e.rankable else 1
    group = 2 if e.racks <= 0 else (1 if not e.rankable or _metric(e, objective) is None else 0)
    if objective is Objective.MAX_COMPUTE:
        return (side, group, -e.racks, e.weeks, e.capex, e.ident)
    if objective is Objective.FASTEST_TO_POWER:
        return (side, group, e.weeks, -e.racks, e.ident)
    return (side, group, e.capex_per_rack, -e.racks, e.ident)


def rank(entries: list[SiteEntry], objective: Objective = Objective.MAX_COMPUTE) -> list[SiteEntry]:
    """Order halls by the objective, applied to the scenario that objective selects for each hall.

    A hall whose figure for the objective is undefined (no deployable rack, or a relief with no lead time) is
    placed after every hall that has one rather than being ranked on a number that does not exist. A hall that is not rankable is placed
    after every hall that is."""
    return sorted((replace(e, objective=objective) for e in with_sharing(entries)), key=lambda e: _sort_key(e, objective))


def with_sharing(entries: list[SiteEntry]) -> list[SiteEntry]:
    """The entries with ``site_siblings`` and ``likely_siblings`` filled in from their documents, in the order given.

    Same declared site.id: the halls most likely draw on one grid connection. An identical grid block under DIFFERENT (or undeclared) site
    ids: a likely shared connection, said and never merged. A site id left to the library default is not a declaration, so two such halls are
    never grouped."""
    keys = [site_key(e.intake.document) for e in entries]
    prints = [grid_fingerprint(e.intake.document) for e in entries]
    out = []
    for i, e in enumerate(entries):
        same = sorted(entries[j].hall_id for j in range(len(entries)) if j != i and keys[i] is not None and keys[j] == keys[i])
        likely = sorted(entries[j].hall_id for j in range(len(entries))
                        if j != i and prints[i] is not None and prints[j] == prints[i] and not (keys[i] is not None and keys[j] == keys[i]))
        out.append(replace(e, site_siblings=tuple(same), likely_siblings=tuple(likely)))
    return out


def holds_a_rank(e: SiteEntry) -> bool:
    """True when this hall is ranked on a figure. A hall with no deployable rack, a required input missing or an equipment bank undeclared is
    NOT ranked (``rank_notes`` says so): it is listed after the halls that are, and carries no rank. ``rank`` is null for it, never a number
    that reads as a place."""
    return e.racks > 0 and e.rankable


def ranks(ordered: list[SiteEntry]) -> list[int | None]:
    """The rank of each hall of an ordered list: 1, 2, 3 ... over the halls that hold one, None for the rest. A hall without a rank is placed
    after every hall that has one (``_sort_key``), so the ranks that exist are always 1..k with no gap."""
    out: list[int | None] = []
    held = 0
    for e in ordered:
        if holds_a_rank(e):
            held += 1
            out.append(held)
        else:
            out.append(None)
    return out


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
                            "ranked on a figure against halls that supplied them"
                            + ("; equipment banks not declared: " + ", ".join(e.unassessed_banks) if e.unassessed_banks else ""))
        elif e.unassessed_banks:
            notes[i].append("equipment banks not declared (" + ", ".join(e.unassessed_banks) + "): those constraints were not evaluated, "
                            "so this hall is not ranked on a figure against halls that declared them")
        elif _metric(e, objective) is None:
            notes[i].append("a relief on the path has no lead time, so no date is given; ranked after halls with one")
        if e.racks > 0 and not e.best.economics.capex_complete:
            gone = [g["component"] for g in e.best.economics.unpriced_summary()]
            notes[i].append("capex is a lower bound; unpriced: "
                            + ("; ".join(gone) if gone else "a relief on the path"))
        if e.site_siblings:
            notes[i].append("shares a site with " + ", ".join(e.site_siblings) + ", so most likely one grid connection: its racks are not "
                            "additive with theirs")
        if e.likely_siblings:
            notes[i].append("declares a grid block identical to " + ", ".join(e.likely_siblings) + " under another site id: likely one "
                            "connection, not merged")
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
    return (f"{q.value:.0f} weeks" + (f" ({lo:.0f}–{hi:.0f})" if hi > lo else "")
            + (f" — {ASSUMED_DATE_LABEL}" if e.date_basis.assumed else ""))


def portfolio_rows(entries: list[SiteEntry], objective: Objective = Objective.MAX_COMPUTE) -> list[dict]:
    """The ranked table as plain data, with the evidence class and band of every figure. One source for the
    report and the API, so the two cannot disagree about a hall."""
    ordered = rank(entries, objective)
    notes = rank_notes(ordered, objective)
    rows = []
    for i, (e, note, rk) in enumerate(zip(ordered, notes, ranks(ordered)), 1):
        w, c, cpr = e.weeks_q, e.capex_q, e.capex_per_rack_q
        rows.append({
            "rank": rk, "site": e.intake.context.site.name, "hall": e.intake.context.hall.id,
            "metro": e.intake.context.site.metro,
            "racks": e.racks, "racks_evidence": e.rack_class.name,
            "weeks_to_full": None if w is None else w.value,
            "weeks_band": None if w is None else list(w.band),
            "weeks_evidence": None if w is None else w.evidence.name,
            "schedule_complete": e.schedule_complete,
            **e.date_basis.to_dict(),
            "capex_eur": c.value, "capex_band_eur": list(c.band), "capex_evidence": c.evidence.name,
            "capex_complete": e.best.economics.capex_complete,
            "decision_grade": e.best.economics.decision_grade,
            "economics_limitations": e.best.economics.limitations,
            "capex_per_rack_eur": None if cpr is None else cpr.value,
            "capex_per_rack_band_eur": None if cpr is None else list(cpr.band),
            "binds_first": e.best.envelope.binding.name,
            "intake_completeness": round(e.intake.report.completeness, 3),
            "rank_note": note,
            # Comparability, as data rather than prose: a hall with a required gap or an undeclared bank was not evaluated against every
            # constraint, so its racks are not the same kind of number as a fully evaluated hall's.
            "required_gaps": e.required_gap_paths,
            "unassessed_banks": e.unassessed_banks,
            "rankable": e.rankable,
            "rankable_reason": e.rankable_reason,
            "evidence_floor": e.rack_class.name,
            # Other halls in this ranking that, on the face of the documents, draw on the same grid connection (hall ids).
            "shares_site_connection": list(e.site_siblings),
            "likely_shares_connection_with": list(e.likely_siblings),
            # The row's place in this table (1-based), which `rank` used to double as: a hall that is not ranked is listed but has no rank.
            "position": i,
        })
    return rows


def _by_site_max(es: list[SiteEntry]) -> int:
    """Sum over declared sites of the LARGEST hall's racks (a hall that declares no site is its own site). Read from the halls' own results:
    what one shared connection can host is not solved here, only bracketed (the sum of the halls above, the largest hall below)."""
    best: dict[str, int] = {}
    loose = 0
    for e in es:
        k = site_key(e.intake.document)
        if k is None:
            loose += e.racks
        else:
            best[k] = max(best.get(k, 0), e.racks)
    return loose + sum(best.values())


def constraint_rollup(ordered: list[SiteEntry]) -> dict:
    """How many halls each constraint binds, as found and after every relief is taken. A constraint that binds across several halls is a
    portfolio programme. ``incomparable_halls`` counts the halls among them that were not evaluated against every constraint, whose binding
    constraint is the first of the ones that WERE evaluated."""
    def tally(pick) -> list[dict]:
        return [{"constraint": k, "halls": len(v), "incomparable_halls": sum(1 for x in v if not x.rankable), "members": [x.name for x in v]}
                for k, v in _bound_by(ordered, pick)]
    return {"as_found": tally(lambda e: e.best.envelope.binding.name),
            "after_relief": tally(lambda e: e.after_relief_binding.name)}


def _bound_by(ordered: list[SiteEntry], pick) -> list[tuple[str, list[SiteEntry]]]:
    """(constraint name, the halls it binds), most halls first, then by name."""
    groups: dict[str, list[SiteEntry]] = {}
    for e in ordered:
        groups.setdefault(pick(e), []).append(e)
    return sorted(groups.items(), key=lambda kv: (-len(kv[1]), kv[0]))


def portfolio_summary(entries: list[SiteEntry], objective: Objective = Objective.MAX_COMPUTE) -> dict:
    """The portfolio-level figures beside the rows, with what each one adds up and what it leaves out. One source for the API and the
    document. Nothing here solves anything: every number is read from the per-hall results the rows already carry."""
    ordered = rank(entries, objective)
    comparable = [e for e in ordered if e.rankable]
    return {
        "total_racks_upper_bound": sum(e.racks for e in ordered),
        "total_racks_by_site_max": _by_site_max(ordered),
        # null, not 0, when no hall is comparable: there is no total, and "no total" is not "zero racks"
        "comparable_total_racks": sum(e.racks for e in comparable) if comparable else None,
        "comparable_total_racks_by_site_max": _by_site_max(comparable) if comparable else None,
        "comparable_total_racks_evidence": min(e.rack_class for e in comparable).name if comparable else None,
        "incomparable_halls": [{"rank": rk, "site": e.intake.context.site.name, "hall": e.hall_id, "racks": e.racks,
                                "required_gaps": e.required_gap_paths, "unassessed_banks": e.unassessed_banks,
                                "reason": e.rankable_reason, "position": i}
                               for i, (e, rk) in enumerate(zip(ordered, ranks(ordered)), 1) if not e.rankable],
        "constraint_rollup": constraint_rollup(ordered),
        "totals_note": (f"Every total sums, for each hall, the figure of the architecture the objective {objective.value!r} selects for it; "
                        "another objective selects other architectures and gives other totals. total_racks and total_racks_upper_bound "
                        "add every hall's own figure, an upper bound while a grid connection is shared between halls or a hall has "
                        "constraints that were not evaluated. comparable_total_racks adds only the halls that are rankable; "
                        "total_racks_by_site_max and comparable_total_racks_by_site_max count only the largest hall at each declared site."),
    }


def sharing_statements(ordered: list[SiteEntry]) -> list[str]:
    """One sentence per set of halls that most likely share a grid connection, in an order that does not depend on the order of the input.
    Said, never merged: the engine does not model a connection shared between halls, so the figures stay each hall's own."""
    out: list[str] = []
    groups: dict[str, list[SiteEntry]] = {}
    for e in ordered:
        k = site_key(e.intake.document)
        if k is not None:
            groups.setdefault(k, []).append(e)
    for k in sorted(groups):
        g = groups[k]
        if len(g) < 2:
            continue
        names = " and ".join(sorted(x.name for x in g))
        out.append(f"{names} are at the same site ({g[0].intake.context.site.id}) and, on the face of the documents, draw on one grid "
                   f"connection, so their racks are not additive. Their own figures add to {sum(x.racks for x in g)} racks; that is an upper "
                   f"bound, because the connection is counted once per hall. The largest hall alone is {max(x.racks for x in g)} racks. The "
                   "engine does not model the shared connection: supply the site's own capacity for a combined figure.")
    prints: dict[str, list[SiteEntry]] = {}
    for e in ordered:
        fp = grid_fingerprint(e.intake.document)
        if fp is not None:
            prints.setdefault(fp, []).append(e)
    for g in sorted(prints.values(), key=lambda g: sorted(x.name for x in g)):
        keys = {site_key(x.intake.document) for x in g}
        if len(g) < 2 or (len(keys) == 1 and None not in keys):
            continue           # a single hall, or already said above as one declared site
        names = " and ".join(sorted(x.name for x in g))
        out.append(f"{names} declare an identical grid block under different site ids: this is likely one connection counted once per "
                   f"hall. They are not merged. Their own figures add to {sum(x.racks for x in g)} racks, an upper bound; the largest "
                   f"alone is {max(x.racks for x in g)} racks. Confirm whether they share a connection.")
    return out


def portfolio_warnings(entries: list[SiteEntry], objective: Objective = Objective.MAX_COMPUTE) -> list[str]:
    """What a reader of the totals must be told: shared connections and halls that are not comparable. Empty for a portfolio of fully
    evaluated halls on separate connections."""
    ordered = rank(entries, objective)
    out = sharing_statements(ordered)
    bad = [e for e in ordered if not e.rankable]
    if bad:
        out.append(f"{len(bad)} of {len(ordered)} halls are not comparable (a required input not supplied or an equipment bank not "
                   f"declared): {', '.join(e.name for e in bad)}. total_racks includes them, so it is an upper bound; "
                   + (f"comparable_total_racks adds only the {len(ordered) - len(bad)} that are."
                      if len(bad) < len(ordered) else "no hall is comparable, so comparable_total_racks is null."))
    return out


def build(entries: list[SiteEntry], *, client: str = "Portfolio",
          objective: Objective = Objective.MAX_COMPUTE) -> Report:
    ordered = rank(entries, objective)
    notes = rank_notes(ordered, objective)
    phrase = _OBJECTIVE_PHRASE[objective]
    total_racks = sum(e.racks for e in ordered)
    deliverable = [e for e in ordered if e.racks > 0]
    comparable = [e for e in ordered if e.rankable]
    incomparable = [e for e in ordered if not e.rankable]
    shared = sharing_statements(ordered)
    r = Report(
        title=f"Portfolio Screen — {len(entries)} halls ranked by {phrase}",
        subtitle=(f"{client} · one methodology applied to every hall · "
                  f"ranked by {objective.value.replace('_', ' ')}"),
        watermark=("SCREENING OPINION — modelled from the inputs supplied for each hall. "
                   "Not a design package, and not a measurement of any asset."),
        status="Portfolio Screen",
        meta=[("Client", client), ("Halls screened", str(len(entries))),
              ("Halls that can take the platform", str(len(deliverable))),
              *([("Halls comparable on the inputs supplied", f"{len(comparable)} of {len(entries)}")] if incomparable else []),
              ("Ranking objective", objective.value.replace("_", " "))],
        footer=("Every hall was screened with the identical model, library and assumptions, so a difference "
                "in the ranking comes from the halls, not the method. The inputs are not equally complete or "
                "equally evidenced across halls: the evidence class on each figure and the ranking note on "
                "each row say where an order cannot be relied on."),
    )

    s = Section("1. The ranking")
    # A total is stated for the objective it was ranked by (each hall's figure is read from the architecture that objective selects, so
    # another objective gives another total), and only over halls that can be added: a hall some constraints of which were never
    # evaluated describes a building with fewer limits than the real one, and adding it to fully evaluated halls adds two kinds of number.
    objective_note = (f"for the objective {phrase}; another objective selects other architectures and gives another total")
    counted = comparable if incomparable else ordered
    if counted:
        # A sum of rack counts is no better evidenced than the weakest hall in it.
        weakest = min(e.rack_class for e in counted)
        upper = any(e.site_siblings or e.likely_siblings for e in counted)
        label = (("Comparable" if incomparable else "Total") + " deployable racks across the portfolio"
                 + (" (upper bound: a shared grid connection is counted once per hall)" if upper else ""))
        basis = (f"{len([e for e in counted if e.racks > 0])} of {len(entries)} halls can take the platform at all"
                 if not incomparable else
                 f"{len(comparable)} of {len(entries)} halls are comparable and counted; {len([e for e in comparable if e.racks > 0])} of "
                 "them can take the platform at all")
        s.blocks.append(Statement(label, V(float(sum(e.racks for e in counted)), "racks", "portfolio deployable racks", weakest),
                                  f"{basis} · {objective_note}"))
    if incomparable:
        out_text = "; ".join(f"{e.name} ({e.what_is_missing})" for e in incomparable)
        if counted:
            s.blocks.append(Para("In this total: " + "; ".join(e.name for e in comparable) + f". Not in this total: {out_text}."))
        else:
            s.blocks.append(Callout("warning",
                "No total is given: no hall in this portfolio is comparable. Each was evaluated against fewer constraints than the real "
                "hall has (those constraints were not evaluated), and a sum of such figures describes no building. Not in this total: "
                + out_text + "."))
        s.blocks.append(Para(
            f"Every hall's own figure adds to {total_racks} racks. That is an upper bound, not a total: a constraint that was not "
            "evaluated can only lower a hall's racks, never raise them."))
    for text in shared:
        s.blocks.append(Callout("warning", text))
    rows = []
    for rk, e, note in zip(ranks(ordered), ordered, notes):
        hid = e.intake.context.hall.id
        cpr = e.capex_per_rack_q
        rows.append([
            Lit(str(rk) if rk is not None else "—"),         # a hall that is not ranked is listed without a place, as its note says
            e.name,
            e.intake.context.site.metro,
            V(float(e.racks), "racks", f"{hid}: deployable racks", e.rack_class),
            _weeks_cell(e),
            e.capex_q,
            cpr if cpr is not None else "— (no deployable racks)",
            e.best.envelope.binding.name,
            note,
        ])
    any_assumed = any(e.date_basis.assumed for e in ordered)
    s.blocks.append(Table(["#", "Hall", "Metro", "Racks",
                           f"Time to power ({ASSUMED_DATE_LABEL})" if any_assumed else "Time to power", "Capex",
                           "Capex per rack", "Binds first", "Ranking note"], rows,
                          caption="Ranked portfolio. Each figure carries the evidence class of the weakest "
                                  "input that determines it. Time to power and capex are bounded by the lead "
                                  "times and prices on each hall's relief path, not by a fixed multiplier. "
                                  "Capex excludes IT hardware, migration and lost tenancy revenue."
                                  + (f" A time figure marked E0 is an {ASSUMED_DATE_LABEL}, not an "
                                     "energisation date." if any_assumed else "")))
    r.sections.append(s)

    s = Section("2. Where the portfolio is constrained")
    for heading, pick, caption in (
            ("Binding constraint", lambda e: e.best.envelope.binding.name,
             "As found: what binds each hall before any works. A constraint that binds across several halls is a portfolio programme, "
             "not a site problem — and it is usually cheaper to solve once."),
            ("Binding constraint after the relief works", lambda e: e.after_relief_binding.name,
             "After the relief works: what binds each hall once every relief on its ladder is taken. This is the constraint the programme "
             "has to move next.")):
        rows = []
        for name, halls in _bound_by(ordered, pick):
            row = [name, V(float(len(halls)), "halls", f"halls bound by {name}", min(x.rack_class for x in halls))]
            if incomparable:
                row.append(Lit(str(sum(1 for x in halls if not x.rankable))))
            rows.append(row)
        s.blocks.append(Table([heading, "Halls", *(["Of which not comparable"] if incomparable else [])], rows,
                              caption=caption + (" A hall that is not comparable reports the first binding constraint of the ones that "
                                                 "were evaluated." if incomparable else "")))
    r.sections.append(s)

    s = Section("3. Where to start")
    startable = [e for e in comparable if e.racks > 0]
    if startable:
        first = startable[0]
        s.blocks.append(Para(
            f"Start with {first.name}: {first.racks} racks, {_weeks_text(first)} to full capacity, "
            f"binding first on {first.best.envelope.binding.name.lower()}."
            + (f" Its grid connection is shared with {', '.join(first.site_siblings)}: racks there are not additive."
               if first.site_siblings else "")))
        unreliable = [e for e in incomparable if e.racks > 0]
        if unreliable:
            s.blocks.append(Para(
                f"{len(unreliable)} further hall(s) show racks but are not recommended, because some of their constraints were never "
                f"evaluated: {', '.join(e.name for e in unreliable)}. Supply the data below and they can be ranked."))
    elif any(e.racks > 0 for e in incomparable):
        s.blocks.append(Callout("warning",
            "No hall can be recommended yet. The halls that show racks were not evaluated against every constraint, so their figures "
            "describe buildings with fewer limits than the real ones"
            + (", and no hall that was fully evaluated can take the platform" if comparable else "")
            + ". What would make a hall rankable: " + "; ".join(
                f"{e.name}: " + "; ".join(([f"supply {', '.join(e.required_gaps)}"] if e.required_gaps else [])
                                          + ([f"declare the {' and '.join(e.unassessed_banks)} bank(s)"] if e.unassessed_banks else []))
                for e in incomparable if e.racks > 0) + "."))
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
        *(["A hall that is not comparable (a required input missing, or an equipment bank undeclared) is placed after every comparable "
           "hall whatever its rack count, is left out of the comparable total and is never the hall to start with."]
          if incomparable else []),
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
        f"{claim_label(k)} is {w.name.split('_', 1)[0]} where an issued deliverable requires "
        f"{f.name.split('_', 1)[0]}" for k, (w, f) in below.items())
    if detail:
        s.blocks.append(Callout("warning",
            f"{DISCLOSURE_MARKER} this portfolio was screened partly on library defaults. {detail}. "
            "The ranking notes in section 1 mark every position that is tied or lies inside the "
            "uncertainty of the figures; close the per-hall data gaps before committing capital to the "
            "order."))
    r.sections.append(s)
    return r
