"""A bid is only as comparable as the checks that let it into the comparison.

Each test is a way a tender was observed to be won by a response that should never
have been ranked: silence on mandatory requirements, a zero or negative or
non-finite price, a price in the wrong unit, a response written for another hall or
revision, an expired offer, a superseded duplicate.
"""
import os

import pytest

from gridforge.intake.loader import load
from gridforge.procurement import ProcurementError, SupplierResponse, build_spec
from gridforge.procurement.evaluate import assess, rank_bids
from gridforge.scenario.run import run_all
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture(autouse=True)
def pinned_today(monkeypatch):
    monkeypatch.setenv("GRIDFORGE_REPORT_DATE", "2026-10-13")


@pytest.fixture(scope="module")
def pkg():
    intake = load(ROOT / "examples" / "intake" / "reference_hall.json")
    results = run_all(intake.context, intake.scenarios)
    best = max(results, key=lambda r: r.unlocked_racks)
    from gridforge.procurement import relief_steps
    step = relief_steps(best)[0]
    return build_spec(intake, best, constraint_id=step.binding_id)


def resp(pkg, supplier="S", capex=None, lead=30, comp="C", spec=True, **extra):
    capex = pkg.budget_eur.value if capex is None else capex
    d = {"supplier": supplier, "received_on": "2026-10-01", "valid_until": "2026-12-31",
         "values": {"capex_eur": capex, "lead_time_weeks": lead, "install_weeks": 4},
         "compliance": {q.id: comp for q in pkg.mandatory()} if comp else {}}
    if spec:
        d["specification"] = {"project": pkg.project, "hall": pkg.hall,
                              "constraint": pkg.constraint_id,
                              "sized_for_racks": pkg.sized_for_racks}
    d.update(extra)
    return SupplierResponse.from_dict(d)


def test_silence_on_mandatory_requirements_is_not_compliance(pkg):
    silent = resp(pkg, "Silent", capex=pkg.budget_eur.value * 0.5, comp="")
    good = resp(pkg, "Good")
    ranked = rank_bids(pkg, [silent, good])
    assert ranked[0].supplier == "Good"
    assert not next(a for a in ranked if a.supplier == "Silent").compliant


@pytest.mark.parametrize("capex", [0, -100])
def test_a_non_positive_price_is_not_ranked(pkg, capex):
    a = assess(pkg, [resp(pkg, capex=capex)])[0]
    assert a.disqualified and "positive" in " ".join(a.notes)


def test_non_finite_numbers_are_refused_at_load(pkg):
    with pytest.raises(ProcurementError, match="finite"):
        resp(pkg, capex="nan")
    with pytest.raises(ProcurementError, match="finite"):
        resp(pkg, capex="inf")


def test_a_price_in_the_wrong_unit_cannot_win(pkg):
    kilo = resp(pkg, "Thousands", capex=pkg.budget_eur.value / 1000)
    a = assess(pkg, [kilo, resp(pkg, "Normal")])
    k = next(x for x in a if x.supplier == "Thousands")
    assert k.disqualified and "confirm the units" in " ".join(k.notes)
    assert rank_bids(pkg, [kilo, resp(pkg, "Normal")])[0].supplier == "Normal"


def test_a_response_for_another_specification_is_refused(pkg):
    wrong = resp(pkg)
    wrong.specification["sized_for_racks"] = pkg.sized_for_racks + 7
    with pytest.raises(ProcurementError, match="re-price against the current specification"):
        assess(pkg, [wrong])
    other = resp(pkg)
    other.specification["hall"] = "SOMEWHERE-ELSE"
    with pytest.raises(ProcurementError, match="hall"):
        assess(pkg, [other])


def test_expired_and_future_dated_responses(pkg):
    expired = resp(pkg, valid_until="2025-01-01")
    assert assess(pkg, [expired])[0].disqualified
    with pytest.raises(ProcurementError, match="future"):
        assess(pkg, [resp(pkg, received_on="2030-01-01")])
    with pytest.raises(ProcurementError, match="ISO date"):
        assess(pkg, [resp(pkg, received_on="not-a-date")])


def test_two_responses_from_one_supplier_are_refused(pkg):
    with pytest.raises(ProcurementError, match="one current response per supplier"):
        assess(pkg, [resp(pkg, "Acme"), resp(pkg, "ACME ")])


def test_unknown_compliance_codes_are_refused_and_deviation_is_visible(pkg):
    ids = [q.id for q in pkg.mandatory()]
    with pytest.raises(ProcurementError, match="C, CD or N"):
        resp(pkg, comp="").__class__.from_dict({
            "supplier": "X", "received_on": "2026-10-01",
            "values": {"capex_eur": pkg.budget_eur.value, "lead_time_weeks": 30},
            "compliance": {ids[0]: "MAYBE"}}) and assess(pkg, [SupplierResponse.from_dict({
                "supplier": "X", "received_on": "2026-10-01",
                "values": {"capex_eur": pkg.budget_eur.value, "lead_time_weeks": 30},
                "compliance": {ids[0]: "MAYBE"}})])
    dev = resp(pkg, "Dev")
    dev.compliance[ids[0]] = "CD"
    full = resp(pkg, "Full")
    by = {a.supplier: a for a in assess(pkg, [dev, full])}
    assert by["Dev"].deviations == [ids[0]]
    assert by["Dev"].scores["C1"] < by["Full"].scores["C1"]
