"""The change note — what a Hall Watch delivers.

Not another study. Four pages that answer the only question a client has six months
after the study: what moved, which input moved it, and does it change the decision.

It is short on purpose. A subscription that sends a fifty-page document every quarter
gets unsubscribed; one that sends three paragraphs naming the input that moved the
answer gets read, and gets renewed.
"""
from __future__ import annotations

from ..clock import report_date_iso

from ..common import V
from ..change import EnvelopeDiff, EnvelopeState
from ..validation import EvidenceClass
from ..envelope.time_to_power import date_basis_of
from .gates import DISCLOSURE_MARKER
from .labels import date_basis_text, date_title
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


def _assumed_weeks(d: EnvelopeDiff) -> bool:
    c = _cls(d.after.weeks_class)
    return c is None or c <= EvidenceClass.E0_ASSUMPTION


def _cls(name: str) -> EvidenceClass | None:
    return EvidenceClass[name] if name in EvidenceClass.__members__ else None


def _known(*names: str) -> EvidenceClass:
    """The first recorded class, else E0 (never a claim). Explicit ``is None``: EvidenceClass is an IntEnum and
    E0 is falsy, so ``a or b`` would skip a recorded E0 and fall through to a stronger class."""
    for n in names:
        c = _cls(n)
        if c is not None:
            return c
    return EvidenceClass.E0_ASSUMPTION


def _band_text(lo: float | None, hi: float | None, value: float, fmt: str) -> str:
    return f" [{lo:{fmt}}–{hi:{fmt}}]" if lo is not None and hi is not None and hi > lo else ""


def _was_racks(st: EnvelopeState) -> str:
    c = _cls(st.racks_class)
    return f"was {st.racks_after_ladder}" + (f" ({c.short})" if c is not None else " (evidence class not recorded)")


def _was_weeks(st: EnvelopeState) -> str:
    if st.weeks_to_full is None:
        return "no prior date"
    return (f"was {st.weeks_to_full:.0f}{_band_text(st.weeks_lo, st.weeks_hi, st.weeks_to_full, '.0f')}"
            + ("" if st.weeks_lo is not None else " (band not recorded)"))


def _was_capex(st: EnvelopeState) -> str:
    return (f"was EUR {st.capex_eur:,.0f}{_band_text(st.capex_lo, st.capex_hi, st.capex_eur, ',.0f')}"
            + ("" if st.capex_lo is not None else " (band not recorded)"))


def _overlap(st_a: EnvelopeState, st_b: EnvelopeState) -> bool:
    """Do the two capex estimates' recorded bands overlap? False when either band was not recorded."""
    if None in (st_a.capex_lo, st_a.capex_hi, st_b.capex_lo, st_b.capex_hi):
        return False
    return st_a.capex_lo <= st_b.capex_hi and st_b.capex_lo <= st_a.capex_hi


_DRIFT_TEXT = {
    "prices": "a price in the cost library has been revised (a new quotation, or an expired one downgraded)",
    "relief path": "the relief path, or a lead time along it, differs from the recorded run",
    "constraint model": ("neither the recorded prices, the lead times nor the relief path differ, so the cause "
                         "is in a constraint limit or formula, or in a built-in default price"),
}


def build(d: EnvelopeDiff, *, site: str, hall: str, client: str,
          period: str = "") -> Report:
    today = report_date_iso()
    r = Report(
        title=f"Change note — {site}, hall {hall}",
        subtitle=(f"{client} · {period or today} · compared on {d.before.scenario_name}"),
        watermark=("Modelled from the inputs on record. A change note re-solves the same model "
                   "against new inputs; it is not a new survey of the asset."),
        status="Change note",
        meta=[("Client", client), ("Site", site), ("Hall", hall),
              ("Compared on", d.before.scenario_name), ("Issued", today),
              ("Inputs changed", {"changed": str(len(d.changed_paths)) if d.changed_paths else "yes, not itemised",
                                   "unchanged": "0 (verified)",
                                   "unknown": "unknown (earlier inputs not recorded)"}[d.inputs])],
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
        if d.capex_delta:
            s.blocks.append(Para(
                f"Indicative capex moved from EUR {d.before.capex_eur:,.0f} to EUR {d.after.capex_eur:,.0f}"
                + (", inside the uncertainty of both estimates." if _overlap(d.before, d.after)
                   else ", outside the recorded uncertainty of the earlier estimate.")))
    else:
        rc = _known(d.after.racks_class)
        s.blocks.append(Statement(
            "Deployable racks after the ladder",
            V(float(d.after.racks_after_ladder), "racks", "deployable racks, current inputs", rc),
            _was_racks(d.before)))
        if d.after.weeks_to_full is not None:
            wl, wh = d.after.weeks_lo, d.after.weeks_hi
            db = date_basis_of(_known(d.after.weeks_class), d.after.sets_the_date)
            s.blocks.append(Statement(
                date_title("Time to full capacity", db),
                V(d.after.weeks_to_full, "weeks", "weeks to full capacity, current inputs",
                  _known(d.after.weeks_class),
                  band=(wl, wh) if wl is not None and wh is not None and wh > wl else None),
                date_basis_text(db, _was_weeks(d.before) + f" · set by {d.after.sets_the_date.lower()}")))
        elif d.after.racks_after_ladder:
            s.blocks.append(Para(
                "No date is given for full capacity: a relief on the path has no lead time on record, and "
                "treating it as zero weeks would understate the date. " + _was_weeks(d.before).capitalize()
                + "."))
        cl, ch = d.after.capex_lo, d.after.capex_hi
        s.blocks.append(Statement(
            "Indicative capex",
            V(d.after.capex_eur, "EUR", "indicative capex, current inputs",
              _known(d.after.capex_class),
              band=(cl, ch) if cl is not None and ch is not None and ch > cl else None),
            _was_capex(d.before)
            + ("" if d.after.capex_complete else " · a relief on the path is unpriced, so this is a lower bound")))
        if d.capex_delta and _overlap(d.before, d.after):
            s.blocks.append(Para(
                "The capex change is inside the uncertainty of both estimates; it is not evidence that the "
                "cost moved."))
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
    if d.inputs == "unknown" and d.material:
        s.blocks.append(Para(
            "The earlier run did not record its inputs, so we cannot say whether anything you supplied "
            "changed or whether the answer moved on our side. The movement is not attributed to either."))
    elif d.inputs == "unchanged" and (d.material or d.drift):
        s.blocks.append(Para(
            "Nothing you supplied has changed (checked against the inputs recorded with the earlier run). "
            + ("The answer moved on our side." if d.material else
               "Something on our side did, without moving the racks, what binds first or the date.")))
        if d.drift_known and d.drift:
            s.blocks.append(Bullets([_DRIFT_TEXT[x][:1].upper() + _DRIFT_TEXT[x][1:] + "." for x in d.drift]))
        else:
            s.blocks.append(Para("The earlier run recorded no fingerprint of our prices or relief path, so "
                                 "which of them moved cannot be told from the record."))
        if d.material:
            s.blocks.append(Callout("note",
                "Ask us which revision moved it. Every figure in the underlying model carries its "
                "provenance, so the answer is specific rather than 'the model improved'."))
    elif d.inputs == "unchanged":
        s.blocks.append(Para("No input on record has changed since the last run, and the "
                             "answer is unchanged."))
    elif not d.changed_paths:
        s.blocks.append(Para(
            "The inputs on record differ from the earlier run, but the earlier inputs themselves were not "
            "kept, so the change cannot be itemised or attributed input by input."))
    else:
        s.blocks.append(Para(
            "Each input was moved on its own, from its old value to its new one, and the hall "
            "re-solved. Each row is that input's effect when moved alone, not its share of the total."))
        rows = []
        for dr in d.drivers:
            rows.append([
                label_for(dr.path),
                Lit(str(dr.before)), Lit(str(dr.after)),
                V(float(dr.racks_delta), "racks", f"contribution of {dr.path}",
                  _known(dr.racks_class, d.after.racks_class)),
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
        elif rows:
            s.blocks.append(Para(
                f"The single-input contributions sum to the total ({d.racks_delta:+d} racks) here. That does "
                "not show the inputs act independently: opposing interactions can cancel."))
        if d.unprobed:
            s.blocks.append(Callout("note",
                f"{len(d.unprobed)} further inputs changed but were not probed individually. At "
                "this many changes the hall is materially different and deserves a fresh study "
                "rather than a change note."))
        if d.unprobeable:
            s.blocks.append(Callout("note",
                f"{len(d.unprobeable)} changed input(s) have no individual contribution because they were "
                f"removed or cannot be solved alone: {', '.join(label_for(x) for x in d.unprobeable)}."))
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
        if d.inputs != "changed" and d.material:
            actions.append("Ask which revision of ours moved the answer before acting on it; nothing you "
                           "supplied is the cause." if d.inputs == "unchanged" else
                           "Establish whether your inputs or our model moved the answer before acting on "
                           "it; the record does not say.")
        if d.racks_delta < 0 and d.inputs == "changed":
            actions.append("Capacity fell. Before accepting it, confirm the inputs that drove it "
                           "are real and current — a contractual figure that moved on paper is "
                           "worth checking against the meter.")
        if d.racks_delta > 0 and d.inputs == "changed":
            actions.append("Capacity rose. Check whether the commercial commitments made against "
                           "the old number can now be enlarged.")
        if (d.weeks_delta or 0) > 0:
            actions.append(f"The {'assumed lead time' if _assumed_weeks(d) else 'date'} moved by {d.weeks_delta:.0f} weeks. Lead time, not "
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
