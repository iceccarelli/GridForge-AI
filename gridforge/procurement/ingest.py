"""A returned bid becomes a cost-library entry.

This is the flywheel, and it is the reason the procurement engagement is worth
selling at a price that looks low next to the study. A study rests on library
defaults with a -50%/+100% band. A returned quotation is a dated, attributable,
project-specific price — E3 or E5 evidence — and the moment it lands in the
library every future study touching that line gets stronger and its AACE class
improves.

Nothing here writes to the committed seed. Quotations are confidential and
frequently NDA'd; they go to the private library, same rule as everywhere else.
"""
from __future__ import annotations

from ..costs import COST_EVIDENCE
from .schema import ProcurementError, SpecPackage, SupplierResponse


def _to_library_basis(pkg: SpecPackage, unit: str, lump_sum: float) -> tuple[str, float]:
    """Convert a supplier's delivered price onto the basis the library holds.

    A supplier quotes one number for the job. The library holds `tapoff.unit` per
    rack, `ups.per_kW` per kW and `cdu.addition` as a lump sum, and the conversion
    is against what the package was SIZED for — the hall's end state — because that
    is what the supplier priced.

    Getting this wrong is the one way this flywheel does damage rather than good: a
    per-rack line entered as a lump sum is off by the rack count, it carries a
    quotation's evidence class, and every future study inherits it with a straight
    face.
    """
    u = (unit or "EUR").strip()
    if u.endswith("/rack"):
        if pkg.sized_for_racks <= 0:
            raise ProcurementError(
                f"cannot convert to {u}: the package is sized for no racks")
        return u, round(lump_sum / pkg.sized_for_racks, 2)
    if u.endswith("/kW"):
        if pkg.sized_for_kW <= 0:
            raise ProcurementError(
                f"cannot convert to {u}: the package is sized for no load")
        return u, round(lump_sum / pkg.sized_for_kW, 2)
    return u, round(lump_sum, 2)


def cost_entries_from(pkg: SpecPackage, response: SupplierResponse, *,
                      basis: str = "budgetary_quote",
                      region: str = "", project: str = "") -> list[dict]:
    """The `gridforge cost add` arguments implied by a response.

    Returned as data rather than written, so the engineer sees what is about to
    enter the library before it does. A price that lands in the library unreviewed
    is a price nobody can defend when a client asks where it came from.
    """
    if basis not in COST_EVIDENCE:
        raise ProcurementError(
            f"unknown basis {basis!r}. One of: {', '.join(sorted(COST_EVIDENCE))}")
    if basis in ("library_default", "published_benchmark"):
        raise ProcurementError(
            "a supplier response is a quotation, not a benchmark. Use budgetary_quote, "
            "firm_quote or contracted.")

    out: list[dict] = []
    for f in pkg.response_fields:
        if not f.cost_key:
            continue
        value = response.get(f.key)
        if value is None:
            continue
        unit, converted = _to_library_basis(pkg, f.cost_unit or f.unit, value)
        out.append({
            "key": f.cost_key,
            "label": f"{pkg.relief_title} ({response.supplier})",
            "unit": unit,
            "value": converted,
            "basis": basis,
            "supplier": response.supplier,
            "quoted_on": response.received_on,
            "valid_until": response.valid_until,
            "region": region,
            "project": project or pkg.project,
            "note": (f"From the response to the {pkg.relief_title} specification for hall "
                     f"{pkg.hall}. Relieves {pkg.constraint_name}."
                     + (f" Reference {response.reference}." if response.reference else "")),
        })
    if not out:
        raise ProcurementError(
            "nothing in this response maps to a cost-library key — the specification's "
            "response schedule has no priced field with a cost_key")
    return out


def command_lines(entries: list[dict], library: str = "") -> list[str]:
    """The exact `gridforge cost add` invocations, for an engineer to review and run."""
    lines = []
    for e in entries:
        parts = ["python3 -m gridforge cost add",
                 f"--key {e['key']}",
                 f"--label {e['label']!r}",
                 f"--unit {e['unit']}",
                 f"--value {e['value']}",
                 f"--basis {e['basis']}",
                 f"--supplier {e['supplier']!r}",
                 f"--quoted-on {e['quoted_on']}"]
        if e.get("valid_until"):
            parts.append(f"--valid-until {e['valid_until']}")
        if e.get("region"):
            parts.append(f"--region {e['region']}")
        if e.get("project"):
            parts.append(f"--project {e['project']!r}")
        if library:
            parts.append(f"--library {library}")
        lines.append(" \\\n    ".join(parts))
    return lines
