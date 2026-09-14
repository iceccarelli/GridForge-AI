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


# --- the cost library must never leak a quotation into the repository --------
def test_the_committed_seed_holds_no_quotations():
    """A supplier quotation is confidential and frequently under NDA. It must not
    be committed to a repository or shipped in an image."""
    from gridforge.costs import BUNDLED_PATH, CostLibrary
    bad = CostLibrary.load(BUNDLED_PATH).publishable_violations()
    assert not bad, (
        f"the committed cost library holds quotations: {bad}. Move them to the private "
        "library (drop --bundled) and remove them from version control."
    )


def test_the_private_library_is_gitignored():
    from gridforge.costs import PRIVATE_FILENAME
    assert PRIVATE_FILENAME in (ROOT / ".gitignore").read_text()


def test_cli_refuses_a_quotation_in_the_committed_seed():
    r = subprocess.run(
        [sys.executable, "-m", "gridforge", "cost", "add", "--bundled", "--key", "x",
         "--unit", "EUR", "--value", "1", "--basis", "firm_quote", "--supplier", "A",
         "--quoted-on", "2026-01-01"],
        cwd=ROOT, capture_output=True, text=True)
    assert r.returncode == 2
    assert "confidential" in r.stderr


def test_cli_refuses_a_quotation_with_no_supplier(tmp_path):
    r = subprocess.run(
        [sys.executable, "-m", "gridforge", "cost", "add", "--key", "x", "--unit", "EUR",
         "--value", "1", "--basis", "firm_quote", "--library", str(tmp_path / "c.json")],
        cwd=ROOT, capture_output=True, text=True)
    assert r.returncode == 2
    assert "not a quotation" in r.stderr


def test_cost_where_reports_both_files():
    r = subprocess.run([sys.executable, "-m", "gridforge", "cost", "where"],
                       cwd=ROOT, capture_output=True, text=True)
    assert r.returncode == 0, r.stdout + r.stderr
    assert "seed" in r.stdout and "yours" in r.stdout


# --- the walkthrough deck ----------------------------------------------------
def test_deck_has_the_slides_that_win_the_room(solved):
    from gridforge.reporting.deck import build as build_deck
    intake, results = solved
    kickers = [s.kicker for s in build_deck(intake, results).slides]
    for expected in ("The answer", "What stops it", "When", "Cost", "Evidence",
                     "Recommendation", "Boundary"):
        assert expected in kickers


def test_deck_charts_label_every_value_they_encode(solved):
    """Nothing may be knowable only by colour or only by hovering."""
    from gridforge.reporting.deck import build as build_deck, to_html
    intake, results = solved
    html = to_html(build_deck(intake, results))
    for res in results:
        assert f">{res.unlocked_racks}<" in html, (
            f"{res.spec.id}'s value is not printed beside its bar"
        )


def test_deck_energisation_curve_has_one_point_per_week(solved):
    from gridforge.envelope.time_to_power import schedule
    from gridforge.reporting.deck import _energisation_svg
    from gridforge.reporting.study import _pick_recommended
    intake, results = solved
    svg = _energisation_svg(schedule(_pick_recommended(results).ladder))
    assert svg.count("<circle") <= 6, (
        "several ladder steps land in the same week; stacking a column of dots on one x "
        "position reads as noise and implies events the client never experiences"
    )


def test_deck_declares_what_it_is_not(solved):
    from gridforge.reporting.deck import build as build_deck, to_html
    intake, results = solved
    html = to_html(build_deck(intake, results))
    assert "no margin on hardware" in html
    assert "not a design package" in html.lower() or "Not a design package" in html


def test_deck_is_self_contained(solved):
    from gridforge.reporting.deck import build as build_deck, to_html
    intake, results = solved
    html = to_html(build_deck(intake, results))
    assert "http://" not in html and "https://" not in html, (
        "the deck must render with no network at all — a client may open it offline"
    )
