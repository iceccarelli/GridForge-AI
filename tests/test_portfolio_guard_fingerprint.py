"""What identifies a shared grid connection, and what the CLI headline says when halls share one (review R9).

`grid_fingerprint` hashed every leaf of the grid block, strings included, although its own docstring says notes are not part of the identity: two
halls on one connection whose documents spell the operator or the queue note differently were missed. And three round numbers in common (10, 8 and
5 MW) were read as "likely one connection" between unrelated sites. Only figures identify a connection, and one of them must be a measured
site-level figure. The CLI printed "131 deployable racks across the 2 comparable" for two halls on one site, with the upper-bound qualifier only on
stderr.
"""
import copy
import json
from pathlib import Path

from gridforge.cli import main
from gridforge.reporting.portfolio_guard import grid_fingerprint

ROOT = Path(__file__).resolve().parents[1]
GRID = {"firm_capacity_MVA": 14, "contracted_MW": 12, "current_site_peak_MW": 7.4, "current_it_load_MW": 4.9}


def test_labels_do_not_change_the_identity_of_a_connection():
    a = {"grid": {**GRID, "dso": "Operator One", "queue_note": "in queue since 2024"}}
    b = {"grid": {**GRID, "dso": "operator one ltd", "queue_note": "no queue position yet"}}
    assert grid_fingerprint(a) is not None and grid_fingerprint(a) == grid_fingerprint(b)


def test_a_different_figure_is_a_different_connection():
    a = {"grid": dict(GRID)}
    b = {"grid": {**GRID, "current_site_peak_MW": 7.5}}
    assert grid_fingerprint(a) != grid_fingerprint(b)


def test_three_coincident_round_contract_numbers_are_not_evidence_of_one_connection():
    assert grid_fingerprint({"grid": {"firm_capacity_MVA": 10, "contracted_MW": 8, "power_factor": 0.97}}) is None
    assert grid_fingerprint({"grid": {"firm_capacity_MVA": 10, "contracted_MW": 8, "current_site_peak_MW": 5}}) is not None   # one measured figure counts


def test_the_cli_headline_says_upper_bound_when_halls_share_a_connection(tmp_path, capsys):
    ref = json.loads((ROOT / "examples" / "intake" / "reference_hall.json").read_text(encoding="utf-8"))
    sibling = copy.deepcopy(ref)
    sibling["hall"]["id"] = "DH-03"
    sibling["hall"]["rack_positions"] = 500
    a, b = tmp_path / "a.json", tmp_path / "b.json"
    a.write_text(json.dumps(ref)), b.write_text(json.dumps(sibling))
    assert main(["portfolio", str(a), str(b), "-o", str(tmp_path / "out")]) == 0
    out = capsys.readouterr().out
    headline = next(line for line in out.splitlines() if line.startswith("Portfolio Screen"))
    assert "upper bound" in headline and "counted once each" in headline


def test_separate_halls_get_no_upper_bound_caveat(tmp_path, capsys):
    ex = ROOT / "examples" / "intake"
    assert main(["portfolio", str(ex / "reference_hall.json"), str(ex / "dublin_hall.json"), "-o", str(tmp_path / "out")]) == 0
    headline = next(line for line in capsys.readouterr().out.splitlines() if line.startswith("Portfolio Screen"))
    assert "upper bound" not in headline
