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
    "E10", "E1x", "E1 (measured)", "E39", "E70", "e5foo", "E8", "E9", "E", "", " ", "E-1", "E 3", "EE3", "E3_ENGINEERING_ESTIMATE",
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
