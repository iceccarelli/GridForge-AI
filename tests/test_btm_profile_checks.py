"""What the BTM assessment may say when the load profile cannot be trusted (audit J3-2).

A load CSV in MW under a kW header gave a peak of 0.032 MW and 'GRID ONLY' passed; `next_action` said 'Obtain a budgetary or firm quote for: '
with an empty list; a 1- or 3-sample profile (the documented example uses 3) said 'green light to prepare an RFQ' while the 'directional' warning
sat only in `load_profile.warnings`.
"""
from __future__ import annotations

import copy

import pytest

from gridforge.api.server import ApiError, _btm_spec_from_body, handle_power_deploy_assess
from gridforge.api.tiers import Tier
import gridforge.power.load_profile as LP
from gridforge.power.load_profile import from_csv

BASE = {
    "grid_firm_MW": 10.0, "target_MW": 35.0, "ride_through_hours": 3.0, "redundancy": "N+1",
    "generation": [
        {"id": "GEN-A", "kind": "gas_engine", "nameplate_MW": 20.0, "capex_eur": 16000000, "lead_time_weeks": 44, "fuel_type": "natural gas"},
        {"id": "GEN-B", "kind": "gas_engine", "nameplate_MW": 20.0, "capex_eur": 16000000, "lead_time_weeks": 44, "fuel_type": "natural gas"}],
    "bess": [{"id": "BESS-1", "power_MW": 8.0, "energy_MWh": 32.0, "capex_eur": 7200000, "lead_time_weeks": 30}],
    "interconnection": {"utility": "TenneT", "pcc_voltage_kV": 20, "import_capacity_MW": 15},
    "permitting": {"emissions_status": "application submitted"},
}


def series(kW, n, minutes=15) -> str:
    rows = []
    for i in range(n):
        t = i * minutes
        rows.append(f"2026-01-{1 + t // 1440:02d}T{(t % 1440) // 60:02d}:{t % 60:02d}:00,{kW}")
    return "timestamp,kW\n" + "\n".join(rows) + "\n"


def assess(csv: str, **extra) -> dict:
    body = copy.deepcopy(BASE)
    body["load_profile"] = {"csv": csv}
    body.update(extra)
    return handle_power_deploy_assess(body, Tier.CLIENT)


# --- a peak that is a unit slip -------------------------------------------------------------------------------------------------

def test_mw_values_under_a_kw_header_do_not_pass_green_and_say_what_to_check():
    out = assess(series(32, 24))                     # 32 MW written as 32, under a kW header: a 0.032 MW peak against a 35 MW target
    lp = out["load_profile"]
    assert lp["peak_MW"] == 0.032 and lp["peak_plausible"] is False
    warning = next(w for w in lp["warnings"] if w.startswith("implausible peak"))
    assert "unit" in warning and "MW" in warning and "35" in warning and "32000 kW" in warning, warning
    assert all(a["status"] != "pass" for a in out["architectures"]), "no architecture is called a pass on a probable unit slip"
    assert all(a["rfq_ready"] is False for a in out["architectures"])
    assert any("load profile:" in b for a in out["architectures"] for b in a["blocking"])
    act = out["next_action"]
    assert act["action"].startswith("Check the units of the load profile") and "Proceed to RFQ" not in act["action"]
    assert "unit" in act["why"] and act["profile_problem"]


def test_a_probable_unit_slip_blocks_the_rfq_gate_the_spec_endpoint_checks():
    body = copy.deepcopy(BASE)
    body["load_profile"] = {"csv": series(32, 24)}
    body.update(architecture="GRID + BESS + GENERATION", require_rfq_ready=True)
    with pytest.raises(ApiError) as exc:
        _btm_spec_from_body(body)
    assert exc.value.status == 409 and "not RFQ-ready" in str(exc.value)


def test_a_peak_a_thousand_times_too_large_is_named_too():
    # 4,000,000 kW (4,000 MW: a 4 MW site written in W under a kW header) against a 35 MW target and 10 MW grid
    out = assess(series(4_000_000, 96))
    assert out["load_profile"]["peak_plausible"] is False
    assert "W" in next(w for w in out["load_profile"]["warnings"] if w.startswith("implausible peak"))
    assert out["next_action"]["action"].startswith("Check the units")


def test_a_peak_within_the_same_order_as_the_target_is_not_flagged():
    out = assess(series(30000, 96))
    assert out["load_profile"]["peak_plausible"] is True
    assert not any(w.startswith("implausible") for w in out["load_profile"]["warnings"])


def test_the_plausibility_boundary_and_the_both_references_rule():
    f = LP.PEAK_PLAUSIBILITY_FACTOR
    peak_plausibility_problem = LP.peak_plausibility_problem
    assert f == 100.0
    assert peak_plausibility_problem(100.0, 35.0, 10.0) == "", "exactly 100 times below the nearer reference (the 10 MW grid) is the boundary: not flagged"
    assert peak_plausibility_problem(99.0, 35.0, 10.0) != ""
    assert peak_plausibility_problem(200.0, 35.0, 0.1) == "", "tiny against the target but not against the grid capacity: not flagged"
    assert peak_plausibility_problem(5.0, 35.0, 0.0) != "" and peak_plausibility_problem(5.0, 0.0, 0.0) == "", "nothing to compare with: not flagged"
    assert peak_plausibility_problem(float("nan"), 35.0, 10.0) == ""


# --- a profile that is too short to size from -----------------------------------------------------------------------------------

@pytest.mark.parametrize("n", [1, 3])
def test_a_one_or_three_sample_profile_carries_the_directional_caveat_in_the_next_action(n):
    """The documented example uses 3 samples. Old: 'Proceed to RFQ for: ... This is a green light to prepare an RFQ' with the caveat only in warnings."""
    out = assess(series(30000, n))
    act = out["next_action"]
    assert out["load_profile"]["directional"] is True and act["directional"] is True
    assert "directional only" in act["action"] and act["action"].startswith("Proceed to RFQ for: GRID + BESS + GENERATION"), act["action"]
    assert "green light to prepare an RFQ" not in act["why"] and "NOT a green light to build" in act["why"]
    assert f"only {n} sample(s)" in act["directional_reason"] and f"{LP.MIN_SAMPLES_FOR_SIZING} samples" in act["directional_reason"]
    assert "full-day" in act["why"]


def test_a_full_day_profile_is_not_directional_and_keeps_the_plain_answer():
    out = assess(series(30000, 96))
    act = out["next_action"]
    assert out["load_profile"]["directional"] is False and "directional" not in act
    assert act["action"] == "Proceed to RFQ for: GRID + BESS + GENERATION" and "green light to prepare an RFQ" in act["why"]
    assert not any("sample(s)" in w for w in out["load_profile"]["warnings"])


@pytest.mark.parametrize("n, minutes, directional", [
    (24, 60, False),        # a day of hourly readings: 24 samples, 24 h
    (23, 60, True),         # one reading short of a day
    (96, 15, False),        # a day at 15 minutes
    (95, 15, True),
    (24, 15, True),         # 24 samples but only 6 h
    (4, 360, True),         # 24 h but only four readings
])
def test_the_documented_minimum_is_24_samples_over_24_hours(n, minutes, directional):
    assert LP.MIN_SAMPLES_FOR_SIZING == 24 and LP.MIN_SPAN_HOURS_FOR_SIZING == 24.0
    lp = from_csv(series(100, n, minutes))
    assert bool(lp.directional_reason()) is directional
    assert bool(lp.validate().directional) is directional


# --- no quote sentence for nothing ----------------------------------------------------------------------------------------------

def test_a_grid_only_pass_never_asks_for_a_quote_for_an_empty_list():
    """Old: 'Obtain a budgetary or firm quote for: ' (nothing after the colon) because GRID ONLY has no units to price."""
    out = assess(series(8000, 96), generation=[], bess=[])        # an 8 MW site on a 10 MW grid: GRID ONLY passes
    assert out["architectures"][0]["label"] == "GRID ONLY" and out["architectures"][0]["status"] == "pass"
    act = out["next_action"]
    assert "quote" not in act["action"] and act["action"].startswith("No equipment purchase is indicated"), act["action"]
    assert "gap to the target is 25.0 MW" in act["why"] and "units" in act["why"]


def test_a_grid_only_pass_beside_priced_equipment_is_noted_in_the_green_answer():
    out = assess(series(8000, 96))
    why = out["next_action"]["why"]
    assert out["next_action"]["action"].startswith("Proceed to RFQ") and "'GRID ONLY' also passes" in why


@pytest.mark.parametrize("csv, extra", [
    (series(32, 24), {"generation": [], "bess": []}),
    (series(8000, 96), {"generation": [], "bess": []}),
    (series(8000, 3), {"generation": [], "bess": []}),
    (series(30000, 96), {}),
    (series(30000, 3), {}),
    (series(32, 24), {}),
])
def test_no_next_action_ends_in_an_empty_list(csv, extra):
    action = assess(csv, **extra)["next_action"]["action"]
    assert not action.rstrip().endswith(":"), action
