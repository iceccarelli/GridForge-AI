"""The load-profile CSV a customer exports, and what the BTM assessment does with it.

Each test is a way a real export was observed to be misread, or to crash the endpoint:
repeated timestamps (a zero sampling interval and a ZeroDivisionError reported as a generic 422), a file from a
European Excel (BOM, semicolons, decimal commas), a profile in the wrong unit or too short to size anything from.
"""
from __future__ import annotations

import copy

import pytest

from gridforge.api.server import ApiError, handle_power_deploy_assess
from gridforge.api.tiers import Tier
from gridforge.power.load_profile import LoadProfile, LoadProfileError, from_csv

#: A small deployment request: 20 MW of gas, an 8 MW battery, 10 MW of firm grid against a 35 MW target.
BASE = {
    "grid_firm_MW": 10.0, "target_MW": 35.0, "ride_through_hours": 3.0, "redundancy": "N+1",
    "generation": [
        {"id": "GEN-A", "kind": "gas_engine", "nameplate_MW": 20.0, "capex_eur": 16000000, "lead_time_weeks": 44, "fuel_type": "natural gas"},
        {"id": "GEN-B", "kind": "gas_engine", "nameplate_MW": 20.0, "capex_eur": 16000000, "lead_time_weeks": 44, "fuel_type": "natural gas"}],
    "bess": [{"id": "BESS-1", "power_MW": 8.0, "energy_MWh": 32.0, "capex_eur": 7200000, "lead_time_weeks": 30}],
    "interconnection": {"utility": "TenneT", "pcc_voltage_kV": 20, "import_capacity_MW": 15},
    "permitting": {"emissions_status": "application submitted"},
}


def request(csv: str, **extra) -> dict:
    body = copy.deepcopy(BASE)
    body["load_profile"] = {"csv": csv, "source": "test.csv"}
    body.update(extra)
    return body


def refusal(csv: str, **extra) -> str:
    with pytest.raises(ApiError) as exc:
        handle_power_deploy_assess(request(csv, **extra), Tier.CLIENT)
    assert exc.value.status == 422
    return str(exc.value)


# --- N11: repeated timestamps ---------------------------------------------------------------------------------------------------

THREE_EQUAL_ONE_LATER = ("timestamp,kW\n2026-01-01T00:00:00,1000\n2026-01-01T00:00:00,1000\n"
                         "2026-01-01T00:00:00,1000\n2026-01-01T00:15:00,1000\n")


def test_repeated_timestamps_are_refused_by_row_not_as_a_division_by_zero():
    """Three equal timestamps and one later made the median step zero, so the inferred interval was 0 and gaps() divided by it: the endpoint
    answered 'ZeroDivisionError: float division by zero' and the real cause, repeated timestamps, was never named."""
    message = refusal(THREE_EQUAL_ONE_LATER)
    assert "ZeroDivision" not in message and "division" not in message
    assert "row 3" in message and "row 4" in message and "row 2" in message, message
    assert message.startswith("load_profile:"), "the module's normal refusal shape names the request field"
    assert "one reading per instant" in message


def test_a_single_repeat_among_many_readings_is_refused_naming_both_rows():
    csv = "timestamp,kW\n" + "".join(f"2026-01-01T{h:02d}:00:00,1000\n" for h in range(6)) + "2026-01-01T03:00:00,900\n"
    message = refusal(csv)
    assert "row 8 repeats the timestamp of row 5" in message, message


def test_every_reading_at_one_instant_is_refused_not_given_a_zero_interval():
    message = refusal("timestamp,kW\n2026-01-01T00:00:00,1000\n2026-01-01T00:00:00,1000\n")
    assert "repeats the timestamp of row 2" in message


def test_the_library_refuses_the_same_file_with_its_own_error():
    with pytest.raises(LoadProfileError, match="row 3 repeats the timestamp of row 2"):
        from_csv(THREE_EQUAL_ONE_LATER)


def test_a_profile_built_in_code_cannot_carry_a_zero_interval():
    from gridforge.power.load_profile import LoadSample
    from datetime import datetime
    from gridforge.common import ASSUMED
    samples = [LoadSample(datetime(2026, 1, 1), 1.0), LoadSample(datetime(2026, 1, 1, 1), 1.0)]
    for bad in (0.0, -15.0, float("nan"), float("inf")):
        with pytest.raises(LoadProfileError, match="sampling interval"):
            LoadProfile(samples=samples, interval_minutes=bad, evidence=ASSUMED)


def test_timestamps_with_and_without_an_offset_are_refused_by_row_not_a_type_error():
    message = refusal("timestamp,kW\n2026-01-01T00:00:00Z,1000\n2026-01-01T00:15:00,1000\n")
    assert "row 3" in message and "UTC offset" in message, message
    assert "TypeError" not in message and "offset-naive" not in message


def test_readings_in_reverse_order_are_still_accepted_and_sorted():
    """Out-of-order is not a repeat: a newest-first export is a legitimate file and is sorted, never refused."""
    csv = "timestamp,kW\n" + "".join(f"2026-01-01T00:{m:02d}:00,{1000 + m}\n" for m in (45, 30, 15, 0))
    lp = from_csv(csv)
    assert [s.timestamp.minute for s in lp.samples] == [0, 15, 30, 45] and lp.interval_minutes == 15.0
