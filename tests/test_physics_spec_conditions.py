"""The Procurement Specification states the site conditions its duties are quoted at.

Fixtures are the SYNTHETIC reference hall (examples/intake/reference_hall.json) and a copy of it with fields
removed. Expected strings are written out in full: they are what a supplier reads. Nothing here is real-world
calibration data.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from gridforge.intake.loader import load, load_document
from gridforge.procurement import build_spec, relief_steps
from gridforge.reporting.gates import ReportMode, run_all_gates
from gridforge.reporting.render import to_html, to_markdown
from gridforge.reporting.spec import build as build_spec_report
from gridforge.reporting.study import collect_claims
from gridforge.scenario.run import run_all
from gridforge.validation import EvidenceClass

ROOT = Path(__file__).resolve().parents[1]
INTAKE = ROOT / "examples" / "intake" / "reference_hall.json"
SECTION = "2A. Site conditions and assumptions"


def _spec(doc, constraint="busway_ampacity"):
    intake = load_document(doc)
    results = run_all(intake.context, intake.scenarios)
    best = max(results, key=lambda r: r.unlocked_racks)
    pkg = build_spec(intake, best, constraint_id=constraint)
    report = build_spec_report(pkg, claims=collect_claims(results))
    return pkg, report, results


def _row(md: str, ref: str) -> str:
    return next(line for line in md.splitlines() if line.startswith(f"| {ref} |"))


@pytest.fixture(scope="module")
def reference():
    doc = json.loads(INTAKE.read_text())
    pkg, report, results = _spec(doc)
    return pkg, report, results, to_markdown(report)


@pytest.fixture(scope="module")
def missing_dry_bulb():
    doc = json.loads(INTAKE.read_text())
    del doc["site"]["design_drybulb_C"]
    del doc["site"]["design_wetbulb_C"]
    del doc["transformers"][0]["redundancy"]
    pkg, report, results = _spec(doc)
    return pkg, report, results, to_markdown(report)


# --- the reference hall ----------------------------------------------------------------------------------------
class TestReferenceHall:
    def test_the_section_exists_in_markdown_and_html(self, reference):
        pkg, report, _, md = reference
        assert f"## {SECTION}" in md
        assert SECTION in to_html(report, full_document=True)

    def test_the_section_says_every_numeric_requirement_names_its_constraint(self, reference):
        md = reference[3]
        assert "Each numeric requirement in section 3 is derived from the constraint named in its " \
               "'From constraint' column" in md
        assert "| Ref | Clause | Obl. | Value | From constraint |" in md       # the column it points at

    @pytest.mark.parametrize("ref, expected", [
        ("SC-01", "| SC-01 | Design ambient dry bulb (summer) | 34 degC (E3) | supplied | "
                  "supplied by the client (not measured or surveyed by us) |"),
        ("SC-02", "| SC-02 | Design ambient wet bulb (summer) | 21 degC (E5) | supplied | "
                  "supplied by the client (not measured or surveyed by us) |"),
        ("SC-03", "| SC-03 | Facility-water supply temperature (existing plant) | 6 degC (E5) | supplied | "
                  "supplied by the client (not measured or surveyed by us) |"),
        ("SC-04", "| SC-04 | Technology-loop (TCS) supply target | 30 [27–32] degC (E0) | assumed | "
                  "not supplied: assumed 30 degC (E0) |"),
        ("SC-06", "| SC-06 | LV distribution voltage | 400 V (E5) | supplied | "
                  "supplied by the client (not measured or surveyed by us) · 3-phase |"),
        ("SC-09", "| SC-09 | Rack power basis: NVIDIA GB300 NVL72 | 135 [132–142] kW (E0) | library | "
                  "per-rack total TDP from the platform library, used for every electrical and thermal duty "
                  "(utilisation is not applied to a duty) |"),
        ("SC-11", "| SC-11 | Redundancy, transformer bank TX-A/B | N+1 on 3 units | supplied | "
                  "supplied by the client |"),
        ("SC-12", "| SC-12 | Redundancy, UPS bank UPS-1 | N+1 on 6 units | supplied | supplied by the client |"),
    ])
    def test_rows(self, reference, ref, expected):
        assert _row(reference[3], ref) == expected

    def test_altitude_and_frequency_are_declared_not_modelled_never_silently_defaulted(self, reference):
        md = reference[3]
        alt, freq = _row(md, "SC-05"), _row(md, "SC-07")
        assert "| not modelled | not modelled |" in alt and "no altitude derating" in alt
        assert "| not modelled | not modelled |" in freq and "not supplied" in freq
        for c in reference[0].site_conditions:
            if c.id in ("SC-05", "SC-07"):
                assert c.value is None and c.status == "not_modelled"

    def test_assumed_inputs_are_listed_with_class(self, reference):
        md = reference[3]
        assert ("- TCS target supply temperature (thermal.tcs_target_supply_C; degC): not supplied: assumed "
                "30 [27–32] degC (E0)") in md
        assert ("- All-in grid electricity price (economics.electricity_eur_per_MWh; EUR/MWh): not supplied: "
                "assumed library placeholder of 140 EUR/MWh (E0)") in md

    def test_every_numeric_condition_carries_unit_and_evidence_class(self, reference):
        for c in reference[0].site_conditions:
            if c.value is not None:
                d = c.to_dict()
                assert d["unit"] and d["evidence"] in {e.short for e in EvidenceClass}

    def test_every_assumed_condition_is_e0(self, reference):
        for c in reference[0].site_conditions:
            if c.status == "assumed" and c.value is not None:
                assert c.value.evidence == EvidenceClass.E0_ASSUMPTION, c.id

    def test_report_gates_are_satisfied_for_every_purchasable_relief(self, reference):
        pkg, _, results, _ = reference
        intake = load(INTAKE)
        best = max(results, key=lambda r: r.unlocked_racks)
        for cid in sorted({s.binding_id for s in relief_steps(best)}):
            p = build_spec(intake, best, constraint_id=cid)
            rep = build_spec_report(p, claims=collect_claims(results))
            md = to_markdown(rep)
            assert SECTION in md
            run_all_gates(rep, md, claims=collect_claims(results), mode=ReportMode.SCREENING)

    def test_instructions_point_to_the_section(self, reference):
        assert "Quote duties at the site conditions stated in section 2A" in reference[3]


# --- an intake with no design dry bulb ---------------------------------------------------------------------------
class TestMissingDryBulb:
    def test_dry_bulb_is_printed_as_not_supplied_with_the_assumed_value_and_class(self, missing_dry_bulb):
        md = missing_dry_bulb[3]
        assert _row(md, "SC-01") == ("| SC-01 | Design ambient dry bulb (summer) | 32 [30–36] degC (E0) | assumed | "
                                     "not supplied: assumed 32 degC (E0) |")
        assert _row(md, "SC-02") == ("| SC-02 | Design ambient wet bulb (summer) | 21 [19–23] degC (E0) | assumed | "
                                     "not supplied: assumed 21 degC (E0) |")

    def test_a_missing_redundancy_scheme_is_not_presented_as_declared(self, missing_dry_bulb):
        assert _row(missing_dry_bulb[3], "SC-11") == (
            "| SC-11 | Redundancy, transformer bank TX-A/B | N+1 on 3 units | assumed | "
            "not supplied: assumed N+1 (E0) |")

    def test_the_assumed_inputs_list_names_both_bulbs(self, missing_dry_bulb):
        md = missing_dry_bulb[3]
        assert "not supplied: assumed 32 [30–36] degC (E0)" in md
        assert "(site.design_wetbulb_C; degC): not supplied: assumed 21 [19–23] degC (E0)" in md
        assert "(site.design_drybulb_C; degC): not supplied: assumed 32 [30–36] degC (E0)" in md

    def test_the_default_dry_bulb_is_e0_in_the_model_itself(self):
        doc = json.loads(INTAKE.read_text())
        del doc["site"]["design_drybulb_C"]
        del doc["site"]["design_wetbulb_C"]
        site = load_document(doc).context.site
        assert site.design_drybulb_C.value == 32 and site.design_drybulb_C.evidence == EvidenceClass.E0_ASSUMPTION
        assert site.design_wetbulb_C.evidence == EvidenceClass.E0_ASSUMPTION

    def test_gates_still_pass(self, missing_dry_bulb):
        _, report, results, md = missing_dry_bulb
        run_all_gates(report, md, claims=collect_claims(results), mode=ReportMode.SCREENING)

    def test_machine_readable_form(self, missing_dry_bulb):
        pkg = missing_dry_bulb[0]
        d = {c.id: c.to_dict() for c in pkg.site_conditions}
        assert d["SC-01"] == {
            "id": "SC-01", "label": "Design ambient dry bulb (summer)", "path": "site.design_drybulb_C",
            "status": "assumed", "value": 32, "text": None, "unit": "degC", "evidence": "E0",
            "statement": "not supplied: assumed 32 degC (E0)"}
        assert d["SC-05"]["status"] == "not_modelled" and d["SC-05"]["value"] is None
        paths = {a.path for a in pkg.assumed_inputs}
        assert {"site.design_drybulb_C", "site.design_wetbulb_C", "thermal.tcs_target_supply_C"} <= paths


def test_the_response_template_carries_the_conditions(tmp_path):
    out = tmp_path / "spec"
    env = {**os.environ, "GRIDFORGE_REPORT_DATE": "2026-01-01"}
    r = subprocess.run([sys.executable, "-m", "gridforge", "spec", str(INTAKE), "--constraint", "busway_ampacity",
                        "-o", str(out)], cwd=ROOT, env=env, capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    t = json.loads((out / "response_template.json").read_text())
    sc = {c["id"]: c for c in t["specification"]["site_conditions"]}
    assert sc["SC-01"]["value"] == 34 and sc["SC-01"]["unit"] == "degC" and sc["SC-01"]["evidence"] == "E3"
    assert sc["SC-05"]["status"] == "not_modelled"
    assert any(a["path"] == "thermal.tcs_target_supply_C" for a in t["specification"]["assumed_inputs"])
    md = (out / "specification.md").read_text()
    assert SECTION in md
    assert SECTION in (out / "specification.html").read_text()
