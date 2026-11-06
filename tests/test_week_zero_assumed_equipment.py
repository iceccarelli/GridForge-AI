"""Racks that rest on an ASSUMED CDU kit are not "available as found" at week 0.

Defect (stress review, 2026-11-06): ``schedule()`` puts every rack the hall hosts today at week 0, labelled "available as found". In a liquid
scenario with no CDU schedule the loader ASSUMES a kit (``installed=False``: not in the hall, to be bought, delivered and commissioned), so those
racks run on cooling that does not exist yet. The Dublin hybrid DLC scenario said 13 racks at week 0 and ``first_rack_weeks`` 0.0.

A hall being converted from air to liquid has no CDUs by definition. That is the normal state, not an undeclared bank: nothing is withheld and
the date stays a date. What changes is the first point: the as-found racks are energised once the kit is delivered, at the library CDU lead time
(the CDU relief's own figure: 26 weeks, band 16 to 40, an E0 assumption). The commissioning of the kit and the conversion works are not in the
schedule, and the date record says so. Declared (installed) CDUs and air-cooled scenarios are unchanged.

Expected numbers are stated here from the rule and the library constants (26 weeks; 160 weeks for the transformer bank), and the library value
is also read from the engine's own constraint, so the test fails if either moves.
"""
from __future__ import annotations

import copy
import json
import re
from pathlib import Path

import pytest

from gridforge.api.server import handle_compare, handle_screen
from gridforge.api.tiers import Tier
from gridforge.envelope import ladder
from gridforge.envelope.time_to_power import (ASSUMED_CDU_KIT_LABEL, date_record, elapsed_bands, full_capacity_band, schedule,
                                              schedule_complete)
from gridforge.intake.loader import load_document
from gridforge.reporting import deck
from gridforge.scenario import run_all
from gridforge.validation import EvidenceClass

ROOT = Path(__file__).resolve().parents[1]
EXAMPLES = ROOT / "examples" / "intake"


def _doc(name: str) -> dict:
    return json.loads((EXAMPLES / f"{name}_hall.json").read_text(encoding="utf-8"))


DUBLIN, NORDIC, REFERENCE = _doc("dublin"), _doc("nordic"), _doc("reference")

#: The library CDU lead time, stated independently of the engine: gridforge/thermal/constraints.py, cdu_capacity (26 weeks, band 16-40, E0).
CDU_KIT_WEEKS, CDU_KIT_BAND = 26, (16, 40)

#: A declared CDU schedule: the same hardware the loader assumes (3 x 1,350 kW, N+1), stated by the client so it is installed.
DECLARED_CDUS = [{"id": "CDU-ROW", "rated_capacity_kW": 1350, "rated_approach_K": 5, "rated_flow_l_per_min": 2000, "units": 3, "redundancy": "N+1"}]


def _scenario(doc: dict, sid: str):
    intake = load_document(doc)
    return next(r for r in run_all(intake.context, intake.scenarios) if r.spec.id == sid)


def _row(doc: dict, sid: str) -> dict:
    return next(r for r in handle_compare({"intake": doc}, Tier.CLIENT)["scenarios"] if r["id"] == sid)


def _declared(doc: dict) -> dict:
    d = copy.deepcopy(doc)
    d["thermal"]["cdus"] = copy.deepcopy(DECLARED_CDUS)
    return d


# --- the defect --------------------------------------------------------------------------------------------------------------------
@pytest.mark.parametrize("doc", [DUBLIN, NORDIC], ids=["dublin", "nordic"])
def test_as_found_racks_on_an_assumed_kit_are_not_available_at_week_zero(doc):
    r = _scenario(doc, "hybrid_dlc")
    assert r.ladder.initial.max_racks > 0
    assert [c.installed for c in r.ladder.initial_context.thermal.cdus] == [False]           # the kit is assumed, not in the hall
    ttp = schedule(r.ladder)
    assert [p for p in ttp.points if p.unlocked_by == "available as found"] == []              # base b649b3e: a week-0 point of 13 (Dublin) / 3 (Nordic)
    assert all(p.weeks > 0 for p in ttp.points)
    first = ttp.points[0]
    assert (first.weeks, first.racks, first.unlocked_by) == (CDU_KIT_WEEKS, r.ladder.initial.max_racks, ASSUMED_CDU_KIT_LABEL)
    assert "assumed" in first.unlocked_by and "library lead time" in first.unlocked_by
    assert ttp.weeks_to_first_rack == CDU_KIT_WEEKS                                              # base: 0.0
    assert ttp.as_found_waits_for_cdu_kit is True


def test_the_26_weeks_are_the_library_cdu_relief_own_figure_not_a_number_of_the_schedule():
    r = _scenario(DUBLIN, "hybrid_dlc")
    cdu = next(c for c in r.ladder.initial.constraints if c.id == "cdu_capacity")
    lt = cdu.relief.lead_time_weeks
    assert lt.value == CDU_KIT_WEEKS and tuple(lt.band) == CDU_KIT_BAND and lt.evidence == EvidenceClass.E0_ASSUMPTION
    assert r.ladder.cdu_kit_lead_time is lt                                                      # the very object
    (weeks, lo, hi, cls) = elapsed_bands(r.ladder)[0]
    assert (weeks, lo, hi, cls) == (CDU_KIT_WEEKS, *CDU_KIT_BAND, EvidenceClass.E0_ASSUMPTION)


def test_the_curve_and_the_bands_stay_aligned():
    for doc in (DUBLIN, NORDIC, REFERENCE):
        r = _scenario(doc, "hybrid_dlc")
        assert len(schedule(r.ladder).points) == len(elapsed_bands(r.ladder))


# --- the date is NOT withheld ----------------------------------------------------------------------------------------------------------
def test_the_full_capacity_date_is_still_there_and_is_the_longest_lead_time():
    r = _scenario(DUBLIN, "hybrid_dlc")
    ttp = schedule(r.ladder)
    assert ttp.complete is True and schedule_complete(r.ladder) is True
    leads = [s.lead_time_weeks.value for s in r.ladder.taken_steps]
    assert ttp.weeks_to_full == max([CDU_KIT_WEEKS, *leads]) == 160.0                            # the transformer bank (160 weeks, library) sets it
    got = full_capacity_band(r.ladder, ttp)
    assert got is not None and got[0] == 160.0
    rec = date_record(r.ladder, ttp)
    assert rec["status"] == "dated" and rec["controlling_component"] == "Transformer capacity"


def test_with_a_quicker_transformer_the_date_is_still_the_longest_lead_time_and_nothing_is_earlier_than_the_kit():
    d = copy.deepcopy(DUBLIN)
    d["transformers"][0]["replacement_lead_time_weeks"] = 10          # shorter than the kit; the UPS relief (30 weeks, library) now binds
    r = _scenario(d, "hybrid_dlc")
    leads = [s.lead_time_weeks.value for s in r.ladder.taken_steps]
    ttp = schedule(r.ladder)
    assert ttp.weeks_to_full == max([CDU_KIT_WEEKS, *leads]) == 30.0
    assert ttp.weeks_to_first_rack == CDU_KIT_WEEKS and all(p.weeks >= CDU_KIT_WEEKS for p in ttp.points)


def test_the_date_record_states_the_limitation_and_the_comparison_caveat_says_it_too():
    r = _scenario(DUBLIN, "hybrid_dlc")
    rec = date_record(r.ladder)
    assert "first-rack date rests on the library CDU lead time" in rec["limitation"]
    assert "commissioning" in rec["limitation"] and "conversion" in rec["limitation"] and "not in the schedule" in rec["limitation"]
    out = handle_compare({"intake": DUBLIN}, Tier.CLIENT)
    assert any("assumed CDU kit" in c and "not in the schedule" in c for c in out["caveats"])


def test_the_comparison_row_and_the_screen_carry_the_first_rack_date():
    row = _row(DUBLIN, "hybrid_dlc")["time_to_power"]
    assert row["status"] == "dated" and row["weeks"] == 160.0 and row["first_rack_weeks"] == CDU_KIT_WEEKS
    s = next(x for x in handle_screen({"intake": DUBLIN}, Tier.CLIENT)["scenarios"] if x["id"] == "hybrid_dlc")
    assert s["time_to_power"]["weeks_to_first_rack"] == CDU_KIT_WEEKS and s["time_to_power"]["schedule_complete"] is True
    assert all(c["unlocked_by"] != "available as found" for c in s["time_to_power"]["curve"])
    assert s["time_to_power"]["curve"][0]["weeks"] == CDU_KIT_WEEKS


def test_the_four_shipped_halls_liquid_scenarios_remain_dated_with_these_first_rack_dates():
    """first_rack_weeks per scenario (weeks). Only a hall with racks as found on the assumed kit moves (Dublin and Nordic hybrid_dlc: 0 -> 26)."""
    want = {
        "dublin": {"hybrid_dlc": 26, "full_dlc": 32, "full_dlc_btm": 32},
        "nordic": {"hybrid_dlc": 26, "full_dlc": 32},
        "reference": {"hybrid_dlc": 24, "full_dlc": 32, "full_dlc_btm": 32},
    }
    for hall, scenarios in want.items():
        out = handle_compare({"intake": _doc(hall)}, Tier.CLIENT)
        for sid, weeks in scenarios.items():
            t = next(r for r in out["scenarios"] if r["id"] == sid)["time_to_power"]
            assert t["status"] == "dated" and t["weeks"] == 160.0 and t["first_rack_weeks"] == weeks, (hall, sid, t)
    # London was already undated before this change, for its missing UPS schedule (unchanged).
    london = handle_compare({"intake": _doc("london")}, Tier.CLIENT)
    assert {r["time_to_power"]["status"] for r in london["scenarios"] if r["id"] in ("hybrid_dlc", "full_dlc")} == {"lead_time_missing"}


# --- unchanged ---------------------------------------------------------------------------------------------------------------------------
def test_declared_installed_cdus_keep_the_week_zero_point():
    r = _scenario(_declared(DUBLIN), "hybrid_dlc")
    assert r.ladder.assumed_cdu_kit is False
    ttp = schedule(r.ladder)
    assert (ttp.points[0].weeks, ttp.points[0].racks, ttp.points[0].unlocked_by) == (0.0, 13, "available as found")
    assert ttp.weeks_to_first_rack == 0.0 and ttp.complete and ttp.weeks_to_full == 160.0
    assert elapsed_bands(r.ladder)[0] == (0.0, 0.0, 0.0, EvidenceClass.E0_ASSUMPTION)
    assert "first-rack date rests" not in date_record(r.ladder, ttp)["limitation"]
    row = _row(_declared(DUBLIN), "hybrid_dlc")["time_to_power"]
    assert row["status"] == "dated" and row["first_rack_weeks"] == 0.0 and row["weeks"] == 160.0


def test_air_cooled_scenarios_are_unchanged():
    for sid in ("retained_air", "rdhx"):
        r = _scenario(DUBLIN, sid)
        assert r.ladder.assumed_cdu_kit is False
        ttp = schedule(r.ladder)
        assert ttp.points == [] and ttp.as_found_waits_for_cdu_kit is False


def test_an_empty_cdu_list_and_an_absent_key_behave_identically():
    empty, absent = copy.deepcopy(DUBLIN), copy.deepcopy(DUBLIN)
    empty["thermal"]["cdus"] = []
    absent["thermal"].pop("cdus", None)
    a, b = _scenario(empty, "hybrid_dlc"), _scenario(absent, "hybrid_dlc")
    pa, pb = schedule(a.ladder), schedule(b.ladder)
    assert [(p.weeks, p.racks, p.unlocked_by) for p in pa.points] == [(p.weeks, p.racks, p.unlocked_by) for p in pb.points]
    assert date_record(a.ladder, pa) == date_record(b.ladder, pb)
    assert (a.ladder.initial.max_racks, a.ladder.final.max_racks) == (b.ladder.initial.max_racks, b.ladder.final.max_racks)


def test_a_plain_context_with_no_cdus_and_no_scenario_override_is_unchanged():
    lad = ladder(load_document(DUBLIN).context)
    assert lad.assumed_cdu_kit is False and lad.unassessed_banks == ()


def test_transformers_and_ups_still_withhold_the_date_exactly_as_f064f59_set_out():
    d = copy.deepcopy(DUBLIN)
    d.pop("transformers"), d.pop("ups")
    r = _scenario(d, "hybrid_dlc")
    assert list(r.ladder.unassessed_banks) == ["transformers", "UPS"]       # CDUs are not a bank
    assert r.ladder.incomplete_reason == "not declared: transformers, UPS (reliefs they would need are neither priced nor timed)"
    assert _row(d, "hybrid_dlc")["time_to_power"]["status"] == "lead_time_missing"


# --- the deck chart ---------------------------------------------------------------------------------------------------------------------
def _first_path(svg: str) -> str:
    return re.search(r'd="(M [^"]+)"', svg).group(1)


def test_the_energisation_chart_starts_at_zero_racks_when_the_as_found_racks_wait_for_the_kit():
    svg = deck._energisation_svg(schedule(_scenario(DUBLIN, "hybrid_dlc").ladder))
    start_y = _first_path(svg).split()[2]
    assert start_y == "298.0"                      # the baseline (h 350 - bottom margin 52): nothing energised at week 0, not 13 racks


def test_the_energisation_chart_of_a_hall_with_declared_cdus_starts_at_its_racks_as_found():
    svg = deck._energisation_svg(schedule(_scenario(_declared(DUBLIN), "hybrid_dlc").ladder))
    assert _first_path(svg).split()[2] != "298.0"
