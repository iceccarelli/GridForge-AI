"""The procurement specification, as a document a supplier can quote against.

Deliberately shaped like a tender, not like a consultancy report: scope, technical
requirements with obligation words, evaluation criteria with weights, and a
response schedule. A client's procurement team can issue it without rewriting it,
which is the only test that matters.

Every numeric requirement prints the constraint it came from. That is not a
formality — it is the difference between a specification that provably relieves a
limit and one that specifies equipment somebody liked the look of.
"""
from __future__ import annotations

from ..clock import report_date_iso
from ..procurement.schema import (INFORMATIVE, MANDATORY, PREFERRED, SpecPackage)
from .gates import DISCLOSURE_MARKER, claims_below_floor
from .model import Bullets, Callout, Lit, Para, Report, Section, Statement, Table

OBLIGATION_NOTE = {
    MANDATORY: "shall — non-compliance disqualifies the response",
    PREFERRED: "should — scored, not disqualifying",
    INFORMATIVE: "may — stated for context",
}


def build(pkg: SpecPackage, *, reference: str = "", return_by: str = "",
          contact: str = "", claims: dict | None = None) -> Report:
    r = Report(
        title=f"Technical Specification — {pkg.relief_title}",
        subtitle=(f"{pkg.project} · hall {pkg.hall} · issued {report_date_iso()}"
                  + (f" · ref {reference}" if reference else "")),
        watermark=("Duties in this document are derived from a capacity model of this hall. "
                   "They are modelled values, not measurements of installed plant, and each "
                   "one names the constraint it came from."),
        status="Specification for quotation",
        meta=[("Project", pkg.project), ("Hall", pkg.hall),
              ("Constraint relieved", pkg.constraint_name),
              ("Sized for", f"{pkg.sized_for_racks} racks"),
              ("Responses due", return_by or "as agreed"),
              ("Contact", contact or "—")],
        footer=("Issued by GridForge AI on behalf of the client. We specify duty and "
                "interfaces only. We name no make or model, quote no equipment and take no "
                "margin on hardware."),
    )

    # 1 — why this package exists
    s = Section("1. Purpose")
    s.blocks.append(Para(
        f"This package procures the works required to relieve {pkg.constraint_name} in hall "
        f"{pkg.hall}. In the capacity model for this hall that constraint is what limits "
        f"deployable rack count; relieving it moves the hall from {pkg.racks_before} to "
        f"{pkg.racks_after} racks, and it is part of a programme that reaches "
        f"{pkg.sized_for_racks} racks in total."))
    for n in pkg.notes:
        s.blocks.append(Para(n))
    if pkg.budget_eur is not None:
        s.blocks.append(Statement("Modelled budget for this relief", pkg.budget_eur,
                                  basis="Our estimate, not a price. Stated so a response "
                                        "that is in the wrong universe is visible immediately."))
    if pkg.lead_time_weeks is not None:
        s.blocks.append(Statement("Modelled lead time", pkg.lead_time_weeks,
                                  basis="What the capacity model assumed. A response that "
                                        "differs materially moves the energisation date."))
    # Unconditional, because it is unconditionally true. The duties below are
    # derived from a screening model of this hall; some rest on inputs nobody has
    # measured. A supplier is entitled to know which figures they are being asked
    # to guarantee against, and a client is entitled to know before a purchase
    # order is raised against them.
    below = claims_below_floor(claims or {})
    named = ", ".join(sorted(k.replace("_", " ") for k in below)) or \
        "electrical capacity, cooling performance, capex"
    s.blocks.append(Callout("warning",
        f"{DISCLOSURE_MARKER} the duties in section 3 are derived from a capacity model "
        f"built partly on library defaults and assumed inputs, not on a measured survey of "
        f"this hall. The claim kinds still below the evidence required for an issued "
        f"deliverable are: {named}. These duties are sufficient to obtain comparable, "
        f"competent quotations and to see which supplier moves the energisation date. They "
        f"are NOT sufficient on their own to raise a purchase order for long-lead plant: "
        f"confirm the governing figures against site measurement first. The study's "
        f"evidence appendix names exactly which ones those are."))
    r.sections.append(s)

    # 2 — scope
    s = Section("2. Scope of supply")
    by_supplier = [i for i in pkg.scope if i.by_supplier]
    by_others = [i for i in pkg.scope if not i.by_supplier]
    s.blocks.append(Para("Included in this package:"))
    s.blocks.append(Bullets([f"{i.title} — {i.detail}" for i in by_supplier]))
    if by_others:
        s.blocks.append(Para(
            "Explicitly excluded. Listed rather than omitted, because an unstated exclusion "
            "is a gap somebody discovers on site:"))
        s.blocks.append(Bullets([f"{i.title} — {i.detail}" for i in by_others]))
    r.sections.append(s)

    # 3 — the requirements
    s = Section("3. Technical requirements")
    s.blocks.append(Para(
        "Obligation words carry their usual tender meaning: " +
        "; ".join(OBLIGATION_NOTE.values()) + "."))
    s.blocks.append(Table(
        headers=["Ref", "Clause", "Obl.", "Value", "From constraint"],
        rows=[[q.id, q.clause, Lit(q.obligation),
               q.value if q.value is not None else Lit("—"),
               Lit(q.derived_from or "commercial")]
              for q in pkg.requirements],
        caption=("Every numeric requirement names the constraint it was derived from. A "
                 "requirement nobody can trace back to a physical limit is one somebody "
                 "invented.")))
    # The clauses themselves, in full, after the summary table. Kept in one section
    # rather than one section per clause: a tender document with forty headings is
    # harder to read than a numbered list, and procurement teams read these as a list.
    for q in pkg.requirements:
        s.blocks.append(Para(f"**{q.id} — {q.clause}** ({q.obligation}). {q.statement}"))
        if q.value is not None:
            s.blocks.append(Statement("Required", q.value, basis=q.basis or None))
        elif q.basis:
            s.blocks.append(Para(f"*Basis:* {q.basis}"))
        if q.verification:
            s.blocks.append(Para(f"*Verification:* {q.verification}"))
    r.sections.append(s)

    # 4 — evaluation
    s = Section("4. How responses will be evaluated")
    s.blocks.append(Para(
        "Price is one criterion of five. The item being bought exists to unlock compute on a "
        "date: a response that is cheaper and materially slower is the expensive one, and the "
        "weighting says so."))
    s.blocks.append(Table(
        headers=["Ref", "Criterion", "Weight", "What moves it"],
        rows=[[c.id, c.name, Lit(f"{c.weight}%"), c.how] for c in pkg.criteria],
        caption="Weights total 100."))
    s.blocks.append(Callout("note",
        "A response that does not meet every 'shall' requirement is not ranked above one that "
        "does, whatever its price. That ordering is the entire point of a mandatory "
        "requirement."))
    r.sections.append(s)

    # 5 — instructions
    s = Section("5. Instructions to responders")
    s.blocks.append(Bullets([
        "Return the response schedule in section 6, completed. An incomplete schedule is not "
        "evaluated.",
        "State compliance against every requirement in section 3 as C (compliant), CD "
        "(complies with deviation, deviation described) or N (non-compliant).",
        "Quote duties at the site conditions stated, not at a reference condition. A duty at "
        "a reference condition is not a response to this document.",
        "List exclusions explicitly and price them separately where you can.",
        "State which long-lead component governs your delivery date.",
    ]))
    r.sections.append(s)

    # 6 — response schedule
    s = Section("6. Response schedule")
    s.blocks.append(Para(
        "Return these figures in these units. They feed a comparison the client can check "
        "line by line, which is only possible if every response answers the same question."))
    s.blocks.append(Table(
        headers=["Field", "Unit", "Required", "Note"],
        rows=[[f.label, f.unit, Lit("yes" if f.required else "no"), f.note or ""]
              for f in pkg.response_fields],
        caption=("Machine-readable template: `gridforge spec … --template` writes a JSON "
                 "file with these keys, which `gridforge bids` reads back.")))
    r.sections.append(s)

    return r
