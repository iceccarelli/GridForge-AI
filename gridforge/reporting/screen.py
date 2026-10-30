"""Density Screen — the EUR 4,500, five-working-day door-opener (docs/00 §5).

Deliberately short. It answers one question and ends with the data request that
turns it into a full study. It is not a teaser: it must be worth the fee on its
own, which means the binding constraint has to be real and the data-gap list has
to be the one a competent engineer would write.
"""
from __future__ import annotations

from ..commercial import ENGAGEMENTS
from ..common import ASSUMED, ESTIMATED, V
from ..envelope.time_to_power import schedule
from ..intake.loader import Intake
from ..power.plausibility import intake_warnings
from ..scenario.run import ScenarioResult
from .gates import DISCLOSURE_MARKER, claim_label, claims_below_floor
from .model import Bullets, Callout, Lit, Para, Report, Section, Statement, Table
from .study import Objective, _pick_recommended, collect_claims
from .grid_queue_section import section as grid_queue_section
from .retail_price_section import section as retail_price_section
from .labels import (date_basis, date_basis_text, economics_limitations, full_capacity_q,
                     racks_q, relief_text)

WATERMARK = ("SCREENING OPINION — modelled from the inputs supplied. Not a design package, "
             "and not a measurement of this asset.")


def build(intake: Intake, results: list[ScenarioResult],
          *, objective: Objective = Objective.MAX_COMPUTE, grid_queue: dict | None = None,
          retail_price: dict | None = None) -> Report:
    """`retail_price` is a gridforge.context.energy_price.context(...) result; when given, the published average electricity price is set
    beside the price the document used (context only), after the grid-wait section when both are given.
    `grid_queue` is a gridforge.context.grid_queue.context(...) result; when given, the measured queue history is set beside the grid
    wait this document does not date (section 5, context only). Without it the document is exactly what it was."""
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
        racks_q(rec.envelope.max_racks, "deployable racks as found", rec),
        rec.envelope.binding.basis))
    s.blocks.append(Statement(
        "Deployable after the costed ladder",
        racks_q(rec.unlocked_racks, "deployable racks after relief", rec),
        rec.spec.name))
    full_q = full_capacity_q(rec.ladder, t, "elapsed weeks to full energisation")
    if full_q is not None:
        db = date_basis(rec.ladder, t)
        s.blocks.append(Statement("Time to full capacity", full_q, date_basis_text(
            db, f"set by {t.critical_item.lower()}; the range is that item's own lead-time range")))
    if rec.economics.nothing_deployable:
        s.blocks.append(Para("Indicative capex: n/a: nothing deployable (there is no capex to state, not a zero one)."))
    else:
        s.blocks.append(Statement("Indicative capex", rec.economics.capex_total_eur,
                                  rec.economics.aace_class + ("" if rec.economics.capex_complete else
                                                              " · LOWER BOUND: a cost it needs has no price")))
    lims = economics_limitations(rec.economics)
    if lims:
        s.blocks.append(Callout("warning", "These economics are not decision-grade. "
                                + " ".join(x[0].upper() + x[1:] + "." for x in lims)))
    s.blocks.append(Callout("answer",
        f"Binding constraint: {rec.envelope.binding.name} ({rec.envelope.binding.domain}). "
        f"{rec.envelope.binding.basis}."))
    r.sections.append(s)

    s = Section("2. What stops this hall, in order")
    rows = []
    for st in rec.ladder.steps[:6]:
        rows.append([Lit(str(st.step)), st.binding_name, st.domain,
                     racks_q(st.racks_after, f"racks after step {st.step}", rec),
                     relief_text(st),
                     st.capex_eur if (st.capex_eur is not None and st.taken) else "—",
                     st.lead_time_weeks if st.lead_time_weeks is not None else "—"])
    s.blocks.append(Table(["#", "Constraint", "Domain", "Racks after", "Relief", "Capex",
                           "Lead time"], rows,
                          caption="First six rungs of the headroom ladder. The full study carries "
                                  "the complete ladder, the scenario comparison and the "
                                  "sensitivity analysis."))
    r.sections.append(s)

    s = Section("3. Architectures screened")
    rows = [[res.spec.name,
             racks_q(res.envelope.max_racks, f"{res.spec.id}: as found", res),
             racks_q(res.unlocked_racks, f"{res.spec.id}: after ladder", res),
             res.envelope.binding.name] for res in results]
    s.blocks.append(Table(["Architecture", "As found", "After ladder", "Binds first"], rows))
    r.sections.append(s)

    s = Section("4. What we had to assume — and what it would take to stop assuming")
    if intake.report.gaps:
        s.blocks.append(Para(
            f"Intake completeness is {intake.report.completeness:.0%}. Each row below is a number "
            "that moves the answer and that nobody has measured. This list is the deliverable as "
            "much as the number above it."))
        rows = [[g.label, Lit("required" if g.required else "optional"),
                 Lit(g.fallback_description), Lit(g.why_it_binds), Lit(g.how_to_get_it)]
                for g in intake.report.gaps]
        s.blocks.append(Table(["Input", "Status", "Assumed", "Why it binds", "How to get it"], rows))
    else:
        # "Every input supplied" was printed here even though cost, lead time and tariff are library
        # defaults -- directly above a disclosure saying so. The site inputs are the client's; the prices
        # are not, and the count comes from the cost basis, not from a sentence.
        mix = rec.economics.cost_basis_mix or {}
        placeholders, total_lines = mix.get("library_default", 0), sum(mix.values())
        s.blocks.append(Para(
            "Intake is complete: every site input requested was supplied by the client rather than assumed."
            + (f" That does not extend to price and schedule: {placeholders} of {total_lines} priced "
               "lines are library defaults rather than quotations, which is why the accuracy class "
               "below reads as it does." if placeholders else
               " Every priced line rests on a quotation.")))
    for w in intake_warnings(intake):
        s.blocks.append(Callout("warning", w))
    below = claims_below_floor(collect_claims(results))
    detail = "; ".join(
        f"{claim_label(k)} is {w.name.split('_', 1)[0]} where an issued deliverable requires "
        f"{f.name.split('_', 1)[0]}" for k, (w, f) in below.items())
    s.blocks.append(Callout("warning",
        f"{DISCLOSURE_MARKER} this is a screening opinion built partly on library defaults. "
        + (detail + ". " if detail else "") +
        "It is sufficient to decide whether to spend money finding out, and not sufficient to "
        "support procurement, construction or an investment committee decision."))
    r.sections.append(s)

    n = 5
    if grid_queue is not None:
        r.sections.append(grid_queue_section(grid_queue, f"{n}. Grid wait: what has been observed elsewhere (context only)"))
        n += 1
    if retail_price is not None:
        r.sections.append(retail_price_section(retail_price, f"{n}. Electricity price: what has been published (context only)"))
        n += 1

    s = Section(f"{n}. Recommended next step")
    s.blocks.append(Para(intake.report.engagement_recommendation))
    s.blocks.append(Bullets([
        f"{ENGAGEMENTS['envelope_study'].name} — full ladder, all architectures, scenario and "
        "sensitivity analysis, economics, risk register, machine-readable model pack. "
        f"{ENGAGEMENTS['envelope_study'].turnaround_days} working days from a complete intake.",
        "This screen's fee credits in full against it.",
        "Before anything else: get the DSO position in writing on firm capacity and any "
        "flexibility product. It costs nothing but time and it can end the question.",
    ]))
    r.sections.append(s)
    return r
