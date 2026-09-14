"""The cost library and the proposal generator.

Two things carry real commercial weight here and both are tested as such:
a quotation must actually strengthen the deliverable, and the proposal must quote
the same price as the checkout page.
"""
import json
import re
import subprocess
import sys
from pathlib import Path

import pytest

from gridforge.commercial import ENGAGEMENTS, engagement
from gridforge.costs import AACE_BY_EVIDENCE, CostEntry, CostLibrary, reload_library
from gridforge.intake.loader import load
from gridforge.reporting import to_markdown
from gridforge.reporting.proposal import build as build_proposal
from gridforge.scenario import run_all
from gridforge.validation import EvidenceClass

ROOT = Path(__file__).resolve().parents[1]
REFERENCE = ROOT / "examples" / "intake" / "reference_hall.json"


@pytest.fixture(scope="module")
def solved():
    intake = load(REFERENCE)
    return intake, run_all(intake.context, intake.scenarios)


# --- the cost library --------------------------------------------------------
def test_a_missing_line_is_an_assumption_not_a_price():
    lib = CostLibrary()
    q = lib.lookup("nothing.here", 1000, "EUR", "placeholder")
    assert q.evidence is EvidenceClass.E0_ASSUMPTION
    assert "not a price" in " ".join(q.prov.all_assumptions())


def test_a_firm_quote_raises_the_evidence_class_and_tightens_the_band():
    lib = CostLibrary()
    lib.put(CostEntry(key="tapoff.unit", label="tap-off", unit="EUR/rack", value=5200,
                      basis="firm_quote", supplier="Acme", quoted_on="2026-09-01",
                      valid_until="2099-12-31", region="DE"))
    q = lib.lookup("tapoff.unit", 6000, "EUR/rack", "tap-off")
    assert q.evidence is EvidenceClass.E5_CUSTOMER_DATA
    lo, hi = q.band
    assert (hi - lo) / q.value < 0.6, "a quotation must narrow the band, not just relabel it"


def test_an_expired_quote_is_downgraded_not_trusted():
    lib = CostLibrary()
    lib.put(CostEntry(key="k", label="l", unit="EUR", value=100, basis="firm_quote",
                      supplier="Acme", quoted_on="2020-01-01", valid_until="2020-06-30"))
    q = lib.lookup("k", 200, "EUR", "l")
    assert q.evidence <= EvidenceClass.E1_MODEL
    assert any("expired" in a for a in q.prov.all_assumptions())


def test_the_accuracy_class_follows_the_weakest_line():
    lib = CostLibrary()
    lib.put(CostEntry(key="a", label="a", unit="EUR", value=1, basis="contracted"))
    assert lib.aace_class(["a"]) == AACE_BY_EVIDENCE[EvidenceClass.E7_DEPLOYED]
    assert lib.aace_class(["a", "b"]) == AACE_BY_EVIDENCE[EvidenceClass.E0_ASSUMPTION], (
        "one placeholder drags the whole estimate back; averaging would be dishonest"
    )


def test_quotations_reach_the_study_and_the_study_says_how_many_are_missing(tmp_path, solved):
    lib = CostLibrary(path=tmp_path / "costs.json")
    lib.put(CostEntry(key="tapoff.unit", label="tap-off", unit="EUR/rack", value=5200,
                      basis="firm_quote", supplier="Acme", quoted_on="2026-09-01",
                      valid_until="2099-12-31"))
    lib.save()
    try:
        reload_library(tmp_path / "costs.json")
        intake = load(REFERENCE)
        results = run_all(intake.context, intake.scenarios)
        econ = results[-1].economics
        assert econ.cost_basis_mix.get("firm_quote", 0) >= 1
        assert econ.rests_on_placeholders >= 1
    finally:
        reload_library()


def test_cost_cli_round_trips(tmp_path):
    lib = tmp_path / "costs.json"
    add = subprocess.run(
        [sys.executable, "-m", "gridforge", "cost", "add", "--key", "cdu.addition",
         "--label", "row CDU", "--unit", "EUR", "--value", "164000", "--basis", "budgetary_quote",
         "--supplier", "Acme", "--quoted-on", "2026-09-01", "--library", str(lib)],
        cwd=ROOT, capture_output=True, text=True)
    assert add.returncode == 0, add.stderr
    assert "E3" in add.stdout
    listed = subprocess.run([sys.executable, "-m", "gridforge", "cost", "list",
                             "--library", str(lib)], cwd=ROOT, capture_output=True, text=True)
    assert "cdu.addition" in listed.stdout
    assert json.loads(lib.read_text())["entries"][0]["supplier"] == "Acme"


def test_every_taken_relief_prices_from_a_named_library_line(solved):
    _, results = solved
    for res in results:
        for step in res.ladder.taken_steps:
            if step.capex_eur is not None and step.relief_description:
                assert step.cost_key, (
                    f"{step.binding_id} has a price with no cost-library key, so a quotation "
                    "could never replace it"
                )


# --- the proposal ------------------------------------------------------------
def test_proposal_opens_with_a_finding_not_a_company_profile(solved):
    intake, results = solved
    md = to_markdown(build_proposal(intake, results, engagement("density_screen")))
    first = md.split("## 2.")[0]
    assert "What we already found" in first
    assert "Binding constraint" in first
    assert "racks" in first


def test_proposal_states_the_fee_and_the_clock(solved):
    intake, results = solved
    eng = engagement("density_screen")
    md = to_markdown(build_proposal(intake, results, eng))
    assert f"{eng.price_eur:,}" in md
    assert f"{eng.turnaround_days} working days" in md


def test_proposal_carries_the_data_request(solved):
    intake, results = solved
    md = to_markdown(build_proposal(intake, results, engagement("density_screen")))
    assert "What we need from you" in md


def test_proposal_declares_independence(solved):
    intake, results = solved
    md = to_markdown(build_proposal(intake, results, engagement("density_screen")))
    assert "no margin on hardware" in md


def test_proposal_carries_the_evidence_disclosure(solved):
    intake, results = solved
    md = to_markdown(build_proposal(intake, results, engagement("density_screen")))
    assert "EVIDENCE DISCLOSURE" in md


def test_unknown_engagement_is_refused():
    with pytest.raises(KeyError, match="unknown engagement"):
        engagement("free_consulting")


# --- one price list, two languages ------------------------------------------
def _ts_products() -> dict[str, int]:
    src = (ROOT / "lib" / "products.ts").read_text()
    out: dict[str, int] = {}
    for block in re.split(r"\n  (?=\w+: \{)", src):
        m_id = re.search(r'id:\s*"([a-z_]+)"', block)
        m_amt = re.search(r"amountCents:\s*([\d_]+)", block)
        if m_id and m_amt:
            out[m_id.group(1)] = int(m_amt.group(1).replace("_", ""))
    return out


def test_the_website_and_the_engine_quote_the_same_price():
    ts = _ts_products()
    assert ts, "could not parse lib/products.ts — fix the parser before trusting this test"
    assert ts["density_screen"] == ENGAGEMENTS["density_screen"].price_eur * 100, (
        "the proposal and the checkout page must never quote different numbers"
    )


def test_deposits_are_smaller_than_the_engagements_they_reserve():
    ts = _ts_products()
    assert ts["envelope_study_deposit"] < ENGAGEMENTS["envelope_study"].price_eur * 100
    assert ts["portfolio_screen_deposit"] < ENGAGEMENTS["portfolio_screen"].price_eur * 100


def test_every_engagement_declares_what_it_does_not_do():
    for eng in ENGAGEMENTS.values():
        assert eng.scope_out, f"{eng.id} has no scope boundary"
        assert any("no margin on hardware" in x for x in eng.scope_out)
