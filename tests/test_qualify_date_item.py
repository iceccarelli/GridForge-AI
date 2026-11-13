"""/v1/qualify names the item that sets the date only when there IS a date.

The audit found `after_relief.sets_the_date` = "Chilled-water plant capacity" beside `date_basis: "none"` (a lead time on the path is missing, because the
free qualifier never asks for transformers or UPS): an item named as the thing that decides a date that does not exist. /v1/compare on the same hall
sends null. The qualifier now sends null too, with a `sets_the_date_reason`, and the no-date label says which of its two causes is true.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from gridforge.api.payloads import qualify_payload
from gridforge.api.server import _mcp_summary, handle_qualify
from gridforge.api.tiers import Tier
from gridforge.envelope.time_to_power import (CAUSE_LEAD_TIME_MISSING, CAUSE_NOT_DEPLOYABLE, NO_DATE, NO_DATE_LEAD_TIME_MISSING,
                                              NO_DATE_NOT_DEPLOYABLE, date_basis, no_date_cause, no_date_reason, schedule)
from gridforge.intake.loader import load_document
from gridforge.scenario.run import run_all

HALL = {"contracted_MW": 12, "current_site_peak_MW": 7.4, "current_it_load_MW": 4.9,
        "busway_ampacity_A": 400, "tapoff_max_A": 63, "plant_supply_C": 6, "positions_available": 180}
DUBLIN = json.loads((Path(__file__).resolve().parent.parent / "examples" / "intake" / "dublin_hall.json").read_text())


def _after(body):
    return handle_qualify(dict(body), Tier.PUBLIC)["after_relief"]


def test_no_item_sets_a_date_that_does_not_exist_because_a_lead_time_is_missing():
    a = _after(HALL)
    assert a["date_basis"] == "none"
    assert a["sets_the_date"] is None, "a hall with no date has no item that sets it (the old code named the chilled-water plant)"
    assert "transformers" in a["sets_the_date_reason"] and "UPS" in a["sets_the_date_reason"]
    assert a["date_label"] == NO_DATE_LEAD_TIME_MISSING.label
    assert "nothing is deployable" not in a["date_label"], "the label names the cause that is true, not both"


def test_a_hall_with_nothing_deployable_says_that_and_not_that_a_lead_time_is_missing():
    a = _after({**HALL, "positions_available": 0})
    assert a["sets_the_date"] is None
    assert a["date_basis"] == "none"
    assert a["date_label"] == NO_DATE_NOT_DEPLOYABLE.label
    assert "lead time" not in a["date_label"]
    assert "nothing to date" in a["sets_the_date_reason"]


def test_the_two_causes_are_different_labels_and_the_combined_one_survives_for_a_stored_state():
    assert NO_DATE_NOT_DEPLOYABLE.label != NO_DATE_LEAD_TIME_MISSING.label
    assert NO_DATE.label == "no date: nothing is deployable or a lead time on the path is missing"      # the label a stored state still carries
    for d in (NO_DATE_NOT_DEPLOYABLE, NO_DATE_LEAD_TIME_MISSING):
        assert d.basis == "none" and d.evidence_class is None and d.binding_item is None


def test_a_hall_with_a_complete_schedule_still_names_the_item_that_sets_its_date():
    intake = load_document(json.loads(json.dumps(DUBLIN)))
    results = run_all(intake.context, intake.scenarios)
    a = qualify_payload(intake, results)["after_relief"]
    assert a["date_basis"] in ("assumed", "supported")
    assert a["sets_the_date"] and a["sets_the_date"] == a["date_binding_item"]
    assert a["sets_the_date_reason"] is None


def test_the_cause_is_chosen_by_which_is_true_on_the_ladder_itself():
    intake = load_document(json.loads(json.dumps(DUBLIN)))
    results = run_all(intake.context, intake.scenarios)
    for r in results:
        t = schedule(r.ladder)
        cause = no_date_cause(r.ladder, t)
        if cause is None:
            assert no_date_reason(r.ladder, t) is None and date_basis(r.ladder, t).basis != "none"
        else:
            assert date_basis(r.ladder, t).basis == "none" and no_date_reason(r.ladder, t)
            assert date_basis(r.ladder, t).label == (NO_DATE_NOT_DEPLOYABLE.label if cause == CAUSE_NOT_DEPLOYABLE else
                                                     NO_DATE_LEAD_TIME_MISSING.label if cause == CAUSE_LEAD_TIME_MISSING else NO_DATE.label)


def test_the_mcp_summary_follows_the_payload_and_never_names_an_item_for_a_missing_date():
    out = handle_qualify(dict(HALL), Tier.PUBLIC)
    text = _mcp_summary("gridforge_qualify", out)
    assert "sets the date" not in text, "the summary must not name an item the payload does not name"
    assert "No defensible date" in text
    assert "Chilled-water plant capacity" not in text
    # and when the payload does name one, the summary does too
    named = json.loads(json.dumps(out))
    named["after_relief"]["sets_the_date"] = "Transformer capacity"
    assert "Transformer capacity sets the date." in _mcp_summary("gridforge_qualify", named)


def test_the_mcp_summary_for_a_nothing_deployable_hall_says_so():
    out = handle_qualify({**HALL, "positions_available": 0}, Tier.PUBLIC)
    text = _mcp_summary("gridforge_qualify", out)
    assert "sets the date" not in text and "nothing to date" in text


@pytest.mark.parametrize("body", [HALL, {**HALL, "positions_available": 0}])
def test_the_reason_carries_no_weeks_so_it_is_safe_on_the_public_tier(body):
    reason = _after(body)["sets_the_date_reason"]
    assert reason and not any(ch.isdigit() for ch in reason.replace("UPS", ""))
