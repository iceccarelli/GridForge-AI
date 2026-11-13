"""When a tie between two scenarios decided the recommendation, the Study says so (review follow-up to the tie-stable recommendation).

`recommendation_rationale` produces the sentence; the Study's 'Selection objective' paragraph now prints it, so a reader who wonders why one of two
equal scenarios was recommended is told, rather than left to guess that listing order decided it.
"""
import copy
import json
from pathlib import Path

from gridforge.intake.loader import load
from gridforge.reporting import to_markdown
from gridforge.reporting.study import build as build_study
from gridforge.scenario import run_all
from gridforge.scenario.objective import Objective, pick_with_reason, recommendation_rationale

ROOT = Path(__file__).resolve().parents[1]


def _london_tie():
    doc = json.loads((ROOT / "examples" / "intake" / "london_hall.json").read_text(encoding="utf-8"))
    doc = copy.deepcopy(doc)
    doc["scenarios"] = ["full_dlc", "full_dlc_btm"]
    return doc


def test_a_tied_recommendation_is_stated_in_the_study(tmp_path):
    doc = _london_tie()
    f = tmp_path / "tie.json"
    f.write_text(json.dumps(doc), encoding="utf-8")
    intake = load(f)
    results = run_all(intake.context, intake.scenarios)
    rec = pick_with_reason(results, Objective.MAX_COMPUTE)
    assert rec.note, "the example must really tie, or this proves nothing"
    md = to_markdown(build_study(intake.context, results, objective=Objective.MAX_COMPUTE))
    assert recommendation_rationale(results, Objective.MAX_COMPUTE) in md
    assert rec.note in md
