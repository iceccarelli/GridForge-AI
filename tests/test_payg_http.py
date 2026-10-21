"""Pay-as-you-go over a real socket: estimate, charge headers, 402/503 bodies, the operator ledger read,
idempotent replay across a restart, and the MCP path. Every metered call is checked against the ledger,
because the ledger is what the invoice is made from."""
import json
import threading

import pytest

from gridforge.api import keys as K
from gridforge.api import server as S
from gridforge.api.metering import UNIT_COST
from gridforge.commercial import PAYG
from payg_rig import ADMIN, INTAKE, Rig, rig  # noqa: F401  (rig is a fixture)


# --- estimate ---------------------------------------------------------------------------------
def test_estimate_is_public_free_and_never_metered(rig):
    s, b, h = rig.get("/v1/estimate?endpoint=/v1/study")
    assert s == 200
    assert (b["endpoint"], b["units"], b["unit_price_cents"], b["currency"]) == ("/v1/study", 5, 200, "eur")
    assert b["estimated_cents"] == 1000 and b["billable"] is True and b["free"] is False
    assert "5 units" in b["basis"]
    assert "X-GridForge-Units" not in h
    assert rig.events() == [] and rig.meter.current("acme").units == 0
    for k in ("scope", "cap_units", "used_units", "fits"):
        assert k not in b, "a public estimate says nothing about a key it was not given"


def test_estimate_of_a_free_endpoint_is_free(rig):
    s, b, _ = rig.get("/v1/estimate?endpoint=/v1/qualify")
    assert s == 200 and b["units"] == 0 and b["estimated_cents"] == 0
    assert b["billable"] is False and b["free"] is True


@pytest.mark.parametrize("halls", [1, 2, 7, 40, 250])
def test_estimate_scales_a_portfolio_per_hall(rig, halls):
    s, b, _ = rig.get(f"/v1/estimate?endpoint=/v1/portfolio&hall_count={halls}")
    assert s == 200 and b["units"] == halls and b["estimated_cents"] == halls * 200
    s, b2, _ = rig.post("/v1/estimate", {"endpoint": "/v1/portfolio", "body": {"intakes": [{}] * halls}})
    assert s == 200 and b2["units"] == halls and f"{halls} halls" in b2["basis"]


def test_estimate_post_matches_the_meter_for_every_priced_endpoint(rig):
    for endpoint, units in UNIT_COST.items():
        s, b, _ = rig.post("/v1/estimate", {"endpoint": endpoint})
        assert s == 200 and b["units"] == units and b["estimated_cents"] == units * PAYG.unit_price_cents


@pytest.mark.parametrize("q", ["", "?endpoint=/v1/nope", "?endpoint=/v1/revoke", "?endpoint=/v1/admin/ledger",
                               "?endpoint=/v1/portfolio&hall_count=0", "?endpoint=/v1/portfolio&hall_count=abc",
                               "?endpoint=/v1/portfolio&hall_count=999999999"])
def test_estimate_refuses_what_it_cannot_price(rig, q):
    s, b, _ = rig.get("/v1/estimate" + q)
    assert s == 422 and b["error"]
    assert "/v1/revoke" not in json.dumps(b), "the operator route is never listed"


def test_estimate_with_a_key_says_whether_the_call_fits_and_stays_free(rig):
    key = rig.key("trial", quota=PAYG.free_allowance_units, account="free1")
    rig.post("/v1/screen", INTAKE, key=key)
    s, b, h = rig.post("/v1/estimate", {"endpoint": "/v1/study"}, key=key)
    assert s == 200 and b["scope"] == "trial"
    assert (b["cap_units"], b["used_units"], b["remaining_units"]) == (25, 1, 24)
    assert b["fits"] is True and b["would_cost_after_allowance"] == 0
    s, b, _ = rig.post("/v1/estimate", {"endpoint": "/v1/portfolio", "hall_count": 40}, key=key)
    assert b["fits"] is False and b["would_cost_after_allowance"] == (40 - 24) * 200
    assert "X-GridForge-Units" not in h
    assert len(rig.events()) == 1, "estimating must not add ledger events"


def test_estimate_for_a_payg_key_prices_the_whole_call(rig):
    key = rig.key("payg", quota=50)
    s, b, _ = rig.get("/v1/estimate?endpoint=/v1/study", key=key)
    assert b["scope"] == "payg" and b["would_cost_after_allowance"] == 1000 and b["fits"] is True


def test_estimate_does_not_require_or_leak_a_bad_key(rig):
    s, b, _ = rig.get("/v1/estimate?endpoint=/v1/study", key="gfk1.junk.junk")
    assert s == 200 and b["units"] == 5 and b["key_error"]


def test_estimate_is_an_mcp_tool_and_free(rig):
    s, b, _ = rig.post("/mcp", {"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                                "params": {"name": "gridforge_estimate",
                                           "arguments": {"endpoint": "/v1/portfolio", "hall_count": 12}}})
    assert s == 200 and "error" not in b
    assert b["result"]["structuredContent"]["units"] == 12
    assert rig.events() == []
    s, b, _ = rig.post("/mcp", {"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
    assert any(t["name"] == "gridforge_estimate" and t["_meta"]["gridforge/units"] == 0 for t in b["result"]["tools"])


# --- publishing payg -------------------------------------------------------------------------
def test_version_and_tools_publish_the_payg_block(rig):
    for path in ("/v1/version", "/v1/tools"):
        s, b, _ = rig.get(path)
        assert s == 200
        p = b["payg"]
        assert (p["unit_price_cents"], p["currency"], p["min_invoice_cents"], p["free_allowance_units"]) == (
            PAYG.unit_price_cents, PAYG.currency, PAYG.min_invoice_cents, PAYG.free_allowance_units)
        assert "net ledger units" in p["billing_rule"] and "carried forward" in p["billing_rule"]
    assert "/v1/estimate" in rig.get("/v1/version")[1]["endpoints"]


def test_tools_publish_a_rate_card_that_includes_deck(rig):
    _, b, _ = rig.get("/v1/tools")
    card = {r["endpoint"]: r for r in b["rate_card"]}
    assert card["/v1/deck"]["units"] == 3 and card["/v1/deck"]["tool"] is None
    assert card["/v1/study"]["tool"] == "gridforge_study"
    assert card["/v1/estimate"]["units"] == 0 and card["/v1/qualify"]["units"] == 0


# --- charging a payg key ---------------------------------------------------------------------
def test_a_payg_call_reports_what_it_adds_to_the_invoice_and_is_in_the_ledger(rig):
    key = rig.key("payg", quota=50)
    s, b, h = rig.post("/v1/screen", INTAKE, key=key, headers={"X-GridForge-Project": "hall-7"})
    assert s == 200
    assert h["X-GridForge-Units"] == "1" and h["X-GridForge-Charge-Cents"] == "200"
    (ev,) = rig.events()
    assert (ev["kind"], ev["scope"], ev["endpoint"], ev["units"], ev["project"]) == ("charge", "payg", "/v1/screen", 1, "hall-7")
    assert ev["key_id"] == K.verify(key).key_id and ev["account"] == "acme"


def test_the_charge_header_is_for_payg_keys_only(rig):
    for scope in ("trial", "machine"):
        s, _, h = rig.post("/v1/screen", INTAKE, key=rig.key(scope, quota=50, account=scope))
        assert s == 200 and "X-GridForge-Charge-Cents" not in h and h["X-GridForge-Units"] == "1"


@pytest.mark.parametrize("label", ["x" * 65, "has space", "semi;colon", "ünïcode", "a/b"])
def test_a_bad_project_label_is_ignored_not_rejected(rig, label):
    s, _, _ = rig.post("/v1/screen", INTAKE, key=rig.key(), headers={"X-GridForge-Project": label})
    assert s == 200 and rig.events()[0]["project"] == ""


def test_a_rejected_request_is_refunded_with_a_compensating_event_and_costs_nothing(rig):
    key = rig.key("payg", quota=50)
    s, b, h = rig.post("/v1/screen", {"grid": {"contracted_MW": "abc"}}, key=key)
    assert s == 422
    assert h["X-GridForge-Units"] == "0" and h["X-GridForge-Charge-Cents"] == "0"
    charge, refund = rig.events()
    assert (charge["kind"], refund["kind"], refund["ref"]) == ("charge", "refund", charge["id"])
    assert rig.meter.current("acme").units == 0


def test_the_free_qualifier_never_touches_the_ledger_or_an_allowance(rig):
    key = rig.key("trial", quota=PAYG.free_allowance_units, account="free1")
    body = {"contracted_MW": 12, "current_site_peak_MW": 7.4, "current_it_load_MW": 4.9,
            "busway_ampacity_A": 400, "tapoff_max_A": 63, "plant_supply_C": 6, "positions_available": 180}
    for k in (None, key):
        s, _, h = rig.post("/v1/qualify", body, key=k)
        assert s == 200 and "X-GridForge-Units" not in h
    s, _, _ = rig.post("/mcp", {"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                                "params": {"name": "gridforge_qualify", "arguments": body}}, key=key)
    assert s == 200
    assert rig.events() == [] and rig.meter.current("free1").units == 0


def test_a_payg_key_at_its_cap_gets_a_402_that_says_what_to_do(rig):
    key = rig.key("payg", quota=PAYG.cap_units(PAYG.min_cap_eur))     # EUR 20 = 10 units
    for _ in range(10):
        assert rig.post("/v1/screen", INTAKE, key=key)[0] == 200
    s, b, h = rig.post("/v1/screen", INTAKE, key=key)
    assert s == 402
    assert b["plan"] == "api_payg" and b["reason"] == "spending_cap_reached"
    assert (b["units_required"], b["units_used"], b["cap_units"], b["monthly_quota"]) == (1, 10, 10, 10)
    assert b["unit_price_cents"] == 200 and b["cap_eur"] == 20.0 and b["resets_at"].endswith("Z")
    assert "Raise the cap" in b["fix"] and "API access page" in b["fix"]
    assert len(rig.events()) == 10, "a refused call is not in the ledger"


def test_a_free_key_at_its_allowance_gets_a_402_pointing_at_payg(rig):
    key = rig.key("trial", quota=2, account="free1")
    for _ in range(2):
        assert rig.post("/v1/screen", INTAKE, key=key)[0] == 200
    s, b, _ = rig.post("/v1/screen", INTAKE, key=key)
    assert s == 402 and b["plan"] == "api_free" and b["reason"] == "free_allowance_exhausted"
    assert "pay-as-you-go" in b["fix"] and "no charge until you do" in b["fix"]
    assert b["unit_price_cents"] == 200


def test_a_subscription_key_at_its_quota_gets_a_402(rig):
    key = rig.key("machine", quota=1, account="sub1")
    rig.post("/v1/screen", INTAKE, key=key)
    s, b, _ = rig.post("/v1/screen", INTAKE, key=key)
    assert s == 402 and b["plan"] == "subscription" and "upgrade" in b["fix"] and b["unit_price_cents"] == 200


def test_over_the_cap_is_never_a_429(rig):
    key = rig.key("trial", quota=1, account="free1")
    rig.post("/v1/screen", INTAKE, key=key)
    assert rig.post("/v1/screen", INTAKE, key=key)[0] == 402


# --- fail closed over HTTP ---------------------------------------------------------------------
@pytest.mark.parametrize("scope", ["payg", "trial"])
def test_an_unwritable_ledger_is_a_503_with_no_work_and_no_charge(rig, scope, monkeypatch):
    ran = []
    monkeypatch.setitem(S.ROUTES, "/v1/screen", (lambda body, tier: ran.append(1) or {"ok": True}, S.Tier.CLIENT))
    key = rig.key(scope, quota=50, account=scope)
    rig.ledger_path.mkdir()                      # nowhere to append
    s, b, h = rig.post("/v1/screen", INTAKE, key=key)
    assert s == 503 and b["retryable"] is True and "nothing was charged" in b["error"]
    assert h["Retry-After"] == "30"
    assert ran == [], "the work must not run when it cannot be recorded"
    assert rig.meter.current(scope).units == 0
    # a subscription key keeps today's behaviour
    assert rig.post("/v1/screen", INTAKE, key=rig.key("machine", quota=50, account="sub"))[0] == 200


def test_a_503_over_mcp_is_a_json_rpc_error_not_a_free_answer(rig, monkeypatch):
    ran = []
    monkeypatch.setitem(S.ROUTES, "/v1/screen", (lambda body, tier: ran.append(1) or {"ok": True}, S.Tier.CLIENT))
    rig.ledger_path.mkdir()
    s, b, _ = rig.post("/mcp", {"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                                "params": {"name": "gridforge_screen", "arguments": {"intake": INTAKE}}},
                       key=rig.key())
    assert s == 200 and b["error"]["code"] == -32003 and b["error"]["data"]["status"] == 503 and ran == []


# --- idempotency across a restart --------------------------------------------------------------
def test_a_retry_with_the_same_key_is_free_after_an_engine_restart(rig):
    key = rig.key("payg", quota=50)
    h = {"Idempotency-Key": "order-42"}
    s1, b1, h1 = rig.post("/v1/screen", INTAKE, key=key, headers=h)
    assert s1 == 200 and h1["X-GridForge-Charge-Cents"] == "200" and "X-GridForge-Idempotent-Replay" not in h1
    rig.restart()                                  # the response cache is gone; the ledger is not
    s2, b2, h2 = rig.post("/v1/screen", INTAKE, key=key, headers=h)
    assert s2 == 200 and b2 == b1, "the answer is deterministic, so the replay is the same answer"
    assert h2["X-GridForge-Idempotent-Replay"] == "true" and h2["Idempotent-Replay"] == "true"
    assert h2["X-GridForge-Charge-Cents"] == "0" and h2["X-GridForge-Units"] == "0"
    assert len(rig.events()) == 1 and rig.meter.current("acme").units == 1


def test_a_reused_key_with_a_different_body_is_refused_even_after_a_restart(rig):
    key = rig.key("payg", quota=50)
    h = {"Idempotency-Key": "order-42"}
    rig.post("/v1/screen", INTAKE, key=key, headers=h)
    rig.restart()
    s, b, _ = rig.post("/v1/screen", {"grid": {"contracted_MW": 9, "firm_capacity_MVA": 9}}, key=key, headers=h)
    assert s == 422 and "different request body" in b["error"]
    assert len(rig.events()) == 1


def test_a_failed_first_attempt_is_refunded_and_the_retry_is_charged_once(rig):
    key = rig.key("payg", quota=50)
    h = {"Idempotency-Key": "order-43"}
    assert rig.post("/v1/screen", {"grid": {"contracted_MW": "abc"}}, key=key, headers=h)[0] == 422
    assert rig.post("/v1/screen", INTAKE, key=key, headers={"Idempotency-Key": "order-43"})[0] == 200
    assert [e["kind"] for e in rig.events()] == ["charge", "refund", "charge"]
    assert rig.meter.current("acme").units == 1


def test_concurrent_requests_with_one_idempotency_key_are_charged_once(rig):
    key = rig.key("payg", quota=50)
    results = []

    def go():
        results.append(rig.post("/v1/screen", INTAKE, key=key, headers={"Idempotency-Key": "race-1"})[0])
    ts = [threading.Thread(target=go) for _ in range(6)]
    [t.start() for t in ts]
    [t.join() for t in ts]
    assert results == [200] * 6
    assert len([e for e in rig.events() if e["kind"] == "charge"]) == 1


# --- the operator ledger read ------------------------------------------------------------------
def test_the_ledger_read_is_404_to_everyone_but_the_operator(rig):
    key = rig.key()
    assert rig.get("/v1/admin/ledger")[0] == 404
    assert rig.get("/v1/admin/ledger", key=key)[0] == 404
    assert rig.get("/v1/admin/ledger", key="nonsense")[0] == 404
    assert rig.get("/v1/admin/ledger", key=ADMIN)[0] == 200
    for listing in (rig.get("/v1/version")[1]["endpoints"], rig.get("/nope")[1]["endpoints"],
                    [t["endpoint"] for t in rig.get("/v1/tools")[1]["tools"]]):
        assert "/v1/admin/ledger" not in listing


def test_the_ledger_read_pages_without_gaps_or_repeats(rig):
    key = rig.key("payg", quota=500)
    for _ in range(7):
        rig.post("/v1/screen", INTAKE, key=key)
    s, b, _ = rig.get("/v1/admin/ledger?after_seq=0&limit=3", key=ADMIN)
    assert s == 200 and [e["seq"] for e in b["events"]] == [1, 2, 3]
    assert b["last_seq"] == 3 and b["head_seq"] == 7 and b["durable"] is True
    seen = [e["seq"] for e in b["events"]]
    cursor = b["last_seq"]
    while True:
        _, b, _ = rig.get(f"/v1/admin/ledger?after_seq={cursor}&limit=3", key=ADMIN)
        if not b["events"]:
            assert b["last_seq"] == cursor
            break
        seen += [e["seq"] for e in b["events"]]
        cursor = b["last_seq"]
    assert seen == list(range(1, 8))


def test_the_ledger_read_bounds_its_parameters(rig):
    assert rig.get("/v1/admin/ledger?limit=1001", key=ADMIN)[0] == 400
    assert rig.get("/v1/admin/ledger?limit=0", key=ADMIN)[0] == 400
    assert rig.get("/v1/admin/ledger?after_seq=-1", key=ADMIN)[0] == 400
    assert rig.get("/v1/admin/ledger?after_seq=x", key=ADMIN)[0] == 400
    s, b, _ = rig.get("/v1/admin/ledger?limit=1000", key=ADMIN)
    assert s == 200 and b["events"] == [] and b["last_seq"] == 0


def test_the_ledger_read_reports_a_non_durable_ledger(rig):
    rig.ledger_path.mkdir()
    s, b, _ = rig.get("/v1/admin/ledger", key=ADMIN)
    assert s == 200 and b["durable"] is False


def test_the_operator_key_is_never_metered(rig):
    assert rig.post("/v1/screen", INTAKE, key=ADMIN)[0] == 200
    assert rig.events() == []


# --- MCP charges the ledger too ----------------------------------------------------------------
def test_an_mcp_tool_call_reserves_units_and_records_the_project(rig):
    key = rig.key("payg", quota=50)
    s, b, h = rig.post("/mcp", {"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                                "params": {"name": "gridforge_screen", "arguments": {"intake": INTAKE}}},
                       key=key, headers={"X-GridForge-Project": "agent-run-9"})
    assert s == 200 and "error" not in b, b
    assert h["X-GridForge-Charge-Cents"] == "200"
    (ev,) = rig.events()
    assert (ev["endpoint"], ev["units"], ev["project"], ev["scope"]) == ("/v1/screen", 1, "agent-run-9", "payg")


def test_an_mcp_tool_that_fails_is_refunded(rig):
    key = rig.key("payg", quota=50)
    s, b, _ = rig.post("/mcp", {"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                                "params": {"name": "gridforge_screen",
                                           "arguments": {"intake": {"grid": {"contracted_MW": "abc"}}}}}, key=key)
    assert b["error"]
    assert [e["kind"] for e in rig.events()] == ["charge", "refund"] and rig.meter.current("acme").units == 0


def test_an_mcp_portfolio_is_charged_per_hall(rig, monkeypatch):
    monkeypatch.setitem(S.ROUTES, "/v1/portfolio", (lambda body, tier: {"halls": []}, S.Tier.CLIENT))
    key = rig.key("payg", quota=50)
    rig.post("/mcp", {"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                      "params": {"name": "gridforge_portfolio", "arguments": {"intakes": [INTAKE] * 6}}}, key=key)
    (ev,) = rig.events()
    assert ev["units"] == 6 and ev["endpoint"] == "/v1/portfolio"
    # and over HTTP
    rig.post("/v1/portfolio", {"intakes": [INTAKE] * 4}, key=key)
    assert [e["units"] for e in rig.events()] == [6, 4]


def test_an_mcp_tool_over_the_cap_is_a_json_rpc_402(rig):
    key = rig.key("trial", quota=1, account="free1")
    call = {"jsonrpc": "2.0", "id": 1, "method": "tools/call",
            "params": {"name": "gridforge_screen", "arguments": {"intake": INTAKE}}}
    rig.post("/mcp", call, key=key)
    _, b, _ = rig.post("/mcp", call, key=key)
    assert b["error"]["code"] == -32002
    assert b["error"]["data"]["plan"] == "api_free" and b["error"]["data"]["fix"]


def test_an_mcp_batch_of_two_paid_calls_is_two_ledger_charges(rig):
    key = rig.key("payg", quota=50)
    one = {"jsonrpc": "2.0", "method": "tools/call",
           "params": {"name": "gridforge_screen", "arguments": {"intake": INTAKE}}}
    s, b, h = rig.post("/mcp", [dict(one, id=1), dict(one, id=2)], key=key)
    assert s == 200 and len(b) == 2 and all("error" not in r for r in b)
    assert [e["units"] for e in rig.events()] == [1, 1] and h["X-GridForge-Charge-Cents"] == "400"
