"""An equipment bank the client did not declare is UNASSESSED, never "not limiting".

Defect (found by the independent engine review, 2026-11-06, reproduced through ``handle_compare``): with the
``transformers`` and ``ups`` sections left out of the intake, those two constraints evaluate to "unbounded", the
ladder takes fewer reliefs, and ``hybrid_dlc`` comes back ``dated`` at 0.0 weeks where the same hall with the
sections declared is ``dated`` at 160 weeks. Giving the engine LESS data produced a faster, cheaper answer with no
warning. The rack count is deliberately unchanged here (a sparse-data screen still returns a figure); what must
change is that the date, the critical path and the cost are NOT presented as complete.

Fixture: the synthetic Dublin hall in ``examples/intake`` (no customer data). Expected values are stated in the
tests from the rule ("an undeclared bank withholds the date"), not read back from the engine.
"""
from __future__ import annotations

import copy
import json
from pathlib import Path

import pytest

from gridforge.api.server import handle_compare, handle_diff, handle_screen
from gridforge.api.tiers import Tier
from gridforge.envelope import ladder
from gridforge.envelope.time_to_power import date_record, schedule_complete
from gridforge.intake.loader import load_document

DUBLIN = json.loads((Path(__file__).resolve().parent.parent / "examples" / "intake" / "dublin_hall.json").read_text())
# "Fully declared" now includes the CDU schedule: the shipped intake leaves it empty, so the loader assumes a kit and the liquid scenarios are
# undated on that account (tests/test_week_zero_assumed_equipment.py). The same hardware, declared, keeps this file about transformers and UPS.
DUBLIN["thermal"]["cdus"] = [{"id": "CDU-ROW", "rated_capacity_kW": 1350, "rated_approach_K": 5, "rated_flow_l_per_min": 2000,
                              "units": 3, "redundancy": "N+1"}]


def _without(*sections: str) -> dict:
    doc = copy.deepcopy(DUBLIN)
    for s in sections:
        doc.pop(s)
    return doc


def _ladder(doc: dict):
    return ladder(load_document(doc).context)


def _row(doc: dict, scenario: str) -> dict:
    out = handle_compare({"intake": doc}, Tier.CLIENT)
    return next(r for r in out["scenarios"] if r["id"] == scenario)


def test_a_fully_declared_hall_is_unchanged_and_dated():
    lad = _ladder(DUBLIN)
    assert lad.unassessed_banks == ()
    assert lad.critical_path_complete and schedule_complete(lad)
    assert date_record(lad)["status"] == "dated"
    r = _row(DUBLIN, "hybrid_dlc")
    assert r["time_to_power"]["status"] == "dated" and r["time_to_power"]["weeks"] == 160.0


@pytest.mark.parametrize("omitted, named", [
    (("transformers",), ["transformers"]),
    (("ups",), ["UPS"]),
    (("transformers", "ups"), ["transformers", "UPS"]),
])
def test_an_undeclared_bank_makes_the_critical_path_incomplete(omitted, named):
    lad = _ladder(_without(*omitted))
    assert list(lad.unassessed_banks) == named
    assert lad.critical_path_complete is False
    assert schedule_complete(lad) is False


@pytest.mark.parametrize("omitted", [("transformers",), ("ups",), ("transformers", "ups")])
def test_an_undeclared_bank_withholds_the_date_and_names_what_is_missing(omitted):
    rec = date_record(_ladder(_without(*omitted)))
    assert rec["status"] != "dated"
    assert rec["date_interval_weeks"] is None
    wanted = {"transformers": "transformers", "ups": "UPS"}
    for section in omitted:
        assert any(wanted[section] in m and m.startswith("not declared") for m in rec["missing_inputs"]), rec["missing_inputs"]


@pytest.mark.parametrize("omitted", [("transformers",), ("ups",), ("transformers", "ups")])
def test_the_comparison_never_dates_a_hall_with_an_undeclared_bank(omitted):
    for scenario in ("hybrid_dlc", "full_dlc"):
        r = _row(_without(*omitted), scenario)
        tp = r["time_to_power"]
        assert tp["status"] == "lead_time_missing", (scenario, tp)
        assert tp["weeks"] is None and tp["low"] is None and tp["high"] is None
        assert "not declared" in tp["reason"]
        assert any(m.startswith("not declared") for m in r["missing_inputs"])
        assert r["grade"] == "undated"


def test_empty_lists_are_the_same_as_omitted_sections():
    doc = copy.deepcopy(DUBLIN)
    doc["transformers"], doc["ups"] = [], []
    assert list(_ladder(doc).unassessed_banks) == ["transformers", "UPS"]
    assert _row(doc, "hybrid_dlc")["time_to_power"]["status"] == "lead_time_missing"


def test_the_rack_count_of_a_sparse_screen_is_still_returned():
    """The fix withholds the date and the completeness claim; it does not refuse the screen."""
    lad = _ladder(_without("transformers", "ups"))
    assert lad.initial.max_racks > 0


# --- the same rule on the Density Screen and on a diff -------------------------------------------------------------------
# Found by the independent stress-test review: the screen still said schedule_complete=true and gave 32-56 weeks, and the
# diff headlined "capex moved -6.2 M EUR" for a hall that had merely been given less data.

@pytest.mark.parametrize("omitted", [("transformers",), ("ups",), ("transformers", "ups")])
def test_the_screen_does_not_give_a_date_or_call_the_schedule_complete(omitted):
    out = handle_screen({"intake": _without(*omitted)}, Tier.CLIENT)
    for s in out["scenarios"]:
        tp = s["time_to_power"]
        assert tp["schedule_complete"] is False, (s["id"], tp)
        assert tp["weeks_to_full"] is None and tp["weeks_to_first_rack"] in (None, 0.0), (s["id"], tp)
        assert s["economics"]["critical_path_complete"] is False and s["economics"]["critical_path_weeks"] is None
        assert s["economics"]["capex_complete"] is False


def test_the_screen_of_a_fully_declared_hall_is_unchanged():
    out = handle_screen({"intake": DUBLIN}, Tier.CLIENT)
    assert all(s["time_to_power"]["schedule_complete"] is True for s in out["scenarios"])
    assert any(s["time_to_power"]["weeks_to_full"] is not None for s in out["scenarios"])


def test_a_diff_to_a_sparser_hall_does_not_report_a_saving_or_a_weeks_delta():
    d = handle_diff({"before": DUBLIN, "after": _without("transformers", "ups")}, Tier.CLIENT)
    assert d["weeks_delta"] is None
    assert "not a saving" in d["headline"] and "lower bound" in d["headline"]
