"""The one-page board summary (docs/01 §4D) is generated from the same solved model, labels and gates as the study.

It is the page a sponsor forwards without editing, so it is held to the study's rules and to a few of its own:
it must be short, it must say how firm the numbers are, and it must never disagree with the long report."""
import json
import re
import subprocess
import sys
from pathlib import Path

import pytest

from gridforge.api.server import handle_study
from gridforge.api.tiers import Tier
from gridforge.reporting.study import DECISION_GATES

ROOT = Path(__file__).resolve().parent.parent
INTAKES = sorted((ROOT / "examples" / "intake").glob("*.json"))
DUBLIN = ROOT / "examples" / "intake" / "dublin_hall.json"


def run_study(intake, out):
    r = subprocess.run([sys.executable, "-m", "gridforge", "study", str(intake), "-o", str(out)], capture_output=True, text=True, cwd=ROOT)
    assert r.returncode == 0, r.stderr
    return (out / "envelope_study.md").read_text(), (out / "board_summary.md").read_text(), (out / "board_summary.html").read_text()


def body(md):
    """Everything before the provenance appendix: the page itself."""
    return md.split("## Appendix A")[0]


@pytest.mark.parametrize("intake", INTAKES, ids=lambda p: p.stem)
def test_every_study_ships_a_board_summary_that_fits_on_a_page(tmp_path, intake):
    _, board, html = run_study(intake, tmp_path / "o")
    words = len(re.findall(r"\w+", re.sub(r"[|#*>_`-]", " ", body(board))))
    assert words <= 520, f"{words} words is not one page"
    assert "## Appendix A" in board, "the provenance appendix is non-negotiable (docs/01 §6)"
    assert "<h1" in html or "<h2" in html


def test_the_board_summary_states_the_same_numbers_as_the_study(tmp_path):
    study, board, _ = run_study(DUBLIN, tmp_path / "o")
    # the same quantity strings, because they come from the same objects
    for fragment in (re.search(r"after the full headroom ladder:\*\* (\d+ racks \(E\d\))", study).group(1),
                     re.search(r"Time to full capacity:\*\* (\d+ \[\d+–\d+\] weeks \(E\d\))", study).group(1),
                     re.search(r"Indicative capex to reach it:\*\* ([\d,]+ \[[\d,]+–[\d,]+\] EUR \(E\d\))", study).group(1)):
        assert fragment in board, f"{fragment!r} is in the study but not the board summary"


def test_it_says_how_firm_the_numbers_are_and_what_they_depend_on_most(tmp_path):
    _, board, _ = run_study(DUBLIN, tmp_path / "o")
    page = body(board)
    assert "How firm this is" in page and "EVIDENCE DISCLOSURE:" in page
    assert "library defaults rather than quotations" in page
    assert "depends most on one assumed input" in page and "69 to 0 racks" in page
    assert "not yet been checked against any instrumented site" in page


def test_the_decision_gates_are_the_studys_not_a_paraphrase(tmp_path):
    study, board, _ = run_study(DUBLIN, tmp_path / "o")
    for short, long in DECISION_GATES:
        assert short in board and long in study
    assert [g.split(" — ")[0] for g, _ in DECISION_GATES] == ["Gate 1", "Gate 2", "Gate 3", "Gate 4"]


def test_the_stamp_follows_the_same_rule_as_the_study(tmp_path):
    d = json.loads(DUBLIN.read_text())
    d["project"] = {"client": "Acme Data Centres Ltd", "reference": "ACME-001"}
    f = tmp_path / "real.json"
    f.write_text(json.dumps(d))
    _, board, html = run_study(f, tmp_path / "o")
    assert "SYNTHETIC REFERENCE DATA" not in board and "SYNTHETIC REFERENCE DATA" not in html
    _, synth, _ = run_study(DUBLIN, tmp_path / "o2")
    assert "SYNTHETIC REFERENCE DATA" in synth


def test_no_rung_is_listed_that_adds_nothing_and_each_row_says_why_it_is_there(tmp_path):
    _, board, _ = run_study(DUBLIN, tmp_path / "o")
    rows = [l for l in body(board).split("## What decides it")[1].split("## ")[0].splitlines() if l.startswith("| ") and not l.startswith(("| Why", "| ---"))]
    assert 1 <= len(rows) <= 3
    for r in rows:
        assert re.match(r"\| (binds first|largest cost|sets the date)", r), r


def test_the_api_serves_the_same_page(tmp_path):
    doc = json.loads(DUBLIN.read_text())
    out = handle_study({"intake": doc, "format": "md", "view": "board"}, Tier.CLIENT)
    assert out["document"].startswith("# Board summary")
    study, board, _ = run_study(DUBLIN, tmp_path / "o")
    assert body(out["document"]).strip() == body(board).strip()
