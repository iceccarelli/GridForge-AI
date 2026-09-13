"""Density Screen — the EUR 4,500, five-working-day door-opener (docs/00 §5).

Deliberately short. It answers one question and ends with the data request that
turns it into a full study. It is not a teaser: it must be worth the fee on its
own, which means the binding constraint has to be real and the data-gap list has
to be the one a competent engineer would write.
"""
from __future__ import annotations

from ..common import ASSUMED, ESTIMATED, V
from ..envelope.time_to_power import schedule
from ..intake.loader import Intake
from ..scenario.run import ScenarioResult
from .gates import DISCLOSURE_MARKER, claims_below_floor
from .model import Bullets, Callout, Lit, Para, Report, Section, Statement, Table
from .study import Objective, _pick_recommended, collect_claims

WATERMARK = ("SCREENING OPINION — modelled from the inputs supplied. Not a design package, "
             "and not a measurement of this asset.")


def build(intake: Intake, results: list[ScenarioResult],
          *, objective: Objective = Objective.MAX_COMPUTE) -> Report:
    rec = _pick_recommended(results, objective)
    ctx = intake.context
    plat = ctx.cluster.platform
    t = schedule(rec.ladder)
    r = Report(
        title=f"Density Screen — {ctx.site.name}, hall {ctx.hall.id}",
        subtitle=(f"{intake.client} · ref {intake.reference} · target platform {plat.name} · "
                  f"{len(results)} architectures screened"),
        watermark=WATERMARK,
        status="Density Screen",
        meta=[("Client", intake.client), ("Reference", intake.reference),
              ("Site", ctx.site.name), ("Hall", ctx.hall.id),
              ("Target platform", plat.name),
              ("Intake completeness", f"{intake.report.completeness:.0%}")],
        footer=("Screening opinion supported by a documented model. The fee for this screen "
                "credits in full against a Capacity & Density Envelope Study."),
    )

    s = Section("1. The answer")
    s.blocks.append(Statement(
        f"Deployable {plat.name} racks as the hall stands",
        V(float(rec.envelope.max_racks), "racks", "deployable racks as found", ESTIMATED),
        rec.envelope.binding.basis))
    s.blocks.append(Statement(
        "Deployable after the costed ladder",
        V(float(rec.unlocked_racks), "racks", "deployable racks after relief", ESTIMATED),
        rec.spec.name))
    if t.weeks_to_full is not None:
        s.blocks.append(Statement(
            "Time to full capacity",
            V(t.weeks_to_full, "weeks", "elapsed weeks to full energisation", ESTIMATED,
              band=(t.weeks_to_full * 0.7, t.weeks_to_full * 1.6)),
            f"set by {t.critical_item.lower()}"))
    s.blocks.append(Statement("Indicative capex", rec.economics.capex_total_eur,
                              rec.economics.aace_class))
    s.blocks.append(Callout("answer",
        f"Binding constraint: {rec.envelope.binding.name} ({rec.envelope.binding.domain}). "
        f"{rec.envelope.binding.basis}."))
    r.sections.append(s)

    s = Section("2. What stops this hall, in order")
    rows = []
    for st in rec.ladder.steps[:6]:
        rows.append([Lit(str(st.step)), st.binding_name, st.domain,
                     V(float(st.racks_after), "racks", f"racks after step {st.step}", ESTIMATED),
                     (st.relief_description or "no relief available") +
                     ("" if st.taken else "  — NOT TAKEN"),
                     st.capex_eur if st.capex_eur is not None else "—",
                     st.lead_time_weeks if st.lead_time_weeks is not None else "—"])
    s.blocks.append(Table(["#", "Constraint", "Domain", "Racks after", "Relief", "Capex",
                           "Lead time"], rows,
                          caption="First six rungs of the headroom ladder. The full study carries "
                                  "the complete ladder, the scenario comparison and the "
                                  "sensitivity analysis."))
    r.sections.append(s)

    s = Section("3. Architectures screened")
    rows = [[res.spec.name,
             V(float(res.envelope.max_racks), "racks", f"{res.spec.id}: as found", ESTIMATED),
             V(float(res.unlocked_racks), "racks", f"{res.spec.id}: after ladder", ESTIMATED),
             res.envelope.binding.name] for res in results]
    s.blocks.append(Table(["Architecture", "As found", "After ladder", "Binds first"], rows))
    r.sections.append(s)

    s = Section("4. What we had to assume — and what it would take to stop assuming")
    if intake.report.gaps:
        s.blocks.append(Para(
            f"Intake completeness is {intake.report.completeness:.0%}. Each row below is a number "
            "that moves the answer and that nobody has measured. This list is the deliverable as "
            "much as the number above it."))
        rows = [[g.label, Lit("required" if g.required else "optional"), g.fallback_description,
                 g.why_it_binds, g.how_to_get_it] for g in intake.report.gaps]
        s.blocks.append(Table(["Input", "Status", "Assumed", "Why it binds", "How to get it"], rows))
    else:
        s.blocks.append(Para("Intake complete. Every input below the headline was supplied by the "
                             "client rather than assumed."))
    for w in intake.report.warnings:
        s.blocks.append(Callout("warning", w))
    below = claims_below_floor(collect_claims(results))
    detail = "; ".join(
        f"{k.replace('_', ' ')} is {w.name.split('_', 1)[0]} where an issued deliverable requires "
        f"{f.name.split('_', 1)[0]}" for k, (w, f) in below.items())
    s.blocks.append(Callout("warning",
        f"{DISCLOSURE_MARKER} this is a screening opinion built partly on library defaults. "
        + (detail + ". " if detail else "") +
        "It is sufficient to decide whether to spend money finding out, and not sufficient to "
        "support procurement, construction or an investment committee decision."))
    r.sections.append(s)

    s = Section("5. Recommended next step")
    s.blocks.append(Para(intake.report.engagement_recommendation))
    s.blocks.append(Bullets([
        "Capacity & Density Envelope Study — full ladder, all architectures, scenario and "
        "sensitivity analysis, economics, risk register, machine-readable model pack. 3-5 weeks.",
        "This screen's fee credits in full against it.",
        "Before anything else: get the DSO position in writing on firm capacity and any "
        "flexibility product. It costs nothing but time and it can end the question.",
    ]))
    r.sections.append(s)
    return r
