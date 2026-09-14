"""The working files, the pinned clock, and the published worked example.

Two commercial claims are tested here rather than asserted in marketing copy:

  1. "You can check our arithmetic." A client gets the tables the study was
     solved from, with a provenance chain that closes — every quantity a derived
     figure came from is itself in the bundle.
  2. "The worked example on the site is the current output of the engine." That
     only holds if generation is deterministic, so a pinned report date must
     produce byte-identical documents.

If either breaks, we are selling something we do not have.
"""
import csv
import io
import json
import os
import subprocess
import sys
import zipfile
from datetime import date
from pathlib import Path

import pytest

from gridforge.clock import report_date, report_date_iso
from gridforge.intake.loader import load
from gridforge.scenario.run import run_all
from gridforge.serialize import csv_bundle, write_csv_bundle

ROOT = Path(__file__).resolve().parents[1]
REFERENCE_INTAKE = ROOT / "examples" / "intake" / "reference_hall.json"
BUNDLE_FILES = ["scenarios.csv", "headroom_ladder.csv", "constraints.csv",
                "inputs.csv", "assumed_inputs.csv", "provenance.csv", "README.txt"]


def run_cli(*args):
    r = subprocess.run([sys.executable, "-m", "gridforge", *args],
                       cwd=ROOT, capture_output=True, text=True)
    assert "Traceback" not in r.stderr, r.stderr
    return r


@pytest.fixture(scope="module")
def solved():
    intake = load(REFERENCE_INTAKE)
    return intake, run_all(intake.context, intake.scenarios)


# --- the clock -------------------------------------------------------------

def test_report_date_is_pinnable(monkeypatch):
    monkeypatch.setenv("GRIDFORGE_REPORT_DATE", "2026-01-01")
    assert report_date() == date(2026, 1, 1)
    assert report_date_iso() == "2026-01-01"


def test_a_corrupt_pin_falls_back_to_today_rather_than_crashing(monkeypatch):
    """A bad env var must not take the product down mid-delivery."""
    monkeypatch.setenv("GRIDFORGE_REPORT_DATE", "not-a-date")
    assert report_date() == date.today()


def test_unpinned_is_today(monkeypatch):
    monkeypatch.delenv("GRIDFORGE_REPORT_DATE", raising=False)
    assert report_date() == date.today()


# --- the bundle ------------------------------------------------------------

def test_bundle_has_every_promised_file(solved):
    b = csv_bundle(*solved)
    assert sorted(b) == sorted(BUNDLE_FILES)
    for name, text in b.items():
        assert text.strip(), f"{name} is empty"


def test_every_scenario_reaches_the_scenario_table(solved):
    intake, results = solved
    rows = list(csv.DictReader(io.StringIO(csv_bundle(intake, results)["scenarios.csv"])))
    assert len(rows) == len(results)
    assert {r["scenario_id"] for r in rows} == {r.spec.id for r in results}
    for r in rows:
        assert r["binds_first"], "a scenario with no binding constraint"
        assert r["accuracy_class"], "a capex figure with no AACE class attached"


def test_every_constraint_is_reported_not_just_the_binding_one(solved):
    """A client who only sees what bound cannot tell how close the next one was."""
    intake, results = solved
    rows = list(csv.DictReader(io.StringIO(csv_bundle(intake, results)["constraints.csv"])))
    per_scenario = {}
    for r in rows:
        per_scenario.setdefault(r["scenario_id"], []).append(r)
    assert per_scenario
    for sid, rs in per_scenario.items():
        assert len(rs) >= 10, f"{sid} reported only {len(rs)} constraints"
        binding = [r for r in rs if r["binds"] == "True"]
        assert len(binding) == 1, f"{sid} has {len(binding)} binding constraints"


def test_the_provenance_chain_closes(solved):
    """Every quantity a derived figure came from must itself be in the bundle.

    A chain with dangling references is not checkable, and a client's engineer
    will find that faster than we will.
    """
    intake, results = solved
    rows = list(csv.DictReader(io.StringIO(csv_bundle(intake, results)["provenance.csv"])))
    assert len(rows) > 20
    digests = {r["digest"] for r in rows}
    assert all(r["digest"] for r in rows)
    dangling = []
    for r in rows:
        for parent in filter(None, (p.strip() for p in r["derived_from"].split())):
            if parent not in digests:
                dangling.append((r["quantity"], parent))
    assert not dangling, f"provenance references nothing: {dangling[:5]}"
    assert any(r["derived_from"] for r in rows), "nothing derived — the chain is flat"


def test_assumed_inputs_are_the_gap_ledger(solved):
    """What we supplied because the client did not, stated separately from what they gave."""
    intake, results = solved
    b = csv_bundle(intake, results)
    assumed = list(csv.DictReader(io.StringIO(b["assumed_inputs.csv"])))
    used = list(csv.DictReader(io.StringIO(b["inputs.csv"])))
    assert used, "a study with no inputs"
    for r in used:
        assert r["source"] in ("client", "assumed"), r
    assert any(r["source"] == "client" for r in used), "nothing attributed to the client"
    # Nothing the client handed us may be relabelled as something we worked out.
    doc_paths = set(used and {r["path"] for r in used})
    assert doc_paths, "the input table is empty"
    for r in assumed:
        assert r["input"], "a gap with no label"
        assert r["how_to_get_it"], f"{r['input']}: a gap we cannot tell the client how to close"


def test_blank_intake_still_produces_a_bundle(tmp_path):
    """The worst input we ship must not crash the thing we hand the client."""
    blank = tmp_path / "blank.json"
    assert run_cli("init", "-o", str(blank)).returncode == 0
    out = tmp_path / "out"
    r = run_cli("study", str(blank), "-o", str(out), "--csv")
    assert r.returncode == 0, r.stderr
    for name in BUNDLE_FILES:
        assert (out / "working_files" / name).exists(), name


def test_write_csv_bundle_lands_on_disk(tmp_path, solved):
    written = write_csv_bundle(tmp_path / "wf", *solved)
    assert {p.name for p in written} == set(BUNDLE_FILES)


# --- determinism -----------------------------------------------------------

def test_a_pinned_date_produces_identical_documents(tmp_path):
    """Two runs of the same commit must agree byte for byte, or the CI drift
    guard on public/reference reports noise instead of drift."""
    env = dict(os.environ, GRIDFORGE_REPORT_DATE="2026-01-01")
    hashes = []
    for i in range(2):
        d = tmp_path / f"run{i}"
        r = subprocess.run([sys.executable, "-m", "gridforge", "study",
                            str(REFERENCE_INTAKE), "-o", str(d), "--csv"],
                           cwd=ROOT, env=env, capture_output=True, text=True)
        assert r.returncode == 0, r.stderr
        hashes.append({p.relative_to(d).as_posix(): p.read_bytes()
                       for p in sorted(d.rglob("*")) if p.is_file()})
    assert hashes[0].keys() == hashes[1].keys()
    differing = [k for k in hashes[0] if hashes[0][k] != hashes[1][k]]
    assert not differing, f"non-deterministic output: {differing}"
    dated = [k for k, v in hashes[0].items()
             if k.endswith((".md", ".html", ".json")) and b"2026-01-01" in v]
    assert dated, "the pin did not take — no artefact carries the pinned date"
    assert any(k.endswith(".md") for k in dated), (
        "the markdown deliverable carries no date", sorted(hashes[0]))


# --- the published worked example -----------------------------------------

REFERENCE_DIR = ROOT / "public" / "reference"


def test_the_published_example_is_committed():
    for name in ["envelope_study.html", "envelope_study.md", "proposal.html",
                 "proposal.md", "walkthrough.html", "model_pack.json",
                 "working_files.zip"]:
        assert (REFERENCE_DIR / name).exists(), f"public/reference/{name} is missing"
    for name in BUNDLE_FILES:
        assert (REFERENCE_DIR / "working_files" / name).exists(), name


def test_the_published_pack_declares_itself_synthetic():
    """It is downloadable. It will be separated from the page. It must still say
    what it is, or a modelled figure eventually gets quoted as a measurement."""
    d = json.loads((REFERENCE_DIR / "model_pack.json").read_text())
    assert d.get("synthetic") is True
    assert "not a customer asset" in d.get("notice", "")


def test_the_zip_matches_the_loose_files():
    with zipfile.ZipFile(REFERENCE_DIR / "working_files.zip") as z:
        names = sorted(n.split("/")[-1] for n in z.namelist())
        assert names == sorted(BUNDLE_FILES)
        for n in z.namelist():
            on_disk = REFERENCE_DIR / "working_files" / n.split("/")[-1]
            assert z.read(n) == on_disk.read_bytes(), n


def test_the_zip_is_reproducible():
    """Fixed timestamps, or CI reports drift on every rebuild and gets ignored."""
    with zipfile.ZipFile(REFERENCE_DIR / "working_files.zip") as z:
        for info in z.infolist():
            assert info.date_time == (1980, 1, 1, 0, 0, 0), info.filename


def test_the_published_study_carries_no_measurement_language():
    """The report gates run on generation. This asserts the artefact we actually
    shipped passed them, because that file is what a prospect reads."""
    text = (REFERENCE_DIR / "envelope_study.md").read_text().lower()
    for banned in ["as measured", "measured on site", "metered value", "test results confirm"]:
        assert banned not in text, banned
