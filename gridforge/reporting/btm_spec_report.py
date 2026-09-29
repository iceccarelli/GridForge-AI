"""The BTM equipment spec, as a document a supplier can quote against.

Same shape as `gridforge.reporting.spec` (the hall procurement specification):
scope, obligation-worded requirements naming the unit they came from, a weighted
evaluation matrix, and a response schedule. Kept as a separate, smaller renderer
rather than extended into `reporting.spec.build()` because that function reads
`SpecPackage` fields (`hall`, `racks_before`, `racks_after`) a BTM architecture
does not have — see `btm_spec.py`'s own docstring for why this is composition,
not a fork of working code.
"""
from __future__ import annotations

from ..clock import report_date_iso
from ..procurement.schema import INFORMATIVE, MANDATORY, PREFERRED
from .btm_spec import BTMEquipmentSpec
from .model import Bullets, Callout, Lit, Para, Report, Section, Statement, Table

OBLIGATION_NOTE = {
    MANDATORY: "shall — non-compliance disqualifies the response",
    PREFERRED: "should — scored, not disqualifying",
    INFORMATIVE: "may — stated for context",
}


def build(spec: BTMEquipmentSpec, *, reference: str = "", return_by: str = "",
         contact: str = "") -> Report:
    r = Report(
        title=f"Technical Specification — {spec.architecture_label}",
        subtitle=(f"{spec.project} · issued {report_date_iso()}"
                 + (f" · ref {reference}" if reference else "")),
        watermark=("Duties in this document are derived from a BTM Power Deployment "
                  "Assessment. They are modelled and declared values, not measurements of "
                  "installed plant, and each one names the unit it came from."),
        status="Specification for quotation",
        meta=[("Project", spec.project), ("Architecture", spec.architecture_label),
             ("Units covered", ", ".join(spec.units)),
             ("Responses due", return_by or "as agreed"),
             ("Contact", contact or "—")],
        footer=("Issued by GridForge AI on behalf of the client. We specify duty and "
               "interfaces only. We name no make or model, quote no equipment and take no "
               "margin on hardware."),
    )

    s = Section("1. Purpose")
    s.blocks.append(Para(
        f"This package procures the generation and storage units in the '{spec.architecture_label}' "
        f"architecture from a BTM Power Deployment Assessment: {', '.join(spec.units)}."))
    for n in spec.notes:
        s.blocks.append(Para(n))
    s.blocks.append(Callout("warning",
        "EVIDENCE DISCLOSURE: the duties in section 3 are derived from the deployment "
        "assessment's declared unit parameters, which are technology defaults unless the "
        "customer supplied supplier data. These duties are sufficient to obtain comparable, "
        "competent quotations. They are NOT sufficient on their own to raise a purchase order "
        "for long-lead plant — confirm the governing figures against a firm quote first."))
    r.sections.append(s)

    s = Section("2. Scope of supply")
    by_supplier = [i for i in spec.scope if i.by_supplier]
    by_others = [i for i in spec.scope if not i.by_supplier]
    s.blocks.append(Para("Included in this package:"))
    s.blocks.append(Bullets([f"{i.title} — {i.detail}" for i in by_supplier]))
    if by_others:
        s.blocks.append(Para("Explicitly excluded, listed rather than omitted:"))
        s.blocks.append(Bullets([f"{i.title} — {i.detail}" for i in by_others]))
    r.sections.append(s)

    s = Section("3. Technical requirements")
    s.blocks.append(Para(
        "Obligation words carry their usual tender meaning: "
        + "; ".join(OBLIGATION_NOTE.values()) + "."))
    s.blocks.append(Table(
        headers=["Ref", "Clause", "Obl.", "Value", "From unit"],
        rows=[[q.id, q.clause, Lit(q.obligation),
              q.value if q.value is not None else Lit("—"), Lit(q.derived_from or "commercial")]
             for q in spec.requirements],
        caption="Every numeric requirement names the unit it was derived from."))
    for q in spec.requirements:
        s.blocks.append(Para(f"**{q.id} — {q.clause}** ({q.obligation}). {q.statement}"))
        if q.value is not None:
            s.blocks.append(Statement("Required", q.value, basis=q.basis or None))
        elif q.basis:
            s.blocks.append(Para(f"*Basis:* {q.basis}"))
        if q.verification:
            s.blocks.append(Para(f"*Verification:* {q.verification}"))
    r.sections.append(s)

    s = Section("4. How responses will be evaluated")
    s.blocks.append(Table(
        headers=["Ref", "Criterion", "Weight", "What moves it"],
        rows=[[c.id, c.name, Lit(f"{c.weight}%"), c.how] for c in spec.criteria],
        caption="Weights total 100."))
    r.sections.append(s)

    s = Section("5. Instructions to responders")
    s.blocks.append(Bullets([
        "Return the response schedule in section 6, completed.",
        "State compliance against every requirement in section 3 as C (compliant), CD "
        "(complies with deviation) or N (non-compliant).",
        "Quote duties at the conditions stated, not at a reference condition.",
        "List exclusions explicitly and price them separately where you can.",
    ]))
    r.sections.append(s)

    s = Section("6. Response schedule")
    s.blocks.append(Table(
        headers=["Field", "Unit", "Required", "Note"],
        rows=[[f.label, f.unit, Lit("yes" if f.required else "no"), f.note or ""]
             for f in spec.response_fields]))
    r.sections.append(s)

    return r
