"""Proposal generator.

A proposal that opens with a real engineering finding about the client's own hall
outsells one that opens with a company profile. This one does: before it names a
price it tells them what binds, how many racks they can deploy today, and which of
their inputs nobody has measured — because the engine has already run.

That is the part no competitor can copy cheaply. A consultancy's proposal cannot
contain a finding, because producing the finding is the engagement.
"""
from __future__ import annotations

from datetime import date, timedelta

from ..commercial import Engagement
from ..common import ASSUMED, ESTIMATED, V
from ..constraints import EnvelopeContext
from ..envelope.time_to_power import schedule
from ..intake.loader import Intake
from ..scenario.run import ScenarioResult
from .gates import DISCLOSURE_MARKER, claims_below_floor
from .model import Bullets, Callout, Lit, Para, Report, Section, Statement, Table
from .study import Objective, _pick_recommended, collect_claims


def build(intake: Intake, results: list[ScenarioResult], eng: Engagement, *,
          objective: Objective = Objective.MAX_COMPUTE,
          valid_days: int = 30, contact: str = "") -> Report:
    ctx: EnvelopeContext = intake.context
    rec = _pick_recommended(results, objective)
    t = schedule(rec.ladder)
    plat = ctx.cluster.platform
    today = date.today()
    valid_to = today + timedelta(days=valid_days)

    r = Report(
        title=f"Proposal — {eng.name}, {ctx.site.name} hall {ctx.hall.id}",
        subtitle=(f"{intake.client} · prepared {today.isoformat()} · valid to "
                  f"{valid_to.isoformat()} · target platform {plat.name}"),
        watermark=("The findings below are a screening read produced before this engagement "
                   "begins. They are modelled from the inputs supplied, not measured at the site."),
        status="Proposal",
        meta=[("Client", intake.client), ("Site", ctx.site.name), ("Hall", ctx.hall.id),
              ("Engagement", eng.name), ("Fee", f"EUR {eng.price_eur:,}"),
              ("Turnaround", f"{eng.turnaround_days} working days")],
        footer=("GridForge AI — independent power and thermal engineering. We quote no equipment "
                "and take no margin on hardware."),
    )

    # 1 — the finding, before the price
    s = Section("1. What we already found")
    s.blocks.append(Para(
        "We ran your hall through the capacity engine before writing this. The following is not a "
        "claim about what we might do; it is what the constraint set already says, on the inputs "
        "you supplied."))
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
    s.blocks.append(Callout("answer",
        f"Binding constraint: {rec.envelope.binding.name} ({rec.envelope.binding.domain}). "
        f"{rec.envelope.binding.basis}."))
    if rec.envelope.max_racks == 0:
        s.blocks.append(Callout("warning",
            "On these inputs the hall cannot host a single rack of the target platform today. "
            "That is a finding, not a sales problem — and a credible 'not without these three "
            "things' is worth the fee on its own."))
    r.sections.append(s)

    # 2 — the question the engagement answers
    s = Section("2. What this engagement answers")
    s.blocks.append(Para(eng.question))
    s.blocks.append(Para(f"You receive: {eng.deliverable}"))
    s.blocks.append(Bullets(list(eng.scope_in)))
    r.sections.append(s)

    # 3 — what we need
    s = Section("3. What we need from you")
    if intake.report.gaps:
        s.blocks.append(Para(
            f"Intake is {intake.report.completeness:.0%} complete. Each row below is a number that "
            "moves the answer and that nobody has measured. Anything you cannot supply is filled "
            "from a library default and named as an assumption in the deliverable — nothing is "
            "invented silently."))
        s.blocks.append(Table(
            ["Input", "Status", "Assumed if not supplied", "Where it comes from"],
            [[g.label, Lit("required" if g.required else "optional"),
              Lit(g.fallback_description), Lit(g.how_to_get_it)] for g in intake.report.gaps]))
    else:
        s.blocks.append(Para(
            "Intake is complete. Nothing further is required to begin; the clock starts on "
            "commissioning."))
    for w in intake.report.warnings:
        s.blocks.append(Callout("note", w))
    r.sections.append(s)

    # 4 — commercials
    s = Section("4. Fee, timing and terms")
    s.blocks.append(Table(
        ["Item", "Terms"],
        [["Fee", Lit(f"EUR {eng.price_eur:,}, fixed")],
         ["Turnaround", Lit(f"{eng.turnaround_days} working days from a complete intake")],
         ["Payment", Lit(eng.payment_terms)],
         ["Credit", Lit(
             f"Credits in full against the {eng.credits_against.replace('_', ' ')}."
             if eng.credits_against else "—")],
         ["Validity", Lit(f"This proposal is valid to {valid_to.isoformat()}.")],
         ["Independence", Lit("We quote no equipment and take no margin on hardware. Nothing in "
                              "the deliverable routes you to a supplier we are paid by.")]],
        caption="Fixed fee. We do not bill hours, because you are buying an answer."))
    s.blocks.append(Statement(
        "Fee", V(float(eng.price_eur), "EUR", f"{eng.name} fixed fee", ESTIMATED),
        f"{eng.turnaround_days} working days from a complete intake"))
    r.sections.append(s)

    # 5 — scope boundary
    s = Section("5. What is outside scope")
    s.blocks.append(Para(
        "This is an engineering opinion supported by a documented model. It is not a design "
        "package and confers no design liability. Specifically outside scope:"))
    s.blocks.append(Bullets(list(eng.scope_out)))
    r.sections.append(s)

    # 6 — method
    s = Section("6. How the answer is produced")
    s.blocks.append(Bullets([
        "Thirteen independent constraints across electrical, thermal and physical domains are "
        "evaluated over one model of your hall. The envelope is the minimum; the binding "
        "constraint is the one that produced it.",
        "Each constraint reports what relieves it, what that costs and how long it takes, so the "
        "answer is an ordered ladder rather than a single number.",
        "Every quantity carries an evidence class. A number you supply is your measured data; a "
        "number we fall back to is an assumption and is labelled as one. A model applied to "
        "measured data stays a model.",
        "The document cannot assert measurement over a modelled quantity — that check runs "
        "automatically before anything is released.",
        "You receive the model, not just the conclusion, so you can re-run it when your inputs "
        "change.",
    ]))
    r.sections.append(s)

    # 7 — next step
    s = Section("7. To proceed")
    s.blocks.append(Para(
        "Commission the engagement and you will receive an intake link for the hall's numbers. "
        "The clock starts when the intake is complete, not when payment clears."))
    if contact:
        s.blocks.append(Para(contact))
    s.blocks.append(Callout("note",
        "Before you spend anything with us: get the DSO position in writing on firm capacity and "
        "any flexibility product. It costs nothing but time, and on some sites it ends the "
        "question entirely. We would rather tell you that now than bill you to discover it."))
    below = claims_below_floor(collect_claims(results))
    if below:
        detail = "; ".join(
            f"{k.replace('_', ' ')} is {w.name.split('_', 1)[0]} where an issued deliverable "
            f"requires {f.name.split('_', 1)[0]}" for k, (w, f) in below.items())
        s.blocks.append(Callout("warning",
            f"{DISCLOSURE_MARKER} the findings in section 1 are a screening read built partly on "
            f"library defaults. {detail}. They are sufficient to decide whether this engagement is "
            "worth commissioning, and not sufficient to support procurement, construction or an "
            "investment committee decision. Closing the gaps in section 3 is what changes that."))
    r.sections.append(s)
    return r
