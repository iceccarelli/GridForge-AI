"""The Power Readiness Case (gridforge/reporting/readiness.py).

This is the composed decision object: current deployable capacity vs. a target,
the binding constraint, the priced headroom ladder, the critical-path dependencies
that set time to power, the calibration state, and one deterministic next action.
It computes no new physics — every assertion here is really a check that the
composition did not lose, invent, or mis-attribute a number the engine already
produced elsewhere.
"""
import json
import subprocess
import sys
from pathlib import Path

import pytest

from gridforge.intake.loader import load
from gridforge.procurement import relief_steps
from gridforge.reporting.readiness import assess
from gridforge.reporting.study import Objective, _pick_recommended
from gridforge.scenario.run import run_all

ROOT = Path(__file__).resolve().parents[1]
REFERENCE = ROOT / "examples" / "intake" / "reference_hall.json"


def _cli(*args):
    return subprocess.run([sys.executable, "-m", "gridforge", *args],
                          cwd=ROOT, capture_output=True, text=True)


@pytest.fixture(scope="module")
def solved():
    intake = load(REFERENCE)
    results = run_all(intake.context, intake.scenarios)
    return intake, results


def test_binding_constraint_matches_the_recommended_scenarios_own_envelope(solved):
    """The case must not compute a second opinion about what binds — it reads the
    one the recommended scenario already reached."""
    intake, results = solved
    rec = _pick_recommended(results, Objective.MAX_COMPUTE)
    case = assess(intake, results)
    assert case["binding_constraint"]["id"] == rec.envelope.binding.id
    assert case["binding_constraint"]["name"] == rec.envelope.binding.name


def test_headroom_ladder_is_the_same_purchasable_steps_procurement_would_tender(solved):
    """Every rung in the case must be one `gridforge spec` could actually build a
    tender for — the case must not show a relief option procurement cannot act on,
    and must not drop one procurement considers purchasable."""
    intake, results = solved
    rec = _pick_recommended(results, Objective.MAX_COMPUTE)
    steps = relief_steps(rec)
    case = assess(intake, results)
    assert len(case["headroom_ladder"]) == len(steps)
    for row, step in zip(case["headroom_ladder"], steps):
        assert row["binding_constraint"] == step.binding_id
        assert row["purchasable"] == bool(step.taken and step.cost_key not in
                                          (None, "", "not-capital"))


def test_no_capex_or_lead_time_is_invented(solved):
    """Every capex and lead-time figure on the ladder must trace to the same
    Quantity the ladder step itself carries — value, evidence class and all."""
    intake, results = solved
    rec = _pick_recommended(results, Objective.MAX_COMPUTE)
    steps = relief_steps(rec)
    case = assess(intake, results)
    for row, step in zip(case["headroom_ladder"], steps):
        if step.capex_eur is not None:
            assert row["capex_eur"]["value"] == step.capex_eur.rounded()
            assert row["capex_eur"]["evidence"] == step.capex_eur.evidence.name
        else:
            assert row["capex_eur"] is None
        if step.lead_time_weeks is not None:
            assert row["lead_time_weeks"]["evidence"] == step.lead_time_weeks.evidence.name


def test_gap_is_computed_against_the_stated_target(solved):
    intake, results = solved
    case = assess(intake, results, target_racks=300)
    assert case["capacity"]["target_racks"] == 300
    assert case["capacity"]["gap_racks"] == 300 - case["capacity"]["current_deployable_racks"]
    assert case["capacity"]["requested_target_given"] is True


def test_without_a_target_the_gap_is_sized_against_the_ladders_own_ceiling(solved):
    """No target given -> report against what the headroom ladder itself can
    reach, not a silently invented number."""
    intake, results = solved
    case = assess(intake, results)
    assert case["capacity"]["requested_target_given"] is False
    assert case["capacity"]["target_racks"] == case["capacity"]["racks_after_full_headroom_ladder"]
    assert case["capacity"]["gap_racks"] == max(
        case["capacity"]["racks_after_full_headroom_ladder"]
        - case["capacity"]["current_deployable_racks"], 0)


def test_dependencies_are_distinct_and_ordered_by_lead_time(solved):
    """`HeadroomLadder.steps` can revisit the same constraint more than once as
    capacity climbs (relieve busway, hit another limit, relieve it, hit busway
    again at a higher rack count) — real and correct for the ladder itself, but a
    buyer asking "what am I waiting on" needs a short, distinct list."""
    intake, results = solved
    case = assess(intake, results)
    names = [d["step"] for d in case["time_to_power"]["dependencies"]]
    assert len(names) == len(set(names)), f"duplicate dependency in {names}"
    weeks = [d["lead_time_weeks"]["value"] for d in case["time_to_power"]["dependencies"]]
    assert weeks == sorted(weeks, reverse=True)


def test_critical_item_appears_among_the_dependencies(solved):
    intake, results = solved
    case = assess(intake, results)
    names = {d["step"] for d in case["time_to_power"]["dependencies"]}
    assert case["time_to_power"]["critical_item"] in names


def test_calibration_state_is_the_engines_own_and_never_upgraded(solved):
    """The case must never claim more certainty than the calibration ledger
    itself has earned. With an empty bundled ledger, that means UNCALIBRATED,
    stated as such, not silently omitted."""
    intake, results = solved
    case = assess(intake, results)
    assert case["evidence"]["calibration"]["state"] == "uncalibrated"
    assert "modelled" in case["evidence"]["disclosure"].lower()


def test_next_action_prioritises_a_required_data_gap_over_a_purchase():
    """A case with an incomplete intake must point at closing the gap before it
    ever recommends spending money — a relief option priced on an assumption the
    client could have just told us is not a defensible next step. london_hall is
    the one bundled example with a required gap; if a future edit closes it, pick
    another example that still has one rather than skip this silently."""
    path = ROOT / "examples" / "intake" / "london_hall.json"
    intake = load(path)
    assert intake.report.required_gaps, (
        f"{path.name} no longer has a required gap — this test needs a different "
        f"example to exercise the gap-first branch of next_action")
    results = run_all(intake.context, intake.scenarios)
    case = assess(intake, results)
    assert case["next_action"]["action"].startswith("Close the data gap")


def test_next_action_is_always_one_of_the_three_defined_shapes(solved):
    intake, results = solved
    case = assess(intake, results)
    action = case["next_action"]["action"]
    assert (action.startswith("Close the data gap")
            or action.startswith("Obtain a budgetary or firm quote")
            or action.startswith("Proceed to procurement")
            or action.startswith("No purchasable relief identified")), action


def test_cli_power_assess_runs_end_to_end(tmp_path):
    out = tmp_path / "case.json"
    result = _cli("power-assess", str(REFERENCE), "--target-racks", "300", "-o", str(out))
    assert result.returncode == 0, result.stderr
    assert "Binding constraint" in result.stdout
    assert "Next action" in result.stdout
    case = json.loads(out.read_text())
    assert case["capacity"]["target_racks"] == 300
    assert case["binding_constraint"]["id"]


def test_evidence_classes_present_are_never_stronger_than_e3(solved):
    """Nothing in the bundled reference hall's headroom ladder has been reconciled
    against site data — every relief cost and lead time here is a library default
    or an engineering estimate. If a future library change legitimately earns a
    stronger class, update this test's ceiling deliberately; it must never creep
    up by accident."""
    intake, results = solved
    case = assess(intake, results)
    weak = {"E0_ASSUMPTION", "E1_MODELLED", "E2_SIMULATED", "E3_ENGINEERING_ESTIMATE"}
    assert set(case["evidence"]["evidence_classes_in_headroom_ladder"]) <= weak
