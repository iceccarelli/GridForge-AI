"""The one-page board summary (docs/01 §4D): what a sponsor forwards to a board without editing.

It is built from the SAME solved model, labels and gates as the long study -- never from the study's prose -- so it
cannot say anything the study does not, and it is held to the same rules: every number is a Quantity with an
evidence class no higher than its weakest input (reporting/labels.py), the evidence disclosure is mandatory when a
claim is below its floor, and language that implies measurement or certainty is refused by the report gates.

It deliberately says what it is not. A board that is shown one page must be told, on that page, how firm the
numbers are and which single input they depend on most."""
from __future__ import annotations

from ..common import V
from ..envelope.time_to_power import schedule
from ..intake.loader import Intake
from ..scenario.objective import Objective, pick_recommended
from ..scenario.run import ScenarioResult
from .gates import DISCLOSURE_MARKER, claims_below_floor
from .labels import dominant_sensitivity, economics_limitations, full_capacity_q, is_zero_gain, racks_q
from .model import Bullets, Callout, Lit, Para, Report, Section, Statement, Table
from .study import DECISION_GATES, collect_claims, watermark_for


def build(intake: Intake, results: list[ScenarioResult],
          sensitivities: list[tuple[str, int]] | None = None,
          *, objective: Objective = Objective.MAX_COMPUTE) -> Report:
    ctx = intake.context
    plat = ctx.cluster.platform
    rec = pick_recommended(results, objective)
    ttp = schedule(rec.ladder)
    final = rec.ladder.final
    r = Report(
        title=f"Board summary — {ctx.site.name}, hall {ctx.hall.id}",
        subtitle=f"{intake.client} · {plat.name} · summary of the Capacity & Density Envelope Study",
        watermark=watermark_for(intake),
        footer=("One page for a board. The study it summarises carries the full ladder, scenarios, sensitivity "
                "and provenance. Engineering opinion supported by a documented model; not a design package."),
        status="Board summary",
        meta=[("Site", ctx.site.name), ("Hall", ctx.hall.id), ("Target platform", plat.name),
              ("Recommended architecture", rec.spec.name if rec.unlocked_racks > 0 else "none — no architecture is deployable on these inputs")],
    )

    s = Section("The answer")
    s.blocks.append(Statement(f"Deployable {plat.name} racks today", racks_q(rec.envelope.max_racks,
                              "deployable racks as found", rec), rec.envelope.binding.name.lower()))
    s.blocks.append(Statement(f"Deployable racks after the costed works", racks_q(rec.unlocked_racks,
                              "deployable racks after relief", rec), rec.spec.name))
    if final is not None:
        s.blocks.append(Statement("IT load at that point", final.it_load_kW, "at the recommended architecture"))
    fq = full_capacity_q(rec.ladder, ttp, "elapsed weeks to full capacity")
    if fq is not None:
        s.blocks.append(Statement("Time to full capacity", fq,
                                  f"set by {ttp.critical_item.lower()}; works run in parallel"))
    s.blocks.append(Statement("Indicative capital cost", rec.economics.capex_total_eur,
                              rec.economics.aace_class + ("" if rec.economics.capex_complete else
                                                          " · LOWER BOUND: a cost it needs has no price")))
    if rec.envelope.max_racks == 0:
        s.blocks.append(Callout("warning",
            "As the hall stands it cannot host a single rack of the target platform. Stopping here is a "
            "legitimate outcome of this study."))
    r.sections.append(s)

    # what decides it: the rung that binds first, the dearest, and the slowest -- each once
    s = Section("What decides it")
    steps = [st for st in rec.ladder.taken_steps if not is_zero_gain(st) and st.capex_eur is not None]
    picks: list = []
    for st in (steps[:1] + [max(steps, key=lambda x: x.capex_eur.value)] if steps else []) + \
              ([max(steps, key=lambda x: x.lead_time_weeks.value)] if steps else []):
        if st.relief_description not in {p.relief_description for p in picks}:
            picks.append(st)
    rows = []
    for st in picks:
        tags = []
        if st is picks[0]:
            tags.append("binds first")
        if st.capex_eur.value == max(x.capex_eur.value for x in steps):
            tags.append("largest cost")
        if st.lead_time_weeks is not None and st.lead_time_weeks.value == max(
                x.lead_time_weeks.value for x in steps if x.lead_time_weeks is not None):
            tags.append("sets the date")
        rows.append([Lit(", ".join(tags) or "—"), st.binding_name, (st.relief_description or "")[:80], st.capex_eur,
                     st.lead_time_weeks if st.lead_time_weeks is not None else "—"])
    if rows:
        s.blocks.append(Table(["Why it matters", "Constraint", "Relief", "Cost", "Lead time"], rows,
                              caption=f"Of {len(rec.ladder.taken_steps)} steps on the full ladder; the study lists all of them."))
    r.sections.append(s)

    # how firm it is -- the part a board most needs and a summary most often drops
    s = Section("How firm this is")
    items: list[str] = []
    mix = rec.economics.cost_basis_mix or {}
    placeholders, total = mix.get("library_default", 0), sum(mix.values())
    if placeholders:
        items.append(f"{placeholders} of {total} priced lines are library defaults rather than quotations; "
                     "the cost is an order-of-magnitude figure, not a budget.")
    if not rec.economics.decision_grade:
        n = len(rec.economics.unpriced_summary())
        items.append("The economics are not decision-grade"
                     + (f"; {n} cost component{'s have' if n != 1 else ' has'} no price" if n else "")
                     + "; the study lists every gap.")
    dom = dominant_sensitivity(sensitivities, rec.unlocked_racks)
    if dom is not None and dom[1] != rec.unlocked_racks:
        items.append(f"The answer depends most on one assumed input: {dom[0].lower()} takes it from "
                     f"{rec.unlocked_racks} to {dom[1]} racks."
                     + (" That input should be confirmed before anything else." if dom[1] == 0 else ""))
    from ..calibration import accuracy_block
    acc = accuracy_block(["envelope.racks"])
    items.append(
        "This model has not yet been checked against any instrumented site (0 reconciled observations); "
        "every figure here is modelled, not measured."
        if not acc["observations"] else acc["statement"])
    s.blocks.append(Bullets(items))
    below = claims_below_floor(collect_claims(results))
    if below:
        detail = "; ".join(f"{k.replace('_', ' ')} is {w.name.split('_', 1)[0]} where an issued deliverable "
                           f"requires {f.name.split('_', 1)[0]}" for k, (w, f) in below.items())
        s.blocks.append(Callout("warning",
            f"{DISCLOSURE_MARKER} screening study on library defaults and assumed inputs: {detail}. "
            "Sufficient to decide whether to spend money finding out; not sufficient for procurement, "
            "construction or an investment committee decision."))
    r.sections.append(s)

    s = Section("What to decide next")
    s.blocks.append(Bullets([short for short, _long in DECISION_GATES]))
    r.sections.append(s)
    return r
