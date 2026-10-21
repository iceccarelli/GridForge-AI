"""Time-to-Power comparison priced on accepted supplier quotations.

POST /v1/compare takes the same request-scoped `cost_evidence` the screen and the study take. These tests run the real
engine handlers. Every supplier, price and date is a SYNTHETIC fixture (suppliers are named SYNTHETIC-SUPPLIER-x);
none is a real quotation. The assertions are about rules: what may move a number, what is refused, what the answer says
about the evidence it used, and that a comparison without evidence is exactly what it was before.
"""
import json
from pathlib import Path

import pytest

from gridforge.api.compare_payload import request_digest
from gridforge.api.server import ApiError, _invoke, handle_compare
from gridforge.api.tiers import Tier
from gridforge.scenario.objective import Objective

ROOT = Path(__file__).resolve().parents[1]
TODAY = "2026-10-13"
DUBLIN = json.loads((ROOT / "examples" / "intake" / "dublin_hall.json").read_text())


@pytest.fixture(autouse=True)
def pinned_today(monkeypatch):
    monkeypatch.setenv("GRIDFORGE_REPORT_DATE", TODAY)


def line(evidence_id="ev-1", value=2_340_000.0, key="transformer.replacement", **over):
    d = {
        "key": key, "label": "transformer replacement (SYNTHETIC-SUPPLIER-A)", "unit": "EUR", "value": value,
        "basis": "firm_quote", "supplier": "SYNTHETIC-SUPPLIER-A", "quoted_on": "2026-10-01", "valid_until": "2026-12-31",
        "currency": "EUR", "quoted_quantity": 23.4, "quoted_quantity_unit": "MVA", "scope": "supply, install, commission",
        "comparability": "exact", "status": "accepted", "evidence_id": evidence_id, "response_ref": "a" * 64,
        "reviewer": "Test Reviewer", "reviewed_on": TODAY, "includes_keys": [], "synthetic": False,
    }
    d.update(over)
    return d


def compare(evidence=None, **kw):
    body = {"intake": DUBLIN, **kw}
    if evidence is not None:
        body["cost_evidence"] = evidence
    return _invoke("/v1/compare", handle_compare, body, Tier.CLIENT)


def row(out, sid):
    return next(r for r in out["scenarios"] if r["id"] == sid)


def capex(out, sid):
    q = row(out, sid)["economics"]["capex_total_eur"]
    return None if q is None else q["value"]          # None: nothing deployable, so there is no capex to state


# --- no evidence: exactly what it was ----------------------------------------------------------------------------------

def test_without_evidence_the_comparison_is_unchanged_and_carries_no_evidence_block():
    out = compare()
    assert "cost_evidence" not in out
    # The identity is the one the digest function has always produced for these inputs.
    assert out["request_digest"] == request_digest(DUBLIN, [r["id"] for r in out["scenarios"]], Objective.MAX_COMPUTE, out["baseline"])
    assert out == handle_compare({"intake": DUBLIN}, Tier.CLIENT)


# --- an accepted quotation contributes the right values ------------------------------------------------------------------

def test_an_accepted_quotation_prices_the_steps_it_covers_and_says_so():
    base, priced = compare(), compare([line()])
    assert [r["id"] for r in base["scenarios"]] == [r["id"] for r in priced["scenarios"]]
    # Physics is not cost: racks and dates are identical.
    for a, b in zip(base["scenarios"], priced["scenarios"]):
        assert a["after_ladder"]["racks"] == b["after_ladder"]["racks"]
        assert a["time_to_power"]["weeks"] == b["time_to_power"]["weeks"]
    assert capex(priced, "full_dlc_btm") != capex(base, "full_dlc_btm")
    used = priced["cost_evidence"]["used"]
    assert [u["evidence_id"] for u in used] == ["ev-1"] and used[0]["basis"] == "firm_quote"
    assert priced["cost_evidence"]["ignored"] == []
    fx = priced["cost_evidence"]["effect"]
    btm = next(x for x in fx["scenarios"] if x["scenario"] == "full_dlc_btm")
    # The effect carries unrounded figures; the comparison's totals are serialised to three significant figures.
    # The effect's delta is exactly the sum of the steps it says were repriced, and agrees with the totals to that rounding.
    assert btm["capex_delta_eur"] == pytest.approx(sum(c["capex_after_eur"] - c["capex_before_eur"] for c in btm["steps_changed"]))
    assert btm["capex_delta_eur"] < 0
    assert btm["capex_delta_eur"] == pytest.approx(capex(priced, "full_dlc_btm") - capex(base, "full_dlc_btm"), abs=0.01 * capex(base, "full_dlc_btm"))


def test_each_repriced_step_names_the_cost_key_that_priced_it():
    fx = compare([line()])["cost_evidence"]["effect"]
    changed = [c for x in fx["scenarios"] for c in x["steps_changed"]]
    assert changed and all(c["constraint"] == "transformer_capacity" for c in changed)
    assert all("transformer.replacement" in c["cost_keys"] for c in changed)
    assert all(c["basis_after"] == "firm_quote" for c in changed)


# --- quoted is distinguishable from estimated ------------------------------------------------------------------------------

def test_the_basis_mix_separates_quoted_lines_from_library_placeholders():
    base, priced = compare(), compare([line()])
    b_mix = row(base, "full_dlc_btm")["economics"]["cost_basis_mix"]
    p_mix = row(priced, "full_dlc_btm")["economics"]["cost_basis_mix"]
    # The mix counts priced cost lines (one per cost key), not ladder steps: one quoted line, one placeholder fewer.
    assert "firm_quote" not in b_mix and p_mix["firm_quote"]["lines"] == 1
    assert p_mix["library_default"]["lines"] == b_mix["library_default"]["lines"] - 1
    # Everything the quote does not cover is still a placeholder, and the answer still says it is not decision-grade.
    assert row(priced, "full_dlc_btm")["economics"]["decision_grade"] is False
    steps = row(priced, "full_dlc_btm")["time_to_power"]["lead_times"]
    assert {s["cost_basis"] for s in steps if s["constraint"] == "transformer_capacity"} == {"firm_quote"}
    assert any(s["cost_basis"] == "library_default" for s in steps)


# --- incompleteness is not hidden by a quotation --------------------------------------------------------------------------------

def test_a_quotation_does_not_complete_a_capex_that_has_other_unpriced_components():
    base, priced = compare(), compare([line()])
    incomplete_before = {r["id"] for r in base["scenarios"] if not r["economics"]["capex_complete"]}
    assert incomplete_before                                   # the fixture really has an incomplete scenario
    for sid in incomplete_before:
        assert row(priced, sid)["economics"]["capex_complete"] is False
        assert row(priced, sid)["economics"]["unpriced_components"] == row(base, sid)["economics"]["unpriced_components"]
    # A partial cost is still not ranked as if it were whole.
    cheap = compare([line()], objective="min_cost")
    assert {e["id"] for e in cheap["ranking"]["excluded"]} >= incomplete_before - {"retained_air", "rdhx"}


def test_a_quotation_for_a_cost_the_hall_never_buys_is_used_by_the_overlay_but_changes_nothing():
    base = compare()
    priced = compare([line(evidence_id="ev-x", key="busway.retrofit", value=1.0, unit="EUR/kW", quoted_quantity=None, quoted_quantity_unit=None)])
    for a, b in zip(base["scenarios"], priced["scenarios"]):
        assert a["economics"]["capex_total_eur"] == b["economics"]["capex_total_eur"]
    # The site reads "backed" from steps_changed, not from `used`: nothing was repriced, so nothing is quotation-backed.
    assert [c for x in priced["cost_evidence"]["effect"]["scenarios"] for c in x["steps_changed"]] == []


# --- nothing that is not currently accepted can move a number -------------------------------------------------------------------

@pytest.mark.parametrize("status", ["received", "validated", "rejected", "superseded", "withdrawn"])
def test_evidence_that_is_not_accepted_is_ignored_with_a_reason_and_changes_nothing(status):
    base = compare()
    out = compare([line(status=status)])
    assert out["cost_evidence"]["used"] == []
    assert out["cost_evidence"]["ignored"] == [{"key": "transformer.replacement", "evidence_id": "ev-1", "reason": f"status is {status}, not accepted"}]
    assert [r["economics"] for r in out["scenarios"]] == [r["economics"] for r in base["scenarios"]]
    assert out["request_digest"] == base["request_digest"]       # nothing applied, so the same question


def test_an_expired_quotation_is_ignored_with_its_date():
    out = compare([line(valid_until="2026-01-31")])
    assert out["cost_evidence"]["used"] == []
    assert "expired on 2026-01-31" in out["cost_evidence"]["ignored"][0]["reason"]
    assert [r["economics"] for r in out["scenarios"]] == [r["economics"] for r in compare()["scenarios"]]


# --- currency ---------------------------------------------------------------------------------------------------------------------------

def test_a_quotation_in_another_currency_is_refused_not_converted_or_mixed():
    with pytest.raises(ApiError) as e:
        compare([line(currency="USD")])
    assert e.value.status == 422 and "not EUR" in e.value.message


# --- duplicates do not inflate totals -----------------------------------------------------------------------------------------------

def test_two_accepted_quotations_for_one_cost_are_never_both_applied():
    older = line(evidence_id="ev-old", value=2_900_000.0, quoted_on="2026-09-01")
    newer = line(evidence_id="ev-new", value=2_340_000.0, quoted_on="2026-10-01")
    both, only_newer = compare([older, newer]), compare([newer])
    assert [u["evidence_id"] for u in both["cost_evidence"]["used"]] == ["ev-new"]
    assert both["cost_evidence"]["ignored"][0]["evidence_id"] == "ev-old"
    assert "superseded within this request" in both["cost_evidence"]["ignored"][0]["reason"]
    assert [capex(both, r["id"]) for r in both["scenarios"]] == [capex(only_newer, r["id"]) for r in only_newer["scenarios"]]
    # The order the lines are offered in never changes the answer or its identity.
    assert compare([newer, older])["request_digest"] == both["request_digest"]


# --- the identity covers the evidence -------------------------------------------------------------------------------------------------

def test_the_same_hall_on_different_quotations_is_a_different_question():
    plain, a, b = compare(), compare([line(value=2_340_000.0)]), compare([line(value=2_500_000.0)])
    assert len({plain["request_digest"], a["request_digest"], b["request_digest"]}) == 3
    assert compare([line()])["request_digest"] == a["request_digest"]     # the same evidence is the same question


def test_applying_evidence_leaves_the_library_for_the_next_comparison_untouched():
    before = compare()
    compare([line()])
    assert compare() == before


# --- synthetic evidence says so ------------------------------------------------------------------------------------------------------------

def test_synthetic_evidence_is_named_in_the_limitations_of_every_scenario_it_prices():
    out = compare([line(synthetic=True)])
    hit = [r for r in out["scenarios"] if any("synthetic" in t for t in r["economics"]["limitations"])]
    assert hit and all(r["economics"]["decision_grade"] is False for r in hit)


# --- the interface --------------------------------------------------------------------------------------------------------------------------------

def test_malformed_evidence_is_a_422_the_caller_can_act_on():
    for bad in ("nope", [{"key": "x"}], [line(quoted_quantity=-1)], [line(status="invalid")]):
        with pytest.raises(ApiError) as e:
            compare(bad)
        assert e.value.status == 422
