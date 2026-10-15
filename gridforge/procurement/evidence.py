"""From a supplier's response to cost evidence the engine may use. The transition between procurement and the model.

A response is not evidence because it was received. Three separate steps, in this order, and only the last one lets a
number move a run:

  1. ``quote_lines``    every priced line of every response becomes a ``QuoteLine``: normalised to the unit and scope
                        the engine prices the line in, checked against the specification it answers, and marked
                        VALIDATED or INVALID with its reasons. Nothing is rejected silently and nothing is trusted.
  2. a person reviews   (the site stores the decision; this module only refuses to promote what is not validated).
  3. ``accept``         a validated line plus a named reviewer becomes a ``CostEntry`` with ``status="accepted"``,
                        carrying the supplier, dates, scope, quantity, unit, currency and the record it came from.

``costs.cost_overlay`` then applies accepted entries to ONE run, and reports what it ignored. The library is never
written by any of this.
"""
from __future__ import annotations

import hashlib
import json
import math
from dataclasses import dataclass, field
from datetime import date

from ..clock import report_date
from ..costs import CAPACITY_SCALED_KEYS, COST_EVIDENCE, CostEntry, declared_unit
from .evaluate import COMPLIES_WITH_DEVIATION, NON_COMPLIANT, _check_response
from .ingest import _to_library_basis
from .schema import ProcurementError, SpecPackage, SupplierResponse

VALIDATED = "validated"
INVALID = "invalid"


@dataclass
class QuoteLine:
    key: str                      # cost-library key
    unit: str                     # the unit the line is recorded in ("EUR" lump, "EUR/rack", ...)
    value: float                  # converted onto that basis
    submitted_value: float        # what the supplier wrote
    currency: str
    supplier: str
    received_on: str
    valid_until: str
    reference: str
    scope: str                    # the relief this package tendered
    quoted_quantity: float | None
    quoted_quantity_unit: str | None
    specification: dict           # what it answers: project / hall / constraint / sized_for_racks
    response_digest: str          # sha256 of the response as received: the idempotency key
    status: str = VALIDATED
    problems: list = field(default_factory=list)        # why INVALID
    limitations: list = field(default_factory=list)     # why VALIDATED but of limited comparability

    @property
    def comparability(self) -> str:
        return "limited" if self.limitations else "exact"

    @property
    def digest(self) -> str:
        """One line of one response, once: re-submitting the same response yields the same digest."""
        raw = json.dumps([self.key, self.response_digest, self.supplier.strip().lower()], sort_keys=True)
        return hashlib.sha256(raw.encode()).hexdigest()

    def to_dict(self) -> dict:
        def num(x):          # JSON has no NaN/inf: an unreadable amount is null, never a number that is not one
            return x if isinstance(x, (int, float)) and math.isfinite(x) else None
        return {"key": self.key, "unit": self.unit, "value": num(self.value) or None, "submitted_value": num(self.submitted_value),
                "currency": self.currency, "supplier": self.supplier, "received_on": self.received_on,
                "valid_until": self.valid_until, "reference": self.reference, "scope": self.scope,
                "quoted_quantity": self.quoted_quantity, "quoted_quantity_unit": self.quoted_quantity_unit,
                "specification": self.specification, "response_digest": self.response_digest,
                "status": self.status, "problems": list(self.problems), "limitations": list(self.limitations),
                "comparability": self.comparability, "digest": self.digest}


def response_digest(r: SupplierResponse) -> str:
    """Canonical hash of a response as received: the same content always hashes the same, whatever its key order."""
    body = {"supplier": r.supplier.strip().lower(), "received_on": r.received_on, "valid_until": r.valid_until,
            "currency": r.currency, "reference": r.reference, "values": dict(sorted(r.values.items())),
            "compliance": dict(sorted(r.compliance.items())), "specification": r.specification}
    return hashlib.sha256(json.dumps(body, sort_keys=True, default=str).encode()).hexdigest()


def quote_lines(pkg: SpecPackage, responses: list[SupplierResponse], *, today: date | None = None) -> list[QuoteLine]:
    """Every priced line of every response, validated against the package it answers. Never raises for a bad response:
    a response that cannot be used yields INVALID lines that say why, so the reviewer sees it and nothing is lost."""
    today = today or report_date()
    seen: dict[str, int] = {}
    lines: list[QuoteLine] = []
    cost_fields = [f for f in pkg.response_fields if f.cost_key]
    if not cost_fields:
        raise ProcurementError("this specification's response schedule has no priced field with a cost_key, so a "
                               "response to it cannot become cost evidence")
    mandatory = [q.id for q in pkg.mandatory()]
    for r in responses:
        seen[r.supplier.strip().lower()] = seen.get(r.supplier.strip().lower(), 0) + 1
    for r in responses:
        digest = response_digest(r)
        base_problems: list[str] = []
        limits: list[str] = []
        try:
            soft = _check_response(pkg, r, today)
        except ProcurementError as exc:
            soft = []
            base_problems.append(str(exc))
        base_problems.extend(soft)
        if seen[r.supplier.strip().lower()] > 1:
            base_problems.append("another response from the same supplier is in this submission: supply one current "
                                 "response per supplier")
        if r.currency != "EUR":
            base_problems.append(
                f"currency {r.currency or 'not stated'}: the specification requires EUR (C-01) and the engine holds no "
                f"exchange rate, so the price cannot be compared")
        for rid in mandatory:
            code = r.compliance.get(rid, "")
            if not code:
                limits.append(f"no compliance statement for mandatory requirement {rid}")
            elif code == NON_COMPLIANT:
                limits.append(f"mandatory requirement {rid} is marked non-compliant: the price is for a different scope")
            elif code == COMPLIES_WITH_DEVIATION:
                limits.append(f"complies with deviation on {rid}")
        for f in cost_fields:
            raw = r.get(f.key)
            problems = list(base_problems)
            value = None
            unit = f.cost_unit or f.unit
            if raw is None:
                problems.append(f"{f.label}: not supplied")
            elif not (isinstance(raw, (int, float)) and math.isfinite(raw) and raw > 0):
                problems.append(f"{f.label}: {raw!r} is not a positive finite amount")
            else:
                try:
                    unit, value = _to_library_basis(pkg, unit, float(raw), f.cost_key)
                except ProcurementError as exc:
                    problems.append(str(exc))
            qty = qunit = None
            line_limits = list(limits)
            if f.cost_key in CAPACITY_SCALED_KEYS:
                if pkg.scope_quantity and pkg.scope_quantity_unit:
                    qty, qunit = pkg.scope_quantity, pkg.scope_quantity_unit
                else:
                    line_limits.append("the specification states no quantity for this line, so the lump cannot be "
                                       "scaled to what each step needs")
            elif unit.startswith("EUR/") and (pkg.sized_for_racks <= 0 and unit.endswith("/rack")):
                problems.append("the package is sized for no racks")
            if f.cost_key not in CAPACITY_SCALED_KEYS and unit != declared_unit(f.cost_key, unit):
                problems.append(f"unit {unit} does not match the library line's unit {declared_unit(f.cost_key, unit)}")
            lines.append(QuoteLine(
                key=f.cost_key, unit=unit, value=float(value) if value is not None else float(raw or 0),
                submitted_value=float(raw) if isinstance(raw, (int, float)) and math.isfinite(raw) else float("nan"),
                currency=r.currency or "", supplier=r.supplier, received_on=r.received_on, valid_until=r.valid_until,
                reference=r.reference, scope=pkg.relief_title, quoted_quantity=qty, quoted_quantity_unit=qunit,
                specification={"project": pkg.project, "hall": pkg.hall, "constraint": pkg.constraint_id,
                               "sized_for_racks": pkg.sized_for_racks},
                response_digest=digest, status=INVALID if problems else VALIDATED, problems=problems,
                limitations=[] if problems else line_limits))
    return lines


def accept(line: QuoteLine | dict, *, evidence_id: str, reviewer: str, reviewed_on: str, basis: str = "budgetary_quote",
           comparability: str | None = None, includes_keys: tuple = (), region: str | None = None,
           project: str | None = None, note: str | None = None) -> CostEntry:
    """Promote ONE validated line to accepted cost evidence. Refuses anything else.

    ``basis`` is the reviewer's judgement of what kind of quotation it is (budgetary, firm or contracted); it is never
    inferred from the fact of receipt. A reviewer may downgrade comparability to limited, never upgrade a line that
    validation found limited."""
    ln = line if isinstance(line, dict) else line.to_dict()
    if ln.get("status") != VALIDATED:
        raise ProcurementError(f"only a validated quotation line can be accepted; this one is {ln.get('status')!r}: "
                               f"{'; '.join(ln.get('problems') or [])}")
    if basis not in ("budgetary_quote", "firm_quote", "contracted"):
        raise ProcurementError(f"a supplier response is accepted as a budgetary_quote, firm_quote or contracted cost, "
                               f"not {basis!r}")
    if not (reviewer or "").strip():
        raise ProcurementError("acceptance needs the name of the person who reviewed the quotation")
    limited = ln.get("comparability") == "limited" or comparability == "limited"
    if comparability == "exact" and ln.get("comparability") == "limited":
        raise ProcurementError("validation found this quotation's comparability limited; a reviewer cannot upgrade it")
    return CostEntry(
        key=ln["key"], label=f"{ln['scope']} ({ln['supplier']})", unit=ln["unit"], value=float(ln["value"]),
        basis=basis, supplier=ln["supplier"], quoted_on=ln["received_on"], valid_until=ln["valid_until"] or None,
        region=region, project=project, note=note, currency=ln["currency"],
        quoted_quantity=ln.get("quoted_quantity"), quoted_quantity_unit=ln.get("quoted_quantity_unit"),
        scope=ln["scope"], comparability="limited" if limited else "exact", status="accepted",
        evidence_id=evidence_id, response_ref=ln["response_digest"], reviewer=reviewer.strip(), reviewed_on=reviewed_on,
        includes_keys=tuple(includes_keys))
