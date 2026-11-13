"""Two ways a customer's equipment schedule was misread (audit J6-1, J6-2).

J6-1: `TX-A` and `tx-a` were two banks (the duplicate check was case-sensitive); counting both moved a date from 160 to 36 weeks.
J6-2: a title row above the header was refused with 'no column gives unit_rating_MVA', which does not say 'delete the rows above the header'.
"""
from __future__ import annotations

import pytest

from gridforge.intake.schedule_import import ScheduleImportError, parse_schedule

HDR = "Asset ID,Rating (MVA),Units,Redundancy"


def parse(text: str, kind="transformers"):
    return parse_schedule(text.encode("utf-8"), file_name="s.csv", kind=kind, rows_are_installed=True)


def refusal(text: str, kind="transformers") -> str:
    with pytest.raises(ScheduleImportError) as exc:
        parse(text, kind)
    return str(exc.value)


# --- J6-1: ids are one id whatever their case ---------------------------------------------------------------------------------

def test_two_spellings_of_one_id_are_refused_naming_both_spellings_and_both_rows():
    message = refusal(f"{HDR}\nTX-A,5,2,N+1\ntx-a,5,2,N+1\n")
    assert "row 3" in message and "'tx-a'" in message and "repeats row 2" in message and "'TX-A'" in message, message
    assert "letter case" in message and "counted twice" in message


@pytest.mark.parametrize("a, b", [("TX-A", "Tx-a"), ("tx-a", "TX-A"), ("Trafo-1", "TRAFO-1"), ("TX-ß", "tx-SS")])
def test_ids_differing_only_in_case_are_a_repeat(a, b):
    assert "repeats row 2" in refusal(f"{HDR}\n{a},5,2,N+1\n{b},5,2,N+1\n")


def test_an_id_with_padding_is_the_same_id():
    message = refusal(f'{HDR}\nTX-A,5,2,N+1\n"  TX-A ",5,2,N+1\n')
    assert "repeats row 2" in message


def test_distinct_ids_are_not_a_repeat_and_keep_their_own_spelling():
    parsed = parse(f"{HDR}\nTX-A,5,2,N+1\nTX-B,5,2,N+1\nTX-A1,5,1,N\n")
    assert [i["id"] for i in parsed.items] == ["TX-A", "TX-B", "TX-A1"]


def test_the_exact_repeat_message_still_says_repeats_row():
    message = refusal(f"{HDR}\nTX-A,5,2,N+1\nTX-A,5,2,N+1\n")
    assert "repeats row 2" in message and "differ only in letter case" not in message


def test_the_ups_importer_compares_ids_the_same_way():
    message = refusal("Asset ID,Module rating (kW),Units,Redundancy\nUPS-1,1200,6,N+1\nups-1,1200,6,N+1\n", "ups")
    assert "repeats row 2" in message and "letter case" in message


# --- J6-2: a title row above the header ---------------------------------------------------------------------------------------

def test_a_title_row_above_the_header_is_named_and_the_fix_is_said():
    message = refusal(f"Transformer schedule rev C\n{HDR}\nTX-A,5,2,N+1\n")
    assert "row 1" in message and "title row" in message and "row 2" in message, message
    assert "Delete the rows above the header" in message
    assert "no column gives" in message, "the original cause is still reported beside the hint"


def test_a_title_row_padded_with_delimiters_in_a_semicolon_file():
    message = refusal("Transformer schedule rev C;;;\nAsset ID;Rating (MVA);Units;Redundancy\nTX-A;5;2;N+1\n")
    assert "title row" in message and "row 2" in message and "Delete the rows above" in message


def test_two_lines_of_title_matter_and_the_header_is_found_below_them():
    message = refusal(f"ACME Data Centres\n\nIssued 2026-03-01\n{HDR}\nTX-A,5,2,N+1\n")
    assert "row 1" in message and "row 4" in message and "Delete the rows above" in message, message


def test_a_title_with_no_header_below_it_still_says_it_is_a_title():
    message = refusal("Transformer schedule rev C\nTX-A,5,2,N+1\n")
    assert "single non-empty cell" in message and "title" in message and "Delete the rows above" in message


def test_a_real_header_with_another_problem_is_not_called_a_title_row():
    message = refusal("Asset ID,Units,Redundancy\nTX-A,2,N+1\n")
    assert "no column gives" in message and "title" not in message


def test_unknown_columns_in_the_first_row_with_nothing_below_are_not_called_a_title_row():
    message = refusal("Name of thing,Foo,Bar\nTX-A,5,2\n")
    assert "title" not in message


def test_a_file_whose_header_is_the_first_row_is_unaffected():
    parsed = parse(f"{HDR}\nTX-A,5,2,N+1\n")
    assert parsed.items[0]["id"] == "TX-A"
