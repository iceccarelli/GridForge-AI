"""'An evidence class per headline figure' now holds for the rack counts: `racks_evidence` sits beside `racks`.

The audit found `racks` a bare integer in /v1/qualify and /v1/compare (only it_load_kW carried a class), so the claim on the site did not hold for the
figure most people read first. `racks_evidence` is the class, as a short code (E0..E7), of the rack count beside it: the weakest class among the
constraints that cap it, the same definition the portfolio's `racks_evidence` uses (there as the full name).
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from gridforge.api.server import handle_compare, handle_qualify
from gridforge.api.tiers import Tier
from gridforge.api.tools import TOOLS_BY_NAME
from gridforge.envelope.solver import rack_evidence
from gridforge.intake.loader import load_document
from gridforge.reporting.labels import rack_class
from gridforge.scenario.run import run_all
from gridforge.validation import EvidenceClass

ROOT = Path(__file__).resolve().parent.parent
HALL = {"contracted_MW": 12, "current_site_peak_MW": 7.4, "current_it_load_MW": 4.9,
        "busway_ampacity_A": 400, "tapoff_max_A": 63, "plant_supply_C": 6, "positions_available": 180}
CODES = {e.short for e in EvidenceClass}


def example(name):
    return json.loads((ROOT / "examples" / "intake" / f"{name}_hall.json").read_text())


def test_qualify_carries_the_class_of_each_rack_count():
    out = handle_qualify(dict(HALL), Tier.PUBLIC)
    assert out["as_found"]["racks_evidence"] in CODES and out["after_relief"]["racks_evidence"] in CODES
    assert isinstance(out["as_found"]["racks"], int) and isinstance(out["after_relief"]["racks"], int)


def test_qualify_says_the_rack_count_is_an_assumption_when_it_rests_on_one():
    # nothing but the seven figures, every other input a library default: the count is no better evidenced than the weakest constraint behind it
    out = handle_qualify(dict(HALL), Tier.PUBLIC)
    assert out["as_found"]["racks_evidence"] == "E0"
    declared = handle_qualify({**HALL, "assumed_fields": list(HALL)}, Tier.PUBLIC)
    assert declared["as_found"]["racks_evidence"] == "E0"


def test_qualify_class_is_the_one_the_engine_computes_for_that_count():
    from gridforge.api.server import qualify_to_intake
    intake = load_document(qualify_to_intake(dict(HALL)))
    results = run_all(intake.context, intake.scenarios)
    out = handle_qualify(dict(HALL), Tier.PUBLIC)
    from gridforge.reporting.study import _pick_recommended, Objective
    rec = _pick_recommended(results, Objective.MAX_COMPUTE)
    assert out["as_found"]["racks_evidence"] == rack_evidence(rec.envelope).short
    assert out["after_relief"]["racks_evidence"] == rack_class(rec).short


@pytest.mark.parametrize("name", ["reference", "dublin", "nordic", "london"])
def test_compare_carries_the_class_of_each_rack_count_in_every_scenario(name):
    doc = example(name)
    out = handle_compare({"intake": doc}, Tier.CLIENT)
    intake = load_document(json.loads(json.dumps(doc)))
    by_id = {r.spec.id: r for r in run_all(intake.context, intake.scenarios)}
    assert out["scenarios"]
    for row in out["scenarios"]:
        res = by_id[row["id"]]
        assert row["as_found"]["racks_evidence"] == rack_evidence(res.envelope).short in CODES
        assert row["after_ladder"]["racks_evidence"] == rack_class(res).short in CODES
        assert row["as_found"]["racks"] == res.envelope.max_racks and row["after_ladder"]["racks"] == res.unlocked_racks


def test_the_keys_are_additive_the_old_ones_are_where_they_were():
    out = handle_qualify(dict(HALL), Tier.PUBLIC)
    assert {"racks", "it_load_kW", "binding_constraint", "domain", "basis"} <= set(out["as_found"])
    assert {"racks", "architecture", "then_binds_on", "sets_the_date"} <= set(out["after_relief"])
    row = handle_compare({"intake": example("dublin")}, Tier.CLIENT)["scenarios"][0]
    assert {"racks", "binding", "binding_name"} <= set(row["as_found"]) and {"racks", "binding", "binding_name", "it_load_kW"} <= set(row["after_ladder"])


def test_the_tool_text_describes_it():
    for tool in ("gridforge_qualify", "gridforge_compare"):
        assert "racks_evidence" in TOOLS_BY_NAME[tool]["returns"]
