"""The engine side of the Verified Power Record.

The site stores projects, packages and responses; it computes none of it. What it
needs from the engine is (1) a tender package for ONE architecture's units, refused
unless that architecture is RFQ-ready, and (2) supplier responses to that package
ranked by the SAME `procurement.rank_bids` the hall comparison uses. These tests pin
both, plus the calibration record the whole feature promises not to touch.
"""
import json
import os
import threading
import urllib.error
import urllib.request

import pytest

from gridforge.api.server import Handler, make_server
from gridforge.calibration import all_keys, accuracy_block, load_ledger
from gridforge.procurement import SupplierResponse, rank_bids
from gridforge.reporting.btm_spec import build_equipment_spec

KEY = "project-record-key"

REQUEST = {
    "load_profile": {"flat_kW": 30000},
    "grid_firm_MW": 10.0, "target_MW": 35.0, "ride_through_hours": 3.0, "redundancy": "N+1",
    "generation": [
        {"id": "GEN-A", "kind": "gas_engine", "nameplate_MW": 20.0, "capex_eur": 16_000_000,
         "lead_time_weeks": 44, "fuel_type": "natural gas"},
        {"id": "GEN-B", "kind": "gas_engine", "nameplate_MW": 20.0, "capex_eur": 16_000_000,
         "lead_time_weeks": 44, "fuel_type": "natural gas"},
    ],
    "bess": [{"id": "BESS-1", "power_MW": 8.0, "energy_MWh": 32.0, "capex_eur": 7_200_000,
              "lead_time_weeks": 30}],
    "interconnection": {"utility": "TenneT", "pcc_voltage_kV": 20, "import_capacity_MW": 15},
    "permitting": {"emissions_status": "application submitted"},
}
ARCH = "GRID + BESS + GENERATION"


@pytest.fixture(scope="module")
def server():
    os.environ["GRIDFORGE_API_KEYS"] = KEY
    Handler.limiter.per_minute = 0
    httpd = make_server("127.0.0.1", 0)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{httpd.server_address[1]}"
    httpd.shutdown()
    os.environ.pop("GRIDFORGE_API_KEYS", None)


def call(base, path, body):
    req = urllib.request.Request(f"{base}{path}", data=json.dumps(body).encode(), method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("X-API-Key", KEY)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def response(template, supplier, **values):
    return {"supplier": supplier, "received_on": "2026-10-01",
            "values": {**template["values"], **values},
            "compliance": {rid: "C" for rid in template["compliance"]}}


def test_the_spec_tenders_only_the_chosen_architectures_units(server):
    status, body = call(server, "/v1/power/deploy/spec",
                        {**REQUEST, "architecture": "GRID + GENERATION", "format": "json"})
    assert status == 200, body
    assert body["specification"]["units"] == ["GEN-A", "GEN-B"]       # no BESS-1
    status, body = call(server, "/v1/power/deploy/spec",
                        {**REQUEST, "architecture": "GRID + BESS", "format": "json"})
    assert body["specification"]["units"] == ["BESS-1"]


def test_the_rendered_spec_carries_a_response_template_the_comparison_can_read(server):
    status, body = call(server, "/v1/power/deploy/spec",
                        {**REQUEST, "architecture": ARCH, "format": "html"})
    assert status == 200, body
    assert "GEN-A" in body["document_md"] and "<html" in body["document_full"]
    t = body["response_template"]
    assert set(t) == {"supplier", "received_on", "valid_until", "values", "compliance"}
    assert t["compliance"], "mandatory clauses must be answerable one by one"


def test_require_rfq_ready_is_decided_by_the_engine_not_the_caller(server):
    ready = {**REQUEST, "architecture": ARCH, "format": "json", "require_rfq_ready": True}
    assert call(server, "/v1/power/deploy/spec", ready)[0] == 200
    unpriced = {**REQUEST, "bess": [], "generation": [{"id": "GEN-A", "kind": "gas_engine",
                "nameplate_MW": 20.0}], "architecture": "GRID + GENERATION",
                "format": "json", "require_rfq_ready": True}
    status, body = call(server, "/v1/power/deploy/spec", unpriced)
    assert status == 409, body
    assert body["capex_uncosted_units"] == ["GEN-A"]
    # an architecture the assessment never compared has nothing to be ready against
    status, _ = call(server, "/v1/power/deploy/spec",
                     {**REQUEST, "architecture": "Made up", "require_rfq_ready": True})
    assert status == 422


def test_btm_bids_are_ranked_by_the_same_function_the_hall_comparison_uses(server):
    _, spec = call(server, "/v1/power/deploy/spec", {**REQUEST, "architecture": ARCH})
    t = spec["response_template"]
    a = response(t, "Cheap but late", capex_eur=30_000_000, lead_time_weeks=60, install_weeks=10)
    b = response(t, "Dearer, sooner", capex_eur=38_000_000, lead_time_weeks=36, install_weeks=8)
    status, body = call(server, "/v1/power/deploy/bids",
                        {**REQUEST, "architecture": ARCH, "responses": [a, b]})
    assert status == 200, body

    # Recompute with the library directly: same package, same function, same answer.
    from gridforge.reporting.btm_assessment import deployment_request
    kw = deployment_request(REQUEST)
    pkg = build_equipment_spec(ARCH, project="p", generation=kw["generation"], bess=kw["bess"])
    assert pkg.sized_for_racks == 0
    ranked = rank_bids(pkg, [SupplierResponse.from_dict(a), SupplierResponse.from_dict(b)])
    assert [(r["supplier"], r["score"]) for r in body["ranked"]] == \
        [(r.supplier, round(r.total_score, 1)) for r in ranked]
    assert {r["supplier"] for r in body["ranked"]} == {"Cheap but late", "Dearer, sooner"}
    assert all(r["eur_per_rack"] is None for r in body["ranked"])   # no racks in BTM: not invented
    assert "scored by an engineer" in body["note"]


def test_a_non_compliant_bid_is_never_ranked_above_a_compliant_one(server):
    _, spec = call(server, "/v1/power/deploy/spec", {**REQUEST, "architecture": ARCH})
    t = spec["response_template"]
    cheap_bad = response(t, "Cheap non-compliant", capex_eur=1, lead_time_weeks=1)
    first_clause = next(iter(t["compliance"]))
    cheap_bad["compliance"][first_clause] = "N"
    fair = response(t, "Compliant", capex_eur=40_000_000, lead_time_weeks=50)
    _, body = call(server, "/v1/power/deploy/bids",
                   {**REQUEST, "architecture": ARCH, "responses": [cheap_bad, fair]})
    assert [r["supplier"] for r in body["ranked"]] == ["Compliant", "Cheap non-compliant"]
    assert body["leading"] == "Compliant"


def test_an_incomplete_response_is_disqualified_not_guessed_at(server):
    _, spec = call(server, "/v1/power/deploy/spec", {**REQUEST, "architecture": ARCH})
    t = spec["response_template"]
    blank = response(t, "No price")
    status, body = call(server, "/v1/power/deploy/bids",
                        {**REQUEST, "architecture": ARCH, "responses": [blank]})
    assert status == 200
    assert body["ranked"][0]["disqualified"] is True and body["leading"] is None
    status, body = call(server, "/v1/power/deploy/bids",
                        {**REQUEST, "architecture": ARCH,
                         "responses": [{**blank, "values": {"capex_eur": "about forty"}}]})
    assert status == 422


def test_the_bids_route_refuses_an_empty_comparison(server):
    assert call(server, "/v1/power/deploy/bids", {**REQUEST, "architecture": ARCH})[0] == 422


def test_the_calibration_record_is_still_empty():
    """The project record gives a future observation somewhere to attach. It must not
    have created one: no observation, no site, and an honest 'nothing yet' statement."""
    ledger = load_ledger()
    assert ledger.to_dict()["observations"] == []
    block = accuracy_block(all_keys(), ledger)
    assert block["observations"] == 0 and block["sites"] == 0
