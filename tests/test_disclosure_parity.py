"""Every answer the engine gives says how far the engine has been checked against real sites, including that it has not been. Audit defect D8.

/v1/screen and /v1/qualify carried the accuracy record; /v1/compare, /v1/diff and the behind-the-meter routes carried only
`calibration_sha256` (which ledger produced the answer) and not what that ledger says. SKILL.md: the calibration ledger is empty and
EVERY API RESPONSE says so. This walks gridforge.api.server.ROUTES, so a route added later without the disclosure fails here.
"""
import json
from pathlib import Path

import pytest

from gridforge.api import server as S
from gridforge.api.tiers import Tier
from gridforge.calibration import accuracy_block, constraint_key

ROOT = Path(__file__).resolve().parents[1]
HALL = json.loads((ROOT / "examples" / "intake" / "reference_hall.json").read_text())
OTHER_HALL = json.loads((ROOT / "examples" / "intake" / "dublin_hall.json").read_text())

BTM = {
    "load_profile": {"csv": "timestamp,kW\n2026-01-01T00:00:00,30000\n2026-01-01T00:15:00,30000\n2026-01-01T00:30:00,30000\n",
                     "source": "synthetic-hall.csv"},
    "grid_firm_MW": 10.0, "target_MW": 35.0, "ride_through_hours": 3.0, "redundancy": "N+1",
    "generation": [{"id": "GEN-A", "kind": "gas_engine", "nameplate_MW": 20.0, "capex_eur": 16_000_000, "lead_time_weeks": 44, "fuel_type": "natural gas"}],
    "bess": [{"id": "BESS-1", "power_MW": 8.0, "energy_MWh": 32.0, "capex_eur": 7_200_000, "lead_time_weeks": 30}],
    "interconnection": {"utility": "TenneT", "pcc_voltage_kV": 20, "import_capacity_MW": 15},
    "permitting": {"emissions_status": "application submitted"},
    "architecture": "GRID + BESS + GENERATION", "project": "North Campus",
}

#: Routes that legitimately carry no accuracy record, and why. Anything NOT listed here must carry it.
NO_DISCLOSURE = {
    "/v1/estimate": "arithmetic on the published rate card: it states what a call would cost and gives no capacity or decision answer",
    "/v1/revoke": "key administration (internal tier): it answers whether a key id was revoked, nothing about a hall or a plant",
}
#: GET routes. /v1/calibration IS the record; the others state the service, not an answer about a site.
GET_NO_DISCLOSURE = {
    "/health": "liveness", "/v1/version": "build and rate card (it points at /v1/calibration)", "/v1/platforms": "the platform catalogue",
    "/v1/intake/template": "a blank form", "/v1/tools": "the tool catalogue", "/v1/usage": "a key's own metering statement",
    "/v1/calibration": "this IS the accuracy record", "/v1/calibration/residuals": "the residual aggregate; says uncalibrated when empty",
}
#: Where the block sits when it is not the top-level `calibration` key (an older shape that is kept as it was).
DISCLOSED_AT = {"/v1/power/assess": ("evidence", "calibration")}


def _bids_for_hall():
    return {"intake": HALL, "responses": [{"supplier": "Synthetic Supplier", "received_on": "2026-10-01", "currency": "EUR",
                                           "values": {"capex_eur": 1_000_000, "lead_time_weeks": 30, "install_weeks": 4}}]}


def _btm_bids():
    pkg = S._btm_spec_from_body(BTM)
    bid = {"supplier": "S", "received_on": "2026-10-01", "valid_until": "2027-12-31", "currency": "EUR",
           "values": {"capex_eur": 23_000_000, "lead_time_weeks": 40, "install_weeks": 8}, "compliance": {q.id: "C" for q in pkg.mandatory()}}
    return {**BTM, "responses": [bid]}


REQUESTS = {
    "/v1/qualify": ({"site_name": "T", "metro": "Frankfurt", "contracted_MW": 12, "current_site_peak_MW": 7.4, "current_it_load_MW": 4.9,
                     "busway_ampacity_A": 400, "tapoff_max_A": 63, "plant_supply_C": 6, "positions_available": 180}, Tier.PUBLIC),
    "/v1/screen": ({"intake": HALL}, Tier.CLIENT),
    "/v1/compare": ({"intake": HALL}, Tier.CLIENT),
    "/v1/study": ({"intake": HALL}, Tier.CLIENT),
    "/v1/portfolio": ({"intakes": [HALL, OTHER_HALL]}, Tier.CLIENT),
    "/v1/proposal": ({"intake": HALL, "format": "md"}, Tier.CLIENT),
    "/v1/deck": ({"intake": HALL}, Tier.CLIENT),
    "/v1/diff": ({"before": HALL, "after": OTHER_HALL}, Tier.CLIENT),
    "/v1/spec": ({"intake": HALL, "format": "md"}, Tier.CLIENT),
    "/v1/bids": (_bids_for_hall(), Tier.CLIENT),
    "/v1/power/assess": ({"intake": HALL}, Tier.CLIENT),
    "/v1/power/deploy/assess": (BTM, Tier.CLIENT),
    "/v1/power/deploy/spec": ({**BTM, "format": "md"}, Tier.CLIENT),
    "/v1/power/deploy/bids": (_btm_bids(), Tier.CLIENT),
}


@pytest.fixture(autouse=True)
def pinned_today(monkeypatch):
    monkeypatch.setenv("GRIDFORGE_REPORT_DATE", "2026-10-13")


def _disclosure(route, out):
    node = out
    for part in DISCLOSED_AT.get(route, ("calibration",)):
        node = node.get(part) if isinstance(node, dict) else None
    return node


def test_every_post_route_is_either_exercised_here_or_listed_with_the_reason_it_has_no_disclosure():
    unaccounted = set(S.ROUTES) - set(REQUESTS) - set(NO_DISCLOSURE)
    assert not unaccounted, f"a new route needs a request here (so its disclosure is checked) or an entry in NO_DISCLOSURE: {sorted(unaccounted)}"
    assert set(NO_DISCLOSURE) <= set(S.ROUTES) and set(GET_NO_DISCLOSURE) <= set(S.GET_ROUTES)
    assert set(S.GET_ROUTES) == set(GET_NO_DISCLOSURE), "a new GET route must be listed with the reason it carries no disclosure"


@pytest.mark.parametrize("route", sorted(REQUESTS))
def test_the_answer_carries_the_accuracy_record_and_it_says_the_ledger_is_empty(route):
    body, tier = REQUESTS[route]
    out = S.ROUTES[route][0](body, tier)
    block = _disclosure(route, out)
    assert isinstance(block, dict), f"{route} answers without the calibration disclosure"
    assert block["state"] == "uncalibrated" and block["observations"] == 0 and block["sites"] == 0
    assert "has not been established" in block["statement"] and "0 reconciled observations" in block["statement"]


def test_the_btm_routes_use_the_key_the_ledger_actually_has():
    out = S.handle_power_deploy_assess(BTM, Tier.CLIENT)
    assert out["calibration"] == accuracy_block(["btm.firm_MW"])
    assert out["calibration"]["keys_asserted"] == 1 and out["calibration"]["uncalibrated_keys"] == ["btm.firm_MW"]


def test_compare_and_diff_use_the_same_block_as_screen_for_the_same_hall():
    screen = S.handle_screen({"intake": HALL}, Tier.CLIENT)["calibration"]
    compare = S.handle_compare({"intake": HALL}, Tier.CLIENT)["calibration"]
    assert compare["statement"] == screen["statement"] and list(compare) == list(screen)
    diff = S.handle_diff({"before": HALL, "after": HALL}, Tier.CLIENT)["calibration"]
    assert diff["statement"] == screen["statement"]


def test_the_diff_asserts_the_constraints_that_bound_before_and_after():
    out = S.handle_diff({"before": HALL, "after": OTHER_HALL}, Tier.CLIENT)
    ids = {out["before"]["binding_id"], out["after"]["binding_id"]}
    block = out["calibration"]
    assert block["keys_asserted"] == len({constraint_key(i) for i in ids} | {"envelope.racks", "envelope.it_load_kW"})


def test_the_new_key_is_additive_existing_keys_are_untouched():
    compare = S.handle_compare({"intake": HALL}, Tier.CLIENT)
    assert {"schema", "scenarios", "ranking", "grade", "caveats", "request_digest", "provenance"} <= set(compare)
    diff = S.handle_diff({"before": HALL, "after": OTHER_HALL}, Tier.CLIENT)
    assert {"headline", "material", "before", "after", "racks_delta", "weeks_delta", "capex_delta_eur", "drivers"} <= set(diff)


def test_a_ledger_that_is_not_empty_is_what_the_disclosure_reports(monkeypatch):
    """The block is read from the ledger in effect, not written as a constant: give it one observation and compare says so."""
    from gridforge.calibration import ledger as L
    from gridforge.calibration.schema import Observation, site_only_ref
    from gridforge.validation.evidence import EvidenceClass
    one = Observation(key="envelope.racks", site_ref=site_only_ref("S1"), predicted=20.0, observed=24.0, unit="racks",
                      observed_on="2026-06-15", evidence=EvidenceClass.E5_CUSTOMER_DATA, method="metering")
    monkeypatch.setattr(L, "load_ledger", lambda *a, **k: L.Ledger(observations=[one]))
    import gridforge.calibration.disclosure as D
    monkeypatch.setattr(D, "load_ledger", L.load_ledger)
    out = S.handle_compare({"intake": HALL}, Tier.CLIENT)
    assert out["calibration"]["observations"] == 1 and out["calibration"]["state"] != "calibrated"
