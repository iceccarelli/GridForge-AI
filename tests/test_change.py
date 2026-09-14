"""The change engine: what moved, and which input moved it.

This is what a Hall Watch sells. The tests that matter are the honesty ones — an
attribution that quietly adds up to the wrong number, or a "nothing changed" that
hides a movement, would destroy the only thing the subscription is selling.
"""
import copy
import json
import subprocess
import sys
from pathlib import Path

import pytest

from gridforge.change import EnvelopeState, changed_paths, diff, diff_from_state, flatten
from gridforge.reporting import to_markdown
from gridforge.reporting.change_note import build as build_note
from gridforge.scenario.objective import Objective

ROOT = Path(__file__).resolve().parents[1]
REFERENCE = ROOT / "examples" / "intake" / "reference_hall.json"


@pytest.fixture(scope="module")
def base():
    return json.loads(REFERENCE.read_text())


def moved(base, **changes):
    d = copy.deepcopy(base)
    for path, value in changes.items():
        cur = d
        parts = path.split(".")
        for p in parts[:-1]:
            cur = cur.setdefault(p, {})
        existing = cur.get(parts[-1])
        if isinstance(existing, dict) and "value" in existing:
            existing["value"] = value
        else:
            cur[parts[-1]] = value
    return d


# --- flattening and change detection -----------------------------------------
def test_a_value_wrapper_is_one_leaf_not_a_subtree(base):
    flat = flatten(base)
    assert flat["hall.floor_loading_kPa"] == 12
    assert "hall.floor_loading_kPa.note" not in flat, (
        "a note is provenance, not an input; treating it as one would report prose as a driver"
    )


def test_metadata_changes_are_not_reported_as_input_changes(base):
    after = copy.deepcopy(base)
    after["project"]["client"] = "Someone else"
    assert changed_paths(base, after) == []


def test_a_note_changing_is_not_an_input_change(base):
    after = copy.deepcopy(base)
    after["hall"]["floor_loading_kPa"]["note"] = "restated"
    assert "hall.floor_loading_kPa" not in changed_paths(base, after)


# --- the diff ----------------------------------------------------------------
def test_identical_intakes_report_nothing(base):
    d = diff(base, copy.deepcopy(base))
    assert not d.material
    assert d.racks_delta == 0
    assert "Nothing that changes the answer" in d.headline()


def test_losing_contracted_power_loses_racks(base):
    d = diff(base, moved(base, **{"grid.contracted_MW": 10.5}))
    assert d.racks_delta < 0
    assert d.drivers[0].path == "grid.contracted_MW"
    assert d.drivers[0].racks_delta == d.racks_delta


def test_the_driver_table_is_ranked_by_effect(base):
    d = diff(base, moved(base, **{"grid.contracted_MW": 10.5, "lv.tapoff_max_A": 250}))
    deltas = [abs(x.racks_delta) for x in d.drivers]
    assert deltas == sorted(deltas, reverse=True)


def test_an_input_that_flips_the_binding_constraint_is_named(base):
    d = diff(base, moved(base, **{"lv.tapoff_max_A": 400}))
    assert any(x.flips_binding_to for x in d.drivers), (
        "relieving the tap-off rating must show up as changing what binds first"
    )


def test_contributions_and_residual_reconcile_to_the_total(base):
    d = diff(base, moved(base, **{"grid.contracted_MW": 10.5, "lv.tapoff_max_A": 250}))
    assert d.explained + d.residual == d.racks_delta, (
        "the driver table plus the stated residual must equal the total, or the note lies"
    )


def test_comparison_is_pinned_to_one_scenario(base):
    d = diff(base, moved(base, **{"grid.contracted_MW": 10.5}))
    assert d.before.scenario_id == d.after.scenario_id, (
        "comparing different architectures would report a change of subject as a change of hall"
    )


def test_a_changed_recommendation_is_reported_separately(base):
    # Strip the behind-the-meter options and the recommended architecture must move.
    after = copy.deepcopy(base)
    after["btm_options"] = []
    d = diff(base, after)
    assert d.recommendation_changed is not None
    assert d.recommendation_changed[0] != d.recommendation_changed[1]


def test_diff_from_a_recorded_state_needs_no_previous_document(base):
    first = diff(base, copy.deepcopy(base))
    again = diff_from_state(first.after, base)
    assert not again.material
    assert again.drivers == []


def test_a_movement_with_no_changed_inputs_is_attributed_to_our_side(base):
    stale = EnvelopeState(**{**diff(base, copy.deepcopy(base)).after.__dict__,
                             "racks_after_ladder": 5})
    d = diff_from_state(stale, base)
    assert d.material and not d.changed_paths
    md = to_markdown(build_note(d, site="S", hall="H", client="C"))
    assert "on our side" in md, (
        "if the answer moved because our libraries moved, the client must be told that"
    )


# --- the change note ---------------------------------------------------------
def test_change_note_leads_with_what_moved(base):
    d = diff(base, moved(base, **{"grid.contracted_MW": 10.5}))
    md = to_markdown(build_note(d, site="S", hall="H", client="C"))
    assert md.index("What moved") < md.index("What moved it")
    assert "racks" in md


def test_change_note_states_the_residual_when_there_is_one(base):
    d = diff(base, moved(base, **{"grid.contracted_MW": 10.5, "lv.tapoff_max_A": 250}))
    md = to_markdown(build_note(d, site="S", hall="H", client="C"))
    if d.residual:
        assert "unexplained" in md


def test_change_note_says_do_nothing_when_nothing_moved(base):
    d = diff(base, copy.deepcopy(base))
    md = to_markdown(build_note(d, site="S", hall="H", client="C"))
    assert "No action" in md
    assert "manufacture a finding" in md


def test_change_note_carries_the_evidence_disclosure(base):
    d = diff(base, moved(base, **{"grid.contracted_MW": 10.5}))
    assert "EVIDENCE DISCLOSURE" in to_markdown(build_note(d, site="S", hall="H", client="C"))


def test_cli_diff_writes_a_note_and_a_machine_readable_change(tmp_path, base):
    after = tmp_path / "after.json"
    after.write_text(json.dumps(moved(base, **{"grid.contracted_MW": 10.5})))
    r = subprocess.run(
        [sys.executable, "-m", "gridforge", "diff", str(REFERENCE), str(after), "-o", str(tmp_path)],
        cwd=ROOT, capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    assert "Traceback" not in r.stderr
    payload = json.loads((tmp_path / "change.json").read_text())
    assert payload["racks_delta"] < 0
    assert payload["drivers"][0]["path"] == "grid.contracted_MW"
    assert (tmp_path / "change_note.md").exists()


def test_cli_diff_explains_a_missing_file(tmp_path):
    r = subprocess.run(
        [sys.executable, "-m", "gridforge", "diff", str(REFERENCE), str(tmp_path / "nope.json"),
         "-o", str(tmp_path)], cwd=ROOT, capture_output=True, text=True)
    assert r.returncode == 2 and "no such intake file" in r.stderr
