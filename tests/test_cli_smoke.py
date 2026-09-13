"""Smoke tests: every command in the README and the runbook, run exactly as documented.

This file exists because the suite once passed 62 tests while `gridforge screen`
crashed on the blank intake that `gridforge init` had just produced. Unit tests on
library functions do not prove the product works. These do: they run the real
entry point, on the real files, and fail on a traceback.

Rule for this file: if a command appears in the README, the runbook or a reply to
the founder, it is exercised here.
"""
import json
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
INTAKE_DIR = ROOT / "examples" / "intake"
EXAMPLES = sorted(INTAKE_DIR.glob("*.json"))


def run(*args, cwd=ROOT):
    r = subprocess.run([sys.executable, "-m", "gridforge", *args],
                       cwd=cwd, capture_output=True, text=True)
    assert "Traceback" not in r.stderr, (
        f"gridforge {' '.join(map(str, args))} raised instead of failing cleanly:\n{r.stderr}")
    return r


def test_examples_exist():
    assert EXAMPLES, "the shipped example intakes are part of the product"


@pytest.fixture(scope="module")
def blank(tmp_path_factory):
    """The worst realistic input: what `init` hands a client before they fill it in."""
    d = tmp_path_factory.mktemp("blank")
    out = d / "intake.json"
    r = run("init", "-o", str(out))
    assert r.returncode == 0, r.stderr
    assert out.exists()
    json.loads(out.read_text())
    return out


def test_init_then_gaps_on_a_blank_intake(blank):
    r = run("gaps", str(blank))
    assert r.returncode == 0, r.stderr
    assert "Intake completeness: 0%" in r.stdout
    assert "Density Screen" in r.stdout, "a blank intake must route to the screen, not the study"


def test_screen_survives_a_blank_intake(blank, tmp_path):
    r = run("screen", str(blank), "-o", str(tmp_path))
    assert r.returncode == 0, r.stderr + r.stdout
    for name in ("density_screen.md", "density_screen.html", "model_pack.json"):
        p = tmp_path / name
        assert p.exists() and p.stat().st_size > 0


def test_study_survives_a_blank_intake(blank, tmp_path):
    r = run("study", str(blank), "-o", str(tmp_path))
    assert r.returncode == 0, r.stderr + r.stdout
    assert (tmp_path / "envelope_study.md").stat().st_size > 0
    assert "required inputs are assumed" in r.stdout, (
        "a study built on assumptions must say so on the console, not only in the report")


def test_blank_intake_report_never_claims_a_client(blank, tmp_path):
    run("study", str(blank), "-o", str(tmp_path))
    md = (tmp_path / "envelope_study.md").read_text()
    assert "Unnamed client" in md
    assert "— :" not in md, "an empty client name must not render as a dangling separator"


@pytest.mark.parametrize("intake", EXAMPLES, ids=lambda p: p.stem)
def test_screen_runs_for_every_shipped_example(intake, tmp_path):
    r = run("screen", str(intake), "-o", str(tmp_path))
    assert r.returncode == 0, r.stderr + r.stdout
    assert (tmp_path / "density_screen.md").stat().st_size > 0


@pytest.mark.parametrize("intake", EXAMPLES, ids=lambda p: p.stem)
def test_study_runs_for_every_shipped_example(intake, tmp_path):
    r = run("study", str(intake), "-o", str(tmp_path))
    assert r.returncode == 0, r.stderr + r.stdout
    pack = json.loads((tmp_path / "model_pack.json").read_text())
    assert pack["scenarios"], "a study with no scenarios is not a study"


@pytest.mark.parametrize("objective", ["max_compute", "min_cost", "fastest"])
def test_every_objective_runs(objective, tmp_path):
    r = run("study", str(EXAMPLES[0]), "-o", str(tmp_path), "--objective", objective)
    assert r.returncode == 0, r.stderr


def test_portfolio_runs_over_the_shipped_examples(tmp_path):
    r = run("portfolio", *[str(p) for p in EXAMPLES], "-o", str(tmp_path),
            "--client", "Smoke test")
    assert r.returncode == 0, r.stderr + r.stdout
    assert (tmp_path / "portfolio_screen.md").stat().st_size > 0
    assert len(list(tmp_path.glob("model_pack_*.json"))) == len(EXAMPLES)


def test_unmatched_glob_explains_itself(tmp_path):
    r = run("portfolio", "halls/*.json", "-o", str(tmp_path))
    assert r.returncode == 2
    assert "no intake files matched" in r.stderr


def test_missing_file_explains_itself(tmp_path):
    r = run("study", str(tmp_path / "nope.json"), "-o", str(tmp_path))
    assert r.returncode == 2
    assert "no such intake file" in r.stderr


def test_directory_instead_of_file_explains_itself(tmp_path):
    r = run("study", str(INTAKE_DIR), "-o", str(tmp_path))
    assert r.returncode == 2
    assert "is a directory" in r.stderr


def test_malformed_json_explains_itself(tmp_path):
    bad = tmp_path / "bad.json"
    bad.write_text("{ this is not json")
    r = run("screen", str(bad), "-o", str(tmp_path))
    assert r.returncode == 2
    assert "not valid JSON" in r.stderr


def test_makefile_targets_match_the_cli():
    """The runbook tells a founder to type `make screen`. It has to work."""
    mk = (ROOT / "Makefile").read_text()
    for target in ("screen:", "study:", "portfolio:", "gaps:", "intake:"):
        assert target in mk, f"Makefile is missing the documented target {target!r}"
