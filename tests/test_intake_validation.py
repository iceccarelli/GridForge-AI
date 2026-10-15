"""An invalid intake must be refused by name, never ranked, never a traceback."""
import copy
import json
from pathlib import Path

import pytest

from gridforge.intake.loader import IntakeError, load_document

ROOT = Path(__file__).resolve().parents[1]
BASE = json.loads((ROOT / "examples" / "intake" / "dublin_hall.json").read_text())


def mutated(path, value):
    d = copy.deepcopy(BASE)
    cur = d
    parts = path.split(".")
    for p in parts[:-1]:
        cur = cur[int(p)] if p.isdigit() else cur[p]
    last = parts[-1]
    if last.isdigit():
        cur[int(last)] = value
    else:
        cur[last] = value
    return d


@pytest.mark.parametrize("path,value,fragment", [
    ("grid.power_factor", 1.5, "at most 1"),
    ("grid.power_factor", 0, "above 0"),
    ("grid.firm_capacity_MVA", float("nan"), "finite"),
    ("grid.firm_capacity_MVA", float("inf"), "finite"),
    ("grid.contracted_MW", "abc", "not a number"),
    ("grid.contracted_MW", -5, "negative"),
    ("thermal.plant.chilled_water_capacity_kW", float("nan"), "finite"),
    ("transformers.0.derating_factor", 5, "at most 1"),
    ("transformers.0.replacement_lead_time_weeks", None, "not a number"),
    ("lv.busway_ampacity_A", True, "not a number"),
])
def test_invalid_values_are_refused_with_the_field_named(path, value, fragment):
    with pytest.raises(IntakeError, match=fragment):
        load_document(mutated(path, value))


def test_the_reference_intake_still_loads():
    load_document(copy.deepcopy(BASE))


def test_a_client_cannot_self_declare_field_validation():
    d = copy.deepcopy(BASE)
    d["grid"]["firm_capacity_MVA"] = {"value": 14, "evidence": "E7"}
    intake = load_document(d)
    from gridforge.validation import EvidenceClass
    assert intake.context.power.grid.firm_capacity_MVA.evidence <= EvidenceClass.E5_CUSTOMER_DATA
    assert any("capped at E5" in w for w in intake.report.warnings)


def test_structural_garbage_is_an_intake_error_not_a_traceback():
    d = copy.deepcopy(BASE)
    del d["transformers"][0]["unit_rating_MVA"]
    with pytest.raises(IntakeError, match="unit_rating_MVA"):
        load_document(d)
    d = copy.deepcopy(BASE)
    d["hall"]["floor_type"] = "marble"
    with pytest.raises(IntakeError, match="malformed|floor"):
        load_document(d)
    d = copy.deepcopy(BASE)
    d["compute"] = {"platform": "gb300_nvl72", "default_architecture": "teleporter"}
    with pytest.raises(IntakeError, match="default_architecture"):
        load_document(d)
    d = copy.deepcopy(BASE)
    d["scenarios"] = []
    with pytest.raises(IntakeError, match="empty list"):
        load_document(d)
    with pytest.raises(IntakeError):
        load_document([])


def test_btm_kind_is_case_insensitive():
    d = copy.deepcopy(BASE)
    d["btm_options"][0]["kind"] = "GAS_ENGINE"
    i = load_document(d)
    assert i.context.power.options[0].kind == "gas_engine"
