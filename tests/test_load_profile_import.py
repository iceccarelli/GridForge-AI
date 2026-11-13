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


# --- J3-3: a file from a European Excel -----------------------------------------------------------------------------------------

ROWS = [("2026-01-01T00:00:00", "30000"), ("2026-01-01T00:15:00", "31000"), ("2026-01-01T00:30:00", "30500")]


def csv_text(sep=",", header="timestamp{s}kW", bom=False, dec="."):
    lines = [header.format(s=sep)] + [f"{t}{sep}{v.replace('.', dec)}" for t, v in ROWS]
    return ("﻿" if bom else "") + "\n".join(lines) + "\n"


def profile(csv: str) -> dict:
    return handle_power_deploy_assess(request(csv), Tier.CLIENT)["load_profile"]


def test_the_reference_comma_file_loads():
    assert profile(csv_text())["peak_MW"] == 31.0


def test_a_utf8_bom_is_dropped_not_stuck_to_the_first_header():
    """Old: expected columns starting 'timestamp,kW[,kVAR]', got ['\\ufefftimestamp', 'kW']"""
    assert profile(csv_text(bom=True))["peak_MW"] == 31.0
    assert from_csv(csv_text(bom=True)).peak_kW().value == 31000, "the library's own reader drops it too"


@pytest.mark.parametrize("sep, name", [(";", "semicolon"), ("\t", "tab")])
def test_semicolon_and_tab_files_load_and_say_how_they_were_read(sep, name):
    """Old: got ['timestamp;kW'], then 'unparseable timestamp' on every row."""
    for bom in (False, True):
        p = profile(csv_text(sep, bom=bom))
        assert p["peak_MW"] == 31.0
        assert any(f"read as {name}-separated" in w for w in p["warnings"]), p["warnings"]


def test_a_semicolon_file_with_decimal_commas_is_read_and_the_reading_is_reported():
    csv = csv_text(";", dec=",")
    csv = csv.replace("31000", "31000,5")
    from gridforge.reporting.load_profile_csv import load_profile_from_csv
    assert load_profile_from_csv(csv, source="t").peak_kW().value == 31000.5, "read as 31000.5 kW, not 310005 or 31000"
    p = profile(csv)
    assert any("decimal comma" in w and "read as decimal points" in w for w in p["warnings"]), p["warnings"]


@pytest.mark.parametrize("sep", [",", "\t"])
def test_a_decimal_comma_outside_a_semicolon_file_is_refused_with_the_reason(sep):
    csv = f'timestamp{sep}kW\n2026-01-01T00:00:00{sep}"1234,5"\n'
    message = refusal(csv)
    assert "row 2" in message and "decimal comma is read only in a semicolon-separated file" in message, message
    assert "refused rather than guessed" in message


@pytest.mark.parametrize("cell", ["1,234", "12,345", "123,456"])
def test_a_cell_that_could_be_a_decimal_comma_or_a_thousands_separator_is_never_guessed(cell):
    message = refusal(f"timestamp;kW\n2026-01-01T00:00:00;{cell}\n")
    assert "row 2" in message and "will not choose" in message, message


def test_a_thousands_separator_beside_a_decimal_comma_is_refused():
    message = refusal("timestamp;kW\n2026-01-01T00:00:00;1.234,5\n")
    assert "mixes a decimal point and a comma" in message


# --- review E10: a thousands dot in a decimal-comma (semicolon) file -----------------------------------------------------------------

@pytest.mark.parametrize("cell,thousands,plain", [("30.000", "30000", "30"), ("1.234", "1234", "1.234"), ("123.456", "123456", "123.456"), ("-30.000", "-30000", "-30")])
def test_a_point_and_exactly_three_digits_in_a_semicolon_file_is_ambiguous_and_refused_by_row_and_column(cell, thousands, plain):
    """`30.000` in a semicolon-separated file is thirty thousand kW in a decimal-comma locale; read as a decimal point it was 30 kW and the profile
    was quietly a thousandth of the hall's real load. It is refused by row and column, with the plain number asked for."""
    message = refusal(f"timestamp;kW\n2026-01-01T00:00:00;{cell}\n")
    assert "row 2: kW" in message, message
    assert f"could be {plain} (read with a decimal point) or {thousands} (read with the point as a thousands separator" in message, message
    assert "this tool will not choose" in message and "Write the plain number with no thousands separator" in message
    assert message.startswith("load_profile:")


def test_the_ambiguous_cell_is_named_in_its_own_row_and_column_not_the_first_row():
    csv = "timestamp;kW;kVAR\n2026-01-01T00:00:00;30000;10\n2026-01-01T00:15:00;31000;12.500\n"
    message = refusal(csv)
    assert "row 3: kVAR" in message and "'12.500'" in message, message


@pytest.mark.parametrize("cell,expect_kW", [("30.5", 30.5), ("30.50", 30.5), ("30.5000", 30.5), ("0.500", 0.5), ("1234.567", 1234.567), ("30000", 30000.0),
                                            ("30,0", 30.0), ("30,5", 30.5), ("12.34", 12.34), ("12.3", 12.3), ("100.00", 100.0)])
def test_the_plain_numbers_of_a_semicolon_file_are_still_read_as_documented(cell, expect_kW):
    """Not three digits after the point, a leading zero (never a thousands group), four or more digits before the point, or a decimal comma: read."""
    from gridforge.reporting.load_profile_csv import load_profile_from_csv
    rows = "".join(f"2026-01-01T{h:02d}:00:00;{cell}\n" for h in range(2))
    assert load_profile_from_csv("timestamp;kW\n" + rows, source="t").peak_kW().value == pytest.approx(expect_kW)


def test_a_comma_with_three_digits_is_still_refused_by_name_as_before():
    message = refusal("timestamp;kW\n2026-01-01T00:00:00;30,000\n")
    assert "row 2" in message and "will not choose" in message and "30,000" in message


@pytest.mark.parametrize("sep", [",", "\t"])
def test_a_point_and_three_digits_in_a_comma_or_tab_file_is_a_plain_decimal(sep):
    """The ambiguity is the decimal-comma locale's: a comma- or tab-separated file has no decimal comma, so `30.000` is thirty."""
    from gridforge.reporting.load_profile_csv import load_profile_from_csv
    csv = f"timestamp{sep}kW\n2026-01-01T00:00:00{sep}30.000\n2026-01-01T01:00:00{sep}31.250\n"
    assert load_profile_from_csv(csv, source="t").peak_kW().value == pytest.approx(31.25)


def test_the_library_reader_refuses_the_same_cell_in_a_semicolon_file_with_its_own_error():
    from gridforge.power.load_profile import CsvRows, from_rows
    rows = CsvRows([(1, ["timestamp", "kW"]), (2, ["2026-01-01T00:00:00", "30.000"]), (3, ["2026-01-01T01:00:00", "31.000"])], ";")
    with pytest.raises(LoadProfileError, match="row 2: kW.*could be 30"):
        from_rows(rows)


def test_rows_are_named_by_the_line_the_customer_sees_with_comments_above():
    csv = "# exported 2026-01-02\n\ntimestamp;kW\n2026-01-01T00:00:00;100\n2026-01-01T00:15:00;abc\n"
    assert "row 5" in refusal(csv)


def test_a_day_first_date_is_refused_saying_why_not_guessed():
    message = refusal("timestamp;kW\n01.01.2026 00:00;100\n01.01.2026 00:15;100\n")
    assert "row 2" in message and "ISO 8601" in message and "two ways" in message, message


def test_a_separator_that_is_none_of_the_three_names_the_cause():
    message = refusal("timestamp|kW\n2026-01-01T00:00:00|100\n")
    assert "single cell" in message and "'timestamp|kW'" in message and "comma, semicolon or tab" in message, message


def test_the_library_reader_alone_names_a_semicolon_file_instead_of_a_bare_mismatch():
    with pytest.raises(LoadProfileError) as exc:
        from_csv("timestamp;kW\n2026-01-01T00:00:00;100\n")
    assert "semicolon-separated" in str(exc.value) and "single cell" in str(exc.value)


def test_a_delimiter_tie_is_refused_by_the_importers_own_rule():
    message = refusal("timestamp;kW,x\n2026-01-01T00:00:00;100,1\n")
    assert "delimiter is ambiguous" in message


def test_python_only_number_forms_are_not_numbers():
    for cell in ("1_000", "٣"):
        assert "unparseable number" in refusal(f"timestamp,kW\n2026-01-01T00:00:00,{cell}\n")
