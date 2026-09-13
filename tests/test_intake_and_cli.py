"""Intake, the data-gap ledger, the CLI and the model pack.

This is the delivery machine: one JSON file in, a priced engagement out. The tests
that matter here are the ones that stop it producing something that looks finished
but is built on numbers nobody measured.
"""
import json
import subprocess
import sys
from pathlib import Path

import pytest

from gridforge.intake.loader import IntakeError, blank_intake, load, load_document
from gridforge.intake.schema import INTAKE_FIELDS, REQUIRED_PATHS
from gridforge.reporting.portfolio import SiteEntry, rank
from gridforge.reporting.portfolio import build as build_portfolio
from gridforge.reporting.screen import build as build_screen
from gridforge.reporting.study import Objective
from gridforge.scenario import run_all
from gridforge.serialize import model_pack

ROOT = Path(__file__).resolve().parents[1]
INTAKE_DIR = ROOT / "examples" / "intake"
REFERENCE = INTAKE_DIR / "reference_hall.json"


def _cli(*args):
    return subprocess.run([sys.executable, "-m", "gridforge", *args],
                          cwd=ROOT, capture_output=True, text=True)


def test_reference_intake_is_complete():
    intake = load(REFERENCE)
    assert intake.report.completeness == 1.0
    assert intake.report.can_issue


def test_thin_intake_is_flagged_and_priced_as_a_screen():
    doc = {"project": {"client": "Thin"}, "compute": {"platform": "gb300_nvl72"}}
    intake = load_document(doc)
    assert not intake.report.can_issue
    assert len(intake.report.required_gaps) >= 5
    assert "Density Screen" in intake.report.engagement_recommendation


def test_every_gap_says_why_it_binds_and_where_to_get_it():
    intake = load_document({"project": {}})
    for g in intake.report.gaps:
        assert g.why_it_binds, f"{g.path} has no reason a customer would act on"
        assert g.how_to_get_it, f"{g.path} has no source a customer could go to"


def test_assumed_inputs_are_never_customer_evidence():
    intake = load_document({"project": {}})
    q = intake.context.power.grid.firm_capacity_MVA
    assert q.evidence.short == "E0", "a fallback must never masquerade as customer data"


def test_supplied_inputs_carry_customer_evidence():
    intake = load(REFERENCE)
    assert intake.context.power.grid.firm_capacity_MVA.evidence.short == "E5"


def test_empty_schedule_counts_as_missing():
    intake = load_document({"project": {}, "ups": [], "transformers": []})
    paths = {g.path for g in intake.report.gaps}
    assert "ups" in paths and "transformers" in paths
    assert any("unprotected" in w for w in intake.report.warnings)


def test_unknown_platform_is_refused_with_the_available_list():
    with pytest.raises(IntakeError, match="unknown platform"):
        load_document({"compute": {"platform": "vr200_nvl144"}})


def test_unknown_scenario_is_refused():
    with pytest.raises(IntakeError, match="unknown scenario"):
        load_document({"scenarios": ["teleportation"]})


def test_blank_intake_covers_every_declared_field():
    doc = blank_intake()
    flat = json.dumps(doc)
    for f in INTAKE_FIELDS:
        assert f.path.split(".")[0] in flat


def test_required_paths_are_the_ones_that_block_issue():
    assert set(REQUIRED_PATHS) <= {f.path for f in INTAKE_FIELDS}
    assert len(REQUIRED_PATHS) >= 10


def test_model_pack_carries_provenance_on_every_headline_number():
    intake = load(REFERENCE)
    results = run_all(intake.context, intake.scenarios)
    pack = model_pack(intake, results)
    for sc in pack["scenarios"]:
        q = sc["after_ladder"]["it_load_kW"]
        assert q and q["evidence"] and q["digest"] and q["label"]
        assert sc["economics"]["capex_total_eur"]["evidence"]


def test_model_pack_records_what_was_assumed():
    intake = load_document({"project": {"client": "Thin"}})
    pack = model_pack(intake, run_all(intake.context, intake.scenarios))
    assert pack["intake"]["gaps"]
    assert pack["intake"]["can_issue"] is False


def test_screen_and_study_both_render_and_pass_gates():
    intake = load(REFERENCE)
    results = run_all(intake.context, intake.scenarios)
    from gridforge.reporting import to_html, to_markdown
    from gridforge.reporting.gates import ReportMode, run_all_gates
    from gridforge.reporting.study import build as build_study, collect_claims
    for report in (build_screen(intake, results),
                   build_study(intake.context, results, client=intake.client)):
        md = to_markdown(report)
        run_all_gates(report, md, claims=collect_claims(results), mode=ReportMode.SCREENING)
        assert "EVIDENCE DISCLOSURE" in md
        assert "<table" in to_html(report)


def test_portfolio_ranks_and_the_orderings_disagree():
    intakes = [load(p) for p in sorted(INTAKE_DIR.glob("*.json"))]
    entries = [SiteEntry(intake=i, results=run_all(i.context, i.scenarios)) for i in intakes]
    by_compute = [e.intake.reference for e in rank(entries, Objective.MAX_COMPUTE)]
    by_speed = [e.intake.reference for e in rank(entries, Objective.FASTEST_TO_POWER)]
    assert len(by_compute) == len(intakes)
    assert by_compute != by_speed, "if every objective gives the same order, the objective is fake"
    report = build_portfolio(entries, client="test")
    from gridforge.reporting import to_markdown
    assert "Ranked portfolio" in to_markdown(report)


def test_cli_gaps_prints_a_data_request():
    r = _cli("gaps", str(REFERENCE))
    assert r.returncode == 0
    assert "Intake completeness" in r.stdout


def test_cli_study_writes_three_artefacts(tmp_path):
    r = _cli("study", str(REFERENCE), "-o", str(tmp_path))
    assert r.returncode == 0, r.stderr
    for name in ("envelope_study.md", "envelope_study.html", "model_pack.json"):
        assert (tmp_path / name).exists()
    json.loads((tmp_path / "model_pack.json").read_text())


def test_cli_screen_writes_artefacts(tmp_path):
    r = _cli("screen", str(REFERENCE), "-o", str(tmp_path))
    assert r.returncode == 0, r.stderr
    assert (tmp_path / "density_screen.md").exists()


def test_cli_portfolio_writes_one_pack_per_hall(tmp_path):
    files = [str(p) for p in sorted(INTAKE_DIR.glob("*.json"))]
    r = _cli("portfolio", *files, "-o", str(tmp_path))
    assert r.returncode == 0, r.stderr
    assert (tmp_path / "portfolio_screen.md").exists()
    assert len(list(tmp_path.glob("model_pack_*.json"))) == len(files)


def test_cli_rejects_a_bad_intake_without_a_traceback(tmp_path):
    bad = tmp_path / "bad.json"
    bad.write_text(json.dumps({"compute": {"platform": "not_a_platform"}}))
    r = _cli("study", str(bad), "-o", str(tmp_path))
    assert r.returncode == 2
    assert "intake error" in r.stderr
    assert "Traceback" not in r.stderr
