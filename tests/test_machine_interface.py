"""The engine as something another machine buys.

The next customer is not a person filling in a form; it is a portfolio tool, an
underwriting model or an agent calling this API in a loop. Three things have to be
true for that customer to exist, and each is tested here:

  1. It can discover what it can call, and what each call costs, before calling.
  2. It is billed in units it can reconcile, and refused in a way it can act on —
     402 means buy more, 429 means retry, and an agent told the wrong one will
     hammer an endpoint it can never afford.
  3. Every answer carries its evidence class and its calibration state, because a
     modelled figure loose inside an agent loop is more dangerous than one in a
     board pack, not less.
"""
import json
import os
import threading
import urllib.error
import urllib.request

import pytest

from gridforge.api.metering import KeyPlan, Meter, UNIT_COST, units_for
from gridforge.api.server import Handler, VERSION, make_server
from gridforge.api.tools import TOOLS, TOOLS_BY_NAME, catalogue, mcp_tools, openai_tools

KEY = "sk_machine_test"
QUOTA = 12


@pytest.fixture(scope="module")
def server():
    os.environ["GRIDFORGE_API_KEYS"] = f"{KEY}:testaccount:{QUOTA}"
    os.environ["GRIDFORGE_RATE_LIMIT"] = "0"
    Handler.limiter.per_minute = 0
    httpd = make_server("127.0.0.1", 0)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{httpd.server_address[1]}"
    httpd.shutdown()
    os.environ.pop("GRIDFORGE_API_KEYS", None)


def call(base, path, body=None, key=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(f"{base}{path}", data=data,
                                 method="POST" if data is not None else "GET")
    if data is not None:
        req.add_header("Content-Type", "application/json")
    if key:
        req.add_header("X-API-Key", key)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, json.loads(r.read() or b"{}"), dict(r.headers)
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}"), dict(e.headers)


def rpc(base, method, params=None, key=KEY, rpc_id=1):
    body = {"jsonrpc": "2.0", "method": method}
    if rpc_id is not None:
        body["id"] = rpc_id
    if params is not None:
        body["params"] = params
    return call(base, "/mcp", body, key=key)


QUALIFY_ARGS = {
    "contracted_MW": 12, "current_site_peak_MW": 7.4, "current_it_load_MW": 4.9,
    "busway_ampacity_A": 400, "tapoff_max_A": 63, "plant_supply_C": 6,
    "positions_available": 180,
}


# --- discovery -------------------------------------------------------------

def test_every_tool_is_callable_and_priced():
    for t in TOOLS:
        assert t["endpoint"] in UNIT_COST, f"{t['name']} has no published unit rate"
        assert t["units"] == UNIT_COST[t["endpoint"]]
        assert t["inputSchema"]["type"] == "object"
        assert t["description"].strip() and len(t["description"]) > 40
        assert t["returns"], f"{t['name']} does not say what it returns"


def test_the_schemas_are_valid_in_both_dialects():
    for f in openai_tools():
        assert f["type"] == "function"
        assert f["function"]["parameters"]["type"] == "object"
    for m in mcp_tools():
        assert set(m) >= {"name", "description", "inputSchema"}
        assert m["_meta"]["gridforge/units"] >= 0


def test_the_catalogue_warns_a_machine_about_evidence_class():
    """An agent will happily write an E0 figure into a model as though it were
    surveyed. The catalogue has to say so where an integrator will read it."""
    c = catalogue()
    note = c["evidence_note"].lower()
    assert "evidence class" in note
    assert "must not present" in note
    assert "calibration" in note


def test_tools_and_calibration_are_public(server):
    status, body, _ = call(server, "/v1/tools")
    assert status == 200
    assert {t["name"] for t in body["tools"]} == set(TOOLS_BY_NAME)
    assert body["mcp"]["endpoint"] == "/mcp"
    status, body, _ = call(server, "/v1/calibration")
    assert status == 200
    assert body["state"] == "uncalibrated"
    assert body["keys_asserted"] > 10


def test_version_publishes_the_rate_card(server):
    status, body, _ = call(server, "/v1/version")
    assert status == 200
    assert body["version"] == VERSION
    assert body["unit_rates"]["/v1/study"] == 5
    assert body["unit_rates"]["/v1/qualify"] == 0, "the free tier must bill zero"
    assert body["metering"]["over_quota_status"] == 402
    assert body["machine_interface"]["mcp"] == "/mcp"


# --- metering --------------------------------------------------------------

def test_units_scale_with_the_work_not_the_call_count():
    assert units_for("/v1/qualify") == 0
    assert units_for("/v1/study") > units_for("/v1/screen")
    assert units_for("/v1/portfolio", {"intakes": [{}] * 40}) == 40
    assert units_for("/v1/portfolio", {"intakes": []}) == 1


def test_key_plan_parses_all_three_forms_so_old_deployments_keep_working():
    assert KeyPlan.parse("sk_a").key == "sk_a"
    assert KeyPlan.parse("sk_a").monthly_quota == 0
    assert KeyPlan.parse("sk_a:acme").label == "acme"
    p = KeyPlan.parse("sk_a:acme:5000")
    assert (p.key, p.label, p.monthly_quota) == ("sk_a", "acme", 5000)
    assert KeyPlan.parse("  ") is None
    assert KeyPlan.parse("sk_a:acme:nonsense").monthly_quota == 0


def test_a_metering_failure_never_costs_the_caller_their_answer(tmp_path):
    """Losing an invoice line is survivable. Losing a customer's answer over an
    accounting problem is not."""
    bad = tmp_path / "nope" / "usage.json"
    bad.parent.mkdir()
    bad.write_text("{ not json")
    m = Meter(str(bad))
    assert m.current("k").units == 0
    m.record("k", "/v1/study", 5)
    assert m.current("k").units == 5


def test_usage_is_durable_when_a_file_is_configured(tmp_path):
    p = tmp_path / "usage.json"
    Meter(str(p)).record("k", "/v1/study", 5)
    again = Meter(str(p))
    assert again.current("k").units == 5
    assert again.durable is True
    assert Meter(None).durable is False


def test_an_in_memory_meter_says_it_is_not_billable():
    s = Meter(None).statement(None)
    assert s["durable"] is False
    assert "not durable" in s["note"]


def test_a_usage_path_that_cannot_be_written_is_reported_not_assumed():
    """GRIDFORGE_USAGE_FILE=/data/usage.json on a machine with no volume mounted
    looks identical to a working configuration until the first invoice."""
    m = Meter("/proc/definitely/not/writable/usage.json")
    assert m.durable is False
    note = m.statement(None)["note"]
    assert "not writable" in note
    assert "volume" in note


def test_calls_are_metered_and_reported(server):
    status, body, headers = call(server, "/v1/qualify", QUALIFY_ARGS)
    assert status == 200
    assert "X-GridForge-Units" not in headers, "the free tier must not meter"

    status, body, headers = call(server, "/v1/screen", {"intake": {"grid": {"contracted_MW": 12}}},
                                 key=KEY)
    assert status == 200
    assert headers["X-GridForge-Units"] == "1"
    used = int(headers["X-GridForge-Units-Month"])

    status, body, headers = call(server, "/v1/usage", key=KEY)
    assert status == 200
    assert body["units"] == used
    assert body["monthly_quota"] == QUOTA
    assert body["account"] == "testaccount"
    assert KEY not in json.dumps(body), "the usage statement echoed the key back"


def test_usage_needs_a_key(server):
    status, _, _ = call(server, "/v1/usage")
    assert status == 401


def test_over_quota_is_402_not_429(server):
    """They mean different things to a machine. 429 says retry; 402 says buy more.
    An agent told to retry a call it can never afford will retry it forever."""
    body = {"intake": {"grid": {"contracted_MW": 12}, "lv": {"busway_ampacity_A": 400}}}
    last = None
    for _ in range(20):
        status, payload, _ = call(server, "/v1/study", body, key=KEY)
        last = (status, payload)
        if status == 402:
            break
    assert last[0] == 402, "the quota never bit"
    assert "quota" in last[1]["error"]
    assert last[1]["units_required"] > 0
    assert last[1]["fix"]


# --- MCP -------------------------------------------------------------------

def test_mcp_requires_a_key(server):
    status, body, _ = call(server, "/mcp", {"jsonrpc": "2.0", "id": 1, "method": "initialize"})
    assert status == 401
    assert body["tool_schemas"] == "/v1/tools"


def test_mcp_handshake(server):
    status, body, _ = rpc(server, "initialize", {})
    assert status == 200
    r = body["result"]
    assert r["serverInfo"]["name"] == "gridforge"
    assert r["protocolVersion"]
    assert "evidence class" in r["instructions"].lower()
    assert "modelled" in r["instructions"].lower()


def test_mcp_lists_the_same_tools_as_the_catalogue(server):
    status, body, _ = rpc(server, "tools/list")
    assert status == 200
    assert {t["name"] for t in body["result"]["tools"]} == set(TOOLS_BY_NAME)


def test_mcp_notification_gets_no_body(server):
    status, body, _ = call(server, "/mcp",
                           {"jsonrpc": "2.0", "method": "notifications/initialized"}, key=KEY)
    assert status == 202
    assert body == {}


def test_mcp_unknown_method_is_a_jsonrpc_error_not_a_500(server):
    status, body, _ = rpc(server, "does/not/exist")
    assert status == 200
    assert body["error"]["code"] == -32601


def test_mcp_unknown_tool_names_the_ones_that_exist(server):
    status, body, _ = rpc(server, "tools/call", {"name": "gridforge_invent", "arguments": {}})
    assert body["error"]["code"] == -32602
    assert "gridforge_qualify" in body["error"]["data"]["available"]


def test_mcp_tool_call_returns_text_and_structure(server):
    status, body, _ = rpc(server, "tools/call",
                          {"name": "gridforge_qualify", "arguments": QUALIFY_ARGS})
    assert status == 200
    r = body["result"]
    assert r["isError"] is False
    text = r["content"][0]["text"]
    assert "binds first on" in text.lower()
    assert "calibration" in text.lower(), (
        "the one-line summary an agent reads must carry the calibration state")
    payload = r["structuredContent"]
    assert payload["as_found"]["binding_constraint"]
    assert payload["calibration"]["state"] == "uncalibrated"


def test_mcp_leaks_no_priced_content_to_an_agent_on_the_free_tool(server):
    status, body, _ = rpc(server, "tools/call",
                          {"name": "gridforge_qualify", "arguments": QUALIFY_ARGS})
    blob = json.dumps(body)
    assert "EUR" not in blob and "capex" not in blob


def test_mcp_batch_is_answered_as_a_batch(server):
    status, body, _ = call(server, "/mcp", [
        {"jsonrpc": "2.0", "id": "a", "method": "ping"},
        {"jsonrpc": "2.0", "method": "notifications/initialized"},
        {"jsonrpc": "2.0", "id": "b", "method": "tools/list"},
    ], key=KEY)
    assert status == 200
    assert isinstance(body, list)
    assert [m["id"] for m in body] == ["a", "b"], "the notification must not get a reply"


def test_mcp_malformed_params_do_not_500(server):
    status, body, _ = rpc(server, "tools/call", {"name": "gridforge_study", "arguments": "oops"})
    assert status == 200
    assert body["error"]["code"] == -32602


# --- self-serve keys, end to end -------------------------------------------

@pytest.fixture(scope="module")
def selfserve():
    """A deployment that holds no keys at all, only the secret to verify them.

    This is what a self-serve deployment actually looks like: every key was issued
    by the website and the engine has never seen any of them.
    """
    import threading as _t
    from gridforge.api.server import make_server as _mk
    old_keys = os.environ.pop("GRIDFORGE_API_KEYS", None)
    os.environ["GRIDFORGE_KEY_SECRET"] = "selfserve-test-secret"
    os.environ["GRIDFORGE_RATE_LIMIT"] = "0"
    Handler.limiter.per_minute = 0
    httpd = _mk("127.0.0.1", 0)
    _t.Thread(target=httpd.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{httpd.server_address[1]}"
    httpd.shutdown()
    os.environ.pop("GRIDFORGE_KEY_SECRET", None)
    if old_keys is not None:
        os.environ["GRIDFORGE_API_KEYS"] = old_keys


def test_a_key_the_engine_has_never_seen_works(selfserve):
    from gridforge.api.keys import issue
    token = issue("selfserve-acme", quota=50)
    status, body, headers = call(selfserve, "/v1/screen",
                                 {"intake": {"grid": {"contracted_MW": 12}}}, key=token)
    assert status == 200, body
    assert headers["X-GridForge-Units"] == "1"
    assert "X-GridForge-Key-Expires" in headers
    status, usage, _ = call(selfserve, "/v1/usage", key=token)
    assert usage["account"] == "selfserve-acme"
    assert usage["monthly_quota"] == 50
    assert usage["scope"] == "machine"


def test_an_expired_key_is_told_why(selfserve):
    from datetime import date, timedelta
    from gridforge.api.keys import issue
    dead = issue("lapsed", quota=50, days=1,
                 issued_on=date.today() - timedelta(days=30))
    status, body, _ = call(selfserve, "/v1/screen", {"intake": {}}, key=dead)
    assert status == 401
    assert "expired" in body["error"]
    assert body["public_endpoint"] == "/v1/qualify"


def test_paid_endpoints_are_enabled_by_the_secret_alone(selfserve):
    """With no GRIDFORGE_API_KEYS at all, the deployment must still be configured —
    otherwise a self-serve engine reports itself broken and returns 503."""
    status, body, _ = call(selfserve, "/v1/version")
    assert body["auth_configured"] is True
    assert body["signed_keys"] is True
    status, body, _ = call(selfserve, "/v1/screen", {"intake": {}})
    assert status == 401, "an unconfigured 503 would be wrong here"


def test_rotating_a_key_does_not_reset_the_allowance(selfserve):
    from gridforge.api.keys import issue
    a = issue("rotator", quota=4)
    b = issue("rotator", quota=4)
    assert a != b
    assert call(selfserve, "/v1/screen", {"intake": {}}, key=a)[0] == 200
    assert call(selfserve, "/v1/screen", {"intake": {}}, key=b)[0] == 200
    status, body, _ = call(selfserve, "/v1/usage", key=b)
    assert body["units"] == 2, "usage did not follow the account across a rotation"
