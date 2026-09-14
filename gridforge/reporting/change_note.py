"""The change note — what a Hall Watch delivers.

Not another study. Four pages that answer the only question a client has six months
after the study: what moved, which input moved it, and does it change the decision.

It is short on purpose. A subscription that sends a fifty-page document every quarter
gets unsubscribed; one that sends three paragraphs naming the input that moved the
answer gets read, and gets renewed.
"""
from __future__ import annotations

from datetime import date

from ..common import ASSUMED, ESTIMATED, V
from ..change import EnvelopeDiff
from .gates import DISCLOSURE_MARKER
from .model import Bullets, Callout, Lit, Para, Report, Section, Statement, Table

_LABELS = {
    "grid.contracted_MW": "Contracted capacity",
    "grid.firm_capacity_MVA": "Firm connection capacity",
    "grid.current_site_peak_MW": "Current site peak",
    "grid.current_it_load_MW": "Current IT load",
    "lv.busway_ampacity_A": "Busway ampacity",
    "lv.tapoff_max_A": "Tap-off rating",
    "hall.positions_available": "Rack positions available",
    "hall.floor_loading_kPa": "Floor loading",
    "thermal.plant.chilled_water_capacity_kW": "Chilled-water plant capacity",
    "thermal.plant.design_supply_C": "Plant supply temperature",
    "thermal.residual_air_capacity_kW_per_rack": "Air removal per rack position",
    "compute.platform": "Target platform",
}


def label_for(path: str) -> str:
    if path in _LABELS:
        return _LABELS[path]
    tail = path.split(".")[-1]
    return tail.replace("_", " ").replace("[", " ").replace("]", "").strip().capitalize()


def build(d: EnvelopeDiff, *, site: str, hall: str, client: str,
          period: str = "") -> Report:
    today = date.today().isoformat()
    r = Report(
        title=f"Change note — {site}, hall {hall}",
        subtitle=(f"{client} · {period or today} · compared on {d.before.scenario_name}"),
        watermark=("Modelled from the inputs on record. A change note re-solves the same model "
                   "against new inputs; it is not a new survey of the asset."),
        status="Change note",
        meta=[("Client", client), ("Site", site), ("Hall", hall),
              ("Compared on", d.before.scenario_name), ("Issued", today),
              ("Inputs changed", str(len(d.changed_paths)))],
        footer=("Hall Watch — the model stays live so the answer can be re-run when the hall "
                "moves. We quote no equipment and take no margin on hardware."),
    )

    s = Section("1. What moved")
    s.blocks.append(Para(d.headline()))
    if not d.material:
        s.blocks.append(Callout("answer",
            "No action. The envelope, the binding constraint and the date are unchanged on the "
            "inputs we hold. We would rather tell you that in three lines than manufacture a "
            "finding."))
    else:
        s.blocks.append(Statement(
            "Deployable racks after the ladder",
            V(float(d.after.racks_after_ladder), "racks", "deployable racks, current inputs",
              ESTIMATED),
            f"was {d.before.racks_after_ladder}"))
        if d.after.weeks_to_full is not None:
            s.blocks.append(Statement(
                "Time to full capacity",
                V(d.after.weeks_to_full, "weeks", "weeks to full capacity, current inputs",
                  ESTIMATED),
                (f"was {d.before.weeks_to_full:.0f}" if d.before.weeks_to_full is not None
                 else "no prior figure") + f" · set by {d.after.sets_the_date.lower()}"))
        s.blocks.append(Statement(
            "Indicative capex",
            V(d.after.capex_eur, "EUR", "indicative capex, current inputs", ASSUMED,
              band=(d.after.capex_eur * 0.5, d.after.capex_eur * 2.0)),
            f"was EUR {d.before.capex_eur:,.0f}"))
        if d.binding_moved:
            s.blocks.append(Callout("warning",
                f"What binds first has changed: {d.before.binding_name} gave way to "
                f"{d.after.binding_name}. {d.after.binding_basis}. A plan built around the "
                "previous constraint is now aimed at the wrong thing."))
        if d.recommendation_changed:
            s.blocks.append(Callout("warning",
                f"The recommended architecture changed from {d.recommendation_changed[0]} to "
                f"{d.recommendation_changed[1]}."))
    r.sections.append(s)

    s = Section("2. What moved it")
    if not d.changed_paths:
        if d.material:
            s.blocks.append(Para(
                "Nothing you supplied has changed. The answer moved on our side: the constraint "
                "set, a library default or a recorded price has been revised since the last run. "
                "That is the point of keeping the model live rather than re-reading an old "
                "document — you hear it from us instead of discovering it."))
            s.blocks.append(Callout("note",
                "Ask us which revision moved it. Every figure in the underlying model carries its "
                "provenance, so the answer is specific rather than 'the model improved'."))
        else:
            s.blocks.append(Para("No input on record has changed since the last run, and the "
                                 "answer is unchanged."))
    else:
        s.blocks.append(Para(
            "Each input was moved on its own, from its old value to its new one, and the hall "
            "re-solved. The change in the answer is that input's contribution."))
        rows = []
        for dr in d.drivers:
            rows.append([
                label_for(dr.path),
                Lit(str(dr.before)), Lit(str(dr.after)),
                V(float(dr.racks_delta), "racks", f"contribution of {dr.path}", ESTIMATED),
                Lit(dr.flips_binding_to or "—"),
            ])
        if rows:
            s.blocks.append(Table(
                ["Input", "Was", "Now", "On its own", "Changes what binds to"], rows,
                caption="Ranked by how far each input moves the answer by itself."))
        if d.residual:
            s.blocks.append(Callout("note",
                f"The single-input contributions account for {d.explained:+d} racks against a "
                f"total of {d.racks_delta:+d}, leaving {d.residual:+d} unexplained. That residual "
                "is the constraints interacting — two inputs that each do little can matter "
                "together, and one that helps alone can be masked by another. It is reported "
                "rather than distributed, because distributing it would be arithmetic dressed up "
                "as insight."))
        if d.unprobed:
            s.blocks.append(Callout("note",
                f"{len(d.unprobed)} further inputs changed but were not probed individually. At "
                "this many changes the hall is materially different and deserves a fresh study "
                "rather than a change note."))
    r.sections.append(s)

    s = Section("3. What to do about it")
    actions: list[str] = []
    if not d.material:
        actions.append("Nothing. Revisit at the next scheduled run, or sooner if the connection "
                       "agreement, the tenancy or the target platform changes.")
    else:
        if d.binding_moved:
            actions.append(f"Re-aim the programme at {d.after.binding_name.lower()}. Whatever was "
                           f"queued against {d.before.binding_name.lower()} no longer sets the "
                           "answer.")
        if d.racks_delta < 0:
            actions.append("Capacity fell. Before accepting it, confirm the inputs that drove it "
                           "are real and current — a contractual figure that moved on paper is "
                           "worth checking against the meter.")
        if d.racks_delta > 0:
            actions.append("Capacity rose. Check whether the commercial commitments made against "
                           "the old number can now be enlarged.")
        if (d.weeks_delta or 0) > 0:
            actions.append(f"The date slipped by {d.weeks_delta:.0f} weeks. Lead time, not "
                           "construction, usually governs — look at the item that sets it before "
                           "anything else.")
        actions.append("If more than a handful of inputs have moved, commission a fresh study "
                       "rather than stacking change notes on an ageing model.")
    s.blocks.append(Bullets(actions))
    r.sections.append(s)

    s = Section("4. Basis")
    s.blocks.append(Bullets([
        "The same constraint set, the same libraries and the same scenario as the study this "
        "note updates, so a change in the answer is a change in the hall.",
        "Inputs you did not update are carried forward unchanged, including the ones that were "
        "assumed. An assumption that has gone stale is not a measurement.",
        "This note re-solves a model. It is not a survey, and it does not observe the asset.",
    ]))
    s.blocks.append(Callout("warning",
        f"{DISCLOSURE_MARKER} this note is built on the inputs on record, which include library "
        "defaults where nobody has supplied a measurement. Electrical capacity and cooling "
        "performance figures here are modelled, not measured. They are sufficient to steer a "
        "programme and not sufficient to support procurement on their own."))
    r.sections.append(s)
    return r
