"""/v1/diff against a recorded state says so when it cannot name what moved.

The audit found a transformer lead-time change 160 -> 120 answered '-40 weeks' with `drivers: []`, `changed_inputs: []` and `inputs: "changed"`: an
empty list beside a verdict that the inputs changed, which reads as 'nothing moved'. A recorded state keeps fingerprints of the earlier inputs, not
the inputs, so the path cannot be named from it; the answer now says that, and what to send. With `before` the driver is named, as it always was.
gridforge/change.py is not touched: this is the API's reading of what that module reports.
"""
from __future__ import annotations

import copy
import json
from pathlib import Path

import pytest

from gridforge.api.server import handle_diff
from gridforge.api.tiers import Tier
from gridforge.api.tools import TOOLS_BY_NAME

ROOT = Path(__file__).resolve().parent.parent
REF = json.loads((ROOT / "examples" / "intake" / "reference_hall.json").read_text())
NOTE = "the earlier inputs were not stored, so the driver cannot be named; send `before` to get it"


def diff(**body):
    return handle_diff(dict(body), Tier.CLIENT)


@pytest.fixture(scope="module")
def state():
    return diff(before=REF, after=REF)["after"]


def lead_time_moved():
    d = copy.deepcopy(REF)
    d["transformers"][0]["replacement_lead_time_weeks"] = 120
    return d


def evidence_upgraded():
    d = copy.deepcopy(REF)
    v = d["lv"]["tapoff_max_A"]
    d["lv"]["tapoff_max_A"] = {"value": v["value"] if isinstance(v, dict) else v, "evidence": "E6"}
    return d


def test_a_changed_input_against_a_recorded_state_says_the_driver_cannot_be_named(state):
    out = diff(previous_state=state, after=lead_time_moved())
    assert out["inputs"] == "changed" and out["weeks_delta"] == -40.0
    assert out["changed_inputs"] == [] and out["drivers"] == []
    assert out["changed_inputs_known"] is False, "an empty list here is 'cannot be named', not 'nothing moved'"
    assert out["drivers_note"] == NOTE


def test_the_same_change_with_before_names_the_input_and_says_nothing_is_hidden(state):
    out = diff(before=REF, after=lead_time_moved())
    assert out["changed_inputs"] == ["transformers[0].replacement_lead_time_weeks"]
    assert [dr["path"] for dr in out["drivers"]] == out["changed_inputs"]
    assert out["changed_inputs_known"] is True and out["drivers_note"] is None


def test_an_evidence_only_upgrade_against_a_state_says_so_and_names_what_it_cannot(state):
    out = diff(previous_state=state, after=evidence_upgraded())
    assert out["material"] is True and out["material_reasons"] == ["evidence"]
    assert out["changed_inputs_known"] is False
    assert out["drivers_note"].startswith(NOTE) and "declared evidence classes also differ" in out["drivers_note"]
    assert out["evidence_changed_inputs"] == []


def test_an_evidence_only_upgrade_with_before_names_the_input_whose_class_moved():
    out = diff(before=REF, after=evidence_upgraded())
    assert out["changed_inputs"] == [] and out["evidence_changed_inputs"] == ["lv.tapoff_max_A"]
    assert out["changed_inputs_known"] is True and out["drivers_note"] is None


def test_unchanged_inputs_against_a_state_have_nothing_to_name_and_say_nothing_is_missing(state):
    out = diff(previous_state=state, after=REF)
    assert out["inputs"] == "unchanged" and out["changed_inputs"] == []
    assert out["changed_inputs_known"] is True and out["drivers_note"] is None


def test_a_state_with_no_input_fingerprint_says_it_cannot_tell_whether_the_inputs_moved(state):
    bare = {**state, "intake_digest": ""}
    out = diff(previous_state=bare, after=lead_time_moved())
    assert out["inputs"] == "unknown" and out["changed_inputs_known"] is False
    assert "carries no fingerprint of its inputs" in out["drivers_note"] and "send `before`" in out["drivers_note"]


def test_the_keys_are_additive_nothing_that_was_there_changed(state):
    old = {"headline", "material", "material_reasons", "not_compared", "before", "after", "racks_delta", "weeks_delta", "capex_delta_eur",
           "binding_moved", "changed_inputs", "drivers", "explained_racks", "unexplained_racks", "inputs", "model_drift", "model_drift_known",
           "unprobed_inputs", "unprobeable_inputs", "calibration", "date_basis", "date_evidence_class", "date_binding_item", "date_label"}
    out = diff(previous_state=state, after=lead_time_moved())
    assert old <= set(out)
    assert {"changed_inputs_known", "drivers_note", "evidence_changed_inputs"} <= set(out)


def test_the_published_text_says_it():
    props = TOOLS_BY_NAME["gridforge_diff"]["inputSchema"]["properties"]
    assert "Send before to get the drivers" in props["previous_state"]["description"]
    assert "drivers_note" in TOOLS_BY_NAME["gridforge_diff"]["returns"]
