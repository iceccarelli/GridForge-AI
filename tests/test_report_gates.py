import pytest

from examples.reference_site import SCENARIOS, build_context
from gridforge.common import ASSUMED, V
from gridforge.reporting import to_html, to_markdown
from gridforge.reporting.gates import (GateFailure, ReportMode, check_language,
                                       run_all_gates)
from gridforge.reporting.model import ProvenanceError, Report, Section, Table
from gridforge.reporting.study import build as build_study, collect_claims
from gridforge.scenario import run_all


@pytest.fixture(scope="module")
def study():
    ctx = build_context()
    results = run_all(ctx, SCENARIOS)
    return ctx, results, build_study(ctx, results, client="test")


def test_bare_numbers_are_rejected_in_tables():
    with pytest.raises(ProvenanceError):
        Table(["a"], [["47 kW"]])


def test_report_renders_and_passes_screening_gates(study):
    _, results, report = study
    md = to_markdown(report)
    run_all_gates(report, md, claims=collect_claims(results), mode=ReportMode.SCREENING)
    assert "Appendix A" in md and "EVIDENCE DISCLOSURE" in md
    assert "<table" in to_html(report)


def test_issued_mode_refuses_assumption_grade_claims(study):
    _, results, report = study
    md = to_markdown(report)
    with pytest.raises(GateFailure):
        run_all_gates(report, md, claims=collect_claims(results), mode=ReportMode.ISSUED)


def test_language_gate_blocks_assertions_of_measurement(study):
    _, _, report = study
    with pytest.raises(GateFailure):
        check_language("The hall's capacity is 12 MW and performance is guaranteed.", report)


def test_every_reported_quantity_has_provenance(study):
    _, _, report = study
    for q in report.quantities():
        assert q.prov.label
        assert q.prov.model_id


def test_watermark_present_on_synthetic_study(study):
    _, _, report = study
    assert "SYNTHETIC" in report.watermark.upper()
    assert "SYNTHETIC" in to_markdown(report).upper()
