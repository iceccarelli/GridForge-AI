"""The unmetered-path sweep.

Every way into the engine is either billable and PROVEN to reserve units (HTTP and MCP, portfolio per hall),
or free and named on an allowlist in this file. A route that is free by omission is a hole in the invoice, so
adding one means editing this test and saying why.
"""
import json

import pytest

from gridforge.api import server as S
from gridforge.api.metering import FREE_ENDPOINTS, UNIT_COST, units_for
from gridforge.api.tiers import Tier
from gridforge.api.tools import TOOLS, TOOLS_BY_NAME
from payg_rig import ADMIN, INTAKE, Rig, rig  # noqa: F401

#: POST routes that are free on purpose, and why. Nothing else may be.
FREE_POST_ROUTES = {
    "/v1/qualify": "the free qualifier: the demo, never counted against an allowance",
    "/v1/estimate": "pricing a call is never itself a cost",
}
#: Operator routes: no customer can call them, and they are never billed.
OPERATOR_POST_ROUTES = {"/v1/revoke"}
#: Operator-only GET routes: 404 to every customer, absent from every listing, never metered.
OPERATOR_GET_ROUTES = ("/v1/admin/ledger", "/v1/admin/economics")
#: MCP tools that are free on purpose.
FREE_TOOLS = {"gridforge_qualify": "/v1/qualify", "gridforge_estimate": "/v1/estimate"}
#: GET routes (all free, none may touch a ledger).
GET_FREE = ("/health", "/v1/version", "/v1/platforms", "/v1/intake/template", "/v1/calibration", "/v1/tools",
            "/v1/usage")


def _body(path: str) -> dict:
    return {"intakes": [INTAKE] * 3} if path == "/v1/portfolio" else {"intake": INTAKE}


# --- the route table itself -------------------------------------------------------------------
def test_every_post_route_is_billable_free_by_name_or_operator_only():
    for path, (_, tier) in S.ROUTES.items():
        if tier is Tier.INTERNAL:
            assert path in OPERATOR_POST_ROUTES, f"{path}: an unlisted operator route"
            assert path not in UNIT_COST
        elif path in FREE_POST_ROUTES:
            assert UNIT_COST[path] == 0
        else:
            assert UNIT_COST.get(path, 0) > 0, f"{path} is routable, customer-facing and bills nothing"
    assert set(FREE_POST_ROUTES) | OPERATOR_POST_ROUTES <= set(S.ROUTES)


def test_the_free_allowlist_is_exactly_the_zero_weight_routes():
    zero = {p for p, u in UNIT_COST.items() if u == 0}
    assert zero == FREE_ENDPOINTS
    # The only weight-0 entries that are not POST routes are the GET listings and the /mcp transport.
    assert zero - set(FREE_POST_ROUTES) == {"/v1/calibration", "/v1/tools", "/v1/usage", "/mcp"}


def test_a_route_with_no_published_weight_is_billed_never_free():
    assert units_for("/v1/some-future-route") == 1


def test_every_tool_is_billable_or_on_the_free_tool_allowlist():
    for t in TOOLS:
        if t["name"] in FREE_TOOLS:
            assert t["units"] == 0 and t["tier"] == Tier.PUBLIC.value and t["endpoint"] == FREE_TOOLS[t["name"]]
        else:
            assert t["units"] > 0 and t["tier"] == Tier.CLIENT.value, t["name"]
            assert t["units"] == UNIT_COST[t["endpoint"]]
    assert set(FREE_TOOLS) <= set(TOOLS_BY_NAME)


def test_the_only_customer_route_without_a_tool_is_deck_and_it_is_still_billed():
    advertised = {t["endpoint"] for t in TOOLS}
    unadvertised = {p for p, (_, tier) in S.ROUTES.items() if tier is not Tier.INTERNAL} - advertised
    assert unadvertised == {"/v1/deck"}
    assert UNIT_COST["/v1/deck"] > 0


# --- proof by execution: HTTP ----------------------------------------------------------------
BILLABLE_POST = sorted(p for p, (_, tier) in S.ROUTES.items()
                       if tier is Tier.CLIENT and p not in FREE_POST_ROUTES)


@pytest.mark.parametrize("path", BILLABLE_POST)
def test_every_billable_post_route_reserves_its_units_in_the_ledger(rig, monkeypatch, path):
    monkeypatch.setitem(S.ROUTES, path, (lambda body, tier: {"ok": True}, Tier.CLIENT))
    key = rig.key("payg", quota=500)
    body = _body(path)
    s, _, h = rig.post(path, body, key=key)
    assert s == 200
    (ev,) = rig.events()
    assert ev["kind"] == "charge" and ev["endpoint"] == path
    assert ev["units"] == units_for(path, body) == UNIT_COST[path] * (3 if path == "/v1/portfolio" else 1)
    assert h["X-GridForge-Charge-Cents"] == str(ev["units"] * 200)


@pytest.mark.parametrize("path", BILLABLE_POST)
def test_every_billable_post_route_refuses_a_call_with_no_key_and_records_nothing(rig, monkeypatch, path):
    ran = []
    monkeypatch.setitem(S.ROUTES, path, (lambda body, tier: ran.append(1) or {}, Tier.CLIENT))
    s, _, _ = rig.post(path, _body(path))
    assert s in (401, 503) and ran == [] and rig.events() == []


@pytest.mark.parametrize("path", BILLABLE_POST)
def test_every_billable_post_route_stops_at_the_cap(rig, monkeypatch, path):
    monkeypatch.setitem(S.ROUTES, path, (lambda body, tier: {"ok": True}, Tier.CLIENT))
    need = units_for(path, _body(path))
    key = rig.key("trial", quota=need, account="free1")
    assert rig.post(path, _body(path), key=key)[0] == 200
    assert rig.post(path, _body(path), key=key)[0] == 402
    assert len(rig.events()) == 1


@pytest.mark.parametrize("path", sorted(FREE_POST_ROUTES))
def test_every_free_post_route_leaves_no_ledger_trace(rig, path):
    key = rig.key("trial", quota=25, account="free1")
    body = ({"contracted_MW": 12, "current_site_peak_MW": 7.4, "current_it_load_MW": 4.9,
             "busway_ampacity_A": 400, "tapoff_max_A": 63, "plant_supply_C": 6, "positions_available": 180}
            if path == "/v1/qualify" else {"endpoint": "/v1/study"})
    assert rig.post(path, body, key=key)[0] == 200
    assert rig.post(path, body)[0] == 200
    assert rig.events() == [] and rig.meter.current("free1").units == 0


def test_the_get_routes_never_charge(rig):
    key = rig.key("payg", quota=50)
    for path in GET_FREE:
        s, _, _ = rig.get(path, key=key)
        assert s == 200, path
    assert rig.get("/v1/estimate?endpoint=/v1/study", key=key)[0] == 200
    assert rig.events() == []


@pytest.mark.parametrize("path", OPERATOR_GET_ROUTES)
def test_operator_get_routes_are_hidden_from_customers_and_never_charge(rig, path):
    key = rig.key("payg", quota=50)
    for k in (None, key, "nonsense"):
        assert rig.get(path, key=k)[0] == 404
    assert rig.get(path, key=ADMIN)[0] == 200
    listings = json.dumps([rig.get("/v1/version")[1], rig.get("/v1/tools")[1], rig.get("/nope")[1],
                           rig.post("/v1/nope", {})[1]])
    assert path not in listings
    assert path not in S.ROUTES and path not in S.GET_ROUTES and path not in UNIT_COST
    assert rig.events() == []


def test_the_mcp_transport_itself_is_free(rig):
    key = rig.key("payg", quota=50)
    for method in ("initialize", "ping", "tools/list"):
        assert rig.post("/mcp", {"jsonrpc": "2.0", "id": 1, "method": method}, key=key)[0] == 200
    assert rig.post("/mcp", {"jsonrpc": "2.0", "method": "notifications/initialized"}, key=key)[0] == 202
    assert rig.events() == []


# --- proof by execution: MCP -----------------------------------------------------------------
BILLABLE_TOOLS = sorted(t["name"] for t in TOOLS if t["name"] not in FREE_TOOLS)


def _args(name: str) -> dict:
    return {"intakes": [INTAKE] * 3} if name == "gridforge_portfolio" else {"intake": INTAKE}


@pytest.mark.parametrize("name", BILLABLE_TOOLS)
def test_every_billable_mcp_tool_reserves_its_units_in_the_ledger(rig, monkeypatch, name):
    endpoint = TOOLS_BY_NAME[name]["endpoint"]
    monkeypatch.setitem(S.ROUTES, endpoint, (lambda body, tier: {"ok": True}, Tier.CLIENT))
    key = rig.key("payg", quota=500)
    s, b, h = rig.post("/mcp", {"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                                "params": {"name": name, "arguments": _args(name)}}, key=key)
    assert s == 200 and "error" not in b, b
    (ev,) = rig.events()
    assert ev["kind"] == "charge" and ev["endpoint"] == endpoint
    assert ev["units"] == units_for(endpoint, _args(name))
    assert ev["units"] == TOOLS_BY_NAME[name]["units"] * (3 if name == "gridforge_portfolio" else 1)
    assert h["X-GridForge-Charge-Cents"] == str(ev["units"] * 200)


@pytest.mark.parametrize("name", BILLABLE_TOOLS)
def test_every_billable_mcp_tool_refuses_without_a_key_and_records_nothing(rig, monkeypatch, name):
    endpoint = TOOLS_BY_NAME[name]["endpoint"]
    ran = []
    monkeypatch.setitem(S.ROUTES, endpoint, (lambda body, tier: ran.append(1) or {}, Tier.CLIENT))
    _, b, _ = rig.post("/mcp", {"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                                "params": {"name": name, "arguments": _args(name)}})
    assert b["error"]["code"] == -32001 and ran == [] and rig.events() == []


@pytest.mark.parametrize("name", BILLABLE_TOOLS)
def test_every_billable_mcp_tool_stops_at_the_cap(rig, monkeypatch, name):
    endpoint = TOOLS_BY_NAME[name]["endpoint"]
    monkeypatch.setitem(S.ROUTES, endpoint, (lambda body, tier: {"ok": True}, Tier.CLIENT))
    key = rig.key("trial", quota=units_for(endpoint, _args(name)), account="free1")
    call = {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": name, "arguments": _args(name)}}
    assert "error" not in rig.post("/mcp", call, key=key)[1]
    assert rig.post("/mcp", call, key=key)[1]["error"]["code"] == -32002
    assert len(rig.events()) == 1


def test_the_free_mcp_tools_leave_no_ledger_trace(rig):
    key = rig.key("trial", quota=25, account="free1")
    q = {"contracted_MW": 12, "current_site_peak_MW": 7.4, "current_it_load_MW": 4.9,
         "busway_ampacity_A": 400, "tapoff_max_A": 63, "plant_supply_C": 6, "positions_available": 180}
    for name, args in (("gridforge_qualify", q), ("gridforge_estimate", {"endpoint": "/v1/study"})):
        for k in (None, key):
            _, b, _ = rig.post("/mcp", {"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                                        "params": {"name": name, "arguments": args}}, key=k)
            assert "error" not in b, (name, b)
    assert rig.events() == [] and rig.meter.current("free1").units == 0


def test_the_calibration_ledger_is_still_published_empty(rig):
    """The usage ledger is billing, not calibration: it must never leak into the accuracy record."""
    _, b, _ = rig.get("/v1/calibration")
    assert b["state"] == "uncalibrated" and b["keys_asserted"] > 10
    rig.post("/v1/screen", INTAKE, key=rig.key("payg", quota=50))
    assert rig.get("/v1/calibration")[1]["state"] == "uncalibrated"
