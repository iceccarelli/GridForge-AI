"""The equipment-schedule CSV importer (gridforge/intake/schedule_import.py): a customer's transformer or UPS schedule export becomes the
intake's `transformers` / `ups` list, with a provenance ledger, and NEVER an invented value.

What is pinned here, by the number in the brief:

  1  golden        a schedule equivalent to examples/intake/reference_hall.json gives the same max_racks and constraint racks through the solver
  2  traceability  every emitted number re-derives from a ledger cell (raw text + conversion), and that cell is where the ledger says it is
  3  refusals      each refusal is all-or-nothing, names the file row and column, and writes nothing
  4  no invention  a seeded randomized pass: random layouts give the canonical items or a refusal, never a different item
  5  idempotence   the same input twice is byte-identical output and ledger
  6  gaps          what the file does not say stays a REQUIRED named gap after the real loader, and blocks issue
  7  merge         a non-empty section is replaced only with --replace, and the report says what was replaced
  8  CLI           exit 0 / 2 and the unmapped / excluded / gap summaries on stdout / stderr
  9  hostile       size and row caps, NUL, a huge cell, nested quotes, mixed line endings, non-ASCII digits, formula prefixes

Every figure in the fixtures and in the generated files is SYNTHETIC. The importer assigns no evidence class; test_the_loader_gives_the_evidence_*
documents what the loader assigns, so the sentence in the importer's docstring and report stays true.
"""
from __future__ import annotations

import copy
import csv
import io
import json
import random
import re
import subprocess
import sys
from collections import namedtuple
from fractions import Fraction
from pathlib import Path

import pytest

from gridforge import cli as gf_cli
from gridforge.envelope import solve
from gridforge.intake import schedule_import as si
from gridforge.intake.loader import (EQUIPMENT_KEYS, MAX_EQUIPMENT_ITEMS, PLAUSIBLE_MAX, IntakeError, _REDUNDANCY, load_document)
from gridforge.intake.schedule_import import MAX_BYTES, MAX_DATA_ROWS, ScheduleImportError, import_schedule, parse_schedule
from gridforge.validation import EvidenceClass

ROOT = Path(__file__).resolve().parents[1]
FIX = Path(__file__).resolve().parent / "fixtures_schedule"
REFERENCE = json.loads((ROOT / "examples" / "intake" / "reference_hall.json").read_text(encoding="utf-8"))

TX_MAX_MVA = PLAUSIBLE_MAX["transformers.unit_rating_MVA"]
TX_MAX_UNITS = PLAUSIBLE_MAX["transformers.units"]
TX_MAX_WEEKS = PLAUSIBLE_MAX["transformers.replacement_lead_time_weeks"]
UPS_MAX_KW = PLAUSIBLE_MAX["ups.unit_rating_kW"]
UPS_MAX_UNITS = PLAUSIBLE_MAX["ups.units"]


# ------------------------------------------------------------------------------------------------------------------ helpers
Run = namedtuple("Run", "rc out err out_path ledger_path src")


def run_main(capsys, *argv):
    rc = gf_cli.main([str(a) for a in argv])
    cap = capsys.readouterr()
    return rc, cap.out, cap.err


def invoke(tmp_path, capsys, content, kind="transformers", *flags, name="schedule.csv", into=None, installed=True, label=None) -> Run:
    """Write `content` (str or bytes) as the schedule and run the real CLI entry in-process."""
    src = tmp_path / name
    src.write_bytes(content if isinstance(content, bytes) else content.encode("utf-8"))
    out, led = tmp_path / "out.json", tmp_path / "out.import.json"
    argv = ["import-schedule", src, "--kind", kind, "-o", out, "--ledger", led]
    if installed:
        argv.append("--rows-are-installed")
    if into is not None:
        argv += ["--into", into]
    if label is not None:
        argv += ["--source-label", label]
    argv += list(flags)
    rc, o, e = run_main(capsys, *argv)
    return Run(rc, o, e, out, led, src)


def assert_nothing_written(r: Run, tmp_path):
    assert not r.out_path.exists() and not r.ledger_path.exists()
    assert sorted(p.name for p in tmp_path.iterdir()) == [r.src.name], "a refusal left a file behind (a temp file counts)"


def parse(text, kind="transformers", **kw):
    data = text if isinstance(text, bytes) else text.encode("utf-8")
    kw.setdefault("rows_are_installed", True)
    return parse_schedule(data, file_name="schedule.csv", kind=kind, **kw)


def fixture(name):
    return (FIX / name).read_bytes()


BASE_HDR = "Asset ID,Rating (MVA),Units,Redundancy,Derating factor,Replacement lead time (weeks)"
GOOD_TX = "SYN-TX-1,5,3,N+1,0.9,160"
UPS_HDR = "Asset ID,Module rating (kW),Units,Redundancy,Step load capability"
GOOD_UPS = "SYN-UPS-1,1200,6,N+1,0.5"


def tx_csv(*rows, header=BASE_HDR):
    return header + "\n" + "\n".join(rows) + "\n"


def ups_csv(*rows, header=UPS_HDR):
    return header + "\n" + "\n".join(rows) + "\n"


# ================================================================================================================ 1: golden
def test_golden_a_schedule_equivalent_to_the_reference_hall_gives_the_same_racks():
    tx = import_schedule(FIX / "SYNTHETIC_transformers_reference_equivalent.csv", "transformers", rows_are_installed=True)
    up = import_schedule(FIX / "SYNTHETIC_ups_reference_equivalent.csv", "ups", rows_are_installed=True)
    doc = copy.deepcopy(REFERENCE)
    doc["transformers"], doc["ups"] = tx.items, up.items
    ref = solve(load_document(REFERENCE).context)
    new = solve(load_document(doc).context)
    assert new.max_racks == ref.max_racks
    assert {c.id: c.racks for c in new.constraints} == {c.id: c.racks for c in ref.constraints}
    # the item is the reference's item, apart from the id the schedule gave it
    strip = lambda i: {k: v for k, v in i.items() if k != "id"}      # noqa: E731
    assert strip(tx.items[0]) == strip(REFERENCE["transformers"][0])
    assert strip(up.items[0]) == strip(REFERENCE["ups"][0])


def test_golden_is_sensitive_the_same_check_fails_for_a_schedule_that_differs():
    """A comparison that cannot fail proves nothing: one unit fewer in the bank moves the transformer constraint."""
    tx = parse(tx_csv("SYN-TX-1,5.0,2,N+1,0.9,160")).items
    doc = copy.deepcopy(REFERENCE)
    doc["transformers"] = tx
    ref = {c.id: c.racks for c in solve(load_document(REFERENCE).context).constraints}
    new = {c.id: c.racks for c in solve(load_document(doc).context).constraints}
    assert new != ref


def test_golden_through_the_cli_in_two_merges(tmp_path, capsys):
    base = tmp_path / "hall.json"
    base.write_text(json.dumps(REFERENCE, indent=2), encoding="utf-8")
    t_out, t_led = tmp_path / "step1.json", tmp_path / "step1.import.json"
    rc, out, err = run_main(capsys, "import-schedule", FIX / "SYNTHETIC_transformers_reference_equivalent.csv", "--kind", "transformers",
                            "--rows-are-installed", "--into", base, "--replace", "-o", t_out, "--ledger", t_led)
    assert rc == 0, err
    u_out, u_led = tmp_path / "step2.json", tmp_path / "step2.import.json"
    rc, out, err = run_main(capsys, "import-schedule", FIX / "SYNTHETIC_ups_reference_equivalent.csv", "--kind", "ups",
                            "--rows-are-installed", "--into", t_out, "--replace", "-o", u_out, "--ledger", u_led)
    assert rc == 0, err
    merged = json.loads(u_out.read_text(encoding="utf-8"))
    ref = solve(load_document(REFERENCE).context)
    new = solve(load_document(merged).context)
    assert new.max_racks == ref.max_racks
    assert {c.id: c.racks for c in new.constraints} == {c.id: c.racks for c in ref.constraints}


# ============================================================================================================ 2: traceability
def _csv_cells_by_row(raw: bytes, delimiter: str) -> dict[int, list[str]]:
    """An independent oracle for 'which cell is at (row, column)': the standard csv module, with row = the physical line a record starts on."""
    reader = csv.reader(io.StringIO(raw.decode("utf-8-sig"), newline=""), delimiter=delimiter)
    rows, prev = {}, 0
    for cells in reader:
        rows[prev + 1] = cells
        prev = reader.line_num
    return rows


def _expected_value(key: str, field: dict):
    ins, conv = field["inputs"], field["conversion"]
    raw0 = ins[0]["raw"].strip()
    if key == "id":
        return raw0
    if key == "redundancy":
        return raw0.upper().replace(" ", "")
    if key == "units":
        assert Fraction(raw0).denominator == 1
        return int(Fraction(raw0))
    if conv is None:
        return float(Fraction(raw0))
    if conv["op"] == "divide":
        return float(Fraction(raw0) / conv["by"])
    if conv["op"] == "multiply":
        return float(Fraction(raw0) * Fraction(ins[1]["raw"].strip()))
    raise AssertionError(f"unknown conversion {conv}")


def assert_traceable(parsed, raw: bytes):
    ledger = parsed.ledger
    cells = _csv_cells_by_row(raw, ledger["delimiter"])
    assert len(ledger["items"]) == len(parsed.items)
    for item, rec in zip(parsed.items, ledger["items"]):
        assert rec["id"] == item["id"]
        assert set(rec["fields"]) == set(item), "an emitted key without a ledger record, or a record without a key"
        for key, field in rec["fields"].items():
            assert field["verified"] is False
            assert field["row"] == rec["row"]
            assert field["value"] == item[key]
            assert _expected_value(key, field) == item[key], (key, field)
            for inp in field["inputs"]:
                assert cells[field["row"]][inp["column"] - 1] == inp["raw"], "the ledger names a cell that does not hold that text"
                assert cells[ledger["header_row"]][inp["column"] - 1] == inp["header"]
    assert all_verified_false(ledger)


def all_verified_false(node) -> bool:
    if isinstance(node, dict):
        return all((v is False) if k == "verified" else all_verified_false(v) for k, v in node.items())
    if isinstance(node, list):
        return all(all_verified_false(v) for v in node)
    return True


@pytest.mark.parametrize("name, kind", [
    ("SYNTHETIC_transformers_reference_equivalent.csv", "transformers"),
    ("SYNTHETIC_ups_reference_equivalent.csv", "ups"),
    ("SYNTHETIC_transformers_kva_status_semicolon.csv", "transformers"),
    ("SYNTHETIC_ups_kva_with_power_factor.csv", "ups"),
    ("SYNTHETIC_transformers_no_redundancy_column.csv", "transformers"),
])
def test_every_emitted_number_traces_to_a_ledger_cell(name, kind):
    raw = fixture(name)
    parsed = parse_schedule(raw, file_name=name, kind=kind, rows_are_installed="status" not in raw.decode().lower())
    assert parsed.items
    assert_traceable(parsed, raw)


def test_conversions_are_exact_decimal_not_float_arithmetic():
    """101 kVA x 0.8 is 80.8 kW and 1600.1 kVA is 1.6001 MVA. In float arithmetic they are 80.80000000000001 and 1.6000999999999999: values nobody wrote."""
    assert 101 * 0.8 != 80.8 and float("1600.1") / 1000 != 1.6001          # the traps, so this test cannot pass for the wrong reason
    p = parse(ups_csv("SYN-UPS-1,101,0.8,4,N+1", header="Asset ID,Rating (kVA),Power factor,Units,Redundancy"), "ups")
    assert p.items[0]["unit_rating_kW"] == 80.8
    q = parse(tx_csv("SYN-TX-1,1600.1,2,N+1,,", header=BASE_HDR.replace("(MVA)", "(kVA)")))
    assert q.items[0]["unit_rating_MVA"] == 1.6001
    assert q.ledger["items"][0]["fields"]["unit_rating_MVA"]["conversion"] == {"op": "divide", "by": 1000, "from_unit": "kVA", "to_unit": "MVA"}


def test_the_ledger_records_both_inputs_of_a_kva_times_power_factor_rating():
    raw = fixture("SYNTHETIC_ups_kva_with_power_factor.csv")
    p = parse_schedule(raw, file_name="u.csv", kind="ups", rows_are_installed=True)
    f = p.ledger["items"][0]["fields"]["unit_rating_kW"]
    assert [(i["role"], i["header"], i["raw"]) for i in f["inputs"]] == [("kVA", "Rating (kVA)", "1111"), ("power_factor", "PF", "0.9")]
    assert f["conversion"] == {"op": "multiply", "factors": ["kVA", "power_factor"], "to_unit": "kW"}
    assert p.items[0]["unit_rating_kW"] == 999.9 and p.items[1]["unit_rating_kW"] == 400


def test_the_ledger_carries_source_provenance_and_no_clock():
    raw = fixture("SYNTHETIC_transformers_reference_equivalent.csv")
    p = parse_schedule(raw, file_name="E-101.csv", kind="transformers", rows_are_installed=True, source_label="E-101 rev C")
    import hashlib
    assert p.ledger["source"] == {"file": "E-101.csv", "sha256": hashlib.sha256(raw).hexdigest(), "bytes": len(raw), "label": "E-101 rev C"}
    clock_keys = {"timestamp", "generated_at", "created_at", "imported_at", "date", "time", "datetime", "generated"}
    assert not clock_keys & _all_keys(p.ledger)
    assert not re.search(r"\b\d{4}-\d{2}-\d{2}\b|\d{2}:\d{2}:\d{2}", json.dumps(p.ledger))
    q = parse_schedule(raw, file_name="E-101.csv", kind="transformers", rows_are_installed=True)
    assert q.ledger["source"]["label"] is None


def _all_keys(node) -> set:
    if isinstance(node, dict):
        return set(node) | {k for v in node.values() for k in _all_keys(v)}
    if isinstance(node, list):
        return {k for v in node for k in _all_keys(v)}
    return set()


# =============================================================================================================== 3: refusals
# (id, kind, csv, row, column number, column header text, fragment of the reason, installed flag)
def _cases():
    c = []
    add = lambda *a, **k: c.append(pytest.param(*a, id=a[0], **k))                            # noqa: E731
    # ---- empty and placeholder cells
    add("empty-rating", "transformers", tx_csv("SYN-TX-1,,3,N+1,0.9,160"), 2, 2, "Rating (MVA)", "empty")
    add("empty-id", "transformers", tx_csv(",5,3,N+1,0.9,160"), 2, 1, "Asset ID", "empty")
    for tag, cell in (("TBC", "TBC"), ("n-a", "n/a"), ("dash", "-"), ("tbd-lower", "tbd")):
        add(f"placeholder-{tag}", "transformers", tx_csv(f"SYN-TX-1,{cell},3,N+1,0.9,160"), 2, 2, "Rating (MVA)", "placeholder")
    # ---- not a plain decimal
    add("thousands-separator", "transformers", tx_csv('SYN-TX-1,"1,600",3,N+1,0.9,160'), 2, 2, "Rating (MVA)", "thousands separator")
    add("count-times-rating", "transformers", tx_csv("SYN-TX-1,2x1600,3,N+1,0.9,160"), 2, 2, "Rating (MVA)", "product")
    add("formula", "transformers", tx_csv("SYN-TX-1,=1+1,3,N+1,0.9,160"), 2, 2, "Rating (MVA)", "formula")
    add("nan", "transformers", tx_csv("SYN-TX-1,nan,3,N+1,0.9,160"), 2, 2, "Rating (MVA)", "finite")
    add("inf", "transformers", tx_csv("SYN-TX-1,inf,3,N+1,0.9,160"), 2, 2, "Rating (MVA)", "finite")
    add("scientific", "transformers", tx_csv("SYN-TX-1,5e0,3,N+1,0.9,160"), 2, 2, "Rating (MVA)", "scientific")
    add("decimal-comma", "transformers", tx_csv('SYN-TX-1,"1,6",3,N+1,0.9,160'), 2, 2, "Rating (MVA)", "comma")
    add("unit-in-cell", "transformers", tx_csv("SYN-TX-1,5 MVA,3,N+1,0.9,160"), 2, 2, "Rating (MVA)", "unit")
    add("leading-dot", "transformers", tx_csv("SYN-TX-1,.5,3,N+1,0.9,160"), 2, 2, "Rating (MVA)", "plain decimal")
    # ---- value ranges
    add("zero-rating", "transformers", tx_csv("SYN-TX-1,0,3,N+1,0.9,160"), 2, 2, "Rating (MVA)", "above zero")
    add("negative-rating", "transformers", tx_csv("SYN-TX-1,-5,3,N+1,0.9,160"), 2, 2, "Rating (MVA)", "above zero")
    add("rating-above-ceiling", "transformers", tx_csv(f"SYN-TX-1,{TX_MAX_MVA + 1},3,N+1,0.9,160"), 2, 2, "Rating (MVA)", f"{TX_MAX_MVA:g}")
    add("kva-converts-above-ceiling", "transformers", tx_csv(f"SYN-TX-1,{(TX_MAX_MVA + 1) * 1000},3,N+1,0.9,160",
                                                              header=BASE_HDR.replace("(MVA)", "(kVA)")), 2, 2, "Rating (kVA)", f"{TX_MAX_MVA:g}")
    add("units-above-ceiling", "transformers", tx_csv(f"SYN-TX-1,5,{TX_MAX_UNITS + 1},N+1,0.9,160"), 2, 3, "Units", f"{TX_MAX_UNITS:g}")
    add("units-not-integer", "transformers", tx_csv("SYN-TX-1,5,2.5,N+1,0.9,160"), 2, 3, "Units", "whole number")
    add("units-zero", "transformers", tx_csv("SYN-TX-1,5,0,N+1,0.9,160"), 2, 3, "Units", "at least 1")
    add("units-negative", "transformers", tx_csv("SYN-TX-1,5,-2,N+1,0.9,160"), 2, 3, "Units", "at least 1")
    add("units-placeholder", "transformers", tx_csv("SYN-TX-1,5,TBC,N+1,0.9,160"), 2, 3, "Units", "placeholder")
    add("derating-above-one", "transformers", tx_csv("SYN-TX-1,5,3,N+1,1.5,160"), 2, 5, "Derating factor", "at most 1")
    add("derating-zero", "transformers", tx_csv("SYN-TX-1,5,3,N+1,0,160"), 2, 5, "Derating factor", "above zero")
    add("derating-placeholder-in-an-optional-cell", "transformers", tx_csv("SYN-TX-1,5,3,N+1,TBC,160"), 2, 5, "Derating factor", "placeholder")
    add("derating-percent-sign", "transformers", tx_csv("SYN-TX-1,5,3,N+1,90%,160"), 2, 5, "Derating factor", "percent")
    add("lead-time-zero", "transformers", tx_csv("SYN-TX-1,5,3,N+1,0.9,0"), 2, 6, "Replacement lead time (weeks)", "above zero")
    add("lead-time-above-ceiling", "transformers", tx_csv(f"SYN-TX-1,5,3,N+1,0.9,{TX_MAX_WEEKS + 1}"), 2, 6, "Replacement lead time (weeks)", f"{TX_MAX_WEEKS:g}")
    add("lead-time-placeholder", "transformers", tx_csv("SYN-TX-1,5,3,N+1,0.9,TBC"), 2, 6, "Replacement lead time (weeks)", "placeholder")
    add("redundancy-outside-the-accepted-set", "transformers", tx_csv("SYN-TX-1,5,3,2N+1,0.9,160"), 2, 4, "Redundancy", "not one of")
    add("redundancy-placeholder", "transformers", tx_csv("SYN-TX-1,5,3,TBC,0.9,160"), 2, 4, "Redundancy", "not one of")
    add("repeated-id", "transformers", tx_csv(GOOD_TX, GOOD_TX), 3, 1, "Asset ID", "repeats row 2")
    # ---- headers
    add("lead-time-in-months", "transformers", tx_csv(GOOD_TX, header=BASE_HDR.replace("(weeks)", "(months)")), 1, 6, "Replacement lead time (months)", "weeks")
    add("lead-time-in-days", "transformers", tx_csv(GOOD_TX, header=BASE_HDR.replace("(weeks)", "(days)")), 1, 6, "Replacement lead time (days)", "weeks")
    add("lead-time-without-a-unit", "transformers", tx_csv(GOOD_TX, header=BASE_HDR.replace(" (weeks)", "")), 1, 6, "Replacement lead time", "weeks")
    add("rating-without-a-unit", "transformers", tx_csv(GOOD_TX, header=BASE_HDR.replace(" (MVA)", "")), 1, 2, "Rating", "unit")
    add("derating-in-percent-header", "transformers", tx_csv(GOOD_TX, header=BASE_HDR.replace("Derating factor", "Derating (%)")), 1, 5, "Derating (%)", "fraction")
    add("no-rating-column", "transformers", tx_csv("SYN-TX-1,3,N+1", header="Asset ID,Units,Redundancy"), 1, 0, "", "unit_rating_MVA")
    add("no-id-column", "transformers", tx_csv("5,3,N+1", header="Rating (MVA),Units,Redundancy"), 1, 0, "", "asset id")
    add("two-units-columns", "transformers", tx_csv("SYN-TX-1,5,3,N+1,3", header="Asset ID,Rating (MVA),Units,Redundancy,Qty"), 1, 3, "Units", "both")
    add("two-rating-columns-in-one-unit", "transformers", tx_csv("SYN-TX-1,5,5", header="Asset ID,Rating (MVA),Unit rating MVA"), 1, 2, "Rating (MVA)", "both")
    add("two-status-columns", "transformers", tx_csv("SYN-TX-1,5,Installed,Live", header="Asset ID,Rating (MVA),Status,State"), 1, 3, "Status", "both")
    add("row-too-short", "transformers", tx_csv(GOOD_TX, "SYN-TX-2,5,3"), 3, 0, "", "cells")
    add("row-too-long", "transformers", tx_csv(GOOD_TX + ",extra"), 2, 0, "", "cells")
    add("no-status-column-and-no-flag", "transformers", tx_csv(GOOD_TX), 1, 0, "", "--rows-are-installed", marks=())
    # ---- UPS
    add("ups-kva-without-a-power-factor-column", "ups", ups_csv("SYN-UPS-1,1200,6,N+1,0.5", header=UPS_HDR.replace("(kW)", "(kVA)")), 1, 2,
        "Module rating (kVA)", "power factor")
    kva_hdr = "Asset ID,Rating (kVA),Power factor,Units,Redundancy"
    add("ups-kva-with-an-empty-power-factor-cell", "ups", ups_csv("SYN-UPS-1,1200,,6,N+1", header=kva_hdr), 2, 3, "Power factor", "empty")
    add("ups-power-factor-above-one", "ups", ups_csv("SYN-UPS-1,1200,1.2,6,N+1", header=kva_hdr), 2, 3, "Power factor", "at most 1")
    add("ups-power-factor-zero", "ups", ups_csv("SYN-UPS-1,1200,0,6,N+1", header=kva_hdr), 2, 3, "Power factor", "above zero")
    add("ups-converted-rating-above-ceiling", "ups", ups_csv(f"SYN-UPS-1,{UPS_MAX_KW * 2},0.9,6,N+1", header=kva_hdr), 2, 2, "Rating (kVA)", f"{UPS_MAX_KW:g}")
    add("ups-rating-above-ceiling", "ups", ups_csv(f"SYN-UPS-1,{UPS_MAX_KW + 1},6,N+1,0.5"), 2, 2, "Module rating (kW)", f"{UPS_MAX_KW:g}")
    add("ups-units-above-ceiling", "ups", ups_csv(f"SYN-UPS-1,1200,{UPS_MAX_UNITS + 1},N+1,0.5"), 2, 3, "Units", f"{UPS_MAX_UNITS:g}")
    add("ups-step-load-above-one", "ups", ups_csv("SYN-UPS-1,1200,6,N+1,1.2"), 2, 5, "Step load capability", "at most 1")
    add("ups-redundancy-outside-the-set", "ups", ups_csv("SYN-UPS-1,1200,6,3N,0.5"), 2, 4, "Redundancy", "not one of")
    add("ups-rating-in-the-wrong-unit", "ups", ups_csv("SYN-UPS-1,1.2,6,N+1", header="Asset ID,Rating (MW),Units,Redundancy"), 1, 0, "", "unit_rating_kW")
    return c


@pytest.mark.parametrize("case_id, kind, text, row, colno, col_text, fragment", _cases())
def test_refusal_names_row_and_column_and_writes_nothing(tmp_path, capsys, case_id, kind, text, row, colno, col_text, fragment):
    r = invoke(tmp_path, capsys, text, kind, installed=(case_id != "no-status-column-and-no-flag"))
    assert r.rc == 2, (r.out, r.err)
    assert "Traceback" not in r.err
    assert f"row {row}" in r.err, r.err
    if colno:
        assert f"row {row}, column {colno} (" in r.err, r.err
        assert col_text in r.err
    assert fragment.lower() in r.err.lower(), r.err
    assert_nothing_written(r, tmp_path)


def test_every_problem_in_a_file_is_reported_together_not_one_per_attempt(tmp_path, capsys):
    text = tx_csv("SYN-TX-1,TBC,3,N+1,0.9,160", "SYN-TX-2,5,2.5,N+1,0.9,160", "SYN-TX-3,5,3,2N+1,0.9,160")
    r = invoke(tmp_path, capsys, text)
    assert r.rc == 2
    for needle in ("row 2, column 2", "row 3, column 3", "row 4, column 4"):
        assert needle in r.err, r.err
    assert_nothing_written(r, tmp_path)


def test_a_refusal_leaves_an_existing_output_untouched(tmp_path, capsys):
    out = tmp_path / "out.json"
    out.write_text("PREVIOUS", encoding="utf-8")
    r = invoke(tmp_path, capsys, tx_csv("SYN-TX-1,TBC,3,N+1,0.9,160"))
    assert r.rc == 2 and out.read_text(encoding="utf-8") == "PREVIOUS"


def test_the_ceilings_and_the_scheme_set_are_the_loaders_own_not_retyped(monkeypatch):
    from gridforge.intake import loader
    assert si.PLAUSIBLE_MAX is loader.PLAUSIBLE_MAX and si.EQUIPMENT_KEYS is loader.EQUIPMENT_KEYS and si._REDUNDANCY is loader._REDUNDANCY
    assert parse(tx_csv(GOOD_TX)).items                                 # 5 MVA is fine ...
    monkeypatch.setitem(PLAUSIBLE_MAX, "transformers.unit_rating_MVA", 4)
    with pytest.raises(ScheduleImportError) as exc:                      # ... until the loader's own ceiling moves
        parse(tx_csv(GOOD_TX))
    assert "row 2, column 2" in str(exc.value)


def test_values_exactly_at_the_ceilings_are_accepted():
    p = parse(tx_csv(f"SYN-TX-1,{TX_MAX_MVA},{TX_MAX_UNITS},N+1,1,{TX_MAX_WEEKS}"))
    assert p.items[0]["unit_rating_MVA"] == TX_MAX_MVA and p.items[0]["units"] == TX_MAX_UNITS
    assert p.items[0]["replacement_lead_time_weeks"] == TX_MAX_WEEKS and p.items[0]["derating_factor"] == 1
    q = parse(tx_csv(f"SYN-TX-1,{TX_MAX_MVA * 1000},2,N+1,,", header=BASE_HDR.replace("(MVA)", "(kVA)")))
    assert q.items[0]["unit_rating_MVA"] == TX_MAX_MVA
    u = parse(ups_csv(f"SYN-UPS-1,{UPS_MAX_KW},{UPS_MAX_UNITS},N+1,1"), "ups")
    assert u.items[0]["unit_rating_kW"] == UPS_MAX_KW and u.items[0]["units"] == UPS_MAX_UNITS


# --------------------------------------------------------------------------------------------- what is read, and how it is read
def test_a_plain_signed_decimal_with_whitespace_is_read_and_an_integral_units_decimal_is_whole():
    p = parse(tx_csv("  SYN-TX-1 , +5.50 ,3.0, n+1 ,0.90, 160 "))
    assert p.items == [{"id": "SYN-TX-1", "unit_rating_MVA": 5.5, "units": 3, "redundancy": "N+1", "derating_factor": 0.9,
                        "replacement_lead_time_weeks": 160}]
    assert type(p.items[0]["units"]) is int


def test_redundancy_is_canonicalised_through_the_loaders_set_and_the_ledger_says_so():
    p = parse(tx_csv("SYN-TX-1,5,3,n + 1,,"))
    assert p.items[0]["redundancy"] == "N+1"
    assert p.ledger["items"][0]["fields"]["redundancy"]["conversion"] == {"op": "canonical_scheme", "from": "n + 1", "to": "N+1"}
    for scheme in sorted(_REDUNDANCY):
        assert parse(tx_csv(f"SYN-TX-1,5,3,{scheme},,")).items[0]["redundancy"] == scheme


def test_missing_optional_cells_and_columns_are_omitted_never_defaulted():
    p = parse(tx_csv("SYN-TX-1,5,,,,", "SYN-TX-2,5,3,N+1,,160"))
    assert p.items[0] == {"id": "SYN-TX-1", "unit_rating_MVA": 5}
    assert p.items[1] == {"id": "SYN-TX-2", "unit_rating_MVA": 5, "units": 3, "redundancy": "N+1", "replacement_lead_time_weeks": 160}
    assert p.ledger["items"][0]["omitted"] == {"units": "empty cell (column 3)", "redundancy": "empty cell (column 4)",
                                              "derating_factor": "empty cell (column 5)", "replacement_lead_time_weeks": "empty cell (column 6)"}
    q = parse(tx_csv("SYN-TX-1,5", header="Asset ID,Rating (MVA)"))
    assert q.items == [{"id": "SYN-TX-1", "unit_rating_MVA": 5}]
    assert q.ledger["items"][0]["omitted"]["units"] == "no column in the file"


# ----------------------------------------------------------------------------------------------- headers, delimiters, status
def test_the_semicolon_fixture_status_exclusions_unmapped_comments_and_canonical_items():
    raw = fixture("SYNTHETIC_transformers_kva_status_semicolon.csv")
    p = parse_schedule(raw, file_name="s.csv", kind="transformers")
    assert p.ledger["delimiter"] == ";"
    assert p.items == [
        {"id": "SYN-TX-1", "unit_rating_MVA": 2.5, "units": 2, "redundancy": "N+1", "derating_factor": 0.92},
        {"id": "SYN-TX-2", "unit_rating_MVA": 1.6, "units": 3, "redundancy": "N+1"},
        {"id": "SYN-TX-5", "unit_rating_MVA": 1.1115, "units": 4, "redundancy": "N+2", "derating_factor": 0.95}]
    assert [(e["id"], e["status"], e["row"]) for e in p.excluded] == [("SYN-TX-3", "Planned", 6), ("SYN-TX-4", "Decommissioned", 7)]
    assert [(u["column"], u["header"]) for u in p.unmapped] == [(6, "Notes")]
    assert [c["row"] for c in p.ledger["skipped_comment_lines"]] == [1, 2] and p.ledger["blank_lines"] == 1
    assert p.ledger["installed_basis"]["source"] == "status_column"
    assert [i["row"] for i in p.ledger["items"]] == [4, 5, 9]               # SYN-TX-5 starts on row 9: the quoted note spans rows 9-10
    assert_traceable(p, raw)


@pytest.mark.parametrize("status, counts", [
    ("Installed", True), ("installed", True), ("In service", True), ("in-service", True), ("IN_SERVICE", True), ("Commissioned", True), ("Live", True),
    ("Planned", False), ("Proposed", False), ("Decommissioned", False), ("Failed", False), ("Yes", False), ("", False), ("TBC", False), ("=1+1", False)])
def test_only_the_five_installed_statuses_count(status, counts):
    p = parse(f"Asset ID,Rating (MVA),Status\nSYN-TX-1,5,{status}\nSYN-TX-2,5,Installed\n", rows_are_installed=False)
    assert [i["id"] for i in p.items] == (["SYN-TX-1", "SYN-TX-2"] if counts else ["SYN-TX-2"])
    assert [e["id"] for e in p.excluded] == ([] if counts else ["SYN-TX-1"])


def test_with_no_status_column_the_flag_is_required_and_a_refusal_says_why():
    with pytest.raises(ScheduleImportError) as exc:
        parse(tx_csv(GOOD_TX), rows_are_installed=False)
    msg = str(exc.value)
    assert "--rows-are-installed" in msg and "planned" in msg.lower() and "installed" in msg.lower()
    ok = parse(tx_csv(GOOD_TX), rows_are_installed=True)
    assert ok.ledger["installed_basis"] == {"source": "operator_assertion", "flag": "--rows-are-installed"}


def test_a_status_column_governs_and_the_flag_is_recorded_as_not_applied():
    p = parse("Asset ID,Rating (MVA),Status\nSYN-TX-1,5,Planned\nSYN-TX-2,5,Live\n", rows_are_installed=True)
    assert [i["id"] for i in p.items] == ["SYN-TX-2"]
    assert p.ledger["installed_basis"]["source"] == "status_column" and p.ledger["installed_basis"]["operator_assertion_not_applied"] is True


def test_every_excluded_row_is_listed_and_a_file_with_nothing_installed_is_refused():
    with pytest.raises(ScheduleImportError) as exc:
        parse("Asset ID,Rating (MVA),Status\nSYN-TX-1,5,Planned\nSYN-TX-2,5,Proposed\n", rows_are_installed=False)
    assert "SYN-TX-1" in str(exc.value) and "Planned" in str(exc.value)


def test_an_excluded_row_is_not_validated_but_is_still_listed():
    p = parse("Asset ID,Rating (MVA),Status\nSYN-TX-1,TBC,Planned\nSYN-TX-2,5,Live\n", rows_are_installed=False)
    assert [i["id"] for i in p.items] == ["SYN-TX-2"] and p.excluded[0]["id"] == "SYN-TX-1"


def test_identical_rows_with_different_ids_are_different_items_and_units_is_never_inferred():
    p = parse(tx_csv("SYN-TX-1,5,,N+1,,", "SYN-TX-2,5,,N+1,,"))
    assert [i["id"] for i in p.items] == ["SYN-TX-1", "SYN-TX-2"] and all("units" not in i for i in p.items)


def test_unmapped_headers_are_listed_verbatim_with_their_columns_including_an_empty_header_and_repeats():
    p = parse("Asset ID,Rating (MVA),  Notes ,,Notes,Supplier REF\nSYN-TX-1,5,a,b,c,d\n")
    assert [(u["column"], u["header"]) for u in p.unmapped] == [(3, "  Notes "), (4, ""), (5, "Notes"), (6, "Supplier REF")]


def test_a_recognised_but_unused_rating_column_is_listed_unmapped_not_silently_dropped():
    p = parse("Asset ID,Rating (MVA),Rating (kVA)\nSYN-TX-1,5,9999\n")
    assert p.items[0]["unit_rating_MVA"] == 5
    assert [(u["column"], u["header"]) for u in p.unmapped] == [(3, "Rating (kVA)")] and "MVA" in p.unmapped[0]["note"]
    u = parse("Asset ID,Rating (kW),Rating (kVA),PF,Units\nSYN-UPS-1,900,1000,0.9,2\n", "ups")
    assert u.items[0]["unit_rating_kW"] == 900
    assert {x["header"] for x in u.unmapped} == {"Rating (kVA)", "PF"}


@pytest.mark.parametrize("delim", [",", ";", "\t"])
def test_the_delimiter_is_sniffed_from_the_header_line(delim):
    text = "\n".join(delim.join(r) for r in (["Asset ID", "Rating (MVA)", "Units"], ["SYN-TX-1", "5", "3"])) + "\n"
    p = parse(text)
    assert p.ledger["delimiter"] == delim and p.items == [{"id": "SYN-TX-1", "unit_rating_MVA": 5, "units": 3}]


def test_a_delimiter_inside_a_quoted_header_is_not_counted_and_a_tie_is_refused():
    p = parse('"Notes, a, b, c";Asset ID;Rating (MVA)\nfree text;SYN-TX-1;5\n')           # 3 commas inside quotes, 2 semicolons outside
    assert p.ledger["delimiter"] == ";" and p.items == [{"id": "SYN-TX-1", "unit_rating_MVA": 5}]
    with pytest.raises(ScheduleImportError) as exc:
        parse("Asset ID,Rating (MVA);Units\nSYN-TX-1,5;3\n")
    assert "delimiter" in str(exc.value)


def test_a_utf8_bom_is_accepted_and_does_not_leak_into_the_first_header():
    p = parse(b"\xef\xbb\xbf" + tx_csv(GOOD_TX).encode())
    assert p.items[0]["id"] == "SYN-TX-1"


def test_blank_comment_and_delimiter_only_lines_are_skipped_and_counted():
    p = parse("# SYNTHETIC: note\n\n   \nAsset ID,Rating (MVA)\n,\n# another\nSYN-TX-1,5\n,,\n")
    assert [i["id"] for i in p.items] == ["SYN-TX-1"]
    assert [c["row"] for c in p.ledger["skipped_comment_lines"]] == [1, 6] and p.ledger["blank_lines"] == 4


def test_header_aliases_are_exact_after_casefold_and_spacing_and_there_is_no_fuzzy_matching():
    ok = "  TAG , unit_RATING-(kva) ,QTY,Redundancy   Scheme\nSYN-TX-1,5000,2,N+1\n"
    assert parse(ok).items == [{"id": "SYN-TX-1", "unit_rating_MVA": 5, "units": 2, "redundancy": "N+1"}]
    for near in ("Asset Identifier,Rating (MVA)", "Asset ID,Ratings (MVA)", "Asset ID,Rating (MV A)", "Asset ID,Rating (MVAs)"):
        with pytest.raises(ScheduleImportError):
            parse(near + "\nSYN-TX-1,5\n")


# =========================================================================================================== 4: no invention
TX_H = {
    "id": ["id", "Tag", "Name", "Asset ID", "asset_tag", "Equipment-ID", "ASSET TAG"],
    "MVA": ["Rating MVA", "rating (MVA)", "Unit Rating (MVA)", "MVA", "unit_rating_MVA", "Transformer rating [MVA]"],
    "kVA": ["rating (kVA)", "unit rating kva", "kVA", "Nameplate_Rating_(kVA)"],
    "units": ["units", "Qty", "Quantity", "Count", "Number of units"],
    "redundancy": ["redundancy", "Redundancy Scheme", "configuration"],
    "derating_factor": ["derating", "Derating Factor", "derating (fraction)"],
    "replacement_lead_time_weeks": ["replacement lead time (weeks)", "Lead time weeks", "replacement_lead_time_weeks", "LEAD TIME (WKS)"],
    "status": ["status", "State", "Installed", "in service", "Commissioned"],
}
UPS_H = {
    "id": ["id", "Tag", "Asset ID", "Equipment ID"],
    "kW": ["Rating kW", "rating (kW)", "Module Rating (kW)", "UPS rating kW", "kW", "unit_rating_kW"],
    "kVA": ["rating (kVA)", "module rating kva", "kVA"],
    "pf": ["PF", "power factor", "Rated Power Factor"],
    "units": ["units", "Qty", "Count"],
    "redundancy": ["redundancy", "Redundancy Scheme", "configuration"],
    "step_load_capability": ["step load capability", "Step_Load", "step load acceptance (fraction)"],
    "status": ["status", "State", "commissioned"],
}
EXTRA_HEADERS = ["Notes", "Manufacturer", "Location", "Supplier ref", "Comments", "Serial no"]
EXTRA_CELLS = ["TBC", "n/a", "=1+1", "x,y", 'he said "hi"', "multi\nline", "", "５", "٥", "1,600", "@SUM(A1)", "-"]
INSTALLED_WORDS = ["Installed", "In-Service", "in service", "COMMISSIONED", "Live", "in_service"]
EXCLUDED_WORDS = ["Planned", "Proposed", "Decommissioned", "Failed", "", "TBC", "Spare"]
HOSTILE_NUMBERS = ["TBC", "n/a", "-", "1,600", "2x1600", "=1+1", "nan", "inf", "-3", "0", "1e3", "５", "٥٦", "5 MVA", "+SUM(A1)", "@A1",
                   "12.5.3", ".5", "5.", "Infinity", "0x10", "1_000"]
CANON_SCHEMES = ["N", "N+1", "N+2", "2N", "N+N", "N+0"]


def _dec(rng, lo, hi, places):
    """A decimal string for a value in [lo, hi] with up to `places` fractional digits, e.g. '12.50' (trailing zeros kept: they are what a sheet exports)."""
    scale = 10 ** places
    whole, frac = divmod(rng.randint(lo * scale, hi * scale), scale)
    if places == 0 or (frac == 0 and rng.random() < 0.5):
        return str(whole)
    return f"{whole}.{frac:0{places}d}"


def _scheme_variant(rng, s):
    t = s
    if rng.random() < 0.4:
        t = t.lower()
    if rng.random() < 0.3:
        t = t.replace("+", " + ")
    return t


def _make_case(rng, kind):
    """One random but VALID schedule: the rows' canonical items (what a correct importer must emit) and the rendered text."""
    H = TX_H if kind == "transformers" else UPS_H
    n = rng.randint(1, 6)
    rating_variant = rng.choice(["MVA", "kVA"] if kind == "transformers" else ["kW", "kVA"])
    cols = [("id", rng.choice(H["id"])), ("rating", rng.choice(H[rating_variant]))]
    if rating_variant == "kVA" and kind == "ups":
        cols.append(("pf", rng.choice(H["pf"])))
    optional_keys = (["units", "redundancy", "derating_factor", "replacement_lead_time_weeks"] if kind == "transformers"
                     else ["units", "redundancy", "step_load_capability"])
    for key in optional_keys:
        if rng.random() < 0.8:                                   # a column absent altogether, 20% of the time
            cols.append((key, rng.choice(H[key])))
    has_status = rng.random() < 0.5
    if has_status:
        cols.append(("status", rng.choice(H["status"])))
    for _ in range(rng.randint(0, 3)):
        cols.append(("extra", rng.choice(EXTRA_HEADERS)))
    rng.shuffle(cols)
    present = {k for k, _ in cols}
    rows, expected, excluded_ids = [], [], []
    for i in range(n):
        ident = f"SYN-{kind[:2].upper()}-{i + 1}-{rng.randint(0, 999)}"
        cells, item = {"id": ident}, {"id": ident}
        if kind == "transformers":
            if rating_variant == "MVA":
                s = _dec(rng, 1, 1000, 2)
                cells["rating"], val = s, float(Fraction(s))
            else:
                s = _dec(rng, 1, 1_000_000, 2)
                cells["rating"], val = s, float(Fraction(s) / 1000)
            item["unit_rating_MVA"] = val
        else:
            if rating_variant == "kW":
                s = _dec(rng, 1, 20_000, 2)
                cells["rating"], val = s, float(Fraction(s))
            else:
                s, pf = _dec(rng, 1, 20_000, 2), rng.choice(["0.8", "0.9", "0.95", "1", "0.85"])
                cells["rating"], cells["pf"], val = s, pf, float(Fraction(s) * Fraction(pf))      # kVA <= 20000 and pf <= 1: within the ceiling
            item["unit_rating_kW"] = val
        for key in optional_keys:
            if key not in present:
                continue
            if rng.random() < 0.25:
                cells[key] = ""
                continue
            if key == "units":
                cells[key] = str(rng.randint(1, TX_MAX_UNITS if kind == "transformers" else UPS_MAX_UNITS))
                if rng.random() < 0.2:
                    cells[key] += ".0"
                item["units"] = int(Fraction(cells[key]))
            elif key == "redundancy":
                s = rng.choice(CANON_SCHEMES)
                cells[key], item["redundancy"] = _scheme_variant(rng, s), s
            elif key in ("derating_factor", "step_load_capability"):
                cells[key] = rng.choice(["0.9", "0.85", "1", "0.95", "0.5", "0.33", "1.0"])
                item[key] = float(Fraction(cells[key]))
            else:
                cells[key] = str(rng.randint(1, TX_MAX_WEEKS))
                item[key] = int(cells[key])
        counted = True
        if has_status:
            counted = rng.random() < 0.7
            cells["status"] = rng.choice(INSTALLED_WORDS if counted else EXCLUDED_WORDS)
        if counted:
            expected.append(item)
        else:
            excluded_ids.append(ident)
        rows.append(cells)
    if not expected:                                              # an all-excluded file is (correctly) refused; keep these cases valid
        return None
    delim = rng.choice([",", ";", "\t"])
    eol = rng.choice(["\n", "\r\n", "\r"])
    lines = []

    def render(values):
        out = []
        for v in values:
            quote = any(ch in v for ch in (delim, '"', "\n", "\r")) or rng.random() < 0.3
            if quote:
                v = '"' + v.replace('"', '""') + '"'
            elif rng.random() < 0.2:
                v = " " * rng.randint(1, 2) + v + " " * rng.randint(0, 2)
            out.append(v)
        return delim.join(out)

    def noise():
        for _ in range(rng.choice([0, 0, 1, 2])):
            lines.append(rng.choice(["# SYNTHETIC comment", "", "   ", delim * (len(cols) - 1), "#"]))

    noise()
    header_cells = []
    for _, h in cols:
        if rng.random() < 0.3:
            h = h.upper() if rng.random() < 0.5 else h.lower()
        if rng.random() < 0.3:
            h = " " + h + "  "
        header_cells.append(h)
    lines.append(render(header_cells))
    for cells in rows:
        noise()
        values = []
        for key, _ in cols:
            values.append(rng.choice(EXTRA_CELLS) if key == "extra" else cells.get(key, ""))
        lines.append(render(values))
    noise()
    text = eol.join(lines) + rng.choice(["", eol])
    data = text.encode("utf-8")
    if rng.random() < 0.3:
        data = b"\xef\xbb\xbf" + data
    return data, expected, excluded_ids, has_status, cols, rows


@pytest.mark.parametrize("kind", ["transformers", "ups"])
def test_randomized_layouts_give_the_canonical_items_or_a_refusal_never_a_different_item(kind):
    rng = random.Random(20261113 if kind == "transformers" else 20261114)
    made = 0
    seen = {"bom": 0, "status column": 0, "excluded rows": 0, "omitted cells": 0, "scheme respelt": 0, "unit conversion": 0, "unmapped columns": 0,
            "CRLF line ends": 0, "bare CR line ends": 0, "bare LF line ends": 0}
    delimiters = set()
    for _ in range(250):
        case = _make_case(rng, kind)
        if case is None:
            continue
        data, expected, excluded_ids, has_status, _cols, _rows = case
        made += 1
        try:
            p = parse_schedule(data, file_name="r.csv", kind=kind, rows_are_installed=not has_status)
        except ScheduleImportError as exc:                          # allowed by the property, but a VALID file must not be refused
            pytest.fail(f"a valid generated file was refused: {exc}\n{data!r}")
        assert p.items == expected, data
        assert [e["id"] for e in p.excluded] == excluded_ids
        for item in p.items:
            assert set(item) <= EQUIPMENT_KEYS[kind], "an output key outside the loader's allow-list"
            assert not {"evidence", "source", "note", "installed"} & set(item)
        load_document({kind: p.items})                              # and the real loader accepts what was emitted
        assert_traceable(p, data)
        ops = {f["conversion"]["op"] for rec in p.ledger["items"] for f in rec["fields"].values() if f["conversion"]}
        seen["bom"] += data.startswith(b"\xef\xbb\xbf")
        seen["status column"] += has_status
        seen["excluded rows"] += bool(excluded_ids)
        seen["omitted cells"] += any(rec["omitted"] for rec in p.ledger["items"])
        seen["scheme respelt"] += "canonical_scheme" in ops
        seen["unit conversion"] += bool(ops & {"divide", "multiply"})
        seen["unmapped columns"] += bool(p.unmapped)
        seen["CRLF line ends"] += b"\r\n" in data
        seen["bare CR line ends"] += bool(re.search(rb"\r(?!\n)", data))
        seen["bare LF line ends"] += bool(re.search(rb"(?<!\r)\n", data))
        delimiters.add(p.delimiter)
    assert made > 150
    assert delimiters == {",", ";", "\t"}, delimiters                 # the generator really varies what it claims to vary
    assert all(count >= 15 for count in seen.values()), seen


@pytest.mark.parametrize("kind", ["transformers", "ups"])
def test_randomized_hostile_cell_in_any_counted_numeric_or_scheme_cell_is_refused_never_altered(kind):
    rng = random.Random(7_001 if kind == "transformers" else 7_002)
    refused = 0
    for _ in range(250):
        case = _make_case(rng, kind)
        if case is None:
            continue
        _data, expected, _excl, has_status, cols, rows = case
        # re-render deterministically (comma, LF) with one cell replaced
        counted_idx = [i for i, cells in enumerate(rows) if (not has_status) or cells.get("status") in INSTALLED_WORDS]
        victim_row = rng.choice(counted_idx)
        mutable = [k for k, _ in cols if k not in ("id", "status", "extra") and rows[victim_row].get(k, "") != ""]
        if not mutable:
            continue
        key = rng.choice(mutable)
        if key == "redundancy":
            bad = rng.choice(["2N+1", "N+3", "?", "TBC", "3N"])
        else:
            bad = rng.choice(HOSTILE_NUMBERS + (["2.5"] if key == "units" else []))
        lines = [",".join(f'"{h}"' for _, h in cols)]
        for i, cells in enumerate(rows):
            values = []
            for k, _ in cols:
                v = "ignored" if k == "extra" else cells.get(k, "")
                if i == victim_row and k == key:
                    v = bad
                values.append('"' + v.replace('"', '""') + '"')
            lines.append(",".join(values))
        data = ("\n".join(lines) + "\n").encode("utf-8")
        with pytest.raises(ScheduleImportError) as exc:
            parse_schedule(data, file_name="h.csv", kind=kind, rows_are_installed=not has_status)
        assert f"row {victim_row + 2}" in str(exc.value), (bad, key, str(exc.value))
        refused += 1
    assert refused > 150


# =========================================================================================================== 5: idempotence
def test_running_twice_gives_byte_identical_output_and_ledger(tmp_path, capsys):
    outs = []
    for d in ("a", "b"):
        folder = tmp_path / d
        folder.mkdir()
        r = invoke(folder, capsys, fixture("SYNTHETIC_transformers_kva_status_semicolon.csv"), "transformers", installed=False,
                   name="SYNTHETIC_schedule.csv", label="E-101 rev C")
        assert r.rc == 0, r.err
        outs.append((r.out_path.read_bytes(), r.ledger_path.read_bytes(), r.out))
    assert outs[0][0] == outs[1][0] and outs[0][1] == outs[1][1]
    assert outs[0][2].replace(str(tmp_path / "a"), "").replace(str(tmp_path / "b"), "") == outs[1][2].replace(str(tmp_path / "a"), "").replace(str(tmp_path / "b"), "")


def test_parsing_twice_in_one_process_is_identical_and_the_module_has_no_clock():
    import ast
    raw = fixture("SYNTHETIC_transformers_reference_equivalent.csv")
    first = parse_schedule(raw, file_name="x.csv", kind="transformers", rows_are_installed=True)
    second = parse_schedule(raw, file_name="x.csv", kind="transformers", rows_are_installed=True)
    assert json.dumps(first.ledger, sort_keys=True) == json.dumps(second.ledger, sort_keys=True) and first.items == second.items
    imported = {n.module if isinstance(n, ast.ImportFrom) else a.name for n in ast.walk(ast.parse(Path(si.__file__).read_text(encoding="utf-8")))
                if isinstance(n, (ast.Import, ast.ImportFrom)) for a in getattr(n, "names", [None])}
    assert not {"time", "datetime", "random", "secrets", "uuid"} & imported


# ======================================================================================================= 6: gaps and issuing
def _hall_without(section):
    d = copy.deepcopy(REFERENCE)
    d.pop(section, None)
    return d


def test_the_control_hall_is_issuable_so_the_gap_below_is_attributable_to_the_schedule():
    assert load_document(REFERENCE).report.can_issue


def test_a_bank_with_units_but_no_redundancy_column_is_a_required_named_gap_and_blocks_issue(tmp_path, capsys):
    hall = tmp_path / "hall.json"
    hall.write_text(json.dumps(_hall_without("transformers")), encoding="utf-8")
    r = invoke(tmp_path, capsys, fixture("SYNTHETIC_transformers_no_redundancy_column.csv"), "transformers", into=hall)
    assert r.rc == 0, r.err
    item = json.loads(r.out_path.read_text(encoding="utf-8"))["transformers"][0]
    assert "redundancy" not in item and item["units"] == 3                        # NOT defaulted by the importer
    assert "[REQUIRED] transformers[SYN-TX-1].redundancy" in r.out
    assert "Issuable as a full study: no" in r.out
    report = load_document(json.loads(r.out_path.read_text(encoding="utf-8"))).report
    assert "transformers[SYN-TX-1].redundancy" in {g.path for g in report.required_gaps}
    assert report.can_issue is False
    # the optional ones are named too, as optional, and do not block
    assert "transformers[SYN-TX-1].derating_factor" in {g.path for g in report.gaps if not g.required}


def test_a_bank_with_no_units_column_is_a_required_gap_for_units(tmp_path, capsys):
    p = parse(tx_csv("SYN-TX-1,5,,N+1,0.9,160"))
    assert "units" not in p.items[0]
    paths = {g.path for g in load_document({"transformers": p.items}).report.required_gaps}
    assert "transformers[SYN-TX-1].units" in paths


def test_a_complete_schedule_on_an_otherwise_complete_hall_can_issue(tmp_path, capsys):
    hall = tmp_path / "hall.json"
    hall.write_text(json.dumps(_hall_without("transformers")), encoding="utf-8")
    r = invoke(tmp_path, capsys, fixture("SYNTHETIC_transformers_reference_equivalent.csv"), "transformers", into=hall)
    assert r.rc == 0, r.err
    assert "Issuable as a full study: yes" in r.out
    assert load_document(json.loads(r.out_path.read_text(encoding="utf-8"))).report.can_issue is True
    assert import_schedule(FIX / "SYNTHETIC_transformers_reference_equivalent.csv", "transformers", rows_are_installed=True,
                           into=hall).can_issue is True


def test_ups_gaps_use_the_loaders_paths_and_step_load_stays_optional():
    p = parse(ups_csv("SYN-UPS-1,1200,,,", header=UPS_HDR), "ups")
    assert p.items == [{"id": "SYN-UPS-1", "unit_rating_kW": 1200}]
    gaps ={g.path: g.required for g in load_document({"ups": p.items}).report.gaps if g.path.startswith("ups[")}
    assert gaps == {"ups[SYN-UPS-1].units": True, "ups[SYN-UPS-1].redundancy": True, "ups[SYN-UPS-1].step_load_capability": False}


def test_without_into_only_this_sections_gaps_are_reported_and_the_site_is_not_judged(tmp_path, capsys):
    r = invoke(tmp_path, capsys, fixture("SYNTHETIC_transformers_no_redundancy_column.csv"), "transformers")
    assert r.rc == 0, r.err
    assert json.loads(r.out_path.read_text(encoding="utf-8")) == {"transformers": [{"id": "SYN-TX-1", "unit_rating_MVA": 5, "units": 3}]}
    assert "transformers[SYN-TX-1].redundancy" in r.out
    assert "grid.firm_capacity_MVA" not in r.out and "hall.floor_loading_kPa" not in r.out        # other sections' gaps are not this importer's news
    assert "not assessed" in r.out.lower() and "--into" in r.out


def test_the_loader_gives_the_evidence_the_importer_leaves_to_it():
    """The importer asserts no evidence class. These are the classes the LOADER gives what was imported; the importer's docstring and report
    quote them, so a change in the loader that breaks that sentence breaks this test."""
    tx = parse(tx_csv(GOOD_TX)).items
    up = parse(ups_csv(GOOD_UPS), "ups").items
    ctx = load_document({"transformers": tx, "ups": up}).context
    bank, block = ctx.power.transformers[0], ctx.power.ups[0]
    assert bank.unit_rating_MVA.evidence == EvidenceClass.E5_CUSTOMER_DATA
    assert bank.derating_factor.evidence == EvidenceClass.E3_ENGINEERING_ESTIMATE
    assert bank.replacement_lead_time_weeks.evidence == EvidenceClass.E0_ASSUMPTION            # forced down even when the customer supplied it
    assert block.unit_rating_kW.evidence == EvidenceClass.E5_CUSTOMER_DATA
    assert block.step_load_capability.evidence == EvidenceClass.E0_ASSUMPTION
    for item in tx + up:
        assert not {"evidence", "source", "note"} & set(item)


def test_the_report_quotes_the_loaders_evidence_classes_per_supplied_figure(tmp_path, capsys):
    r = invoke(tmp_path, capsys, fixture("SYNTHETIC_transformers_reference_equivalent.csv"), "transformers")
    assert r.rc == 0, r.err
    assert "assigns no evidence class" in r.out.lower()
    assert "SYN-TX-1" in r.out and "unit_rating_MVA E5" in r.out and "replacement_lead_time_weeks E0" in r.out and "derating_factor E3" in r.out


# ============================================================================================================ 7: merge
def test_merging_into_a_non_empty_section_is_refused_without_replace_and_shows_the_diff(tmp_path, capsys):
    hall = tmp_path / "hall.json"
    hall.write_text(json.dumps(REFERENCE, indent=2), encoding="utf-8")
    before = hall.read_bytes()
    r = invoke(tmp_path, capsys, fixture("SYNTHETIC_transformers_kva_status_semicolon.csv"), "transformers", into=hall, installed=False)
    assert r.rc == 2
    assert "--replace" in r.err
    assert "- TX-A/B" in r.err and "+ SYN-TX-1" in r.err and "+ SYN-TX-5" in r.err      # what would go, what would come
    assert hall.read_bytes() == before
    assert not r.out_path.exists() and not r.ledger_path.exists()


def test_with_replace_the_merge_goes_through_and_the_report_says_what_was_replaced(tmp_path, capsys):
    hall = tmp_path / "hall.json"
    hall.write_text(json.dumps(REFERENCE, indent=2), encoding="utf-8")
    r = invoke(tmp_path, capsys, fixture("SYNTHETIC_transformers_reference_equivalent.csv"), "transformers", "--replace", into=hall)
    assert r.rc == 0, r.err
    assert "REPLACED" in r.out and "TX-A/B" in r.out and "SYN-TX-1" in r.out
    merged = json.loads(r.out_path.read_text(encoding="utf-8"))
    assert merged["transformers"][0]["id"] == "SYN-TX-1"
    assert {k: v for k, v in merged.items() if k != "transformers"} == {k: v for k, v in REFERENCE.items() if k != "transformers"}
    assert list(merged) == list(REFERENCE)                                                      # the document keeps its key order


def test_an_in_place_merge_replaces_the_intake_atomically_and_leaves_no_temp_file(tmp_path, capsys):
    hall = tmp_path / "hall.json"
    hall.write_text(json.dumps(REFERENCE, indent=2), encoding="utf-8")
    src = tmp_path / "SYNTHETIC_tx.csv"
    src.write_bytes(fixture("SYNTHETIC_transformers_reference_equivalent.csv"))
    led = tmp_path / "hall.import.json"
    rc, out, err = run_main(capsys, "import-schedule", src, "--kind", "transformers", "--rows-are-installed", "--into", hall, "--replace", "-o", hall,
                            "--ledger", led)
    assert rc == 0, err
    assert json.loads(hall.read_text(encoding="utf-8"))["transformers"][0]["id"] == "SYN-TX-1"
    assert sorted(p.name for p in tmp_path.iterdir()) == ["SYNTHETIC_tx.csv", "hall.import.json", "hall.json"]
    rc, out, err = run_main(capsys, "import-schedule", src, "--kind", "transformers", "--rows-are-installed", "--into", hall, "-o", hall, "--ledger", led)
    assert rc == 2 and "--replace" in err                                           # the merged intake now holds a section: a second run needs --replace


def test_the_diff_separates_changed_unchanged_removed_and_added():
    existing = [{"id": "A", "unit_rating_MVA": 5, "units": 2}, {"id": "B", "unit_rating_MVA": 3, "units": 2}, {"id": "C", "unit_rating_MVA": 1}]
    imported = [{"id": "A", "unit_rating_MVA": 5, "units": 3}, {"id": "B", "unit_rating_MVA": 3, "units": 2}, {"id": "D", "unit_rating_MVA": 2}]
    lines = si.section_diff(existing, imported)
    assert any(line.startswith("~ A") and "units 2 -> 3" in line for line in lines)
    assert any(line.startswith("= B") for line in lines)
    assert any(line.startswith("- C") for line in lines) and any(line.startswith("+ D") for line in lines)


def test_the_diff_does_not_report_5_0_to_5_as_a_change():
    """The same number written two ways (the intake says 5.0, the importer writes 5) is not a difference; only `units` changed here."""
    lines = si.section_diff([{"id": "A", "unit_rating_MVA": 5.0, "units": 2}], [{"id": "A", "unit_rating_MVA": 5, "units": 3}])
    assert lines == ["~ A: units 2 -> 3"]
    assert si.section_diff([{"id": "A", "unit_rating_MVA": 5.0}], [{"id": "A", "unit_rating_MVA": 5}]) == ["= A  unchanged"]


@pytest.mark.parametrize("existing", [None, [], "absent"])
def test_an_empty_or_absent_section_merges_without_replace(tmp_path, capsys, existing):
    d = copy.deepcopy(REFERENCE)
    if existing == "absent":
        d.pop("transformers")
    else:
        d["transformers"] = existing
    hall = tmp_path / "hall.json"
    hall.write_text(json.dumps(d), encoding="utf-8")
    r = invoke(tmp_path, capsys, fixture("SYNTHETIC_transformers_reference_equivalent.csv"), "transformers", into=hall)
    assert r.rc == 0, r.err
    assert "REPLACED" not in r.out
    assert json.loads(r.out_path.read_text(encoding="utf-8"))["transformers"][0]["id"] == "SYN-TX-1"


def test_a_schedule_the_loader_refuses_in_context_is_refused_and_nothing_is_written(tmp_path, capsys):
    """The importer's output is the loader's own input: a hall the loader rejects for another reason is not blamed on the schedule."""
    d = copy.deepcopy(REFERENCE)
    d["transformers"] = []
    d["grid"] = {"firm_capacity_MVA": 10, "no_such_key": 1}
    hall = tmp_path / "hall.json"
    hall.write_text(json.dumps(d), encoding="utf-8")
    r = invoke(tmp_path, capsys, fixture("SYNTHETIC_transformers_reference_equivalent.csv"), "transformers", into=hall)
    assert r.rc == 2 and "no_such_key" in r.err and "intake itself" in r.err
    assert not r.out_path.exists() and not r.ledger_path.exists()


def test_more_installed_items_than_the_loader_accepts_is_refused_naming_its_limit():
    rows = [f"SYN-TX-{i},5,2,N+1,," for i in range(MAX_EQUIPMENT_ITEMS + 1)]
    with pytest.raises(ScheduleImportError) as exc:
        parse(tx_csv(*rows))
    assert str(MAX_EQUIPMENT_ITEMS) in str(exc.value) and "units" in str(exc.value)


# ================================================================================================================== 8: the CLI
def test_cli_success_exit_zero_and_the_summaries_on_stdout(tmp_path, capsys):
    r = invoke(tmp_path, capsys, fixture("SYNTHETIC_transformers_kva_status_semicolon.csv"), "transformers", installed=False,
               name="SYNTHETIC_semicolon.csv", label="E-101 rev C")
    assert r.rc == 0, r.err
    out = r.out
    assert "SYN-TX-1" in out and "SYN-TX-2" in out and "SYN-TX-5" in out
    assert "EXCLUDED" in out and "SYN-TX-3" in out and "Planned" in out and "SYN-TX-4" in out and "Decommissioned" in out
    assert "UNMAPPED" in out and "'Notes'" in out
    assert "[optional] transformers[SYN-TX-2].derating_factor" in out and "[optional] transformers.replacement_lead_time_weeks" in out
    assert "REQUIRED" not in out                                  # units and redundancy were given for every installed row
    assert "comment" in out.lower() and "E-101 rev C" in out
    assert str(r.out_path) in out and str(r.ledger_path) in out
    assert r.err == ""
    assert json.loads(r.ledger_path.read_text(encoding="utf-8"))["source"]["label"] == "E-101 rev C"


def test_cli_refusal_exit_two_reasons_on_stderr_nothing_on_stdout_nothing_written(tmp_path, capsys):
    r = invoke(tmp_path, capsys, tx_csv("SYN-TX-1,TBC,3,N+1,0.9,160"))
    assert r.rc == 2 and r.out == "" and "refused" in r.err.lower() and "nothing written" in r.err.lower()
    assert_nothing_written(r, tmp_path)


def test_cli_loader_warnings_for_the_section_are_shown(tmp_path, capsys):
    r = invoke(tmp_path, capsys, tx_csv("SYN-TX-1,5,1,N+1,0.9,160"))      # one unit under N+1 leaves nothing usable: the loader warns
    assert r.rc == 0, r.err
    assert "leave no usable unit" in r.out and "transformers[0]" in r.out


def test_cli_identical_rows_with_different_ids_are_imported_as_two_items_and_the_loaders_duplicate_warning_is_shown(tmp_path, capsys):
    r = invoke(tmp_path, capsys, tx_csv("SYN-TX-1,5,3,N+1,0.9,160", "SYN-TX-2,5,3,N+1,0.9,160"))
    assert r.rc == 0, r.err
    assert [i["id"] for i in json.loads(r.out_path.read_text(encoding="utf-8"))["transformers"]] == ["SYN-TX-1", "SYN-TX-2"]
    assert "SYN-TX-2 is identical to SYN-TX-1 apart from its id" in r.out


def test_cli_argument_errors_exit_two_without_a_traceback(tmp_path, capsys):
    for argv in (["import-schedule"], ["import-schedule", "x.csv"], ["import-schedule", "x.csv", "--kind", "cdus", "-o", "o", "--ledger", "l"]):
        with pytest.raises(SystemExit) as exc:
            gf_cli.main(argv)
        assert exc.value.code == 2
        assert "Traceback" not in capsys.readouterr().err


def test_cli_through_the_real_entry_point_in_a_subprocess(tmp_path):
    out, led = tmp_path / "o.json", tmp_path / "o.import.json"
    cmd = [sys.executable, "-m", "gridforge", "import-schedule", str(FIX / "SYNTHETIC_ups_kva_with_power_factor.csv"), "--kind", "ups",
           "--rows-are-installed", "-o", str(out), "--ledger", str(led)]
    r = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True)
    assert r.returncode == 0 and "Traceback" not in r.stderr, r.stderr
    assert [i["unit_rating_kW"] for i in json.loads(out.read_text(encoding="utf-8"))["ups"]] == [999.9, 400]
    no_flag = cmd[:7] + ["-o", str(tmp_path / "x.json"), "--ledger", str(tmp_path / "x.import.json")]          # same file, without --rows-are-installed
    bad = subprocess.run(no_flag, cwd=ROOT, capture_output=True, text=True)
    assert bad.returncode == 2 and "--rows-are-installed" in bad.stderr and not (tmp_path / "x.json").exists()


def test_cli_refuses_to_overwrite_its_own_input_or_use_one_path_twice_or_write_into_a_missing_folder(tmp_path, capsys):
    src = tmp_path / "s.csv"
    src.write_text(tx_csv(GOOD_TX), encoding="utf-8")
    base = ["import-schedule", src, "--kind", "transformers", "--rows-are-installed"]
    for extra, why in ((["-o", src, "--ledger", tmp_path / "l.json"], "input"), (["-o", tmp_path / "o.json", "--ledger", tmp_path / "o.json"], "same"),
                       (["-o", tmp_path / "nope" / "o.json", "--ledger", tmp_path / "l.json"], "folder"),
                       (["-o", tmp_path / "o.json", "--ledger", src], "input")):
        rc, out, err = run_main(capsys, *base, *extra)
        assert rc == 2 and why in err.lower(), (extra, err)
    assert src.read_text(encoding="utf-8") == tx_csv(GOOD_TX)
    assert sorted(p.name for p in tmp_path.iterdir()) == ["s.csv"]


def test_cli_missing_file_and_directory_are_refused_by_name(tmp_path, capsys):
    for target, word in ((tmp_path / "missing.csv", "missing.csv"), (tmp_path, "directory")):
        rc, out, err = run_main(capsys, "import-schedule", target, "--kind", "ups", "--rows-are-installed", "-o", tmp_path / "o.json", "--ledger",
                                tmp_path / "l.json")
        assert rc == 2 and "Traceback" not in err and word in err, err
    assert sorted(p.name for p in tmp_path.iterdir()) == []


def test_a_path_with_an_embedded_nul_is_refused_by_name_not_raised(tmp_path):
    """Not reachable from a command line, but import_schedule is a library function too: a caller's bad path is a refusal, not a ValueError."""
    with pytest.raises(ScheduleImportError) as exc:
        import_schedule("sched\x00ule.csv", "ups", rows_are_installed=True)
    assert "cannot read" in str(exc.value) and "\x00" not in str(exc.value)
    src = tmp_path / "SYNTHETIC_tx.csv"
    src.write_bytes(fixture("SYNTHETIC_transformers_reference_equivalent.csv"))
    with pytest.raises(ScheduleImportError) as exc:
        import_schedule(src, "transformers", rows_are_installed=True, into="hall\x00.json")
    assert "cannot read" in str(exc.value)


def test_import_schedule_is_in_the_top_level_help_and_answers_help():
    top = subprocess.run([sys.executable, "-m", "gridforge", "--help"], cwd=ROOT, capture_output=True, text=True)
    sub = subprocess.run([sys.executable, "-m", "gridforge", "import-schedule", "--help"], cwd=ROOT, capture_output=True, text=True)
    assert top.returncode == 0 and "import-schedule" in top.stdout
    assert sub.returncode == 0 and all(flag in sub.stdout for flag in ("--kind", "--into", "--ledger", "--rows-are-installed", "--source-label", "--replace"))


# ================================================================================================================= 9: hostile
def test_the_row_cap(tmp_path, capsys):
    over = [f"SYN-TX-{i},5,2,N+1,,,Planned" for i in range(MAX_DATA_ROWS + 1)]
    hdr = BASE_HDR + ",Status"
    with pytest.raises(ScheduleImportError) as exc:
        parse(tx_csv(*over, header=hdr), rows_are_installed=False)
    assert str(MAX_DATA_ROWS) in str(exc.value)
    r = invoke(tmp_path, capsys, tx_csv(*over, header=hdr), installed=False)
    assert r.rc == 2 and str(MAX_DATA_ROWS) in r.err
    assert_nothing_written(r, tmp_path)
    # exactly the cap is read: here 100 installed (the loader's own limit) and 100 not
    edge = ([f"SYN-TX-{i},5,2,N+1,,,Live" for i in range(MAX_EQUIPMENT_ITEMS)]
            + [f"SYN-TX-P{i},5,2,N+1,,,Planned" for i in range(MAX_DATA_ROWS - MAX_EQUIPMENT_ITEMS)])
    p = parse(tx_csv(*edge, header=hdr), rows_are_installed=False)
    assert len(p.items) == MAX_EQUIPMENT_ITEMS and len(p.excluded) == MAX_DATA_ROWS - MAX_EQUIPMENT_ITEMS


def test_the_size_cap_is_exact():
    body = tx_csv(GOOD_TX).encode()
    pad = MAX_BYTES - len(body) - len(b"#\n")
    at_cap = b"#" + b"x" * pad + b"\n" + body                       # a comment line pads the file to exactly the cap
    assert len(at_cap) == MAX_BYTES
    assert parse(at_cap).items
    with pytest.raises(ScheduleImportError) as exc:
        parse(at_cap + b"\n")
    assert "256 KiB" in str(exc.value) or str(MAX_BYTES) in str(exc.value)


def test_a_one_megabyte_single_cell_is_refused_by_the_size_cap_without_reading_it_all(tmp_path, capsys):
    huge = BASE_HDR + ",Notes\n" + GOOD_TX + "," + "x" * 1_000_000 + "\n"
    with pytest.raises(ScheduleImportError) as exc:
        parse(huge)
    assert "256 KiB" in str(exc.value) or str(MAX_BYTES) in str(exc.value)
    r = invoke(tmp_path, capsys, huge)
    assert r.rc == 2 and "Traceback" not in r.err
    assert_nothing_written(r, tmp_path)


def test_a_big_cell_within_the_cap_is_ignored_in_an_unmapped_column_and_refused_in_a_mapped_one():
    big = "x" * 100_000
    p = parse(f"Asset ID,Rating (MVA),Notes\nSYN-TX-1,5,{big}\n")
    assert p.items == [{"id": "SYN-TX-1", "unit_rating_MVA": 5}] and len(json.dumps(p.ledger)) < 5_000
    with pytest.raises(ScheduleImportError) as exc:
        parse(f"Asset ID,Rating (MVA)\n{big},5\n")
    assert "row 2, column 1" in str(exc.value) and len(str(exc.value)) < 2_000
    with pytest.raises(ScheduleImportError) as exc:
        parse(f"Asset ID,Rating (MVA)\nSYN-TX-1,{'9' * 100_000}\n")
    assert "row 2, column 2" in str(exc.value) and len(str(exc.value)) < 2_000


@pytest.mark.parametrize("data, why", [
    (b"Asset ID,Rating (MVA)\nSYN-TX-1,5\x00\n", "NUL"),
    (b"Asset ID,Rating (MVA)\nSYN\x00-TX-1,5\n", "NUL"),
    (b"\x00" * 100, "NUL"),
    ("Asset ID,Rating (MVA)\nSYN-TX-1,5\n".encode("utf-16"), "UTF-8"),
    (b"Asset ID,Rating (MVA)\nSYN-TX-\xe9,5\n", "UTF-8"),
    (b"\xff\xfe\xfd garbage", "UTF-8"),
    (b"", "empty"),
    (b"\xef\xbb\xbf", "empty"),
    (b"\n\n   \n# only a comment\n", "no header"),
    (b"Asset ID,Rating (MVA)\n", "no data rows"),
    (b"Asset ID,Rating (MVA)\n# nothing\n\n,\n", "no data rows"),
])
def test_binary_and_empty_input_is_refused_by_name(data, why):
    with pytest.raises(ScheduleImportError) as exc:
        parse(data)
    assert why.lower() in str(exc.value).lower()


@pytest.mark.parametrize("text, why", [
    ('Asset ID,Rating (MVA)\n"SYN-TX-1,5\n', "never closed"),
    ('Asset ID,Rating (MVA)\nSYN-TX-1,"5"x\n', "closing quote"),
    ('Asset ID,Rating (MVA)\nSYN"TX-1,5\n', "quote inside"),
    ('Asset ID,Rating (MVA)\n' + '"' * 3 + ',5\n', "never closed"),            # opening quote, one escaped quote, no closing quote
    ('Asset ID,Rating (MVA)\n' + '"' * 20_001 + ',5\n', "never closed"),
])
def test_quote_abuse_is_refused_by_name(text, why):
    with pytest.raises(ScheduleImportError) as exc:
        parse(text)
    assert why in str(exc.value) and "row 2" in str(exc.value)


def test_deeply_nested_quotes_are_linear_and_handled():
    nested = '"' + '""' * 20_000 + '"'                             # a quoted cell holding 20,000 literal quotes
    p = parse(f"Asset ID,Rating (MVA),Notes\nSYN-TX-1,5,{nested}\n")
    assert p.items == [{"id": "SYN-TX-1", "unit_rating_MVA": 5}]
    with pytest.raises(ScheduleImportError) as exc:                  # the same in a mapped column is an over-long id, by row and column
        parse(f"Asset ID,Rating (MVA)\n{nested},5\n")
    assert "row 2, column 1" in str(exc.value)


def test_mixed_line_endings_count_rows_by_physical_line():
    text = "Asset ID,Rating (MVA),Status\r\nSYN-TX-1,5,Live\nSYN-TX-2,5,Live\rSYN-TX-3,5,Planned\r\n\nSYN-TX-4,TBC,Live\n"
    with pytest.raises(ScheduleImportError) as exc:
        parse(text, rows_are_installed=False)
    assert "row 6, column 2" in str(exc.value)                       # CRLF, LF, CR, CRLF, blank, LF: the bad cell is on line 6
    good = parse(text.replace("TBC", "7"), rows_are_installed=False)
    assert [i["id"] for i in good.items] == ["SYN-TX-1", "SYN-TX-2", "SYN-TX-4"] and [i["row"] for i in good.ledger["items"]] == [2, 3, 6]


@pytest.mark.parametrize("cell, why", [
    ("٥", "non-ASCII digits"), ("١٢٣", "non-ASCII digits"), ("５", "non-ASCII digits"), ("１２", "non-ASCII digits"),
    ("५", "non-ASCII digits"), ("5٠", "non-ASCII digits"), ("²", "plain decimal"), ("⅕", "plain decimal")])
def test_non_ascii_digits_are_refused_not_converted(cell, why):
    assert float("٥") == 5.0                                    # Python would happily read it: that is the trap
    with pytest.raises(ScheduleImportError) as exc:
        parse(f"Asset ID,Rating (MVA)\nSYN-TX-1,{cell}\n")
    assert "row 2, column 2" in str(exc.value) and why in str(exc.value)
    with pytest.raises(ScheduleImportError) as exc:
        parse(f"Asset ID,Rating (MVA),Units\nSYN-TX-1,5,{cell}\n")
    assert "row 2, column 3" in str(exc.value)


@pytest.mark.parametrize("prefix", ["=", "+", "-", "@"])
def test_a_formula_prefix_in_an_id_is_refused(prefix):
    with pytest.raises(ScheduleImportError) as exc:
        parse(f"Asset ID,Rating (MVA)\n{prefix}TX1,5\n")
    assert "row 2, column 1" in str(exc.value) and "formula" in str(exc.value)


@pytest.mark.parametrize("cell", ["=1+1", "=cmd|' /C calc'!A0", "+SUM(A1:A2)", "@SUM(A1)", "-1+2", "=HYPERLINK(\"http://x\")", "+", "@"])
def test_a_formula_in_a_numeric_cell_is_refused_and_never_evaluated(cell):
    quoted = '"' + cell.replace('"', '""') + '"'
    for column_header, row_text in (("Rating (MVA)", f"SYN-TX-1,{quoted}"), ("Units", f"SYN-TX-1,5,{quoted}")):
        header = "Asset ID,Rating (MVA)" + (",Units" if column_header == "Units" else "")
        with pytest.raises(ScheduleImportError) as exc:
            parse(f"{header}\n{row_text}\n")
        assert column_header in str(exc.value) and "row 2" in str(exc.value)


def test_a_signed_plain_decimal_is_not_mistaken_for_a_formula():
    assert parse("Asset ID,Rating (MVA)\nSYN-TX-1,+5\n").items[0]["unit_rating_MVA"] == 5
    with pytest.raises(ScheduleImportError) as exc:
        parse("Asset ID,Rating (MVA)\nSYN-TX-1,-5\n")
    assert "above zero" in str(exc.value)


def test_control_characters_in_a_mapped_text_cell_or_a_header_are_refused_but_ignored_in_an_unmapped_cell():
    p = parse("Asset ID,Rating (MVA),Notes\nSYN-TX-1,5,\x1b[31mred\x07\n")
    assert p.items == [{"id": "SYN-TX-1", "unit_rating_MVA": 5}]
    for text, where in (("Asset ID,Rating (MVA)\nSYN-\x1b[31mTX-1,5\n", "row 2, column 1"), ("Asset ID,Rating (MVA)\nSYN-TX-1,5‮\n", "row 2, column 2"),
                        ("Asset\x07 ID,Rating (MVA)\nSYN-TX-1,5\n", "row 1, column 1"), ("Asset ID,Rating (MVA​)\nSYN-TX-1,5\n", "row 1, column 2")):
        with pytest.raises(ScheduleImportError) as exc:
            parse(text)
        assert where in str(exc.value) and "\x1b" not in str(exc.value) and "\x07" not in str(exc.value) and "‮" not in str(exc.value)


def test_a_skipped_comment_line_is_recorded_without_control_or_separator_characters():
    """The ledger keeps the start of each skipped `#` line so an operator can see a data row swallowed as a comment, but never raw bytes a terminal obeys."""
    import unicodedata
    p = parse("# note \x1b[31m red   line ‮ rtl \x07\nAsset ID,Rating (MVA)\n#SYN-TX-9,7\nSYN-TX-1,5\n")
    assert [c["row"] for c in p.ledger["skipped_comment_lines"]] == [1, 3]
    assert p.ledger["skipped_comment_lines"][1]["text"] == "#SYN-TX-9,7"           # a data-looking row that was skipped is visible in the ledger
    for c in p.ledger["skipped_comment_lines"]:
        assert not any(unicodedata.category(ch) in ("Cc", "Cf", "Zl", "Zp") for ch in c["text"]), c


def test_a_refusal_message_never_echoes_raw_control_characters_or_unbounded_text():
    with pytest.raises(ScheduleImportError) as exc:
        parse("Asset ID,Rating (MVA)\nSYN-TX-1,\x1b[2J" + "A" * 5_000 + "\n")
    msg = str(exc.value)
    assert "\x1b" not in msg and len(msg) < 1_500


def test_header_limits():
    with pytest.raises(ScheduleImportError) as exc:
        parse("Asset ID,Rating (MVA)," + ",".join(f"c{i}" for i in range(200)) + "\nSYN-TX-1,5\n")
    assert "columns" in str(exc.value)
    with pytest.raises(ScheduleImportError) as exc:
        parse("Asset ID,Rating (MVA)," + "H" * 5_000 + "\nSYN-TX-1,5\n")
    assert "row 1, column 3" in str(exc.value)


def test_an_over_long_source_label_or_one_with_control_characters_is_refused():
    for label in ("x" * 1_000, "E-101\x00", "E-101\n rev"):
        with pytest.raises(ScheduleImportError) as exc:
            parse(tx_csv(GOOD_TX), source_label=label)
        assert "source label" in str(exc.value).lower()


def test_random_bytes_are_refused_or_imported_but_never_an_uncaught_exception():
    rng = random.Random(404)
    seeds = [tx_csv(GOOD_TX).encode(), fixture("SYNTHETIC_transformers_kva_status_semicolon.csv"), fixture("SYNTHETIC_ups_kva_with_power_factor.csv")]
    outcomes = {"refused": 0, "imported": 0}
    for n in range(600):
        base = bytearray(rng.choice(seeds)) if n % 3 else bytearray(rng.getrandbits(8) for _ in range(rng.randint(0, 400)))
        for _ in range(rng.randint(0, 6)):
            if base:
                pos = rng.randrange(len(base))
                op = rng.choice(["flip", "delete", "insert", "dup"])
                if op == "flip":
                    base[pos] = rng.getrandbits(8)
                elif op == "delete":
                    del base[pos]
                elif op == "insert":
                    base.insert(pos, rng.choice([34, 44, 59, 9, 10, 13, 35, 0, 61, 43, 45, 64, 0xd9, 0xef]))
                else:
                    base[pos:pos] = base[pos:pos + rng.randint(1, 20)]
        for kind in ("transformers", "ups"):
            for installed in (True, False):
                try:
                    p = parse_schedule(bytes(base), file_name="f.csv", kind=kind, rows_are_installed=installed)
                except ScheduleImportError:
                    outcomes["refused"] += 1
                else:
                    outcomes["imported"] += 1
                    for item in p.items:
                        assert set(item) <= EQUIPMENT_KEYS[kind]
                    load_document({kind: p.items})
    assert outcomes["refused"] > 500 and outcomes["imported"] >= 1


def test_hostile_into_documents_are_refused_by_name(tmp_path, capsys):
    cases = {"not-json.json": b"{nope", "list.json": b"[1, 2]", "nul.json": b'{"a": "\x00"}', "deep.json": b"[" * 200_000 + b"]" * 200_000,
             "big.json": b'{"project": {"note": "' + b"x" * 600_000 + b'"}}', "bad-utf8.json": b'{"a": "\xff"}', "scalar.json": b"7"}
    for name, data in cases.items():
        hall = tmp_path / name
        hall.write_bytes(data)
        out, led = tmp_path / f"{name}.out", tmp_path / f"{name}.led"
        rc, o, e = run_main(capsys, "import-schedule", FIX / "SYNTHETIC_transformers_reference_equivalent.csv", "--kind", "transformers",
                            "--rows-are-installed", "--into", hall, "-o", out, "--ledger", led)
        assert rc == 2 and "Traceback" not in e and not out.exists() and not led.exists(), (name, e[-300:])
    rc, o, e = run_main(capsys, "import-schedule", FIX / "SYNTHETIC_transformers_reference_equivalent.csv", "--kind", "transformers",
                        "--rows-are-installed", "--into", tmp_path / "missing.json", "-o", tmp_path / "o", "--ledger", tmp_path / "l")
    assert rc == 2 and "missing.json" in e


def test_an_existing_section_of_the_wrong_shape_needs_replace_and_is_then_replaced(tmp_path, capsys):
    d = copy.deepcopy(REFERENCE)
    d["transformers"] = "oops"
    hall = tmp_path / "hall.json"
    hall.write_text(json.dumps(d), encoding="utf-8")
    r = invoke(tmp_path, capsys, fixture("SYNTHETIC_transformers_reference_equivalent.csv"), "transformers", into=hall)
    assert r.rc == 2 and "--replace" in r.err
    r = invoke(tmp_path, capsys, fixture("SYNTHETIC_transformers_reference_equivalent.csv"), "transformers", "--replace", into=hall)
    assert r.rc == 0 and json.loads(r.out_path.read_text(encoding="utf-8"))["transformers"][0]["id"] == "SYN-TX-1"


def test_the_module_imports_only_the_standard_library_and_the_loader_beside_it():
    """tests/test_architecture.py enforces the layering for the whole package; this pins the importer's own imports tightly."""
    import ast
    tree = ast.parse(Path(si.__file__).read_text(encoding="utf-8"))
    relative, absolute = set(), set()
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.level:
            relative.add((node.level, node.module))
        elif isinstance(node, ast.ImportFrom):
            absolute.add(node.module.split(".")[0])
        elif isinstance(node, ast.Import):
            absolute.update(a.name.split(".")[0] for a in node.names)
    assert relative == {(1, "loader")}, relative
    assert absolute <= {"__future__", "dataclasses", "hashlib", "json", "os", "re", "typing", "unicodedata", "pathlib"}, absolute
    assert IntakeError in ScheduleImportError.__mro__          # so the CLI's generic handler maps any missed path to exit 2
