"""REST / MCP parity: every MCP tool is the same commercial gate as the REST route it fronts.

The engine has two doors onto the same handlers: `POST /v1/<route>` and `POST /mcp` `tools/call`. They are separate code paths for tier
checks, metering, idempotency and refunds (`_do_post` vs `_mcp_call_tool`). If they drift, one door is the cheaper or the more open one, and an
agent will find it. These tests call the REAL handlers over a real socket (tests/payg_rig.py: real keys, a real ledger file, no mocks of
the engine) and compare what each door does, route by route.

Labels: nothing here touches Stripe or a payment provider; keys are signed locally with a test secret.
"""
from __future__ import annotations

import json

import pytest

from gridforge.api import keys as K
from gridforge.api import server as S
from gridforge.api.metering import UNIT_COST
from gridforge.api.tiers import PUBLIC_REDACTED_KEYS, Tier
from gridforge.api.tools import TOOLS, TOOLS_BY_NAME, catalogue, rate_card
from payg_rig import INTAKE, rig  # noqa: F401  (rig is a fixture)
from test_project_record_engine import ARCH, REQUEST

#: Routes that are priced and routed but deliberately not agent tools (gridforge/api/tools.py: a human walkthrough).
ROUTES_WITHOUT_A_TOOL = {"/v1/deck"}

#: A body each priced route accepts, and the units it must cost. Bids need real supplier responses, so its VALID call is not built here: its
#: refused call (422, refunded) is compared instead, like every route's failing call below.
VALID: dict[str, dict] = {
    "/v1/screen": {"intake": INTAKE},
    "/v1/compare": {"intake": INTAKE},
    "/v1/study": {"intake": INTAKE},
    "/v1/portfolio": {"intakes": [INTAKE]},
    "/v1/proposal": {"intake": INTAKE},
    "/v1/diff": {"before": INTAKE, "after": INTAKE},
    "/v1/spec": {"intake": INTAKE},
    "/v1/power/assess": {"intake": INTAKE, "target_racks": 100},
    "/v1/power/deploy/assess": REQUEST,
    "/v1/power/deploy/spec": {**REQUEST, "architecture": ARCH},
}

#: Added by the HTTP layer to every REST body; the MCP result is wrapped in JSON-RPC instead.
ENVELOPE = {"schema_version"}

CLIENT_TOOLS = [t for t in TOOLS if t["tier"] == "client"]
CLIENT_IDS = [t["name"] for t in CLIENT_TOOLS]


def rpc(name: str, arguments, i: int = 1) -> dict:
    return {"jsonrpc": "2.0", "id": i, "method": "tools/call", "params": {"name": name, "arguments": arguments}}


def mcp_call(rig, tool_name: str, args, **kw):
    """-> (http status, JSON-RPC envelope, headers)."""
    return rig.post("/mcp", rpc(tool_name, args), **kw)


def tool_for(endpoint: str) -> dict:
    return next(t for t in TOOLS if t["endpoint"] == endpoint)


def revoke(rig, key: str) -> None:
    """Revoke through the engine's own deny-list (GRIDFORGE_REVOKED_KEYS, read on every verification), as test_api_keys.py does."""
    rig.monkeypatch.setenv("GRIDFORGE_REVOKED_KEYS", K.verify(key).key_id)


def kinds(rig) -> list[str]:
    return [e["kind"] for e in rig.events()]


def net_units(rig, account: str) -> int:
    return rig.meter.current(account).units


def keys_in(value, found: set | None = None) -> set:
    found = set() if found is None else found
    if isinstance(value, dict):
        for k, v in value.items():
            found.add(k)
            keys_in(v, found)
    elif isinstance(value, list):
        for v in value:
            keys_in(v, found)
    return found


# ---------------------------------------------------------------------------------------------------------------------
# 1. The two doors list the same things, at the same tier and the same price
# ---------------------------------------------------------------------------------------------------------------------
class TestTheTwoDoorsAgreeOnThePriceList:
    def test_every_routed_endpoint_has_a_tool_except_the_documented_ones(self):
        tooled = {t["endpoint"] for t in TOOLS}
        public_or_client = {r for r, (_, tier) in S.ROUTES.items() if tier is not Tier.INTERNAL}
        assert public_or_client - tooled == ROUTES_WITHOUT_A_TOOL
        assert tooled - set(S.ROUTES) == set(), "a tool points at a route that does not exist"

    def test_the_operator_route_is_never_an_agent_tool(self):
        assert S.ROUTES["/v1/revoke"][1] is Tier.INTERNAL
        assert "/v1/revoke" not in {t["endpoint"] for t in TOOLS}
        assert "gridforge_revoke" not in TOOLS_BY_NAME

    def test_tool_names_are_unique_and_one_per_endpoint(self):
        assert len(TOOLS_BY_NAME) == len(TOOLS)
        assert len({t["endpoint"] for t in TOOLS}) == len(TOOLS)

    @pytest.mark.parametrize("tool", TOOLS, ids=[t["name"] for t in TOOLS])
    def test_a_tool_declares_the_tier_and_units_of_its_route(self, tool):
        handler, route_tier = S.ROUTES[tool["endpoint"]]
        assert tool["tier"] == route_tier.value
        assert tool["units"] == UNIT_COST.get(tool["endpoint"], 1)

    def test_every_published_listing_carries_the_same_prices(self):
        cat = catalogue()
        listed = {t["name"]: (t["tier"], t["units"], t["endpoint"]) for t in cat["tools"]}
        mcp = {t["name"]: (t["_meta"]["gridforge/tier"], t["_meta"]["gridforge/units"], t["_meta"]["gridforge/endpoint"]) for t in cat["mcp"]["tools"]}
        assert listed == mcp == {t["name"]: (t["tier"], t["units"], t["endpoint"]) for t in TOOLS}
        assert {r["endpoint"]: r["units"] for r in rate_card()} == dict(UNIT_COST)

    def test_every_valid_body_in_this_file_is_for_a_priced_client_route(self):
        assert set(VALID) <= {t["endpoint"] for t in CLIENT_TOOLS}


# ---------------------------------------------------------------------------------------------------------------------
# 2. Tier: a caller without a usable key cannot reach a paid tool by either door, and is never charged
# ---------------------------------------------------------------------------------------------------------------------
class TestAPublicCallerCannotReachPaidWork:
    @pytest.mark.parametrize("tool", CLIENT_TOOLS, ids=CLIENT_IDS)
    def test_no_key_is_refused_on_both_doors_and_nothing_is_recorded(self, rig, tool):
        body = VALID.get(tool["endpoint"], {})
        s, rest_body, _ = rig.post(tool["endpoint"], body)
        assert s == 401 and rest_body["public_endpoint"] == "/v1/qualify"
        s, env, _ = mcp_call(rig, tool["name"], body)
        assert s == 200 and env["error"]["code"] == -32001, env
        assert "requires an API key" in env["error"]["message"]
        assert env["error"]["data"]["free_tool"] == "gridforge_qualify"
        assert "result" not in env
        assert rig.events() == []

    @pytest.mark.parametrize("bad", ["not-a-key", "gf_" + "a" * 40, "sk_forged.value"])
    def test_a_made_up_key_is_a_public_caller_on_both_doors(self, rig, bad):
        s, _, _ = rig.post("/v1/screen", {"intake": INTAKE}, key=bad)
        _, env, _ = mcp_call(rig, "gridforge_screen", {"intake": INTAKE}, key=bad)
        assert s == 401 and env["error"]["code"] == -32001
        assert rig.events() == []

    def test_a_public_caller_gets_no_paid_field_from_the_free_tool_by_either_door(self, rig):
        """gridforge_qualify is free on both doors; whichever door asked, the paid keys are stripped at every depth."""
        args = {"contracted_MW": 12, "current_site_peak_MW": 6, "busway_ampacity_A": 1600, "tapoff_max_A": 400}
        s, rest_body, _ = rig.post("/v1/qualify", args)
        assert s == 200
        _, env, _ = mcp_call(rig, "gridforge_qualify", args)
        mcp_body = env["result"]["structuredContent"]
        for payload in (rest_body, mcp_body):
            leaked = keys_in(payload) & PUBLIC_REDACTED_KEYS
            assert not leaked, f"paid fields reached a PUBLIC caller: {sorted(leaked)}"
        assert keys_in(rest_body) - ENVELOPE == keys_in(mcp_body), "the two doors answer a public caller with different shapes"
        assert rig.events() == [], "the free tool is never metered"

    def test_a_public_mcp_caller_cannot_get_paid_fields_by_smuggling_a_tier_argument(self, rig):
        args = {"contracted_MW": 12, "current_site_peak_MW": 6, "busway_ampacity_A": 1600, "tapoff_max_A": 400}
        for extra in ({"tier": "client"}, {"tier": "internal"}, {"include_paid": True}, {"api_key": "x"}):
            _, env, _ = mcp_call(rig, "gridforge_qualify", {**args, **extra})
            assert "error" in env or not (keys_in(env["result"]["structuredContent"]) & PUBLIC_REDACTED_KEYS), extra

    def test_a_public_mcp_caller_cannot_use_the_estimator_to_spend(self, rig):
        _, env, _ = mcp_call(rig, "gridforge_estimate", {"endpoint": "/v1/study"})
        assert env["result"]["structuredContent"]["units"] == UNIT_COST["/v1/study"]
        assert rig.events() == []

    def test_a_keyed_caller_gets_the_paid_content_on_both_doors(self, rig):
        key = rig.key("payg", quota=50)
        s, rest_body, _ = rig.post("/v1/screen", {"intake": INTAKE}, key=key)
        _, env, _ = mcp_call(rig, "gridforge_screen", {"intake": INTAKE}, key=key)
        assert s == 200 and "result" in env
        assert keys_in(rest_body) & PUBLIC_REDACTED_KEYS, "the paid answer must actually carry the paid fields (else the redaction test proves nothing)"
        assert keys_in(rest_body) - ENVELOPE == keys_in(env["result"]["structuredContent"])


# ---------------------------------------------------------------------------------------------------------------------
# 3. Metering: the same call costs the same units, once, by either door
# ---------------------------------------------------------------------------------------------------------------------
class TestAClientKeyIsMeteredOnceAtTheRoutesPrice:
    @pytest.mark.parametrize("endpoint", sorted(VALID))
    def test_rest_and_mcp_record_the_same_charge(self, rig, endpoint):
        tool = tool_for(endpoint)
        units = UNIT_COST[endpoint]
        a, b = rig.key("payg", quota=500, account="via-rest"), rig.key("payg", quota=500, account="via-mcp")
        s, _, rest_h = rig.post(endpoint, VALID[endpoint], key=a)
        assert s == 200, endpoint
        s, env, mcp_h = mcp_call(rig, tool["name"], VALID[endpoint], key=b)
        assert s == 200 and "result" in env, env
        assert rest_h["X-GridForge-Units"] == mcp_h["X-GridForge-Units"] == str(units)
        assert rest_h["X-GridForge-Charge-Cents"] == mcp_h["X-GridForge-Charge-Cents"]
        charges = [e for e in rig.events() if e["kind"] == "charge"]
        assert sorted((e["account"], e["endpoint"], e["units"]) for e in charges) == sorted(
            [("via-rest", endpoint, units), ("via-mcp", endpoint, units)])
        assert net_units(rig, "via-rest") == net_units(rig, "via-mcp") == units
        assert kinds(rig).count("refund") == 0

    @pytest.mark.parametrize("tool", CLIENT_TOOLS, ids=CLIENT_IDS)
    def test_a_refused_request_is_charged_then_refunded_identically_on_both_doors(self, rig, tool):
        """An empty body is invalid for every paid route: both doors reserve, fail, and refund: net zero, same ledger shape."""
        a, b = rig.key("payg", quota=500, account="via-rest"), rig.key("payg", quota=500, account="via-mcp")
        s, _, _ = rig.post(tool["endpoint"], {}, key=a)
        assert s in (400, 422), (tool["endpoint"], s)
        _, env, _ = mcp_call(rig, tool["name"], {}, key=b)
        assert "error" in env and env["error"]["code"] == -32602, env
        for account in ("via-rest", "via-mcp"):
            assert net_units(rig, account) == 0
            mine = [e["kind"] for e in rig.events() if e["account"] == account]
            assert mine == ["charge", "refund"], (account, mine)

    def test_a_client_key_is_metered_once_per_mcp_call_not_per_layer(self, rig):
        key = rig.key("payg", quota=50)
        s, env, h = mcp_call(rig, "gridforge_study", {"intake": INTAKE}, key=key)
        assert s == 200 and "result" in env
        assert kinds(rig) == ["charge"]
        assert rig.events()[0]["units"] == UNIT_COST["/v1/study"] == int(h["X-GridForge-Units"])
        assert net_units(rig, "acme") == 5

    def test_an_mcp_batch_charges_every_call_exactly_once(self, rig):
        key = rig.key("payg", quota=50)
        batch = [rpc("gridforge_screen", {"intake": INTAKE}, 1), rpc("gridforge_study", {"intake": INTAKE}, 2),
                 rpc("gridforge_estimate", {"endpoint": "/v1/study"}, 3)]
        s, out, _ = rig.post("/mcp", batch, key=key)
        assert s == 200 and all("result" in r for r in out)
        assert sorted(e["units"] for e in rig.events() if e["kind"] == "charge") == [1, 5]
        assert net_units(rig, "acme") == 6

    def test_a_portfolio_is_priced_per_hall_on_both_doors(self, rig):
        a = rig.key("payg", quota=500, account="r")
        b = rig.key("payg", quota=500, account="m")
        second = {"site": {"id": "SITE-2"}, "grid": {"contracted_MW": 9, "firm_capacity_MVA": 9}}
        body = {"intakes": [INTAKE, second]}
        s1, _, h1 = rig.post("/v1/portfolio", body, key=a)
        s2, env, h2 = mcp_call(rig, "gridforge_portfolio", body, key=b)
        assert s1 == 200 and "result" in env, (s1, env)
        assert h1["X-GridForge-Units"] == h2["X-GridForge-Units"] == "2"
        assert net_units(rig, "r") == net_units(rig, "m") == 2

    def test_the_cap_stops_both_doors_at_the_same_point(self, rig):
        """A cap of 5 units: one study fits, a second does not, whichever door asks. The refusal charges nothing."""
        a, b = rig.key("payg", quota=5, account="r"), rig.key("payg", quota=5, account="m")
        assert rig.post("/v1/study", {"intake": INTAKE}, key=a)[0] == 200
        assert mcp_call(rig, "gridforge_study", {"intake": INTAKE}, key=b)[1].get("result")
        s, over, _ = rig.post("/v1/study", {"intake": INTAKE}, key=a)
        assert s == 402 and over["error"] == "monthly unit quota exhausted"
        _, env, _ = mcp_call(rig, "gridforge_study", {"intake": INTAKE}, key=b)
        assert env["error"]["code"] == -32002 and env["error"]["data"]["error"] == over["error"]
        assert env["error"]["data"]["units_required"] == over["units_required"] == 5
        assert net_units(rig, "r") == net_units(rig, "m") == 5

    def test_the_free_tools_are_never_metered_with_a_key_either(self, rig):
        key = rig.key("payg", quota=50)
        args = {"contracted_MW": 12, "current_site_peak_MW": 6, "busway_ampacity_A": 1600, "tapoff_max_A": 400}
        assert rig.post("/v1/qualify", args, key=key)[0] == 200
        assert "result" in mcp_call(rig, "gridforge_qualify", args, key=key)[1]
        assert "result" in mcp_call(rig, "gridforge_estimate", {"endpoint": "/v1/study"}, key=key)[1]
        assert rig.events() == []


# ---------------------------------------------------------------------------------------------------------------------
# 4. Idempotency: a retry is free and identical on both doors; the key cannot be reused for a different request
# ---------------------------------------------------------------------------------------------------------------------
class TestIdempotencyIsTheSameOnBothDoors:
    H = {"Idempotency-Key": "parity-run-1"}

    def test_a_retry_is_charged_once_and_answered_identically(self, rig):
        a, b = rig.key("payg", quota=50, account="r"), rig.key("payg", quota=50, account="m")
        s1, r1, _ = rig.post("/v1/screen", {"intake": INTAKE}, key=a, headers=self.H)
        s2, r2, h2 = rig.post("/v1/screen", {"intake": INTAKE}, key=a, headers=self.H)
        assert s1 == s2 == 200 and r1 == r2 and h2["X-GridForge-Idempotent-Replay"] == "true" and h2["X-GridForge-Charge-Cents"] == "0"
        _, m1, _ = mcp_call(rig, "gridforge_screen", {"intake": INTAKE}, key=b, headers=self.H)
        _, m2, h4 = mcp_call(rig, "gridforge_screen", {"intake": INTAKE}, key=b, headers=self.H)
        assert m1["result"] == m2["result"] and h4["X-GridForge-Idempotent-Replay"] == "true" and h4["X-GridForge-Charge-Cents"] == "0"
        assert net_units(rig, "r") == net_units(rig, "m") == 1
        assert kinds(rig).count("charge") == 2

    @pytest.mark.parametrize("restart", [False, True])
    def test_reusing_the_key_for_another_request_is_refused_on_both_doors_and_charges_nothing(self, rig, restart):
        other = {"grid": {"contracted_MW": 9, "firm_capacity_MVA": 9}}
        a, b = rig.key("payg", quota=50, account="r"), rig.key("payg", quota=50, account="m")
        rig.post("/v1/screen", {"intake": INTAKE}, key=a, headers=self.H)
        mcp_call(rig, "gridforge_screen", {"intake": INTAKE}, key=b, headers=self.H)
        if restart:
            rig.restart()
        s, body, _ = rig.post("/v1/screen", {"intake": other}, key=a, headers=self.H)
        assert s == 422 and "Idempotency-Key" in body["error"] or "different request body" in body["error"]
        _, env, _ = mcp_call(rig, "gridforge_screen", {"intake": other}, key=b, headers=self.H)
        assert env["error"]["code"] == -32602 and "different request body" in env["error"]["message"]
        assert net_units(rig, "r") == net_units(rig, "m") == 1

    def test_the_key_is_scoped_to_the_account_on_both_doors(self, rig):
        a, b = rig.key("payg", quota=50, account="acme"), rig.key("payg", quota=50, account="globex")
        rig.post("/v1/screen", {"intake": INTAKE}, key=a, headers=self.H)
        s, _, h = rig.post("/v1/screen", {"intake": INTAKE}, key=b, headers=self.H)
        assert s == 200 and "X-GridForge-Idempotent-Replay" not in h
        _, env, h = mcp_call(rig, "gridforge_screen", {"intake": INTAKE}, key=b, headers={"Idempotency-Key": "other"})
        assert "result" in env
        assert net_units(rig, "acme") == 1 and net_units(rig, "globex") == 2

    def test_an_overlong_key_is_refused_on_both_doors_before_any_charge(self, rig):
        key = rig.key("payg", quota=50)
        long = {"Idempotency-Key": "k" * 201}
        s, body, _ = rig.post("/v1/screen", {"intake": INTAKE}, key=key, headers=long)
        assert s == 400 and "150" in body["error"]
        _, env, _ = mcp_call(rig, "gridforge_screen", {"intake": INTAKE}, key=key, headers=long)
        assert env["error"]["code"] == -32602 and "150" in env["error"]["message"]
        assert rig.events() == []

    def test_a_failed_call_releases_the_key_on_both_doors(self, rig):
        key = rig.key("payg", quota=50)
        h = {"Idempotency-Key": "retry-after-failure"}
        assert rig.post("/v1/screen", {}, key=key, headers=h)[0] in (400, 422)
        assert mcp_call(rig, "gridforge_screen", {}, key=key, headers=h)[1]["error"]
        assert rig.post("/v1/screen", {"intake": INTAKE}, key=key, headers=h)[0] == 200
        assert net_units(rig, "acme") == 1

    def test_the_header_does_nothing_for_the_estimator_or_without_a_key_on_both_doors(self, rig):
        for _ in range(2):
            assert rig.post("/v1/estimate", {"endpoint": "/v1/study"}, headers=self.H)[0] == 200
            assert "result" in mcp_call(rig, "gridforge_estimate", {"endpoint": "/v1/study"}, headers=self.H)[1]
        assert rig.events() == []


# ---------------------------------------------------------------------------------------------------------------------
# 5. A revoked key is refused on both doors, immediately, and a refusal records nothing
# ---------------------------------------------------------------------------------------------------------------------
class TestARevokedKeyIsRefusedEverywhere:
    @pytest.fixture
    def revoked(self, rig):
        key = rig.key("payg", quota=50)
        assert rig.post("/v1/screen", {"intake": INTAKE}, key=key)[0] == 200, "the key works before revocation"
        assert "result" in mcp_call(rig, "gridforge_screen", {"intake": INTAKE}, key=key)[1]
        before = list(rig.events())
        revoke(rig, key)
        return key, before

    @pytest.mark.parametrize("tool", CLIENT_TOOLS, ids=CLIENT_IDS)
    def test_refused_on_rest_and_mcp_with_no_new_ledger_event(self, rig, revoked, tool):
        key, before = revoked
        body = VALID.get(tool["endpoint"], {})
        s, rest_body, _ = rig.post(tool["endpoint"], body, key=key)
        assert s == 401 and "revoked" in rest_body["error"]
        _, env, _ = mcp_call(rig, tool["name"], body, key=key)
        assert env["error"]["code"] == -32001 and "result" not in env
        assert rig.events() == before

    def test_usage_and_a_replay_of_an_earlier_idempotent_call_are_refused_too(self, rig):
        key = rig.key("payg", quota=50)
        h = {"Idempotency-Key": "pre-revocation"}
        assert rig.post("/v1/screen", {"intake": INTAKE}, key=key, headers=h)[0] == 200
        revoke(rig, key)
        assert rig.get("/v1/usage", key=key)[0] == 401
        s, body, hdr = rig.post("/v1/screen", {"intake": INTAKE}, key=key, headers=h)
        assert s == 401 and "X-GridForge-Idempotent-Replay" not in hdr, "a revoked key must not read back its cached paid answer"
        _, env, _ = mcp_call(rig, "gridforge_screen", {"intake": INTAKE}, key=key, headers=h)
        assert env["error"]["code"] == -32001 and "result" not in env

    def test_the_other_account_key_is_untouched_by_a_revocation(self, rig):
        dead, live = rig.key("payg", account="a"), rig.key("payg", account="b")
        revoke(rig, dead)
        assert rig.post("/v1/screen", {"intake": INTAKE}, key=dead)[0] == 401
        assert rig.post("/v1/screen", {"intake": INTAKE}, key=live)[0] == 200
        assert "result" in mcp_call(rig, "gridforge_screen", {"intake": INTAKE}, key=live)[1]


# ---------------------------------------------------------------------------------------------------------------------
# 6. Tenancy: no door reads or writes another account's usage, and the operator surface is not reachable from a client key
# ---------------------------------------------------------------------------------------------------------------------
class TestNoCrossTenantAccess:
    def test_usage_is_the_callers_own_and_cannot_be_redirected(self, rig):
        a, b = rig.key("payg", quota=50, account="acme"), rig.key("payg", quota=50, account="globex")
        rig.post("/v1/study", {"intake": INTAKE}, key=a)
        s, mine, _ = rig.get("/v1/usage", key=b)
        assert s == 200 and mine["account"] == "globex" and mine["units"] == 0 and mine["calls"] == 0
        for q in ("?account=acme", "?account=acme&key=" + a, "?tenant=acme", "?account=%2A"):
            s, body, _ = rig.get("/v1/usage" + q, key=b)
            assert s == 200 and body["account"] == "globex" and body["units"] == 0 and body["by_endpoint"] == {}, q
        s, theirs, _ = rig.get("/v1/usage", key=a)
        assert theirs["account"] == "acme" and theirs["units"] == 5

    def test_usage_needs_a_key(self, rig):
        assert rig.get("/v1/usage")[0] == 401
        assert rig.get("/v1/usage", key="garbage")[0] == 401

    def test_no_mcp_tool_reads_usage_or_the_ledger(self):
        assert not [t for t in TOOLS if "usage" in t["endpoint"] or "ledger" in t["endpoint"] or "admin" in t["endpoint"]]
        assert "/v1/usage" not in {t["endpoint"] for t in TOOLS}

    @pytest.mark.parametrize("name", ["gridforge_usage", "gridforge_revoke", "gridforge_admin_ledger", "../v1/usage"])
    def test_a_tool_that_does_not_exist_is_an_error_not_a_back_door(self, rig, name):
        key = rig.key("payg", quota=50)
        _, env, _ = mcp_call(rig, name, {"account": "globex"}, key=key)
        assert env["error"]["code"] == -32602 and "unknown tool" in env["error"]["message"]
        assert rig.events() == []

    def test_an_account_argument_cannot_redirect_a_charge_to_another_tenant_on_either_door(self, rig):
        a, b = rig.key("payg", quota=50, account="acme"), rig.key("payg", quota=50, account="globex")
        rig.post("/v1/screen", {"intake": INTAKE, "account": "globex"}, key=a)
        mcp_call(rig, "gridforge_screen", {"intake": INTAKE, "account": "globex"}, key=a)
        rig.post("/v1/screen", {"intake": INTAKE}, key=a, headers={"X-GridForge-Account": "globex"})
        assert {e["account"] for e in rig.events()} <= {"acme"}
        assert net_units(rig, "globex") == 0
        assert rig.get("/v1/usage", key=b)[1]["units"] == 0

    def test_the_operator_surface_is_not_reachable_with_a_client_key_by_either_door(self, rig):
        key = rig.key("payg", quota=50)
        s, _, _ = rig.post("/v1/revoke", {"key_id": K.verify(key).key_id}, key=key)
        assert s == 404, "an operator route does not confirm it exists to a client key"
        assert rig.get("/v1/admin/ledger", key=key)[0] == 404
        assert rig.post("/v1/screen", {"intake": INTAKE}, key=key)[0] == 200, "the client key was not revoked by trying"
        _, env, _ = mcp_call(rig, "gridforge_revoke", {"key_id": K.verify(key).key_id}, key=key)
        assert "unknown tool" in env["error"]["message"]
        # and the operator key is not a client: the engine does not meter it as one
        s, _, _ = rig.post("/v1/revoke", {"key_id": ""}, key=key)
        assert s == 404
