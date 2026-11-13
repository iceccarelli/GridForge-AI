"""A bid is a number from a supplier, and a JSON boolean is not one. Audit defect D4.

`float(True) == 1.0`, so a bid with `true` as its price, lead time and installation time was read as EUR 1, one week, one week and ranked
FIRST. A bid with no currency passed the comparison (`capex_eur` was "euros by contract") but was INVALID for cost evidence, so the two
paths disagreed; and a 30-thousand and a 30-million bid with no currency could both lead.

Everything goes through the real BTM route handler, `handle_power_deploy_bids`, as well as the schema.
"""
import json
import math

import pytest

from gridforge.api import server as S
from gridforge.api.tiers import Tier
from gridforge.procurement import ProcurementError, SupplierResponse
from gridforge.procurement.evaluate import assess

REQUEST = {
    "load_profile": {"csv": "timestamp,kW\n2026-01-01T00:00:00,30000\n2026-01-01T00:15:00,30000\n2026-01-01T00:30:00,30000\n",
                     "source": "synthetic-hall.csv"},
    "grid_firm_MW": 10.0, "target_MW": 35.0, "ride_through_hours": 3.0, "redundancy": "N+1",
    "generation": [
        {"id": "GEN-A", "kind": "gas_engine", "nameplate_MW": 20.0, "capex_eur": 16_000_000, "lead_time_weeks": 44, "fuel_type": "natural gas"},
        {"id": "GEN-B", "kind": "gas_engine", "nameplate_MW": 20.0, "capex_eur": 16_000_000, "lead_time_weeks": 44, "fuel_type": "natural gas"},
    ],
    "bess": [{"id": "BESS-1", "power_MW": 8.0, "energy_MWh": 32.0, "capex_eur": 7_200_000, "lead_time_weeks": 30}],
    "interconnection": {"utility": "TenneT", "pcc_voltage_kV": 20, "import_capacity_MW": 15},
    "permitting": {"emissions_status": "application submitted"},
    "architecture": "GRID + BESS + GENERATION", "project": "North Campus",
}                                          # declared plant: 16.0 + 16.0 + 7.2 = EUR 39.2M


@pytest.fixture(autouse=True)
def pinned_today(monkeypatch):
    monkeypatch.setenv("GRIDFORGE_REPORT_DATE", "2026-10-13")


def bid(name, values, *, currency="EUR", **extra):
    pkg = S._btm_spec_from_body(REQUEST)
    d = {"supplier": name, "received_on": "2026-10-01", "valid_until": "2027-12-31", "values": values,
         "compliance": {q.id: "C" for q in pkg.mandatory()}}
    if currency is not None:
        d["currency"] = currency
    d.update(extra)
    return d


def post(*bids):
    return S.handle_power_deploy_bids({**REQUEST, "responses": list(bids)}, Tier.CLIENT)


GOOD = {"capex_eur": 38_000_000, "lead_time_weeks": 40, "install_weeks": 8}


# ------------------------------------------------------------------------------------------------------------- booleans are not numbers

@pytest.mark.parametrize("field", ["capex_eur", "lead_time_weeks", "install_weeks"])
@pytest.mark.parametrize("value", [True, False])
def test_a_json_boolean_is_refused_for_every_numeric_response_field_and_the_field_is_named(field, value):
    values = {**GOOD, field: value}
    with pytest.raises(ProcurementError, match=field):
        SupplierResponse.from_dict({"supplier": "S", "received_on": "2026-10-01", "values": values})


def test_the_audit_repro_a_bid_of_true_true_true_does_not_rank_first_through_the_btm_route():
    with pytest.raises(S.ApiError) as err:
        post(bid("Honest", GOOD), bid("Boolean", {"capex_eur": True, "lead_time_weeks": True, "install_weeks": True}))
    assert err.value.status == 422 and "capex_eur" in str(err.value) and "boolean" in str(err.value).lower()


@pytest.mark.parametrize("bad", [[1], {"v": 1}, (1,), b"5", object(), 1 + 2j])
def test_any_other_type_is_refused_too(bad):
    with pytest.raises(ProcurementError, match="lead_time_weeks"):
        SupplierResponse.from_dict({"supplier": "S", "received_on": "2026-10-01", "values": {**GOOD, "lead_time_weeks": bad}})


@pytest.mark.parametrize("text,expected", [("38000000", 38_000_000.0), (" 40 ", 40.0), ("1e3", 1000.0)])
def test_a_numeric_string_is_still_read(text, expected):
    r = SupplierResponse.from_dict({"supplier": "S", "received_on": "2026-10-01", "values": {"lead_time_weeks": text}})
    assert r.values["lead_time_weeks"] == expected


@pytest.mark.parametrize("text", ["1_000", "0x10", "true", "ten", "1,5"])
def test_a_string_that_only_python_would_call_a_number_is_refused(text):
    with pytest.raises(ProcurementError, match="capex_eur"):
        SupplierResponse.from_dict({"supplier": "S", "received_on": "2026-10-01", "values": {"capex_eur": text}})


def test_missing_and_null_fields_stay_missing_never_zero():
    r = SupplierResponse.from_dict({"supplier": "S", "received_on": "2026-10-01", "currency": "EUR",
                                    "values": {"capex_eur": 38_000_000, "lead_time_weeks": None, "install_weeks": "  "}})
    assert r.get("lead_time_weeks") is None and r.get("install_weeks") is None
    out = post(bid("Gap", {"capex_eur": 38_000_000, "lead_time_weeks": None, "install_weeks": None}))
    row = out["ranked"][0]
    assert row["disqualified"] and "left blank" in " ".join(row["notes"]), "a missing figure disqualifies the bid, as it always did; it is never zero"
    assert row["weeks_to_energised"] is None


# ------------------------------------------------------------------------------------------------------------- a priced bid names its currency

def test_a_priced_bid_with_no_currency_is_not_ranked_through_the_btm_route():
    out = post(bid("Silent", GOOD, currency=None), bid("Euro", GOOD))
    rows = {r["supplier"]: r for r in out["ranked"]}
    assert rows["Silent"]["disqualified"]
    assert any("currency" in n and "not stated" in n for n in rows["Silent"]["notes"])
    assert not rows["Euro"]["disqualified"]
    assert out["leading"] == "Euro"


def test_the_comparison_and_the_evidence_path_now_agree_about_a_missing_currency():
    """The hall package (the BTM one has no cost-library line to become evidence): the same bid is disqualified by the comparison and
    INVALID as cost evidence, with one wording, where the comparison used to rank it."""
    from pathlib import Path
    from gridforge.intake.loader import load
    from gridforge.procurement import build_spec, relief_steps
    from gridforge.procurement.evidence import INVALID, quote_lines
    from gridforge.scenario.run import run_all
    intake = load(Path(__file__).resolve().parents[1] / "examples" / "intake" / "reference_hall.json")
    best = max(run_all(intake.context, intake.scenarios), key=lambda r: r.unlocked_racks)
    pkg = build_spec(intake, best, constraint_id=relief_steps(best)[0].binding_id)
    d = {"supplier": "Silent", "received_on": "2026-10-01", "valid_until": "2026-12-31",
         "values": {"capex_eur": pkg.budget_eur.value, "lead_time_weeks": 30, "install_weeks": 4},
         "compliance": {q.id: "C" for q in pkg.mandatory()}}
    silent = SupplierResponse.from_dict(d)
    a = assess(pkg, [silent])[0]
    lines = quote_lines(pkg, [silent])
    assert a.disqualified and lines and all(line.status == INVALID for line in lines)
    assert any("currency not stated" in n for n in a.notes)
    assert all(sum("currency not stated" in p for p in line.problems) == 1 for line in lines), "said once, not twice"


def test_thirty_thousand_against_thirty_million_with_no_currency_cannot_lead():
    out = post(bid("Thousands", {**GOOD, "capex_eur": 30_000}, currency=None), bid("Millions", {**GOOD, "capex_eur": 30_000_000}, currency=None))
    assert out["leading"] is None
    assert all(r["disqualified"] for r in out["ranked"])


def test_an_explicit_euro_bid_still_ranks_and_leads():
    out = post(bid("Euro", GOOD))
    assert out["leading"] == "Euro" and not out["ranked"][0]["disqualified"]


# ------------------------------------------------------------------------------------------------------------- price plausibility for the BTM package

def test_a_btm_price_a_thousandth_of_the_declared_plant_is_flagged_even_in_euros():
    """The package is priced from the declared units (EUR 39.2M here), so a thousandth of that is a unit slip, as in the hall comparison."""
    out = post(bid("Slip", {**GOOD, "capex_eur": 39_200}), bid("Real", GOOD))
    rows = {r["supplier"]: r for r in out["ranked"]}
    assert rows["Slip"]["disqualified"] and "confirm the units" in " ".join(rows["Slip"]["notes"])
    assert out["leading"] == "Real"


def test_a_btm_package_with_an_undeclared_price_has_no_budget_and_no_plausibility_check():
    unpriced = {**REQUEST, "generation": [{**g} for g in REQUEST["generation"]]}
    unpriced["generation"][0].pop("capex_eur")
    pkg = S._btm_spec_from_body(unpriced)
    assert getattr(pkg, "budget_eur", None) is None
    r = SupplierResponse.from_dict({"supplier": "S", "received_on": "2026-10-01", "currency": "EUR", "values": {**GOOD, "capex_eur": 39_200}})
    assert "confirm the units" not in " ".join(assess(pkg, [r])[0].notes)


# ------------------------------------------------------------------------------------------------------------- review R7: ceilings and floors

def _strict_scores(out):
    json.dumps(out, allow_nan=False)                                    # a literal NaN or Infinity in the body is not JSON
    return {r["supplier"]: r for r in out["ranked"]}


def test_a_bid_whose_lead_and_install_overflow_the_sum_is_disqualified_and_every_other_score_stays_finite():
    out = post(bid("Reference", GOOD), bid("Odd", {**GOOD, "lead_time_weeks": 1e308, "install_weeks": 1e308}))
    rows = _strict_scores(out)
    assert rows["Odd"]["disqualified"] and any("lead time" in n and "above" in n for n in rows["Odd"]["notes"])
    assert rows["Odd"]["weeks_to_energised"] is None
    assert math.isfinite(rows["Reference"]["score"]) and not rows["Reference"]["disqualified"] and out["leading"] == "Reference"


@pytest.mark.parametrize("lead,install,words", [
    (1e-9, 4, "under"), (0.5, 4, "under"), (30, 0, "installation"), (30, 0.1, "installation"), (30, 1e308, "installation"), (1e308, 4, "above"),
])
def test_a_lead_time_or_installation_a_purchased_item_cannot_have_is_disqualified_not_ranked_first(lead, install, words):
    out = post(bid("Reference", GOOD), bid("Odd", {**GOOD, "lead_time_weeks": lead, "install_weeks": install}))
    rows = _strict_scores(out)
    assert rows["Odd"]["disqualified"] and words in " ".join(rows["Odd"]["notes"])
    assert out["leading"] == "Reference"


def test_the_floors_and_ceilings_are_inclusive_of_what_is_credible():
    out = post(bid("Floor", {**GOOD, "lead_time_weeks": 1, "install_weeks": 0.5}), bid("Ceiling", {**GOOD, "lead_time_weeks": 520, "install_weeks": 520}))
    assert not any(r["disqualified"] for r in out["ranked"])


def test_an_arabic_indic_digit_is_not_a_number_and_the_refusal_names_the_supplier_and_the_field():
    with pytest.raises(S.ApiError) as err:
        post(bid("Reference", GOOD), bid("Odd Supplier", {**GOOD, "install_weeks": "٠"}))
    assert err.value.status == 422 and "Odd Supplier" in str(err.value) and "install_weeks" in str(err.value)


def test_a_boolean_refusal_names_the_supplier_too():
    with pytest.raises(S.ApiError) as err:
        post(bid("Boolean Co", {**GOOD, "capex_eur": True}))
    assert "Boolean Co" in str(err.value) and "capex_eur" in str(err.value)
