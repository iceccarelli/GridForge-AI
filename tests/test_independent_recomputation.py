"""The engine's per-constraint rack counts, recomputed here from the raw intake with formulas written independently of the engine.

This is a check on the solver, not a copy of it: nothing from gridforge/ is imported. The inputs are the reference hall's intake and the
platform library's published rack figures; the formulas are the textbook ones (apparent to real power by the power factor, N+1 meaning one
unit held back, headroom as capacity less what is already drawn, whole racks only). The expected counts were also computed by hand by an
independent review on 2026-11-03 before this test existed. If the engine and this file ever disagree, one of them is wrong and a person
has to decide which; neither is changed to make the other pass.

Scope, stated so the test is not read as more than it is: it covers the six count constraints that are closed-form on the intake. It does not
cover the gates, the cooling-distribution derate, the economics or the schedule, and it cannot say the shared PUE or the platform figures are right.
"""
from __future__ import annotations

import json
import math
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
INTAKE = json.loads((ROOT / "examples" / "intake" / "reference_hall.json").read_text(encoding="utf-8"))
PACK = json.loads((ROOT / "public" / "reference" / "model_pack.json").read_text(encoding="utf-8"))
PLATFORMS = {p["id"]: p for p in json.loads((ROOT / "public" / "reference" / "platforms.json").read_text(encoding="utf-8"))["platforms"]}

SCENARIO = next(s for s in PACK["scenarios"] if s["id"] == "hybrid_dlc")
PERMITTED = {c["id"]: c["racks_permitted"] for c in SCENARIO["constraints"]}

PLATFORM = PLATFORMS[INTAKE["compute"]["platform"]]
RACK_KW = PLATFORM["rack_kW"]
FLOW = PLATFORM["flow_l_per_min_per_rack"]
PUE = 1.30  # the engine's declared default for this hall: the grid constraint's own basis prints "PUE 1.3 [1.22-1.4]"


def val(x):
    return x["value"] if isinstance(x, dict) else x


def whole(x: float) -> int:
    return math.floor(x + 1e-9)


G = INTAKE["grid"]
PEAK_MW = val(G["current_site_peak_MW"])
IT_MW = val(G["current_it_load_MW"])


def test_the_hall_and_platform_are_the_ones_the_hand_check_used():
    assert (RACK_KW, FLOW, PUE) == (135, 130, 1.30)
    assert (PEAK_MW, IT_MW) == (7.4, 4.9)


def test_grid_firm_capacity():
    firm_mw = min(G["firm_capacity_MVA"] * G["power_factor"], G["contracted_MW"])  # 13.58 vs 12 -> the contract binds
    headroom_kw = (firm_mw - PEAK_MW) * 1000                                       # 4,600 kW
    assert headroom_kw == pytest.approx(4600)
    assert whole(headroom_kw / PUE / RACK_KW) == PERMITTED["grid_firm_capacity"] == 26


def test_transformer_capacity_after_n_plus_1_and_derating():
    t = INTAKE["transformers"][0]
    usable_units = t["units"] - 1                                                  # N+1: one unit held back
    mw = t["unit_rating_MVA"] * G["power_factor"] * t["derating_factor"] * usable_units
    headroom_kw = (mw - PEAK_MW) * 1000                                            # 1,330 kW
    assert headroom_kw == pytest.approx(1330, abs=1)
    assert whole(headroom_kw / PUE / RACK_KW) == PERMITTED["transformer_capacity"] == 7


def test_ups_protected_load_has_no_pue_because_it_carries_only_it_load():
    u = INTAKE["ups"][0]
    protected_kw = (u["units"] - 1) * u["unit_rating_kW"]                          # 6,000 kW
    headroom_kw = protected_kw - IT_MW * 1000                                      # 1,100 kW
    assert headroom_kw == pytest.approx(1100)
    assert whole(headroom_kw / RACK_KW) == PERMITTED["ups_capacity"] == 8


def test_busway_is_pooled_across_runs_and_uses_the_three_phase_factor():
    lv = INTAKE["lv"]
    per_run_kw = math.sqrt(3) * lv["voltage_V"] * val(lv["busway_ampacity_A"]) * lv["busway_utilisation_limit"] * G["power_factor"] / 1000
    assert per_run_kw == pytest.approx(215.05, abs=0.05)
    assert whole(per_run_kw * lv["busway_runs"] / RACK_KW) == PERMITTED["busway_ampacity"] == 12
    # The same hall with each rack fed from a single run counts whole racks run by run, which is fewer.
    assert lv["busway_runs"] * whole(per_run_kw / RACK_KW) == 8 < 12


def test_chilled_water_plant_headroom_is_capacity_less_the_existing_it_load():
    plant_kw = INTAKE["thermal"]["plant"]["chilled_water_capacity_kW"]
    assert whole((plant_kw - IT_MW * 1000) / RACK_KW) == PERMITTED["plant_capacity"] == 14


def test_hydraulic_flow_is_available_flow_over_rack_flow():
    pump = INTAKE["thermal"]["plant"]["pump_flow_capacity_l_per_min"]
    assert whole(pump / FLOW) == PERMITTED["hydraulic_flow"] == 69


def test_the_binding_count_is_the_minimum_of_the_counts_and_the_gates_hold_the_hall_at_zero():
    counted = {k: v for k, v in PERMITTED.items() if v is not None and k not in ("rack_feed_tapoff", "residual_air_removal")}
    assert min(counted.values()) == 7                      # transformer capacity: the smallest ceiling
    assert PERMITTED["rack_feed_tapoff"] == 0              # 63 A installed against about 205 A needed: the gate
    assert SCENARIO["as_found"]["racks"] == 0
    # The tap-off need, recomputed: I = P / (sqrt(3) V pf), with the power factor the engine uses for a rack feed.
    need_a = RACK_KW * 1000 / (math.sqrt(3) * INTAKE["lv"]["voltage_V"] * 0.95)
    assert need_a == pytest.approx(205, abs=1)
    assert need_a > INTAKE["lv"]["tapoff_max_A"]
