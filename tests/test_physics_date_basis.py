"""A figure in weeks is never a bare date while the lead time behind it is an assumption.

Every renderer and payload that prints time to full capacity says "assumed lead time, not a date" when the weakest
lead time behind it is E0, and the machine payloads carry date_basis / date_evidence_class / date_binding_item /
date_label. Fixture: the SYNTHETIC reference hall. Nothing here is real-world calibration.
"""
from __future__ import annotations

import copy
import json
from pathlib import Path

import pytest

from gridforge.api.compare_payload import compare_payload
from gridforge.api.payloads import qualify_payload, screen_payload
from gridforge.api.tiers import Tier
from gridforge.change import diff
from gridforge.commercial import engagement
from gridforge.common import ASSUMED, CUSTOMER, V
from gridforge.envelope.time_to_power import (ASSUMED_DATE_LABEL, NO_DATE, date_basis, date_basis_of,
                                              schedule)
from gridforge.intake.loader import load_document
from gridforge.reporting import to_html, to_markdown
from gridforge.reporting import board as board_mod
from gridforge.reporting import change_note, deck as deck_mod, portfolio, proposal, readiness, screen as screen_mod
from gridforge.reporting import spec as spec_mod
from gridforge.reporting import study
from gridforge.reporting.gates import run_all_gates
from gridforge.reporting.study import collect_claims
from gridforge.scenario.objective import Objective
from gridforge.scenario.run import run_all
from gridforge.serialize import csv_bundle, economics_dict, scenario_dict
from gridforge.validation import EvidenceClass

ROOT = Path(__file__).resolve().parents[1]
INTAKE = ROOT / "examples" / "intake" / "reference_hall.json"
LABEL = "assumed lead time, not a date"
KEYS = {"date_basis", "date_evidence_class", "date_binding_item", "date_label"}


@pytest.fixture(scope="module")
def solved():
    doc = json.loads(INTAKE.read_text())
    intake = load_document(copy.deepcopy(doc))
    return doc, intake, run_all(intake.context, intake.scenarios)


def _by_id(results, sid):
    return next(r for r in results if r.spec.id == sid)


def _quote_every_lead_time(result):
    """Replace every lead time on a ladder with a customer-supplied (E5) figure, keeping the values."""
    for st in result.ladder.steps:
        if st.lead_time_weeks is not None:
            st.lead_time_weeks = V(st.lead_time_weeks.value, "weeks", "quoted lead time", CUSTOMER)


# --- the classification --------------------------------------------------------------------------------------------
class TestDateBasis:
    def test_the_reference_hall_date_is_an_assumed_lead_time_set_by_the_transformer(self, solved):
        db = date_basis(_by_id(solved[2], "full_dlc").ladder)
        assert db.basis == "assumed"
        assert db.evidence_class == "E0"
        assert db.binding_item == "Transformer capacity"
        assert db.label == "assumed lead time, not a date (E0; set by transformer capacity)"
        assert db.caption == "assumed lead time, not a date (E0)"
        assert db.to_dict() == {"date_basis": "assumed", "date_evidence_class": "E0",
                                "date_binding_item": "Transformer capacity",
                                "date_label": "assumed lead time, not a date (E0; set by transformer capacity)"}

    def test_a_scenario_that_deploys_nothing_has_no_date(self, solved):
        db = date_basis(_by_id(solved[2], "retained_air").ladder)
        assert db is NO_DATE or db.basis == "none"
        assert db.to_dict()["date_evidence_class"] is None and db.to_dict()["date_binding_item"] is None

    def test_an_incomplete_schedule_has_no_date(self, solved):
        _, intake, _ = solved
        res = _by_id(run_all(intake.context, intake.scenarios), "full_dlc")
        res.ladder.taken_steps[0].lead_time_weeks = None
        assert date_basis(res.ladder).basis == "none"

    def test_quoted_lead_times_are_not_labelled_assumed(self, solved):
        _, intake, _ = solved
        res = _by_id(run_all(intake.context, intake.scenarios), "full_dlc")
        _quote_every_lead_time(res)
        db = date_basis(res.ladder)
        assert (db.basis, db.evidence_class) == ("supported", "E5")
        assert LABEL not in db.label and db.caption == "lead times of class E5 at best"

    def test_one_assumed_lead_time_anywhere_on_the_path_makes_the_figure_assumed(self, solved):
        _, intake, _ = solved
        res = _by_id(run_all(intake.context, intake.scenarios), "full_dlc")
        _quote_every_lead_time(res)
        res.ladder.taken_steps[0].lead_time_weeks = V(5.0, "weeks", "assumed", ASSUMED)
        assert date_basis(res.ladder).basis == "assumed"

    def test_a_recorded_class_is_classified_and_an_unrecorded_one_is_not_a_claim(self):
        assert date_basis_of(EvidenceClass.E0_ASSUMPTION, "X").basis == "assumed"
        assert date_basis_of(EvidenceClass.E3_ENGINEERING_ESTIMATE, "X").basis == "supported"


# --- the machine payloads ------------------------------------------------------------------------------------------
class TestPayloadKeys:
    def test_scenario_dict_and_economics_carry_the_keys(self, solved):
        res = _by_id(solved[2], "full_dlc")
        d = scenario_dict(res)
        assert KEYS <= set(d["time_to_power"])
        assert d["time_to_power"]["date_basis"] == "assumed" and d["time_to_power"]["date_evidence_class"] == "E0"
        assert d["time_to_power"]["date_binding_item"] == "Transformer capacity"
        assert KEYS <= set(d["economics"])

    def test_compare_payload_carries_the_keys_for_every_scenario_including_undated_ones(self, solved):
        doc, intake, results = solved
        out = compare_payload(doc, results, objective=Objective.FASTEST_TO_POWER, baseline=None)
        for row in out["scenarios"]:
            ttp = row["time_to_power"]
            assert KEYS <= set(ttp), row["id"]
            assert (ttp["date_basis"] == "assumed") if ttp["status"] == "dated" else (ttp["date_basis"] == "none")
        dated = next(r for r in out["scenarios"] if r["time_to_power"]["status"] == "dated")
        assert dated["time_to_power"]["date_label"].startswith(LABEL)

    def test_the_public_qualifier_names_the_assumption_without_giving_a_number_of_weeks(self, solved):
        _, intake, results = solved
        body = qualify_payload(intake, results)
        after = body["after_relief"]
        assert after["date_basis"] == "assumed" and after["date_evidence_class"] == "E0"
        assert after["date_binding_item"] == after["sets_the_date"]
        assert after["date_label"].startswith(LABEL)
        assert "weeks" not in json.dumps(after).replace("date_label", "")

    def test_the_public_screen_keeps_the_keys_and_drops_the_weeks(self, solved):
        _, intake, results = solved
        body = screen_payload(intake, results, tier=Tier.PUBLIC)
        for sc in body["scenarios"]:
            assert KEYS <= set(sc["time_to_power"])
            assert "weeks_to_full" not in sc["time_to_power"]

    def test_the_readiness_case_carries_the_keys(self, solved):
        _, intake, results = solved
        case = readiness.assess(intake, results)
        assert KEYS <= set(case["time_to_power"])
        assert case["time_to_power"]["date_basis"] == "assumed"

    def test_csv_bundle_has_the_columns(self, solved):
        _, intake, results = solved
        rows = csv_bundle(intake, results)["scenarios.csv"].splitlines()
        head = rows[0].split(",")
        assert "date_basis" in head and "date_evidence_class" in head
        full = next(r for r in rows[1:] if r.startswith("full_dlc,"))
        assert ",assumed,E0," in full

    def test_economics_dict_critical_path_is_labelled(self, solved):
        e = economics_dict(_by_id(solved[2], "full_dlc"))
        assert e["critical_path_weeks"] == 160.0 and e["date_basis"] == "assumed"


# --- every renderer ------------------------------------------------------------------------------------------------
def _gated(report, results):
    md = to_markdown(report)
    run_all_gates(report, md, collect_claims(results))
    return md


class TestRenderers:
    def test_the_study(self, solved):
        _, intake, results = solved
        md = _gated(study.build(intake.context, results, client=intake.client), results)
        assert "**Time to full capacity:** 160 [80–210] weeks (E0)" in md
        assert "*Limited by: assumed lead time, not a date (E0) · set by transformer capacity;" in md
        assert f"| Elapsed ({LABEL}) |" in md
        assert f"| Time to full capacity ({LABEL}) |" in md
        assert f"Every elapsed figure is an {LABEL} (E0), not a committed energisation date." in md
        assert "The assumed lead time, not a date, is set by transformer capacity." in md

    def test_the_screen(self, solved):
        _, intake, results = solved
        md = _gated(screen_mod.build(intake, results), results)
        assert "**Time to full capacity:** 160 [80–210] weeks (E0)" in md
        assert "*Limited by: assumed lead time, not a date (E0) · set by transformer capacity;" in md

    def test_the_board_summary(self, solved):
        _, intake, results = solved
        md = _gated(board_mod.build(intake, results), results)
        assert "*Limited by: assumed lead time, not a date (E0) · set by transformer capacity; works run in parallel*" in md
        assert "| sets the date (assumed, E0) |" in md

    def test_the_proposal_is_no_longer_a_flat_e3_with_an_invented_band(self, solved):
        _, intake, results = solved
        md = _gated(proposal.build(intake, results, engagement("density_screen")), results)
        assert "**Time to full capacity:** 160 [80–210] weeks (E0)" in md       # was E3 with a x0.7 / x1.6 band
        assert "assumed lead time, not a date (E0) · set by transformer capacity" in md

    def test_the_deck(self, solved):
        _, intake, results = solved
        html = deck_mod.to_html(deck_mod.build(intake, results))
        assert "assumed lead time, not a date (E0)" in html
        assert "elapsed weeks — reliefs run in parallel · assumed lead times, not dates" in html
        assert "One item sets the assumed lead time (not a date): transformer capacity." in html
        assert "Lead time (assumed, E0)" in html

    def test_the_spec(self, solved):
        from gridforge.procurement import build_spec
        _, intake, results = solved
        best = max(results, key=lambda r: r.unlocked_racks)
        pkg = build_spec(intake, best, constraint_id="busway_ampacity")
        md = to_markdown(spec_mod.build(pkg, claims=collect_claims(results)))
        assert f"**Modelled lead time ({LABEL}):**" in md
        assert f"*Limited by: {LABEL} (E0): what the capacity model assumed, not a quotation or a commitment." in md

    def test_the_portfolio(self, solved):
        _, intake, results = solved
        e = portfolio.SiteEntry(intake=intake, results=results, objective=Objective.MAX_COMPUTE)
        rows = portfolio.portfolio_rows([e])
        assert KEYS <= set(rows[0]) and rows[0]["date_basis"] == "assumed"
        md = _gated(portfolio.build([e]), results)
        assert f"| Time to power ({LABEL}) |" in md
        assert f"to full capacity" in md and f"weeks (" in md and f"— {LABEL}" in md
        assert f"A time figure marked E0 is an {LABEL}, not an energisation date." in md

    def test_the_change_note(self, solved):
        doc = solved[0]
        after = copy.deepcopy(doc)
        after["grid"]["contracted_MW"] = 10.5
        d = diff(doc, after)
        md = to_markdown(change_note.build(d, site="S", hall="H", client="C"))
        assert "*Limited by: assumed lead time, not a date (E0) · was 160" in md
        assert d.after.date_basis()["date_basis"] == "assumed"

    def test_quoted_lead_times_are_not_called_assumed_in_the_study(self, solved):
        _, intake, _ = solved
        results = run_all(intake.context, intake.scenarios)
        for r in results:
            _quote_every_lead_time(r)
        md = to_markdown(study.build(intake.context, results, client=intake.client))
        assert LABEL not in md
        assert "lead times of class E5 at best" in md


# --- the CLI ---------------------------------------------------------------------------------------------------------
def test_the_cli_compare_line_says_assumed_lead_time_not_a_date(tmp_path):
    import os
    import subprocess
    import sys
    r = subprocess.run([sys.executable, "-m", "gridforge", "compare", str(INTAKE), "-o", str(tmp_path)], cwd=ROOT,
                       env={**os.environ, "GRIDFORGE_REPORT_DATE": "2026-01-01"}, capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    assert " — assumed lead time, not a date" in r.stdout
    t = json.loads((tmp_path / "ttp_compare.json").read_text())
    assert all(KEYS <= set(s["time_to_power"]) for s in t["scenarios"])


# --- power deploy ----------------------------------------------------------------------------------------------------
class TestAssessDeployment:
    @staticmethod
    def _assess(**kw):
        from gridforge.power.generation import default_generation_unit
        from gridforge.power.load_profile import flat
        from gridforge.power.storage import default_bess
        from gridforge.power.reliability import Redundancy
        from gridforge.reporting.btm_assessment import assess_deployment
        gen = default_generation_unit("GEN-A", "gas_engine", 30.0)
        gen.capex_eur = V(20_000_000, "EUR", "capex", ASSUMED)
        gen.lead_time_weeks = V(50, "weeks", "lead", ASSUMED)
        bess = default_bess("BESS-1", power_MW=10.0, energy_MWh=40.0)
        bess.capex_eur = V(9_000_000, "EUR", "capex", ASSUMED)
        bess.lead_time_weeks = V(20, "weeks", "lead", ASSUMED)
        return assess_deployment(load_profile=flat(15000), grid_firm_MW=V(5.0, "MW", "g", ASSUMED),
                                 generation=[gen], bess=[bess], target_MW=V(30.0, "MW", "t", ASSUMED),
                                 redundancy=Redundancy.N, objective=Objective.MAX_COMPUTE, **kw)

    def test_an_undeclared_ride_through_blocks_every_architecture_that_uses_a_battery(self):
        r = self._assess()
        assert r["capacity"]["ride_through_declared"] is False and r["capacity"]["ride_through_hours"] == 2.0
        with_bess = [a for a in r["architectures"] if "BESS" in a["label"]]
        assert with_bess
        for a in with_bess:
            assert a["status"] != "pass"
            assert any("no ride-through window was declared" in b for b in a["blocking"]), a["label"]

    def test_a_declared_ride_through_is_not_blocked(self):
        r = self._assess(ride_through_hours=V(2.0, "h", "declared ride-through", ASSUMED))
        assert r["capacity"]["ride_through_declared"] is True
        assert not any("no ride-through window was declared" in b for a in r["architectures"] for b in a["blocking"])

    def test_architecture_lead_times_carry_the_keys(self):
        r = self._assess(ride_through_hours=V(2.0, "h", "declared ride-through", ASSUMED))
        for a in r["architectures"]:
            assert KEYS <= set(a)
        both = next(a for a in r["architectures"] if a["label"] == "GRID + BESS + GENERATION")
        assert both["lead_time_weeks"] == 50 and both["date_basis"] == "assumed"
        assert both["date_binding_item"] == "GEN-A" and both["date_evidence_class"] == "E0"
        assert both["date_label"] == "assumed lead time, not a date (E0; set by gen-a)"
