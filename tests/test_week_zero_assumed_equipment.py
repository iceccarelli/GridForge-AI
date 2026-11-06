"""No "available as found at week 0" for racks that depend on equipment nobody declared.

Defect (stress review, 2026-11-06): ``schedule()`` puts every rack the hall hosts today at week 0, labelled "available as found". In a
liquid scenario with no CDU schedule the loader ASSUMES a kit of CDUs (``installed=False``: not in the hall, to be bought and
commissioned), so those as-found racks run on cooling that does not exist yet. The Dublin hybrid DLC scenario said 13 racks at week 0.

The library holds no lead time for a CDU kit's delivery and commissioning of the *assumed* bank, so none is invented. The rule is the one
f064f59 set for transformers and UPS: an equipment bank the client did not declare is UNASSESSED. Here that bank is "CDUs" (liquid
architecture, no declared CDU schedule): the as-found point is withheld, the date is withheld, and the reason names what is missing.
Declared CDUs, air-cooled scenarios and the transformer/UPS behaviour are unchanged.
"""
from __future__ import annotations

import copy
import json
from pathlib import Path

import pytest

from gridforge.api.server import handle_compare, handle_screen
from gridforge.api.tiers import Tier
from gridforge.envelope import ladder
from gridforge.envelope.time_to_power import date_record, elapsed_bands, schedule, schedule_complete
from gridforge.intake.loader import load_document
from gridforge.scenario import run_all

ROOT = Path(__file__).resolve().parents[1]
EXAMPLES = ROOT / "examples" / "intake"
DUBLIN = json.loads((EXAMPLES / "dublin_hall.json").read_text(encoding="utf-8"))
REFERENCE = json.loads((EXAMPLES / "reference_hall.json").read_text(encoding="utf-8"))

#: A declared CDU schedule with the same hardware the loader would assume (3 x 1,350 kW, N+1) but stated by the client.
DECLARED_CDUS = [{"id": "CDU-ROW", "rated_capacity_kW": 1350, "rated_approach_K": 5, "rated_flow_l_per_min": 2000,
                  "units": 3, "redundancy": "N+1"}]


def _with_cdus(doc: dict, cdus) -> dict:
    d = copy.deepcopy(doc)
    d["thermal"]["cdus"] = copy.deepcopy(cdus)
    return d


def _scenario(doc: dict, sid: str):
    intake = load_document(doc)
    return next(r for r in run_all(intake.context, intake.scenarios) if r.spec.id == sid)


def _row(doc: dict, sid: str) -> dict:
    return next(r for r in handle_compare({"intake": doc}, Tier.CLIENT)["scenarios"] if r["id"] == sid)


def _week_zero_as_found(ttp) -> list:
    return [p for p in ttp.points if p.unlocked_by == "available as found"]


# --- the defect ---------------------------------------------------------------------------------------------------------
def test_dublin_hybrid_dlc_has_racks_as_found_but_they_rest_on_an_assumed_cdu_kit():
    r = _scenario(DUBLIN, "hybrid_dlc")
    assert r.ladder.initial.max_racks == 13                       # the as-found count is unchanged
    assert [c.installed for c in r.ladder.initial_context.thermal.cdus] == [False]     # ... on a kit that is not installed
    assert list(r.ladder.unassessed_banks) == ["CDUs"]


@pytest.mark.parametrize("doc", [DUBLIN, REFERENCE], ids=["dublin", "reference"])
@pytest.mark.parametrize("sid", ["hybrid_dlc", "full_dlc", "full_dlc_btm"])
def test_no_week_zero_point_and_no_date_when_the_cdus_are_assumed(doc, sid):
    r = _scenario(doc, sid)
    ttp = schedule(r.ladder)
    assert _week_zero_as_found(ttp) == []                          # base: a week-0 "available as found" point for Dublin hybrid DLC
    assert ttp.weeks_to_first_rack is None                         # base: 0.0
    assert ttp.weeks_to_full is None and ttp.complete is False
    rec = date_record(r.ladder, ttp)
    assert rec["status"] == "lead_time_missing" and "not declared: CDUs" in rec["missing_inputs"]
    assert rec["date_interval_weeks"] is None
    assert "not declared: CDUs" in r.ladder.incomplete_reason
    assert schedule_complete(r.ladder) is False


def test_the_curve_and_the_bands_stay_aligned_when_the_first_point_is_withheld():
    r = _scenario(DUBLIN, "hybrid_dlc")
    ttp = schedule(r.ladder)
    assert len(ttp.points) == len(elapsed_bands(r.ladder))
    assert all(p.weeks > 0 for p in ttp.points)


def test_the_comparison_row_withholds_the_dates_and_says_why():
    row = _row(DUBLIN, "hybrid_dlc")
    tp = row["time_to_power"]
    assert tp["status"] == "lead_time_missing"
    assert tp["weeks"] is None and tp["low"] is None and tp["high"] is None and tp["first_rack_weeks"] is None
    assert "not declared: CDUs" in tp["reason"]
    assert "not declared: CDUs" in row["missing_inputs"]
    assert row["grade"] == "undated"
    assert row["as_found"]["racks"] == 13                          # the screening rack count is still given


def test_the_screen_does_not_say_the_schedule_is_complete():
    out = handle_screen({"intake": DUBLIN}, Tier.CLIENT)
    s = next(x for x in out["scenarios"] if x["id"] == "hybrid_dlc")
    assert s["time_to_power"]["schedule_complete"] is False
    assert s["time_to_power"]["weeks_to_first_rack"] is None and s["time_to_power"]["weeks_to_full"] is None
    assert all(c["unlocked_by"] != "available as found" for c in s["time_to_power"]["curve"])


def test_a_plain_hybrid_context_with_no_cdu_schedule_is_unassessed_too():
    """No scenario override at all: the CDU constraint is skipped ('no CDU schedule declared'), which is the same absence."""
    lad = ladder(load_document(DUBLIN).context)
    assert list(lad.unassessed_banks) == ["CDUs"]


def test_the_incomplete_reason_names_the_cdus_and_says_what_the_kit_is():
    reason = _scenario(DUBLIN, "hybrid_dlc").ladder.incomplete_reason
    assert reason.startswith("not declared: CDUs")
    assert "assumed" in reason and "no delivery or commissioning time" in reason


# --- unchanged: declared CDUs --------------------------------------------------------------------------------------------
def test_declared_cdus_keep_the_week_zero_point_and_the_date():
    doc = _with_cdus(DUBLIN, DECLARED_CDUS)
    r = _scenario(doc, "hybrid_dlc")
    ttp = schedule(r.ladder)
    assert r.ladder.unassessed_banks == ()
    assert [(p.weeks, p.racks, p.unlocked_by) for p in ttp.points][0] == (0.0, 13, "available as found")
    assert ttp.weeks_to_first_rack == 0.0 and ttp.complete and ttp.weeks_to_full == 160.0
    assert date_record(r.ladder, ttp)["status"] == "dated"
    row = _row(doc, "hybrid_dlc")["time_to_power"]
    assert row["status"] == "dated" and row["weeks"] == 160.0 and row["first_rack_weeks"] == 0.0


def test_declared_cdus_give_the_same_racks_as_the_assumed_kit_of_the_same_size():
    assumed = _scenario(DUBLIN, "hybrid_dlc").ladder
    declared = _scenario(_with_cdus(DUBLIN, DECLARED_CDUS), "hybrid_dlc").ladder
    assert (declared.initial.max_racks, declared.final.max_racks) == (assumed.initial.max_racks, assumed.final.max_racks)


def test_air_cooled_scenarios_never_name_cdus():
    for sid in ("retained_air", "rdhx"):
        assert "CDUs" not in _scenario(DUBLIN, sid).ladder.unassessed_banks


# --- unchanged: f064f59 (transformers, UPS) -------------------------------------------------------------------------------
def test_an_undeclared_transformer_bank_still_keeps_the_week_zero_point_when_the_cdus_are_declared():
    doc = _with_cdus(DUBLIN, DECLARED_CDUS)
    doc.pop("transformers")
    r = _scenario(doc, "hybrid_dlc")
    assert list(r.ladder.unassessed_banks) == ["transformers"]
    ttp = schedule(r.ladder)
    assert len(_week_zero_as_found(ttp)) == 1 and ttp.complete is False
    assert r.ladder.incomplete_reason.startswith("not declared: transformers (reliefs they would need are neither priced nor timed)")


def test_all_three_undeclared_are_listed_in_order():
    doc = copy.deepcopy(DUBLIN)
    doc.pop("transformers"), doc.pop("ups")
    assert list(_scenario(doc, "hybrid_dlc").ladder.unassessed_banks) == ["transformers", "UPS", "CDUs"]
