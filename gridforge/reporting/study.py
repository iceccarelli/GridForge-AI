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
from ..costs import BASIS_LABEL, active_evidence
from ..validation import Quantity
from .gates import DISCLOSURE_MARKER, claims_below_floor
from .model import Bullets, Callout, Lit, Para, Report, Section, Statement, Table
from .labels import (capex_per_rack_q, critical_path_q, dominant_sensitivity, elapsed_bands, full_capacity_q, is_zero_gain, rack_class,
                     racks_q, relief_text, step_basis_text, economics_limitations, weeks_q)


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

# The four gates after the study. One list, so the long report and the board summary cannot drift apart.
DECISION_GATES = (
    ("Gate 1 — get the DSO's position on firm capacity and any flexibility product in writing before "
     "committing capital.",
     "Gate 1 — obtain the DSO position in writing on firm capacity and any flexibility product "
     "before committing capital. In most target metros this is the shortest path to a definitive "
     "answer and it costs nothing but time."),
    ("Gate 2 — commission a structural assessment of the floor and a hydraulic model of the secondary loop.",
     "Gate 2 — commission a structural assessment of the hall floor and a hydraulic model of the "
     "secondary loop. Both are cheap relative to the decision and both can invalidate it."),
    ("Gate 3 — place long-lead orders only after Gates 1 and 2 clear.",
     "Gate 3 — place long-lead orders (transformer, busway, CDU) only after Gates 1 and 2 clear; "
     "lead time, not construction, governs the programme."),
    ("Gate 4 — instrument the hall and reconcile this model against twelve months of measured data.",
     "Gate 4 — instrument the hall and reconcile this model against twelve months of measured "
     "data before the second phase. That reconciliation is what moves these numbers from "
     "estimated to field-validated."),
)

# A real client's study. Same wording as the Density Screen's: what it is and what it is not.
CLIENT_WATERMARK = ("SCREENING OPINION — modelled from the inputs supplied. Not a design package, "
                    "and not a measurement of this asset.")


def watermark_for(intake) -> str:
    """The synthetic-data stamp belongs to invented reference intakes only (docs/01 §8)."""
    return WATERMARK if intake.synthetic else CLIENT_WATERMARK


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
        racks_q(rec.envelope.max_racks, "deployable racks as found", rec),
        rec.envelope.binding.basis))
    s.blocks.append(Para(
        f"The binding constraint as found is {rec.envelope.binding.name.lower()} "
        f"({rec.envelope.binding.domain}). {rec.envelope.binding.basis}."))
    s.blocks.append(Statement(
        "Deployable racks after the full headroom ladder",
        racks_q(rec.unlocked_racks, "deployable racks after relief measures", rec),
        f"{rec.ladder.final.binding.name} becomes binding" if rec.ladder.final else ""))
    s.blocks.append(Statement(
        "IT load unlocked",
        rec.ladder.final.it_load_kW if rec.ladder.final else rec.envelope.it_load_kW,
        "at the recommended architecture"))
    ttp = schedule(rec.ladder)
    full_q = full_capacity_q(rec.ladder, ttp, "elapsed weeks to energise the full envelope")
    if full_q is not None:
        s.blocks.append(Statement(
            "Time to full capacity", full_q,
            f"set by {ttp.critical_item.lower()}; reliefs assumed to run in parallel; the range is "
            "that item's own lead-time range"))
    s.blocks.append(Statement(
        "Indicative capex to reach it",
        rec.economics.capex_total_eur,
        rec.economics.aace_class + ("" if rec.economics.capex_complete else
                                    " · LOWER BOUND, not an estimate: a cost it needs has no price")))
    lims = economics_limitations(rec.economics)
    if lims:
        s.blocks.append(Callout("warning",
            "These economics are not decision-grade. " + " ".join(x[0].upper() + x[1:] + "." for x in lims)
            + " Section 9 lists every component and what it rests on."))
    if rec.unlocked_racks <= 0:
        s.blocks.append(Callout("answer",
            f"None of the {len(results)} architectures compared can host a rack on these inputs, "
            f"even after every relief the model knows. {rec.ladder.final.binding.name if rec.ladder.final else rec.envelope.binding.name} "
            f"is the limit that remains. No capital is recommended against the present inputs; "
            f"{rec.spec.name} is shown only as the least-constrained comparison."))
    else:
        s.blocks.append(Callout("answer",
            f"Recommended architecture: {rec.spec.name}. {rec.spec.rationale}"))
    s.blocks.append(Para(
        f"Selection objective: {OBJECTIVE_RATIONALE[objective]} Section 9 shows every architecture "
        "against all three objectives so the ranking can be overruled with the evidence in view."))
    dom = dominant_sensitivity(sensitivities, rec.unlocked_racks)
    if dom is not None and dom[1] != rec.unlocked_racks:
        cliff = dom[1] == 0 and rec.unlocked_racks > 0
        s.blocks.append(Callout("warning" if cliff else "note",
            f"Dominant sensitivity: {dom[0].lower()} takes the answer from {rec.unlocked_racks} to "
            f"{dom[1]} racks (section 10)."
            + (" The headline is therefore not robust to that input, which is assumed rather than "
               "measured: treat it as the first thing to confirm." if cliff else "")))
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
            racks_q(st.racks_before, f"racks before step {st.step}", rec),
            racks_q(st.racks_after, f"racks after step {st.step}", rec),
            relief_text(st),
            st.capex_eur if (st.capex_eur is not None and st.taken) else "—",
            step_basis_text(st) if st.taken else (st.not_taken_reason or "—"),
            st.lead_time_weeks if st.lead_time_weeks is not None else "—",
            V(eur_kw, "EUR/kW", f"cost per kW unlocked at step {st.step}", ASSUMED)
            if (eur_kw is not None and st.taken) else "—",
        ])
    s.blocks.append(Table(
        ["#", "Constraint", "Domain", "Racks before", "Racks after", "Relief",
         "Capex", "What it buys and how it is priced", "Lead time", "EUR per kW unlocked"], rows,
        caption="Headroom ladder for the recommended architecture. A step's price follows what it adds "
                "(units, MVA, kW, racks) where the library is priced per unit; a fixed lump is marked as "
                "not scaled. A component with no price is named, never counted as zero."))
    s.blocks.append(Para(
        "Steps marked NOT TAKEN are shown because they are the next thing that binds, not because "
        "they are recommended. Their cost is excluded from the totals below."))
    zero = [st for st in rec.ladder.steps if is_zero_gain(st)]
    if zero:
        s.blocks.append(Para(
            f"Rungs {', '.join(str(st.step) for st in zero)} are charged but add no racks on their own. "
            "Each relieves one of several constraints that limit the hall to the same figure at that point; "
            "without it a later rung cannot deliver its gain. They are kept, and costed, because dropping "
            "any one of them lowers the final answer — that is checked, not assumed. The EUR-per-kW "
            "column is left blank for them for the same reason: no racks are unlocked at that step."))
    s.blocks.append(Statement("Cumulative relief capex", rec.economics.capex_relief_eur,
                              rec.economics.aace_class))
    s.blocks.append(Statement("Critical-path lead time",
                              critical_path_q(rec.ladder, "longest relief lead time on the path"),
                              "Lead time, not construction, is usually the schedule driver."))
    r.sections.append(s)

    # 3 --------------------------------------------------------- time to power
    s = Section("3. Time to power")
    s.blocks.append(Para(
        "Capacity without a date is not a decision. Each relief on the ladder carries a lead time; "
        "reliefs are assumed to run in parallel, so the racks unlocked by the first N steps become "
        "available at the longest lead time among those N. One item sets the date, and it is almost "
        "never the construction work."))
    rows = [[weeks_q(p.weeks, lo, hi, cls, f"elapsed at {p.racks} racks"),
             racks_q(p.racks, f"racks energised at week {p.weeks:g}", rec),
             p.unlocked_by, p.domain] for p, (_w, lo, hi, cls) in zip(ttp.points, elapsed_bands(rec.ladder))]
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
        fq = full_capacity_q(res.ladder, t, f"{res.spec.id}: weeks to full capacity")
        rows.append([res.spec.name,
                     racks_q(res.unlocked_racks, f"{res.spec.id}: racks after ladder", res),
                     fq if fq is not None else "—",
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
         ["Floor", hall.floor_type.value.replace("_", " ")],
         ["Containment", str(hall.containment).replace("_", " ")],
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
        caption="Baseline as supplied. E5 means supplied by the client — a declared rating, contract term or "
                "design value as given to us, not measured or surveyed by us. E3 marks a figure that is "
                "estimate-grade by nature; E0 marks a library default."))
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
            if c.max_racks.value == float("inf"):
                cell = Lit("passes — not limiting" if c.gate else "not limiting")
            elif c.gate:
                cell = racks_q(c.max_racks.value, f"{c.name}: gate fails", rec)
            else:
                cell = c.max_racks
            rows.append([c.name, "gate" if c.gate else "capacity",
                         cell,
                         c.basis,
                         c.relief.description if c.relief else "—"])
        if not rows:
            continue
        s.blocks.append(Table(["Constraint", "Type", "Racks permitted", "Basis", "Relief"], rows,
                              caption="A gate either passes (it does not limit the hall) or fails (it permits "
                                      "no racks until relieved). Rack counts carry the weakest evidence class "
                                      "among the constraints evaluated."))
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
                     racks_q(res.headline_racks, f"{res.spec.id}: racks as found", res),
                     racks_q(res.unlocked_racks, f"{res.spec.id}: racks after ladder", res),
                     res.envelope.binding.name,
                     res.ladder.final.binding.name if res.ladder.final else "—"])
    s.blocks.append(Table(["Scenario", "Architecture", "PUE used", "Racks as found",
                           "Racks after ladder", "Binds first", "Binds last"], rows,
                          caption="A better cooling architecture buys compute out of the same grid connection."))
    r.sections.append(s)

    # 8 --------------------------------------------------------------- economics
    s = Section("9. Economics")
    rows = []
    none_deployable = []
    any_horizon = any(res.economics.horizon_years for res in results if res.unlocked_racks > 0)
    for res in results:
        e = res.economics
        if res.unlocked_racks == 0:
            # Nothing can be deployed and no relief exists: a cost, a cost per rack and a cost per GPU-hour
            # are not zero, they are undefined. Printing 0 reads as "free".
            none_deployable.append(res.spec.name)
            rows.append([res.spec.name, racks_q(0, f"{res.spec.id}: racks unlocked", res),
                         "—", "—", "—", "—", "—", "—"] + (["—"] if any_horizon else []))
            continue
        rows.append([res.spec.name,
                     racks_q(res.unlocked_racks, f"{res.spec.id}: racks unlocked", res),
                     e.capex_total_eur if e.capex_complete else Lit("≥ " + e.capex_total_eur.render()),
                     capex_per_rack_q(res, f"{res.spec.id}: capex per rack enabled"),
                     e.annual_energy_cost_eur, e.energy_cost_per_gpu_hour_eur,
                     critical_path_q(res.ladder, f"{res.spec.id}: critical path"),
                     Lit("decision-grade" if e.decision_grade else "NOT decision-grade")]
                    + ([e.lifecycle_cost_eur if e.lifecycle_cost_eur is not None else "—"] if any_horizon else []))
    heads = ["Scenario", "Racks", "Total capex", "Capex per rack enabled",
             "Annual energy cost", "Energy cost per GPU-hour", "Critical path", "Economics"]
    if any_horizon:
        heads.append("Lifecycle cost")
    s.blocks.append(Table(heads, rows,
                          caption=f"Cost basis: {rec.economics.aace_class}. Excludes IT hardware, "
                                  f"migration and lost tenancy revenue. A total marked with ≥ is a lower bound: "
                                  f"a cost it needs has no price."
                                  + (" A dash means no rack can be deployed in that architecture and no "
                                     "relief exists, so the figure is undefined rather than zero."
                                     if none_deployable else "")))
    pick_rows = []
    for obj in Objective:
        chosen = pick_recommended(results, obj)
        pick_rows.append([obj.value.replace("_", " "), OBJECTIVE_RATIONALE[obj].split(". ")[0] + ".",
                          chosen.spec.name if chosen.unlocked_racks > 0 else "none deployable",
                          racks_q(chosen.unlocked_racks, f"{chosen.spec.id}: racks under {obj.value}", chosen)])
    s.blocks.append(Table(["Objective", "What it optimises", "Architecture it selects", "Racks"], pick_rows,
                          caption="The same scenarios ranked under each objective. The recommendation above "
                                  "uses the stated objective; where another objective selects a different "
                                  "architecture, that is a judgement for the client, not for the model."))
    e = rec.economics
    s.blocks.append(Table(
        ["How the recommended capex is built", "Amount"],
        [[f"Relief works along the headroom ladder (section 2)", e.capex_relief_eur],
         [f"In-hall conversion of the {rec.unlocked_racks} racks deployed", e.capex_conversion_eur]]
        + ([[f"Initial CDU kit — assumed, not installed ({e.cdu_kit_scope})", e.capex_cdu_kit_eur]]
           if e.capex_cdu_kit_eur is not None else [])
        + [[Lit(f"NOT PRICED — {g['component']} ({g['quantity']:g} x {g['unit'].split('/')[-1]}; "
                f"{len(g['where'])} place{'s' if len(g['where']) != 1 else ''})"), Lit("no price: excluded")]
           for g in e.unpriced_summary()]
        + [["Total (the headline capex)" if e.capex_complete else
            "Total (the headline capex) — LOWER BOUND: the unpriced components above are excluded",
            e.capex_total_eur]],
        caption="The ladder's cumulative figure covers the relief works only; the headline adds the "
                "per-rack conversion inside the hall"
                + (" and the CDUs the model assumed so the liquid scenarios could be solved (the hall has no CDU "
                   "schedule on file; those units must be bought)." if e.capex_cdu_kit_eur is not None else ".")))
    ev = active_evidence()
    if ev is not None:
        # The provenance of every accepted quotation this run used, and what it changed. Accepted evidence is the
        # difference between a library placeholder and a price, so a reader must be able to see exactly which it was.
        used = ev.get("used") or []
        if any(u.get("synthetic") for u in used):
            s.blocks.append(Callout("warning",
                "SYNTHETIC COST EVIDENCE. At least one line below is a test fixture or demonstration, not a real "
                "quotation. Nothing in this run may be quoted as supplier-backed."))
        if used:
            s.blocks.append(Table(
                ["Cost line", "Supplier", "Quoted", "Valid until", "Covers", "Value", "Comparability", "Accepted by",
                 "Evidence record"],
                [[Lit(u["key"]), Lit(u["supplier"] or "—"), Lit(u["quoted_on"] or "—"), Lit(u["valid_until"] or "—"),
                  Lit((f"{u['quoted_quantity']:g} {u['quoted_quantity_unit']}" if u.get("quoted_quantity") else "no quantity stated")),
                  Lit(f"{u['value']:,.0f} {u['currency']} ({u['unit']})"),
                  Lit(u["comparability"]), Lit(f"{u['reviewer']} on {u['reviewed_on']}"),
                  Lit(f"{u['evidence_id']}" + (f" (project {u['project']})" if u.get("project") else ""))] for u in used],
                caption="Accepted supplier evidence used in this run. Each line was reviewed by a named person before it "
                        "could affect a number; a received or unreviewed quotation is never used."))
        for ig in ev.get("ignored") or []:
            s.blocks.append(Callout("note", f"Evidence not used — {ig['key']} ({ig.get('evidence_id') or 'no id'}): {ig['reason']}."))
        eff = ev.get("effect")
        if eff:
            this = next((x for x in eff["scenarios"] if x["scenario"] == rec.spec.id), None)
            if this:
                s.blocks.append(Table(
                    ["Recommended architecture", "Without this evidence", "With it"],
                    [["Total capex (EUR)", Lit(f"{this['capex_before_eur']:,.0f}"), Lit(f"{this['capex_after_eur']:,.0f}")],
                     ["Change", Lit("—"), Lit(f"{this['capex_delta_eur']:+,.0f}")],
                     ["Capex complete", Lit(str(this["capex_complete_before"])), Lit(str(this["capex_complete_after"]))],
                     ["Priced lines still library placeholders", Lit(str(this["placeholder_lines_before"])),
                      Lit(str(this["placeholder_lines_after"]))],
                     ["Cost components with no price", Lit(str(this["unpriced_before"])), Lit(str(this["unpriced_after"]))],
                     ["Decision-grade", Lit(str(this["decision_grade_before"])), Lit(str(this["decision_grade_after"]))]],
                    caption="What the accepted evidence changed. Racks, schedule and constraints are the same in both "
                            "runs; only the cost basis differs."))
                for ch in this["steps_changed"]:
                    s.blocks.append(Callout("note",
                        f"Step {ch['step']} ({ch['constraint']}): {ch['capex_before_eur']:,.0f} → {ch['capex_after_eur']:,.0f} EUR; "
                        f"basis {ch['basis_before']} → {ch['basis_after']} ({ch['price_kind_after']})."))
    # Recurring cost, stated apart from capital: what the hall pays every year, and on what price and run hours.
    op_rows = [["Grid electricity price used", e.tariff_eur_per_MWh,
                Lit("declared by the client" if e.tariff_declared else "library placeholder, not the site's tariff")],
               ["Annual site energy", e.annual_energy_MWh, Lit("utilisation x facility load x 8,760 h")]]
    if e.btm is not None and e.btm.applied:
        op_rows += [["Annual grid energy cost", e.annual_grid_energy_cost_eur,
                     Lit("energy not supplied by on-site generation, at the grid price")],
                    ["BTM generation used on site", e.btm.used_MWh, Lit(
                        "run hours x capacity" + ("; generation above site demand is not valued (export is not modelled)"
                                                  if e.btm.curtailed else ""))],
                    ["BTM variable operating cost per year", e.btm.variable_eur, Lit("fuel / variable cost x energy generated")],
                    ["BTM fixed O&M per year", e.btm.fixed_eur, Lit("declared O&M per kW per year x capacity")]]
    op_rows.append(["Annual energy cost (recurring)", e.annual_energy_cost_eur,
                    Lit("grid + on-site operating cost" if (e.btm is not None and e.btm.applied)
                        else "all energy at the grid price")])
    s.blocks.append(Table(["Recurring cost (recommended architecture)", "Amount", "Basis"], op_rows,
                          caption="Operating cost is stated separately from capital. It covers energy and, where on-site "
                                  "generation is installed, that generation's declared operating cost; it excludes the "
                                  "non-energy operating cost of the cooling plant."))
    if e.btm is not None and not e.btm.applied:
        s.blocks.append(Callout("warning",
            "Behind-the-meter generation is installed on this path but its operating cost cannot be computed: "
            + "; ".join(e.btm.missing) + ". The annual energy cost above therefore prices ALL energy at the grid "
            "price, which the hall would not pay. Supply these inputs to replace that figure."))
    if e.lifecycle_cost_eur is not None:
        s.blocks.append(Statement(
            f"Lifecycle cost over {e.horizon_years} years" + ("" if e.lifecycle_complete else " — LOWER BOUND"),
            e.lifecycle_cost_eur, e.lifecycle_basis))
    else:
        s.blocks.append(Para(
            "No lifecycle horizon was declared, so no lifecycle value is computed: a horizon is the client's "
            "choice and this study does not invent one. Declare economics.horizon_years (and, optionally, a "
            "discount rate) to obtain it."))
    mix = rec.economics.cost_basis_mix or {}
    placeholders = mix.get("library_default", 0)
    priced = sum(v for k, v in mix.items() if k != "library_default")
    total_lines = placeholders + priced
    if total_lines:
        s.blocks.append(Table(
            ["Cost basis", "Lines"],
            [[BASIS_LABEL.get(basis, basis.replace("_", " ")), Lit(f"{n} lines")]
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
        rows = [[label, racks_q(n, f"racks under: {label}", rec),
                 racks_q(n - base, f"delta under: {label}", rec)]
                for label, n in sensitivities]
        rows.sort(key=lambda row: -abs(row[2].value))
        s.blocks.append(Table(["Input varied", "Racks", "Change vs base case"], rows))
        collapse = [label for label, n in sensitivities if n == 0 and base > 0]
        if collapse:
            s.blocks.append(Callout("warning",
                f"The answer is a cliff, not a slope, on: {'; '.join(l.lower() for l in collapse)}. A small "
                "change in that input removes every rack, because it moves a pass/fail gate rather than a "
                "capacity. It is an assumed input; confirming it is worth more than any other measurement "
                "in this study."))
        r.sections.append(s)

    # 10 ------------------------------------------------------------------ risks
    s = Section("11. Risk register")
    risks = []
    seen: dict[tuple[str, str], int] = {}
    for st in rec.ladder.steps:
        if not st.risk:
            continue
        key = (st.binding_name, st.risk)
        if key in seen:
            risks[seen[key]][3] += 1
            continue
        seen[key] = len(risks)
        risks.append([st.binding_name, st.risk,
                      st.lead_time_weeks if st.lead_time_weeks is not None else "—", 1])
    # a constraint relieved on several rungs is one risk, not several
    risks = [[n, d + (f" Applies to {k} rungs of the ladder." if k > 1 else ""), lt] for n, d, lt, k in risks]
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
    if rec.unlocked_racks <= 0:
        s.blocks.append(Para(
            f"Do not proceed to procurement on these inputs. No architecture modelled hosts a "
            f"{plat.name} rack: the site cannot support the requested deployment as described. "
            f"Revisit the inputs that set the limit (listed in sections 1 and 4), or the target platform."))
    else:
        s.blocks.append(Para(
            f"Proceed with {rec.spec.name}. {rec.spec.rationale} On the modelled inputs this unlocks "
            f"{rec.unlocked_racks} racks of {plat.name} against {rec.envelope.max_racks} as found."))
    s.blocks.append(Bullets([long for _short, long in DECISION_GATES]))
    r.sections.append(s)

    # 12 --------------------------------------------------------------- scope
    s = Section("13. Scope, basis and limitations")
    s.blocks.append(Para(
        "This study is an engineering opinion supported by a documented model. It is not a design "
        "package and confers no design liability. The following are outside scope:"))
    s.blocks.append(Bullets(SCOPE_OUT))
    s.blocks.append(Para(
        "Every quantity in this report carries an evidence class; Appendix A lists the assumptions and "
        "sources relied upon and the provenance digest of each headline quantity. No number here is a "
        "measurement of a physical asset unless it is labelled E5 or above — and E5 means supplied by "
        "the client (a declared rating, contract term or design value, or the client's own data as given), "
        "not measured or surveyed by us."))
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

    # 14 ------------------------------------------------- model accuracy record
    # Printed whether or not the record is flattering, and today it is empty. A
    # report that omits its own accuracy record when the record is empty has told
    # the reader the question does not matter.
    r.sections.append(_accuracy_section(results))
    return r


def _accuracy_section(results: list[ScenarioResult]) -> Section:
    from ..calibration import accuracy_block, constraint_key, label as key_label
    bound = sorted({res.envelope.binding.id for res in results})
    keys = [constraint_key(b) for b in bound] + [
        "envelope.racks", "envelope.it_load_kW", "schedule.weeks_to_full",
        "economics.capex_total_eur"]
    block = accuracy_block(keys)

    s = Section("14. Model accuracy against instrumented sites")
    s.blocks.append(Para(
        "Two different things get called accuracy. The ranges shown throughout this report "
        "are input uncertainty propagated through the model — they say how much the answer "
        "moves when an input is uncertain. This section is the other one: how far this "
        "engine's outputs have been reconciled against data from instrumented sites, which "
        "is the only thing that can tell you whether the model itself is right."))
    s.blocks.append(Callout("note" if block["observations"] else "warning", block["statement"]))

    rows = []
    for k in keys:
        c = next((x for x in block["keys"] if x["key"] == k), None)
        # Lit(): these are counts of our own records, not modelled quantities. The
        # provenance guard is right to demand a Quantity for anything computed; a
        # tally of how many sites we have reconciled is neither computed nor ours
        # to attach an evidence class to.
        if c:
            rows.append([key_label(k), c["state"], Lit(str(c["n"])), Lit(str(c["sites"])),
                         Lit(f"{c['bias_pct']:+.0f}%" if c["bias_pct"] is not None else "—"),
                         Lit(c["last_observed_on"] or "—")])
        else:
            rows.append([key_label(k), "uncalibrated", Lit("0"), Lit("0"), Lit("—"), Lit("—")])
    s.blocks.append(Table(
        headers=["Model output", "State", "Observations", "Sites", "Median bias",
                 "Last observation"],
        rows=rows,
        caption=("Bias is the median of observed / predicted, so a positive figure means the "
                 "model has run conservative. An output with no observations is reported as "
                 "uncalibrated rather than omitted.")))
    s.blocks.append(Para(
        "Reconciliation is how a figure in this report moves from estimated to field-validated. "
        "It requires site data we do not have and cannot generate: interval metering at the "
        "relevant point, a BMS trend, or a commissioning record. Where this study recommends "
        "instrumentation, that is what it is for — the client gets a better answer next time, "
        "and the model gets an observation it can be held to."))
    return s


def _pue_of(res: ScenarioResult) -> Quantity:
    from ..thermal.library import PUE_BY_ARCHITECTURE
    from ..thermal.schema import Architecture
    return PUE_BY_ARCHITECTURE[Architecture(res.envelope.architecture)]
