"""A bid is held to the numbers of the 'shall' clauses it answers, not only to the C it declared.

Audit J3-1: the busway tender asks for a continuous ampacity of not less than 1,990 A (E-10) and a price validity of not less than 60 days (C-02).
A bid declaring C on every clause with `duty_at_site_conditions: 1` and `validity_days: 10` came back rank 1, compliant, leading, 85/100, because
only the self-declared C/CD/N codes were scored. `validity_days: 0` and `duty: 0` ranked first too, and a response that was set aside carried
`compliant: true`, a rank and a schedule effect computed from the lead time that disqualified it. Every refusal also named no field.
"""
from __future__ import annotations

import copy
import json
from pathlib import Path

import pytest

from gridforge.api.server import ApiError, handle_bids, handle_spec
from gridforge.api.tiers import Tier
from gridforge.intake.loader import load
from gridforge.procurement import ProcurementError, SupplierResponse, build_spec, relief_steps
from gridforge.procurement.evaluate import assess, rank_bids, schedule_impact
from gridforge.scenario.run import run_all

ROOT = Path(__file__).resolve().parents[1]
INTAKE = json.loads((ROOT / "examples" / "intake" / "reference_hall.json").read_text())


@pytest.fixture(autouse=True)
def pinned_today(monkeypatch):
    monkeypatch.setenv("GRIDFORGE_REPORT_DATE", "2026-10-13")


@pytest.fixture(scope="module")
def spec_out():
    return handle_spec({"intake": INTAKE, "constraint": "busway_ampacity", "format": "json"}, Tier.CLIENT)


@pytest.fixture(scope="module")
def pkg():
    intake = load(ROOT / "examples" / "intake" / "reference_hall.json")
    results = run_all(intake.context, intake.scenarios)
    from gridforge.reporting.study import _pick_recommended
    from gridforge.api.server import _objective
    return build_spec(intake, _pick_recommended(results, _objective({})), constraint_id="busway_ampacity")


def bid(spec_out, name="Bid", *, duty=2100.0, validity=90.0, lead=40.0, capex=1_500_000.0, install=4.0, code="C", **over) -> dict:
    """A completed response schedule built from the spec endpoint's own template, as a supplier would return it."""
    d = copy.deepcopy(spec_out["response_template"])
    d.update({"supplier": name, "received_on": "2026-10-01", "currency": "EUR"})
    d["values"].update({"capex_eur": capex, "lead_time_weeks": lead, "install_weeks": install,
                        "duty_at_site_conditions": duty, "validity_days": validity})
    d["compliance"] = {k: code for k in d["compliance"]}
    d.update(over)
    return d


def compare(spec_out, *bids):
    return handle_bids({"intake": INTAKE, "constraint": "busway_ampacity", "responses": list(bids)}, Tier.CLIENT)


def rows(out) -> dict:
    return {r["supplier"]: r for r in out["ranked"]}


# --- the audit reproduction -----------------------------------------------------------------------------------------------------

def test_a_bid_whose_figures_contradict_the_shall_clauses_cannot_lead(spec_out):
    out = compare(spec_out, bid(spec_out, "Honest", duty=2100, validity=90),
                  bid(spec_out, "Contradicted", duty=1, validity=10, lead=30, capex=1_000_000))
    r = rows(out)
    assert out["leading"] == "Honest" and r["Honest"]["rank"] == 1
    bad = r["Contradicted"]
    assert not bad["compliant"] and not bad["disqualified"] and bad["rank"] == 2
    assert bad["mandatory_failed"] == ["E-10", "C-02"], "declared C, so the bid's own figure fails it exactly as an N would"


def test_the_flag_names_the_requirement_and_the_figure_asked_against_the_figure_offered(spec_out):
    out = compare(spec_out, bid(spec_out, "Contradicted", duty=1, validity=10))
    row = rows(out)["Contradicted"]
    checks = {c["requirement"]: c for c in row["figure_checks"]}
    assert checks["E-10"]["asked"] == 1990 and checks["E-10"]["offered"] == 1 and checks["E-10"]["unit"] == "A"
    assert checks["E-10"]["must_be"] == "at_least" and checks["E-10"]["declared"] == "C"
    assert checks["C-02"]["asked"] == 60 and checks["C-02"]["offered"] == 10 and checks["C-02"]["unit"] == "days"
    notes = " ".join(row["notes"])
    assert "E-10" in notes and "not less than 1,990 A" in notes and "offers 1 A" in notes, notes
    assert "C-02" in notes and "not less than 60 days" in notes and "offers 10 days" in notes, notes
    assert "responses[0].values.duty_at_site_conditions" in notes, "the note names the field to fix, by its path in the request"


def test_the_failed_clauses_cost_the_bid_its_compliance_points(spec_out):
    out = compare(spec_out, bid(spec_out, "Honest"), bid(spec_out, "Short", duty=1, validity=10))
    r = rows(out)
    assert r["Short"]["scores"]["C1"] < r["Honest"]["scores"]["C1"]
    assert r["Short"]["score"] < 85, "no longer 85/100 for a bid that meets neither number"


def test_a_figure_that_meets_the_floor_exactly_or_exceeds_it_stays_compliant(spec_out):
    out = compare(spec_out, bid(spec_out, "Exact", duty=1990, validity=60), bid(spec_out, "Over", duty=5000, validity=365))
    for name in ("Exact", "Over"):
        assert rows(out)[name]["compliant"] and rows(out)[name]["figure_checks"] == []


def test_a_bid_that_states_no_figure_is_not_failed_but_says_it_was_not_checked(spec_out):
    """A missing figure is missing, never zero: the bid is not failed on a number it did not give, and it is not silently treated as checked."""
    d = bid(spec_out, "Silent")
    d["values"]["duty_at_site_conditions"] = None
    d["values"]["validity_days"] = None
    row = rows(compare(spec_out, d))["Silent"]
    assert row["compliant"] and row["mandatory_failed"] == [] and row["figure_checks"] == []
    notes = " ".join(row["notes"])
    assert "E-10" in notes and "not stated" in notes and "supplier's word alone" in notes, notes
    assert "C-02" in notes


def test_a_declared_deviation_with_a_short_figure_stays_a_deviation_with_the_numbers_beside_it(spec_out):
    d = bid(spec_out, "Deviating", duty=1800)
    d["compliance"]["E-10"] = "CD"
    row = rows(compare(spec_out, d))["Deviating"]
    assert "E-10" not in row["mandatory_failed"]
    note = next(n for n in row["notes"] if n.startswith("E-10"))
    assert "not less than 1,990 A" in note and "offers 1,800 A" in note and "accept it in writing" in note


def test_a_bid_declaring_n_is_still_failed_once_not_twice(spec_out):
    d = bid(spec_out, "Honest N", duty=1)
    d["compliance"]["E-10"] = "N"
    row = rows(compare(spec_out, d))["Honest N"]
    assert row["mandatory_failed"] == ["E-10"]


# --- a figure that is not a figure ----------------------------------------------------------------------------------------------

@pytest.mark.parametrize("field", ["duty_at_site_conditions", "validity_days"])
def test_a_zero_duty_or_validity_is_set_aside_not_ranked_first(spec_out, field):
    kwargs = {"duty": 0} if field == "duty_at_site_conditions" else {"validity": 0}
    out = compare(spec_out, bid(spec_out, "Peer"), bid(spec_out, "Zero", lead=30, capex=1_000_000, **kwargs))
    r = rows(out)
    assert r["Zero"]["disqualified"] and r["Zero"]["rank"] is None and out["leading"] == "Peer"
    assert any(f"values.{field}" in n and "not a positive figure" in n for n in r["Zero"]["notes"]), r["Zero"]["notes"]


def test_a_set_aside_response_carries_no_rank_no_compliance_and_no_schedule_effect(spec_out):
    """A lead time of 0 weeks disqualified the response and was then used to say it was 32 weeks earlier than modelled."""
    out = compare(spec_out, bid(spec_out, "Peer"), bid(spec_out, "Zero lead", lead=0, install=4))
    r = rows(out)
    z = r["Zero lead"]
    assert z["disqualified"] and z["compliant"] is False and z["rank"] is None
    assert "earlier" not in z["schedule_impact"] and "later" not in z["schedule_impact"]
    assert z["schedule_impact"].startswith("Not evaluated")
    assert r["Peer"]["rank"] == 1 and out["leading"] == "Peer"


def test_ranks_count_only_the_responses_that_were_compared(spec_out):
    out = compare(spec_out, bid(spec_out, "Zero lead", lead=0), bid(spec_out, "A"), bid(spec_out, "B", capex=1_700_000, lead=44))
    assert [(x["supplier"], x["rank"]) for x in out["ranked"]] == [("A", 1), ("B", 2), ("Zero lead", None)]


def test_the_library_never_calls_a_disqualified_bid_compliant(pkg):
    d = {"supplier": "Zero", "received_on": "2026-10-01", "currency": "EUR",
         "values": {"capex_eur": pkg.budget_eur.value, "lead_time_weeks": 0, "install_weeks": 4},
         "compliance": {q.id: "C" for q in pkg.mandatory()}}
    a = assess(pkg, [SupplierResponse.from_dict(d)])[0]
    assert a.disqualified and not a.compliant
    assert schedule_impact(pkg, a).startswith("Not evaluated")


def test_cost_evidence_records_that_the_price_is_for_a_different_scope_when_the_figure_falls_short(pkg):
    from gridforge.procurement.evidence import quote_lines

    def line(duty):
        d = {"supplier": "S", "received_on": "2026-10-01", "currency": "EUR",
             "values": {"capex_eur": pkg.budget_eur.value, "lead_time_weeks": 30, "install_weeks": 4, "duty_at_site_conditions": duty},
             "compliance": {q.id: "C" for q in pkg.mandatory()}}
        return quote_lines(pkg, [SupplierResponse.from_dict(d)])[0]
    short, fine = line(1.0), line(2100.0)
    assert any("E-10" in x and "different scope" in x and "1 A offered" in x for x in short.limitations), short.limitations
    assert not any("E-10" in x for x in fine.limitations)


# --- scores are relative --------------------------------------------------------------------------------------------------------

def test_the_same_bid_scores_differently_against_different_peers_and_says_so(spec_out):
    me = bid(spec_out, "Me", capex=1_200_000, lead=36)
    alone = rows(compare(spec_out, me))["Me"]
    cheap_fast = bid(spec_out, "Rival", capex=900_000, lead=20)
    against = rows(compare(spec_out, copy.deepcopy(me), cheap_fast))["Me"]
    assert alone["score"] != against["score"], "the premise: the score is cohort-relative"
    for row, n in ((alone, "only bid"), (against, "2 bids")):
        assert n in row["score_basis"] and "relative, not absolute" in row["score_basis"], row["score_basis"]
    from gridforge.procurement.evaluate import SCORE_BASIS
    out = compare(spec_out, me)
    assert "relative, not absolute" in out["note"] and SCORE_BASIS in out["note"]
    assert "relative to the bids compared" in alone["headline"]


def test_a_set_aside_response_is_not_scored_against_anything(spec_out):
    out = compare(spec_out, bid(spec_out, "Peer"), bid(spec_out, "Zero lead", lead=0))
    assert rows(out)["Zero lead"]["score_basis"].startswith("Not scored")


# --- the specification states what it holds a bid to ----------------------------------------------------------------------------

def test_the_response_schedule_asks_for_the_duty_in_the_unit_of_the_clause_it_is_held_to(pkg):
    duty = next(f for f in pkg.response_fields if f.key == "duty_at_site_conditions")
    assert duty.unit == "A" and "E-10" in duty.note and "1,990" in duty.note
    assert "kW or A" not in duty.unit, "a figure with an ambiguous unit cannot be held to a number"
    validity = next(f for f in pkg.response_fields if f.key == "validity_days")
    assert "C-02" in validity.note and "60" in validity.note


def test_the_validity_clause_and_its_check_share_one_number(pkg):
    c02 = next(q for q in pkg.requirements if q.id == "C-02")
    assert c02.figure_limit == 60 and "60 days" in c02.statement


def test_the_specification_document_tells_the_supplier_the_rule():
    md = handle_spec({"intake": INTAKE, "constraint": "busway_ampacity", "format": "md"}, Tier.CLIENT)["document"]
    assert "held to the numeric 'shall' clauses" in md and "not compliant on that clause, whatever code is returned" in md
    assert "relative to the bids compared together, not absolute" in md


# --- the behind-the-meter tender uses the same check ----------------------------------------------------------------------------

def test_the_btm_tender_holds_validity_to_its_60_days_too():
    from gridforge.api import server as S
    from test_power_deploy_bids_currency import REQUEST
    pkg = S._btm_spec_from_body(REQUEST)
    mandatory = [q.id for q in pkg.mandatory()]

    def resp(name, validity):
        return {"supplier": name, "received_on": "2026-10-01", "currency": "EUR",
                "values": {"capex_eur": 30_000_000, "lead_time_weeks": 30, "install_weeks": 4, "validity_days": validity},
                "compliance": {i: "C" for i in mandatory}}

    out = S.handle_power_deploy_bids({**REQUEST, "responses": [resp("Short", 10), resp("Fine", 90)]}, Tier.CLIENT)
    r = {x["supplier"]: x for x in out["ranked"]}
    assert r["Short"]["mandatory_failed"] == ["C-02"] and not r["Short"]["compliant"]
    assert r["Fine"]["compliant"] and out["leading"] == "Fine"
    assert "responses[0].values.validity_days" in " ".join(r["Short"]["notes"])


# --- every refusal names the field ----------------------------------------------------------------------------------------------

def test_a_response_with_no_received_on_names_the_field_and_its_place_in_the_request(spec_out):
    good = bid(spec_out, "Good")
    undated = bid(spec_out, "Undated")
    del undated["received_on"]
    with pytest.raises(ApiError) as exc:
        compare(spec_out, good, undated)
    assert "responses[1].received_on" in str(exc.value) and "date it was received" in str(exc.value)


@pytest.mark.parametrize("mutate, field", [
    (lambda d: d.pop("supplier"), "responses[0].supplier"),
    (lambda d: d["values"].update(capex_eur="a lot"), "responses[0].values.capex_eur"),
    (lambda d: d["values"].update(lead_time_weeks=True), "responses[0].values.lead_time_weeks"),
    (lambda d: d.update(values="nope"), "responses[0].values"),
    (lambda d: d.update(compliance=["C"]), "responses[0].compliance"),
    (lambda d: d["compliance"].update({"E-10": "Y"}), "responses[0].compliance.E-10"),
    (lambda d: d.update(received_on="01/10/2026"), "responses[0].received_on"),
    (lambda d: d.update(received_on="2999-01-01"), "responses[0].received_on"),
    (lambda d: d.update(valid_until="soon"), "responses[0].valid_until"),
    (lambda d: d["specification"].update(hall="OTHER"), "responses[0].specification.hall"),
])
def test_each_refusal_names_the_offending_field_path(spec_out, mutate, field):
    d = bid(spec_out, "X")
    mutate(d)
    with pytest.raises(ApiError) as exc:
        compare(spec_out, d)
    assert field in str(exc.value), str(exc.value)


def test_a_duplicate_supplier_names_both_responses(spec_out):
    with pytest.raises(ApiError) as exc:
        compare(spec_out, bid(spec_out, "Same"), bid(spec_out, "same"))
    assert "responses[1].supplier" in str(exc.value) and "responses[0].supplier" in str(exc.value)


def test_a_priced_response_with_no_currency_names_the_field(spec_out):
    d = bid(spec_out, "NoCurrency")
    d["currency"] = ""
    row = rows(compare(spec_out, d))["NoCurrency"]
    assert row["disqualified"] and any("responses[0].currency" in n for n in row["notes"]), row["notes"]


def test_a_library_caller_with_no_request_gets_the_bare_field_name():
    with pytest.raises(ProcurementError) as exc:
        SupplierResponse.from_dict({"supplier": "X"})
    assert str(exc.value).startswith("received_on:"), str(exc.value)


def test_an_unknown_constraint_in_the_spec_request_names_the_field():
    with pytest.raises(ApiError) as exc:
        handle_spec({"intake": INTAKE, "constraint": "no_such_thing", "format": "json"}, Tier.CLIENT)
    assert "constraint" in str(exc.value) and "no_such_thing" in str(exc.value)
