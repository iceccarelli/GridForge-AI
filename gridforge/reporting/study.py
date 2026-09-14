"""Assembles the Capacity & Density Envelope Study from solved scenarios.

This module IS the automation. Every hour it saves is an hour of founder time
that does not have to be spent on project N+1 (docs/01 §7).
"""
from __future__ import annotations

from enum import Enum

from ..common import ASSUMED, ESTIMATED, V
from ..constraints import EnvelopeContext
from ..envelope.time_to_power import TimeToPower, schedule
from ..scenario.objective import OBJECTIVE_RATIONALE, Objective, pick_recommended
from ..scenario.run import ScenarioResult


# Kept as a module-level alias so existing call sites keep working.
_pick_recommended = pick_recommended
from ..validation import Quantity
from .gates import DISCLOSURE_MARKER, claims_below_floor
from .model import Bullets, Callout, Lit, Para, Report, Section, Statement, Table


def collect_claims(results) -> dict[str, list]:
    """Map report claim kinds to the quantities that carry them."""
    inf = float("inf")
    return {
        "electrical_capacity": [c.max_racks for r in results for c in r.envelope.constraints
                                if c.domain == "electrical" and c.max_racks.value != inf],
        "cooling_performance": [c.max_racks for r in results for c in r.envelope.constraints
                                if c.domain == "thermal" and c.max_racks.value != inf],
        "capex": [r.economics.capex_total_eur for r in results],
        "schedule": [Quantity.given(r.economics.critical_path_weeks, "weeks",
                                    f"{r.spec.id}: critical path", ESTIMATED) for r in results],
    }

WATERMARK = ("SYNTHETIC REFERENCE DATA — NOT A CUSTOMER ASSET. "
             "All values are modelled or assumed; none is a measurement of a real site.")

SCOPE_OUT = [
    "Stamped design drawings and any deliverable requiring a professional engineering signature.",
    "CFD of the hall (available as a priced add-on or a later phase).",
    "Equipment selection, bill of materials, pricing or procurement.",
    "Structural sign-off — the floor-loading check here is a screening calculation only.",
    "Electrical protection and arc-flash studies.",
    "Commissioning, migration planning and tenancy/lease strategy.",
]


def build(ctx: EnvelopeContext, results: list[ScenarioResult],
          sensitivities: list[tuple[str, int]] | None = None,
          *, title: str | None = None, watermark: str = WATERMARK,
          client: str = "Reference Project",
          objective: Objective = Objective.MAX_COMPUTE) -> Report:
    rec = _pick_recommended(results, objective)
    hall = ctx.hall
    plat = ctx.cluster.platform
    r = Report(
        title=title or f"Capacity & Density Envelope Study — {ctx.site.name}, hall {hall.id}",
        subtitle=(f"{client} · target platform {plat.name} · "
                  f"{len(results)} architectures compared · GridForge-AI envelope engine v0.1"),
        watermark=watermark,
        footer=("Engineering opinion supported by a documented model. Not a design package. "
                "Professional indemnity and named-signatory arrangements govern reliance on this report."),
        status="Screening study",
        meta=[
            ("Site", ctx.site.name),
            ("Hall", f"{hall.id} · built {hall.build_year}"),
            ("Metro", f"{ctx.site.metro}, {ctx.site.country}"),
            ("Target platform", plat.name),
            ("Architectures compared", str(len(results))),
            ("Basis", "Screening · AACE Class 5"),
        ],
    )

    # 1 ------------------------------------------------------------------ answer
    s = Section("1. The answer")
    s.blocks.append(Statement(
        f"Deployable {plat.name} racks today, before any investment",
        V(float(rec.envelope.max_racks), "racks", "deployable racks as found", ESTIMATED),
        rec.envelope.binding.basis))
    s.blocks.append(Para(
        f"The binding constraint as found is {rec.envelope.binding.name.lower()} "
        f"({rec.envelope.binding.domain}). {rec.envelope.binding.basis}."))
    s.blocks.append(Statement(
        "Deployable racks after the full headroom ladder",
        V(float(rec.unlocked_racks), "racks", "deployable racks after relief measures", ESTIMATED),
        f"{rec.ladder.final.binding.name} becomes binding" if rec.ladder.final else ""))
    s.blocks.append(Statement(
        "IT load unlocked",
        rec.ladder.final.it_load_kW if rec.ladder.final else rec.envelope.it_load_kW,
        "at the recommended architecture"))
    ttp = schedule(rec.ladder)
    if ttp.weeks_to_full is not None:
        s.blocks.append(Statement(
            "Time to full capacity",
            V(ttp.weeks_to_full, "weeks", "elapsed weeks to energise the full envelope", ESTIMATED,
              band=(ttp.weeks_to_full * 0.7, ttp.weeks_to_full * 1.6)),
            f"set by {ttp.critical_item.lower()}; reliefs assumed to run in parallel"))
    s.blocks.append(Statement(
        "Indicative capex to reach it",
        rec.economics.capex_total_eur,
        rec.economics.aace_class))
    s.blocks.append(Callout("answer",
        f"Recommended architecture: {rec.spec.name}. {rec.spec.rationale}"))
    s.blocks.append(Para(
        f"Selection objective: {OBJECTIVE_RATIONALE[objective]} Section 9 shows every architecture "
        "against all three objectives so the ranking can be overruled with the evidence in view."))
    if rec.envelope.max_racks == 0:
        s.blocks.append(Callout("warning",
            "As found, this hall cannot host a single rack of the target platform. The value of "
            "this study is the ordered, costed list of what has to change — and the option to "
            "stop, which is a legitimate outcome."))
    r.sections.append(s)

    # 2 -------------------------------------------------------------- the ladder
    s = Section("2. Headroom ladder")
    s.blocks.append(Para(
        "Each row is the constraint that binds at that point, what it costs to move it, and how "
        "long that takes. Reliefs are assumed to run in parallel, so the schedule is governed by "
        "the longest lead time rather than the sum."))
    rows = []
    for st in rec.ladder.steps:
        eur_kw = st.eur_per_kW_unlocked(plat.rack_kW.value)
        rows.append([
            Lit(str(st.step)), st.binding_name, st.domain,
            V(float(st.racks_before), "racks", f"racks before step {st.step}", ESTIMATED),
            V(float(st.racks_after), "racks", f"racks after step {st.step}", ESTIMATED),
            (st.relief_description or "no relief available") +
            ("" if st.taken else "  — NOT TAKEN: this relief cannot be obtained in the decision horizon"),
            st.capex_eur if st.capex_eur is not None else "—",
            st.lead_time_weeks if st.lead_time_weeks is not None else "—",
            V(eur_kw, "EUR/kW", f"cost per kW unlocked at step {st.step}", ASSUMED)
            if eur_kw is not None else "—",
        ])
    s.blocks.append(Table(
        ["#", "Constraint", "Domain", "Racks before", "Racks after", "Relief",
         "Capex", "Lead time", "EUR per kW unlocked"], rows,
        caption="Headroom ladder for the recommended architecture."))
    s.blocks.append(Para(
        "Steps marked NOT TAKEN are shown because they are the next thing that binds, not because "
        "they are recommended. Their cost is excluded from the totals below."))
    s.blocks.append(Statement("Cumulative relief capex",
                              V(rec.ladder.cumulative_capex_eur, "EUR",
                                "cumulative capex of relief measures", ASSUMED,
                                band=(rec.ladder.cumulative_capex_eur * 0.5,
                                      rec.ladder.cumulative_capex_eur * 2.0)),
                              rec.economics.aace_class))
    s.blocks.append(Statement("Critical-path lead time",
                              V(rec.ladder.critical_path_weeks, "weeks",
                                "longest relief lead time on the path", ASSUMED),
                              "Lead time, not construction, is usually the schedule driver."))
    r.sections.append(s)

    # 3 --------------------------------------------------------- time to power
    s = Section("3. Time to power")
    s.blocks.append(Para(
        "Capacity without a date is not a decision. Each relief on the ladder carries a lead time; "
        "reliefs are assumed to run in parallel, so the racks unlocked by the first N steps become "
        "available at the longest lead time among those N. One item sets the date, and it is almost "
        "never the construction work."))
    rows = [[V(p.weeks, "weeks", f"elapsed at {p.racks} racks", ESTIMATED),
             V(float(p.racks), "racks", f"racks energised at week {p.weeks:g}", ESTIMATED),
             p.unlocked_by, p.domain] for p in ttp.points]
    if rows:
        s.blocks.append(Table(["Elapsed", "Racks energised", "Unlocked by", "Domain"], rows,
                              caption="Energisation curve for the recommended architecture."))
    s.blocks.append(Callout("note",
        f"The date is set by {ttp.critical_item.lower()}. Every week of that lead time is a week "
        "of the site's contracted power earning nothing, so it is the first thing to attack — "
        "before any further engineering optimisation."))
    rows = []
    for res in results:
        t = schedule(res.ladder)
        rows.append([res.spec.name,
                     V(float(res.unlocked_racks), "racks", f"{res.spec.id}: racks after ladder",
                       ESTIMATED),
                     V(t.weeks_to_full, "weeks", f"{res.spec.id}: weeks to full capacity", ESTIMATED)
                     if t.weeks_to_full is not None else "—",
                     t.critical_item])
    s.blocks.append(Table(["Scenario", "Racks", "Time to full capacity", "Item that sets the date"],
                          rows, caption="Time to power across the architectures compared."))
    r.sections.append(s)

    # 4 ------------------------------------------------------------- the baseline
    s = Section("4. Site and baseline")
    s.blocks.append(Table(
        ["Item", "Value"],
        [["Site", ctx.site.name], ["Metro", ctx.site.metro], ["Country", ctx.site.country],
         ["Hall", hall.id], ["Built", Lit(str(hall.build_year))],
         ["Floor", hall.floor_type.value], ["Containment", hall.containment],
         ["Rack positions", V(float(hall.rack_positions), "positions", "installed rack positions", ESTIMATED)],
         ["Positions available", V(float(hall.positions_available), "positions",
                                   "positions available for redeployment", ESTIMATED)],
         ["Design density", hall.design_density_kW_per_rack],
         ["Net white space", hall.net_white_space_m2],
         ["Floor loading", hall.floor_loading_kPa],
         ["Clear height", hall.clear_height_m],
         ["Design dry bulb", ctx.site.design_drybulb_C],
         ["Firm grid capacity", ctx.power.grid.firm_capacity_MVA],
         ["Contracted power", ctx.power.grid.contracted_MW],
         ["Current site peak", ctx.power.grid.current_site_peak_MW],
         ["Current IT load", ctx.power.current_it_load_MW],
         ["Busway ampacity", ctx.power.lv.busway_ampacity_A],
         ["Tap-off rating", ctx.power.lv.tapoff_max_A],
         ["Plant capacity", ctx.thermal.plant.chilled_water_capacity_kW],
         ["Plant supply / return", f"{ctx.thermal.plant.design_supply_C.render()} / "
                                   f"{ctx.thermal.plant.design_return_C.render()}"],
         ["Pumped flow available", ctx.thermal.plant.pump_flow_capacity_l_per_min]],
        caption="Baseline as supplied. Items marked E5 are customer data; everything else is assumed."))
    if ctx.power.grid.queue_note:
        s.blocks.append(Callout("note", ctx.power.grid.queue_note))
    r.sections.append(s)

    # 4/5 ------------------------------------------------------- constraint detail
    for domain, heading in (("electrical", "5. Electrical capacity analysis"),
                            ("thermal", "6. Thermal and cooling analysis"),
                            ("physical", "7. Physical constraints")):
        s = Section(heading)
        rows = []
        for c in rec.envelope.sorted_constraints():
            if c.domain != domain:
                continue
            rows.append([c.name, "gate" if c.gate else "capacity",
                         c.max_racks if c.max_racks.value != float("inf")
                         else V(0, "racks", f"{c.name}: not limiting", ESTIMATED),
                         c.basis,
                         c.relief.description if c.relief else "—"])
        if not rows:
            continue
        s.blocks.append(Table(["Constraint", "Type", "Racks permitted", "Basis", "Relief"], rows))
        notes = [n for c in rec.envelope.constraints if c.domain == domain for n in c.notes if n]
        if notes:
            s.blocks.append(Bullets(notes))
        r.sections.append(s)

    # 7 --------------------------------------------------- power/thermal coupling
    s = Section("8. Power and thermal interaction")
    s.blocks.append(Para(
        "Power and thermal are not independent budgets. Every kilowatt the cooling architecture "
        "consumes is a kilowatt of grid capacity that cannot be sold as compute, so the choice of "
        "cooling architecture directly changes the electrical envelope. The table shows the same "
        "hall under each architecture."))
    rows = []
    for res in results:
        rows.append([res.spec.name, res.envelope.architecture,
                     _pue_of(res),
                     V(float(res.headline_racks), "racks", f"{res.spec.id}: racks as found", ESTIMATED),
                     V(float(res.unlocked_racks), "racks", f"{res.spec.id}: racks after ladder", ESTIMATED),
                     res.envelope.binding.name,
                     res.ladder.final.binding.name if res.ladder.final else "—"])
    s.blocks.append(Table(["Scenario", "Architecture", "PUE used", "Racks as found",
                           "Racks after ladder", "Binds first", "Binds last"], rows,
                          caption="A better cooling architecture buys compute out of the same grid connection."))
    r.sections.append(s)

    # 8 --------------------------------------------------------------- economics
    s = Section("9. Economics")
    rows = []
    for res in results:
        e = res.economics
        per_rack = e.capex_total_eur.value / max(res.unlocked_racks, 1)
        rows.append([res.spec.name,
                     V(float(res.unlocked_racks), "racks", f"{res.spec.id}: racks unlocked",
                       ESTIMATED),
                     e.capex_total_eur,
                     V(per_rack, "EUR/rack", f"{res.spec.id}: capex per rack enabled", ASSUMED,
                       band=(per_rack * 0.5, per_rack * 2.0)),
                     e.annual_energy_cost_eur, e.energy_cost_per_gpu_hour_eur,
                     V(e.critical_path_weeks, "weeks", f"{res.spec.id}: critical path", ASSUMED)])
    s.blocks.append(Table(["Scenario", "Racks", "Total capex", "Capex per rack enabled",
                           "Annual energy cost", "Energy cost per GPU-hour", "Critical path"], rows,
                          caption=f"Cost basis: {rec.economics.aace_class}. Excludes IT hardware, "
                                  f"migration and lost tenancy revenue."))
    mix = rec.economics.cost_basis_mix or {}
    placeholders = mix.get("library_default", 0)
    priced = sum(v for k, v in mix.items() if k != "library_default")
    total_lines = placeholders + priced
    if total_lines:
        s.blocks.append(Table(
            ["Cost basis", "Lines"],
            [[basis.replace("_", " "), V(float(n), "lines", f"cost lines on {basis}", ESTIMATED)]
             for basis, n in sorted(mix.items(), key=lambda kv: -kv[1])],
            caption="What each price in this study rests on. The accuracy class above follows the "
                    "weakest line, not the average."))
    if placeholders:
        s.blocks.append(Callout("warning",
            f"{placeholders} of {total_lines} priced lines are library placeholders rather than "
            "quotations, which is why this estimate is stated at the accuracy class above. Each "
            "quotation obtained replaces a placeholder and tightens the whole estimate; the "
            "constraint that binds is worth quoting first."))
    s.blocks.append(Callout("warning",
        "Public retrofit cost benchmarks currently span roughly 2 to 12 MEUR per MW — a four- to "
        "sixfold spread. No figure in this section should be treated as a market benchmark; they "
        "are screening estimates pending site-specific quotations."))
    r.sections.append(s)

    # 9 ------------------------------------------------------------- sensitivity
    if sensitivities:
        s = Section("10. Sensitivity")
        s.blocks.append(Para(
            "One-at-a-time sensitivity on the recommended architecture, evaluated against the "
            "relieved case rather than the hall as found. Inputs are ranked by how far each moves "
            "the answer; the ones at the top are the ones worth paying to measure."))
        base = rec.unlocked_racks
        rows = [[label, V(float(n), "racks", f"racks under: {label}", ESTIMATED),
                 V(float(n - base), "racks", f"delta under: {label}", ESTIMATED)]
                for label, n in sensitivities]
        rows.sort(key=lambda row: -abs(row[2].value))
        s.blocks.append(Table(["Input varied", "Racks", "Change vs base case"], rows))
        r.sections.append(s)

    # 10 ------------------------------------------------------------------ risks
    s = Section("11. Risk register")
    risks = []
    for st in rec.ladder.steps:
        if st.risk:
            risks.append([st.binding_name, st.risk,
                          st.lead_time_weeks if st.lead_time_weeks is not None else "—"])
    risks += [
        ["Evidence base", "The dominant inputs in this study are assumed rather than measured. "
                          "Twelve months of hall trend data would move the headline from an "
                          "estimate to a reconciled figure.", "—"],
        ["Structural", "Floor loading is screened, not assessed. A structural engineer must sign "
                       "off before any deployment.", "—"],
        ["Hydraulics", "Pressure drop and pipe sizing are not modelled at screening level; a "
                       "hydraulic model is required before design.", "—"],
        ["Tenancy", "Releasing positions is a commercial and contractual exercise with revenue at "
                    "risk, not an engineering one.", "—"],
    ]
    s.blocks.append(Table(["Risk", "Description", "Lead time exposure"], risks))
    r.sections.append(s)

    # 11 -------------------------------------------------------- recommendation
    s = Section("12. Recommendation and decision gates")
    s.blocks.append(Para(
        f"Proceed with {rec.spec.name}. {rec.spec.rationale} On the modelled inputs this unlocks "
        f"{rec.unlocked_racks} racks of {plat.name} against {rec.envelope.max_racks} as found."))
    s.blocks.append(Bullets([
        "Gate 1 — obtain the DSO position in writing on firm capacity and any flexibility product "
        "before committing capital. In most target metros this is the shortest path to a definitive "
        "answer and it costs nothing but time.",
        "Gate 2 — commission a structural assessment of the hall floor and a hydraulic model of the "
        "secondary loop. Both are cheap relative to the decision and both can invalidate it.",
        "Gate 3 — place long-lead orders (transformer, busway, CDU) only after Gates 1 and 2 clear; "
        "lead time, not construction, governs the programme.",
        "Gate 4 — instrument the hall and reconcile this model against twelve months of measured "
        "data before the second phase. That reconciliation is what moves these numbers from "
        "estimated to field-validated.",
    ]))
    r.sections.append(s)

    # 12 --------------------------------------------------------------- scope
    s = Section("13. Scope, basis and limitations")
    s.blocks.append(Para(
        "This study is an engineering opinion supported by a documented model. It is not a design "
        "package and confers no design liability. The following are outside scope:"))
    s.blocks.append(Bullets(SCOPE_OUT))
    s.blocks.append(Para(
        "Every quantity in this report carries an evidence class; Appendix A lists the assumptions, "
        "sources and provenance of each. No number here is a measurement of a physical asset unless "
        "it is labelled E5 or above."))
    below = claims_below_floor(collect_claims(results))
    if below:
        detail = "; ".join(
            f"{k.replace('_', ' ')} is {w.name.split('_', 1)[0]} where an issued deliverable "
            f"requires {f.name.split('_', 1)[0]}" for k, (w, f) in below.items())
        s.blocks.append(Callout("warning",
            f"{DISCLOSURE_MARKER} this is a screening study built on library defaults and assumed "
            f"inputs. {detail}. These conclusions are not sufficient to support procurement, "
            "construction or an investment committee decision on their own; they are sufficient to "
            "decide whether to spend money finding out. The inputs listed in Appendix A.1 are what "
            "must be measured to lift them."))
    r.sections.append(s)
    return r


def _pue_of(res: ScenarioResult) -> Quantity:
    from ..thermal.library import PUE_BY_ARCHITECTURE
    from ..thermal.schema import Architecture
    return PUE_BY_ARCHITECTURE[Architecture(res.envelope.architecture)]
