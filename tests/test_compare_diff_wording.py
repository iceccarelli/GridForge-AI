"""Two sentences that said the wrong thing.

J2-2: /v1/compare `vs_baseline.weeks_delta_unknown_reason` on a scenario that HAS racks and a date read 'No rack is deployable in this scenario'. It
meant the baseline, and said it of the scenario the row is about.

J2-3: the /v1/diff headline said '+25 racks (62 to 87)' beside drivers that explain 10 of them: the other 15 were only in `unexplained_racks`. The
residual is now in the headline sentence.
"""
from __future__ import annotations

import copy
import json
from pathlib import Path

import pytest

from gridforge.api.compare_payload import compare_payload
from gridforge.api.server import handle_compare, handle_diff
from gridforge.api.tiers import Tier
from gridforge.intake.loader import load_document
from gridforge.scenario.objective import Objective
from gridforge.scenario.run import run_all

ROOT = Path(__file__).resolve().parent.parent
REF = json.loads((ROOT / "examples" / "intake" / "reference_hall.json").read_text())
DUBLIN = json.loads((ROOT / "examples" / "intake" / "dublin_hall.json").read_text())
LONDON = json.loads((ROOT / "examples" / "intake" / "london_hall.json").read_text())


def rows(doc, **kw):
    out = handle_compare({"intake": doc, **kw}, Tier.CLIENT)
    return {r["id"]: r for r in out["scenarios"]}, out


# --- J2-2 -----------------------------------------------------------------------------------------------------------------------------------
def test_a_dated_scenario_against_a_baseline_with_no_racks_names_the_baseline_not_itself():
    by, _ = rows(DUBLIN)
    base, dated = by["retained_air"], by["hybrid_dlc"]
    assert base["time_to_power"]["status"] == "no_deployable_racks" and dated["time_to_power"]["status"] == "dated"
    assert dated["after_ladder"]["racks"] > 0
    why = dated["vs_baseline"]["weeks_delta_unknown_reason"]
    assert dated["vs_baseline"]["weeks_delta"] is None
    assert why == "the baseline (retained_air) deploys no racks, so it has no date to take this scenario's date away from."
    assert "No rack is deployable in this scenario" not in why


def test_the_baseline_itself_and_a_scenario_with_no_racks_keep_the_sentence_about_themselves():
    by, _ = rows(DUBLIN)
    assert by["rdhx"]["time_to_power"]["status"] == "no_deployable_racks"
    assert by["rdhx"]["vs_baseline"]["weeks_delta_unknown_reason"] == by["rdhx"]["time_to_power"]["reason"]
    assert "this scenario" in by["rdhx"]["vs_baseline"]["weeks_delta_unknown_reason"]


def test_a_baseline_whose_lead_time_is_missing_says_that_and_what():
    intake = load_document(copy.deepcopy(DUBLIN))
    results = run_all(intake.context, intake.scenarios)
    broken = copy.deepcopy(next(r for r in results if r.spec.id == "full_dlc"))
    broken.ladder.taken_steps[0].lead_time_weeks = None
    other = next(r for r in results if r.spec.id == "hybrid_dlc")
    out = compare_payload(DUBLIN, [broken, other], objective=Objective.FASTEST_TO_POWER, baseline=None)
    by = {r["id"]: r for r in out["scenarios"]}
    assert by["full_dlc"]["time_to_power"]["status"] == "lead_time_missing" and by["hybrid_dlc"]["time_to_power"]["status"] == "dated"
    why = by["hybrid_dlc"]["vs_baseline"]["weeks_delta_unknown_reason"]
    assert why.startswith("the baseline (full_dlc) has no defensible date (") and why.endswith("so there is no date to take this scenario's date away from.")
    assert "No defensible date:" not in why


def test_a_weeks_difference_that_exists_has_no_reason():
    by, _ = rows(DUBLIN, baseline="hybrid_dlc")
    row = by["full_dlc"]
    assert row["vs_baseline"]["weeks_delta"] is not None and row["vs_baseline"]["weeks_delta_unknown_reason"] is None


def test_no_dated_scenarios_row_reads_a_reason_that_is_about_another_scenario():
    """For every scenario of every example hall: a reason that names 'this scenario' is only ever given to a scenario that is itself undated."""
    for doc in (REF, DUBLIN, LONDON, json.loads((ROOT / "examples" / "intake" / "nordic_hall.json").read_text())):
        by, _ = rows(doc)
        for row in by.values():
            if row["vs_baseline"] is None:            # the baseline is not compared with itself
                continue
            reason = row["vs_baseline"]["weeks_delta_unknown_reason"]
            if reason and "this scenario" in reason.replace("this scenario's date", ""):
                assert row["time_to_power"]["weeks"] is None, (row["id"], reason)


# --- J2-3 -----------------------------------------------------------------------------------------------------------------------------------
def interacting():
    b = copy.deepcopy(REF)
    b["grid"]["contracted_MW"] = 16.0
    b["grid"]["firm_capacity_MVA"] = 18.0
    return b


def test_the_headline_carries_the_part_no_single_input_explains():
    out = handle_diff({"before": REF, "after": interacting()}, Tier.CLIENT)
    assert (out["racks_delta"], out["explained_racks"], out["unexplained_racks"]) == (25, 10, 15)
    assert out["headline"].startswith("+25 racks (62 to 87)")
    assert out["headline"].endswith("The single-input probes explain +10 of the +25 racks; the other +15 are not explained by any one input "
                                    "(the inputs interact).")


def test_a_diff_the_probes_fully_explain_has_the_unchanged_headline():
    after = copy.deepcopy(REF)
    after["btm_options"][1]["capex_eur_per_kW"] = 1600
    out = handle_diff({"before": REF, "after": after}, Tier.CLIENT)
    assert out["unexplained_racks"] == 0 and "single-input probes" not in out["headline"]


def test_a_diff_with_no_drivers_or_no_rack_movement_is_not_touched(monkeypatch):
    same = handle_diff({"before": REF, "after": REF}, Tier.CLIENT)
    assert same["headline"].startswith("Nothing that changes the answer") and "single-input" not in same["headline"]
    no_probe = handle_diff({"before": REF, "after": interacting(), "attribute": False}, Tier.CLIENT)
    assert no_probe["drivers"] == [] and "single-input" not in no_probe["headline"]


def test_the_note_says_when_an_input_was_not_probed_either(monkeypatch):
    import gridforge.change as change
    monkeypatch.setattr(change, "MAX_DRIVERS_PROBED", 1)
    out = handle_diff({"before": REF, "after": interacting()}, Tier.CLIENT)
    assert out["unprobed_inputs"] and "or were not probed" in out["headline"]


def test_the_numbers_in_the_sentence_are_the_payloads_own():
    out = handle_diff({"before": REF, "after": interacting()}, Tier.CLIENT)
    assert f"explain {out['explained_racks']:+d} of the {out['racks_delta']:+d} racks; the other {out['unexplained_racks']:+d}" in out["headline"]
    assert out["explained_racks"] + out["unexplained_racks"] == out["racks_delta"]
