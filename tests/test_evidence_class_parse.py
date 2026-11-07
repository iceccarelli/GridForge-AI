"""A declared evidence class is exactly E0..E7, or it is refused.

Defect (stress review, 2026-11-06): the loader read the declared class with ``str(x).upper()[:2]``, so only the first two characters
counted. "E10" was read as E1, "E39" as E3, "E1 (measured)" as E1, "e5foo" as E5, and a stray ``0`` / ``false`` / ``[]`` was ignored as
"nothing declared". A client could therefore attest to a class it never named. The class now has to be one of E0..E7 after trimming
and upper-casing; anything else is refused with an IntakeError that names the field and the value. A JSON null is "not declared".
"""
from __future__ import annotations

import copy
import json
from pathlib import Path

import pytest

from gridforge.intake.loader import IntakeError, load_document
from gridforge.validation import EvidenceClass

ROOT = Path(__file__).resolve().parents[1]
BASE = json.loads((ROOT / "examples" / "intake" / "reference_hall.json").read_text(encoding="utf-8"))
PATH = "grid.contracted_MW"


def _doc(evidence) -> dict:
    d = copy.deepcopy(BASE)
    d["grid"]["contracted_MW"] = {"value": 12, "source": "DSO contract", "evidence": evidence}
    return d


def _declared(evidence):
    intake = load_document(_doc(evidence))
    return next(s for s in intake.report.sourced if s.path == PATH).evidence


@pytest.mark.parametrize("claimed, expected", [
    ("E0", "E0"), ("E1", "E1"), ("E2", "E2"), ("E3", "E3"), ("E4", "E4"), ("E5", "E5"),
    ("e3", "E3"), ("e0", "E0"), (" E3", "E3"), ("E3 ", "E3"), ("\tE4\n", "E4"), (" e2 ", "E2"),
])
def test_exactly_e0_to_e5_in_any_case_and_trimmed_are_accepted(claimed, expected):
    assert _declared(claimed) == expected


@pytest.mark.parametrize("claimed", ["E6", "E7", "e7", " E7 "])
def test_e6_and_e7_are_still_accepted_and_capped_at_e5(claimed):
    intake = load_document(_doc(claimed))
    assert next(s for s in intake.report.sourced if s.path == PATH).evidence == "E5"
    assert any(PATH in w and "capped at E5" in w for w in intake.report.warnings)


@pytest.mark.parametrize("claimed", [
    "E10", "E1x", "E1 (measured)", "E39", "E70", "e5foo", "E8", "E9", "E", "", " ", "E-1", "E 3", "EE3", "E3_ENGINEERING", "E3_ESTIMATE", "E6_CALIBRATED", "E7 validated", "E0_ASSUMPTIONS", "E5_CUSTOMER_DATA2",
    "E3 derived from design density", "E7_VALIDATED", "3", "e", "Q9", "E３",
    7, 3.0, 0, True, False, ["E3"], {"E3": 1}, [],
], ids=repr)
def test_anything_else_is_refused_and_names_the_field(claimed):
    with pytest.raises(IntakeError) as e:
        load_document(_doc(claimed))
    msg = str(e.value)
    assert PATH in msg and "evidence" in msg
    if isinstance(claimed, str) and claimed.strip():
        assert repr(claimed) in msg


def test_null_is_not_declared_and_the_field_takes_its_default_class():
    intake = load_document(_doc(None))
    assert next(s for s in intake.report.sourced if s.path == PATH).evidence == "E5"      # the field's own supplied class


def test_the_message_lists_the_classes_that_exist():
    with pytest.raises(IntakeError) as e:
        load_document(_doc("E10"))
    for cls in EvidenceClass:
        assert cls.short in str(e.value)


def test_every_integer_typed_field_reads_the_same_rule():
    """positions go through `raw()`, a different reader from `q()`: the same strictness has to apply there."""
    d = copy.deepcopy(BASE)
    d["lv"]["busway_runs"] = {"value": 8, "source": "drawings", "evidence": "E1 (measured)"}
    with pytest.raises(IntakeError, match="lv.busway_runs"):
        load_document(d)
    d["lv"]["busway_runs"] = {"value": 8, "source": "drawings", "evidence": " e4 "}
    load_document(d)


def test_every_shipped_example_still_loads():
    for p in sorted((ROOT / "examples" / "intake").glob("*.json")):
        load_document(json.loads(p.read_text(encoding="utf-8")))


# --- every evidence value the website can emit round-trips through the strict loader ---------------------------------------------------------------
def test_every_evidence_value_the_website_can_emit_is_accepted_by_the_strict_loader():
    """lib/intake-evidence.ts writes `evidence: "E5"` into every confirmed value it merges into an intake (the website emits an evidence key
    only there). Scan the site's sources for every string literal assigned to an `evidence` key and load each through the loader: none may be refused."""
    import re
    found: dict[str, list[str]] = {}
    for sub in ("lib", "app", "components"):
        for p in (ROOT / sub).rglob("*"):
            if p.suffix not in (".ts", ".tsx") or "node_modules" in p.parts:
                continue
            for m in re.finditer(r"""\bevidence["']?\s*:\s*["']([^"']*)["']""", p.read_text(encoding="utf-8", errors="ignore")):
                found.setdefault(m.group(1), []).append(str(p.relative_to(ROOT)))
    emitted = {v: where for v, where in found.items() if re.fullmatch(r"[Ee]\d?", v) or v == ""}          # classes (and an empty one), not labels
    assert "E5" in emitted and any("intake-evidence.ts" in w for w in emitted["E5"])
    for value in emitted:
        intake = load_document(_doc(value))
        assert next(s for s in intake.report.sourced if s.path == PATH).evidence in {"E5", "E0", "E1", "E2", "E3", "E4"}, value


# --- the canonical enum names our own model pack emits are understood (a client re-submits values from it) -----------------------------------------
CANONICAL = [(e.name, e.short) for e in EvidenceClass]


@pytest.mark.parametrize("name, short", [(n, s) for n, s in CANONICAL if s not in ("E6", "E7")])
@pytest.mark.parametrize("variant", [lambda n: n, lambda n: n.lower(), lambda n: f"  {n} ", lambda n: n.title().replace("_", "_")],
                         ids=["exact", "lower", "padded", "title"])
def test_canonical_names_are_accepted_in_any_case_trimmed(name, short, variant):
    assert _declared(variant(name)) == short


@pytest.mark.parametrize("name", ["E6_FIELD_VALIDATED", "E7_DEPLOYED", "e7_deployed", " E6_Field_Validated "])
def test_canonical_e6_and_e7_are_capped_at_e5_with_the_same_disclosure(name):
    intake = load_document(_doc(name))
    assert next(s for s in intake.report.sourced if s.path == PATH).evidence == "E5"
    assert any(PATH in w and "capped at E5" in w for w in intake.report.warnings)


def test_the_eight_canonical_names_are_read_from_the_enum_not_retyped():
    from gridforge.intake import loader
    assert set(loader._EVIDENCE_BY_CANONICAL) == {e.name for e in EvidenceClass} and len(CANONICAL) == 8


def _evidence_values(node):
    if isinstance(node, dict):
        for k, v in node.items():
            if k == "evidence" and isinstance(v, str):
                yield v
            else:
                yield from _evidence_values(v)
    elif isinstance(node, list):
        for v in node:
            yield from _evidence_values(v)


def test_every_evidence_value_in_the_reference_pack_files_round_trips_through_the_loader():
    seen: set[str] = set()
    for p in sorted((ROOT / "public" / "reference").glob("*.json")):
        seen |= set(_evidence_values(json.loads(p.read_text(encoding="utf-8"))))
    assert "E0_ASSUMPTION" in seen                         # the scan is looking at something
    for value in sorted(seen):
        load_document(_doc(value))                         # a refusal raises


def test_every_evidence_value_in_the_model_pack_the_engine_generates_for_the_four_examples_round_trips():
    from gridforge.scenario import run_all
    from gridforge.serialize import model_pack
    seen: set[str] = set()
    for p in sorted((ROOT / "examples" / "intake").glob("*.json")):
        intake = load_document(json.loads(p.read_text(encoding="utf-8")))
        seen |= set(_evidence_values(model_pack(intake, run_all(intake.context, intake.scenarios))))
    assert len(seen) >= 3
    for value in sorted(seen):
        load_document(_doc(value))
