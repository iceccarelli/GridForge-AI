"""A request the engine cannot handle is refused (4xx), never a dropped connection or a 500 "engine error".

Found by the gridforge-stress harness's hostile-input fuzz, which drives every route's handler with wrong types, non-finite and enormous
numbers and structures nested thousands deep and reports anything the HTTP layer would not turn into a clean refusal:

  * the JSON parser raises RecursionError at ~10,000 levels of nesting and do_POST did not catch it, so the request ended with NO HTTP RESPONSE
    (the connection was closed) and a traceback in the log, on the free public endpoints too (no key is needed to send a body there);
  * /v1/diff copies the documents it is given before validating them, so a body nested a few hundred levels deep failed with a RecursionError;
  * /v1/power/deploy/assess read load_profile with .get() whatever its type, so null, a string or a number was an AttributeError.
"""
from __future__ import annotations

import http.client
import json
import threading

import pytest

from gridforge.api import server as S
from gridforge.api.server import MAX_BODY_DEPTH, ApiError, Handler, _nests_deeper_than, make_server
from gridforge.api.tiers import Tier
from gridforge.reporting.btm_assessment import DeploymentRequestError, deployment_request


def nested(depth: int, leaf=1, container=list):
    x = leaf
    for _ in range(depth):
        x = [x] if container is list else {"a": x}
    return x


@pytest.fixture(scope="module")
def base_url():
    mp = pytest.MonkeyPatch()
    mp.setenv("GRIDFORGE_RATE_LIMIT", "0")
    mp.setattr(Handler.limiter, "per_minute", 0)
    httpd = make_server("127.0.0.1", 0)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    yield httpd.server_address[1]
    httpd.shutdown()
    thread.join(timeout=5)
    mp.undo()


def post_raw(port: int, path: str, raw: bytes):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=15)
    try:
        conn.request("POST", path, body=raw, headers={"Content-Type": "application/json"})
        resp = conn.getresponse()
        return resp.status, json.loads(resp.read() or b"{}")
    finally:
        conn.close()


# --- the parser's own limit ----------------------------------------------------------------------------------------------------


@pytest.mark.parametrize("depth", [20_000, 200_000])
@pytest.mark.parametrize("path", ["/v1/qualify", "/v1/estimate", "/mcp"])
def test_a_body_nested_beyond_the_parser_limit_is_a_400_with_a_response(base_url, path, depth):
    """The public endpoints take no key, so this is reachable by anyone. Before the fix: RemoteDisconnected, no response, a traceback in the log."""
    status, out = post_raw(base_url, path, ("[" * depth + "]" * depth).encode())
    assert status == 400
    assert "nested too deeply" in out["error"]


def test_the_server_still_answers_after_a_hostile_body(base_url):
    post_raw(base_url, "/v1/qualify", ("[" * 50_000 + "]" * 50_000).encode())
    status, out = post_raw(base_url, "/v1/estimate", json.dumps({"endpoint": "/v1/screen"}).encode())
    assert status == 200 and out["units"] >= 0


# --- the shared entry every route and the MCP surface go through ---------------------------------------------------------------


def test_the_depth_check_counts_levels_and_is_iterative():
    """nested(n) is n containers around a leaf, so it nests n levels: n == MAX_BODY_DEPTH is allowed, one more is refused."""
    assert not _nests_deeper_than({}, MAX_BODY_DEPTH)
    for container in (list, dict):
        assert not _nests_deeper_than(nested(MAX_BODY_DEPTH, container=container), MAX_BODY_DEPTH)
        assert _nests_deeper_than(nested(MAX_BODY_DEPTH + 1, container=container), MAX_BODY_DEPTH)
    assert _nests_deeper_than(nested(50_000), MAX_BODY_DEPTH)  # a hostile value cannot make the check itself recurse
    assert not _nests_deeper_than("text", 1) and not _nests_deeper_than(7, 1) and not _nests_deeper_than(None, 1)


@pytest.mark.parametrize("route", sorted(r for r, (_, tier) in S.ROUTES.items() if tier is not Tier.INTERNAL))
def test_every_route_refuses_a_deeply_nested_body_before_touching_it(route):
    handler, tier = S.ROUTES[route]
    for hostile in ({"intake": nested(300)}, {"before": nested(300, container=dict), "after": {}}, {"intakes": [nested(300)]}):
        with pytest.raises(ApiError) as exc:
            S._invoke(route, handler, hostile, tier)
        assert exc.value.status == 422 and "levels deep" in exc.value.message


def test_a_reference_sized_body_is_not_affected():
    doc = json.loads((__import__("pathlib").Path(__file__).resolve().parents[1] / "examples" / "intake" / "dublin_hall.json").read_text())
    assert not _nests_deeper_than({"intake": doc}, MAX_BODY_DEPTH)
    out = S._invoke("/v1/screen", S.handle_screen, {"intake": doc}, Tier.CLIENT)
    assert out["scenarios"]


# --- the deployment request ----------------------------------------------------------------------------------------------------


GOOD_DEPLOY = {
    "load_profile": {"flat_kW": 8000},
    "grid_firm_MW": 10,
    "target_MW": 35,
    "generation": [{"id": "GEN-A", "kind": "gas_engine", "nameplate_MW": 10}],
    "bess": [{"id": "BESS-1", "power_MW": 10, "energy_MWh": 40}],
}


@pytest.mark.parametrize("value", [None, True, False, "", "x", 0, 7, 1.5, [], ["flat_kW"], float("nan")], ids=repr)
def test_a_load_profile_that_is_not_an_object_is_a_request_error_not_an_attribute_error(value):
    doc = {**GOOD_DEPLOY, "load_profile": value}
    with pytest.raises(DeploymentRequestError, match="load_profile must be an object"):
        deployment_request(doc)
    with pytest.raises(ApiError) as exc:
        S._invoke("/v1/power/deploy/assess", S.handle_power_deploy_assess, doc, Tier.CLIENT)
    assert exc.value.status == 422


def test_a_valid_deployment_request_still_parses():
    parsed = deployment_request(GOOD_DEPLOY)
    assert parsed["grid_firm_MW"].value == 10 and parsed["target_MW"].value == 35
