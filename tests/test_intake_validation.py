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
