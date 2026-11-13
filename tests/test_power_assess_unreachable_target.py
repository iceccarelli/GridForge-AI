"""/v1/power/assess says so when the target is above what the full headroom ladder reaches.

The audit found target_racks=200 on a hall whose ladder tops out at 62 answered `gap_racks: 200` (target less what deploys now) and the next action
'Obtain a quote for tap-off units', with no word that no relief on the ladder gets there. `target_reachable`, `gap_racks_after_ladder` and a
next action that leads with the fact are added; `gap_racks` keeps its meaning.
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

from gridforge.api.server import handle_power_assess
from gridforge.api.tiers import Tier
from gridforge.api.tools import TOOLS_BY_NAME
from gridforge.intake.loader import load_document
from gridforge.reporting.readiness import assess
from gridforge.scenario.run import run_all

ROOT = Path(__file__).resolve().parent.parent
REF = json.loads((ROOT / "examples" / "intake" / "reference_hall.json").read_text())


@pytest.fixture(scope="module")
def solved():
    intake = load_document(json.loads(json.dumps(REF)))
    return intake, run_all(intake.context, intake.scenarios)


def case(solved, target=None):
    intake, results = solved
    return assess(intake, results, target_racks=target)


def test_a_target_above_the_ladder_is_not_reachable_and_the_answer_says_so(solved):
    ceiling = case(solved)["capacity"]["racks_after_full_headroom_ladder"]
    assert ceiling > 0
    cap = case(solved, ceiling + 138)["capacity"]
    assert cap["target_reachable"] is False
    assert cap["gap_racks_after_ladder"] == 138
    assert cap["gap_racks"] == ceiling + 138 - cap["current_deployable_racks"], "gap_racks keeps its meaning: target less what deploys now"
    na = case(solved, ceiling + 138)["next_action"]
    assert na["action"].startswith(f"The target of {ceiling + 138} racks is not reachable at this hall")
    assert f"reaches {ceiling} racks, 138 short" in na["action"]
    assert na["target_reachable"] is False and na["gap_racks_after_ladder"] == 138
    assert na["ladder_action"] and na["ladder_action"] == case(solved)["next_action"]["action"]
    assert na["why"] and na["how"]


def test_the_audits_case_200_racks_on_a_ladder_that_reaches_62(solved):
    out = case(solved, 200)
    ceiling = out["capacity"]["racks_after_full_headroom_ladder"]
    assert ceiling < 200
    assert out["capacity"]["gap_racks"] == 200 - out["capacity"]["current_deployable_racks"]
    assert out["capacity"]["gap_racks_after_ladder"] == 200 - ceiling and out["capacity"]["target_reachable"] is False
    assert "not reachable" in out["next_action"]["action"] and str(ceiling) in out["next_action"]["action"]


@pytest.mark.parametrize("target", [None, 0, 1, 40, 62])
def test_a_target_the_ladder_reaches_is_reachable_and_the_next_action_is_unchanged(solved, target):
    out = case(solved, target)
    ceiling = out["capacity"]["racks_after_full_headroom_ladder"]
    if target is not None and target > ceiling:
        pytest.fail("fixture ladder is lower than this parametrised target")
    assert out["capacity"]["target_reachable"] is True and out["capacity"]["gap_racks_after_ladder"] == 0
    assert "not reachable" not in out["next_action"]["action"]
    assert "target_reachable" not in out["next_action"], "the next action is exactly what it was for a target the ladder reaches"
    assert out["next_action"] == case(solved)["next_action"]


def test_exactly_the_ladder_ceiling_is_reachable(solved):
    ceiling = case(solved)["capacity"]["racks_after_full_headroom_ladder"]
    assert case(solved, ceiling)["capacity"]["target_reachable"] is True
    assert case(solved, ceiling + 1)["capacity"]["target_reachable"] is False


def test_when_the_ladder_adds_nothing_the_action_says_so_rather_than_promising_a_purchase():
    sparse = json.loads(json.dumps(REF))
    sparse["hall"]["positions_available"] = 0
    intake = load_document(sparse)
    results = run_all(intake.context, intake.scenarios)
    out = assess(intake, results, target_racks=50)
    assert out["capacity"]["racks_after_full_headroom_ladder"] == 0 and out["capacity"]["target_reachable"] is False
    assert "no relief on the ladder adds to the" in out["next_action"]["action"]
    assert "To reach" not in out["next_action"]["action"]


def test_the_http_handler_carries_the_new_keys_on_every_tier():
    for tier in (Tier.CLIENT, Tier.PUBLIC):
        out = handle_power_assess({"intake": REF, "target_racks": 200}, tier)
        assert out["capacity"]["target_reachable"] is False and "not reachable" in out["next_action"]["action"]


def test_the_cli_prints_the_same_next_action(tmp_path):
    result = subprocess.run([sys.executable, "-m", "gridforge", "power-assess", str(ROOT / "examples" / "intake" / "reference_hall.json"),
                             "--target-racks", "300"], capture_output=True, text=True, cwd=ROOT, timeout=120)
    assert result.returncode == 0, result.stderr
    assert "not reachable at this hall" in result.stdout


def test_the_tool_text_names_the_new_keys():
    returns = TOOLS_BY_NAME["gridforge_power_assess"]["returns"]
    assert "target_reachable" in returns and "gap_racks_after_ladder" in returns
