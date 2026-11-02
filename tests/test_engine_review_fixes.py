"""Defects found by independent review of the engine (hand recomputation, property sweeps), each pinned by the case that exposed it.

  1. the free qualifier refused any hall with more than 400 free rack positions, over a total the user never gave;
  2. a rack's feed current was tested at 400 V three-phase whatever the hall's busway voltage (a 208 V hall passed a 250 A tap-off);
  3. a transformer lead time the client supplied kept the library's fixed range, so a date printed beside a range that excluded it;
  4. "capex per rack" divided by every deployable rack, including those that needed no works;
  5. busway capacity was pooled across runs without saying so; the customer can now declare a rack is fed from one run.
"""
import copy
import json
import re
from pathlib import Path

import pytest

from gridforge.api.server import ApiError, handle_qualify, handle_study, _run
from gridforge.api.tiers import Tier
from gridforge.intake.loader import IntakeError, load_document
from gridforge.reporting.labels import capex_per_rack_q, racks_added

ROOT = Path(__file__).resolve().parent.parent
BASE = json.loads((ROOT / "examples" / "intake" / "reference_hall.json").read_text())
QUAL = dict(contracted_MW=30, current_site_peak_MW=18, current_it_load_MW=12, busway_ampacity_A=1600, tapoff_max_A=250, plant_supply_C=7)


def hall(**over):
    d = copy.deepcopy(BASE)
    for path, v in over.items():
        cur = d
        parts = path.split("__")
        for p in parts[:-1]:
            cur = cur[p]
        cur[parts[-1]] = v
    return d


def constraint(doc, cid, scenario=0):
    _, res = _run(doc)
    return next(c for c in res[scenario].envelope.constraints if c.id == cid)


# ---- 1. free positions above the library's default total ---------------------------------------------------------------------

@pytest.mark.parametrize("pos", [1, 100, 399, 400, 401, 600, 1000, 5000])
def test_the_qualifier_takes_any_number_of_free_positions(pos):
    out = handle_qualify({**QUAL, "positions_available": pos}, Tier.PUBLIC)
    assert out["as_found"]["racks"] >= 0
    assert [g["path"] for g in out["intake"]["gaps"]].count("hall.positions_available") == 0


def test_an_undeclared_total_is_still_a_gap_and_is_not_recorded_twice():
    gaps = [g["path"] for g in handle_qualify(QUAL, Tier.PUBLIC)["intake"]["gaps"]]
    assert gaps.count("hall.positions_available") == 1


def test_a_total_the_customer_DID_declare_is_still_enforced():
    with pytest.raises(IntakeError, match="more than hall.rack_positions"):
        load_document(hall(hall__rack_positions=100, hall__positions_available=150))


# ---- 2. rack feed current at the hall's own voltage --------------------------------------------------------------------------

@pytest.mark.parametrize("volts,phases,tap,expect_ok", [
    (400, 3, 250, True),     # the library's own basis: unchanged
    (480, 3, 250, True),     # higher voltage, lower current
    (415, 3, 250, True),
    (208, 3, 250, False),    # ~394 A needed
    (230, 1, 250, False),    # ~618 A needed
    (208, 3, 400, True),
])
def test_the_tap_off_is_tested_against_the_current_at_the_halls_voltage(volts, phases, tap, expect_ok):
    c = constraint(hall(lv__voltage_V=volts, lv__phases=phases, lv__tapoff_max_A=tap), "rack_feed_tapoff")
    assert (c.racks == float("inf")) is expect_ok


def test_the_scaling_is_the_physics_and_is_said_in_the_basis():
    c = constraint(hall(lv__voltage_V=208, lv__phases=3, lv__tapoff_max_A=250), "rack_feed_tapoff")
    assert re.search(r"platform needs 394 ", c.basis)
    assert "scaled to this hall's 208 V three-phase feed" in c.basis
    single = constraint(hall(lv__voltage_V=230, lv__phases=1, lv__tapoff_max_A=250), "rack_feed_tapoff")
    assert re.search(r"platform needs 618 ", single.basis)            # 205 A * (400/230) * sqrt(3)
    assert "scaled" not in constraint(hall(lv__voltage_V=400, lv__phases=3), "rack_feed_tapoff").basis


def test_the_procurement_specification_states_the_same_rating_the_model_tested():
    from gridforge.power.constraints import rack_feed_current_at
    intake, res = _run(hall(lv__voltage_V=208, lv__phases=3, lv__tapoff_max_A=250))
    lv = intake.context.power.lv
    need, _ = rack_feed_current_at(intake.context.cluster.platform.rack_feed_current_A, lv)
    assert round(need.value) == 394
    from gridforge.procurement.build import _tapoff
    reqs = _tapoff(intake.context, 5)
    assert round(reqs[0].value.value) == 394


# ---- 3. a supplied lead time carries a range around itself ----------------------------------------------------------------------

def full_capacity_line(doc):
    md = handle_study({"intake": doc, "format": "md"}, Tier.CLIENT)["document"]
    m = re.search(r"Time to full capacity:\*\* ([\d.]+) \[([\d.]+)[–-]([\d.]+)\] weeks", md)
    assert m, md[:400]
    return tuple(float(x) for x in m.groups())


@pytest.mark.parametrize("weeks", [10, 40, 120, 160, 210, 300])
def test_the_printed_range_always_contains_the_printed_date(weeks):
    doc = hall()
    doc["transformers"][0]["replacement_lead_time_weeks"] = weeks
    date, lo, hi = full_capacity_line(doc)
    assert lo <= date <= hi, (weeks, date, lo, hi)


def test_a_library_placeholder_keeps_the_library_range_and_stays_a_named_gap():
    doc = hall()
    doc["transformers"][0].pop("replacement_lead_time_weeks", None)
    assert full_capacity_line(doc) == (160.0, 80.0, 210.0)
    intake = load_document(doc)
    assert any(g.path == "transformers.replacement_lead_time_weeks" for g in intake.report.gaps)


def test_a_supplied_lead_time_is_still_an_assumption_not_a_date():
    doc = hall()
    doc["transformers"][0]["replacement_lead_time_weeks"] = 40
    md = handle_study({"intake": doc, "format": "md"}, Tier.CLIENT)["document"]
    assert "assumed lead time, not a date" in md


# ---- 4. capex per rack ADDED --------------------------------------------------------------------------------------------------

def scenario_result(doc, i=0):
    return _run(doc)[1][i]


def test_capex_is_divided_by_the_racks_the_works_add_not_all_racks():
    # hybrid DLC on this hall starts at 7 deployable racks and reaches 26 after 5,786,000 EUR of works
    doc = hall(lv__tapoff_max_A=250, lv__busway_ampacity_A=1000, thermal__residual_air_capacity_kW_per_rack=30)
    r = _run(doc)[1][2]
    assert (r.spec.id, int(r.envelope.max_racks), r.unlocked_racks) == ("hybrid_dlc", 7, 26)
    q = capex_per_rack_q(r, "x")
    assert q.value == pytest.approx(r.economics.capex_total_eur.value / 19, rel=1e-9)
    assert q.value > r.economics.capex_total_eur.value / 26          # the old divisor flattered it by about a third


def test_no_works_needed_is_zero_per_rack_not_undefined_and_spend_without_a_rack_is_undefined():
    class Cap:
        def __init__(self, v): self.value, self.unit, self.evidence = v, "EUR", None
    class R:
        def __init__(self, found, final, capex):
            self.envelope = type("E", (), {"max_racks": found})()
            self.unlocked_racks = final
            self.economics = type("X", (), {"capex_total_eur": __import__("gridforge.common", fromlist=["V"]).V(capex, "EUR", "capex", __import__("gridforge.validation", fromlist=["EvidenceClass"]).EvidenceClass.E0_ASSUMPTION)})()
    # racks deployable as found, nothing bought
    from unittest import mock
    with mock.patch("gridforge.reporting.labels.rack_class", return_value=__import__("gridforge.validation", fromlist=["EvidenceClass"]).EvidenceClass.E0_ASSUMPTION):
        z = capex_per_rack_q(R(10, 10, 0.0), "z")
        assert z is not None and z.value == 0.0
        assert capex_per_rack_q(R(10, 10, 500_000.0), "s") is None          # money spent, no rack added
        assert capex_per_rack_q(R(0, 0, 0.0), "n") is None                   # nothing deployable at all
        assert racks_added(R(3, 11, 1.0)) == 8


# ---- 5. busway topology -------------------------------------------------------------------------------------------------------

def test_the_three_topologies_on_the_reference_hall():
    assert constraint(hall(), "busway_ampacity").racks == 12
    assert constraint(hall(lv__rack_feed_topology="pooled"), "busway_ampacity").racks == 12
    assert constraint(hall(lv__rack_feed_topology="single_run"), "busway_ampacity").racks == 8


@pytest.mark.parametrize("volts,amps,runs", [(400, 400, 8), (415, 800, 4), (480, 1000, 2), (400, 630, 5), (400, 250, 12)])
def test_single_run_never_exceeds_pooled_and_equals_whole_racks_per_run(volts, amps, runs):
    kw = {"lv__voltage_V": volts, "lv__busway_ampacity_A": amps, "lv__busway_runs": runs}
    pooled = constraint(hall(**kw), "busway_ampacity").racks
    single = constraint(hall(**kw, lv__rack_feed_topology="single_run"), "busway_ampacity").racks
    per_run_kw = volts * amps * 0.8 * (3 ** 0.5) * BASE["grid"].get("power_factor", 0.97) / 1000
    assert single <= pooled
    assert single == int(per_run_kw // 135) * runs


def test_the_assumption_is_stated_when_undeclared_and_an_unknown_word_is_refused():
    assert "ASSUMES a rack's load can be shared across runs" in constraint(hall(), "busway_ampacity").basis
    assert "ASSUMES" not in constraint(hall(lv__rack_feed_topology="pooled"), "busway_ampacity").basis
    for bad in ("Pooled", "single", "", 3, True, ["pooled"]):
        with pytest.raises(IntakeError, match="rack_feed_topology"):
            load_document(hall(lv__rack_feed_topology=bad))
