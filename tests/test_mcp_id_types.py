"""/mcp validates the type of a request id ONCE (review E8): a string, a number (an integer or a fraction) or null is echoed exactly; an object, an array or
a boolean is an Invalid Request (-32600) answered with id null.

The two paths disagreed. A valid request echoed whatever id it carried (an object, an array, a boolean), while the invalid-request path nulled an id that
was not a string or an integer, so 1.5, which JSON-RPC allows, was answered with null on one path and echoed on the other.
"""
from __future__ import annotations

import http.client
import json
import threading

import pytest

from gridforge.api.server import Handler, _mcp_id_is_valid, _mcp_message_is_valid, make_server

VALID_IDS = [0, 1, -1, 7, 1.5, -0.25, 2.0, 1e10, 10**30, "", "abc", "x" * 200, None]
BAD_IDS = [True, False, {"a": 1}, {}, [1], [], ["a"]]


@pytest.fixture(scope="module")
def port():
    mp = pytest.MonkeyPatch()
    mp.setenv("GRIDFORGE_RATE_LIMIT", "0")
    mp.setattr(Handler.limiter, "per_minute", 0)
    httpd = make_server("127.0.0.1", 0)
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    yield httpd.server_address[1]
    httpd.shutdown()
    t.join(timeout=5)
    mp.undo()


def post(port, body):
    raw = body if isinstance(body, bytes) else json.dumps(body).encode()
    c = http.client.HTTPConnection("127.0.0.1", port, timeout=15)
    try:
        c.request("POST", "/mcp", body=raw, headers={"Content-Type": "application/json"})
        r = c.getresponse()
        data = r.read()
        return r.status, (json.loads(data) if data else None)
    finally:
        c.close()


def same(a, b) -> bool:
    """Equal AND of the same JSON kind: 1 and 1.0 are different ids on the wire, True is not 1."""
    return a == b and type(a) is type(b)


# ----------------------------------------------------------------------------------------------------- the one rule
@pytest.mark.parametrize("rid", VALID_IDS, ids=repr)
def test_the_rule_accepts_a_string_a_number_or_null(rid):
    assert _mcp_id_is_valid(rid)
    assert _mcp_message_is_valid({"jsonrpc": "2.0", "method": "ping", "id": rid})


@pytest.mark.parametrize("rid", BAD_IDS + [float("inf"), float("-inf"), float("nan")], ids=repr)
def test_the_rule_refuses_an_object_an_array_a_boolean_and_a_non_finite_number(rid):
    assert not _mcp_id_is_valid(rid)
    assert not _mcp_message_is_valid({"jsonrpc": "2.0", "method": "ping", "id": rid})


def test_a_message_without_an_id_is_a_notification_and_stays_valid():
    assert _mcp_message_is_valid({"jsonrpc": "2.0", "method": "notifications/initialized"})


# ----------------------------------------------------------------------------------------------------- valid requests echo exactly
@pytest.mark.parametrize("rid", VALID_IDS, ids=repr)
def test_a_valid_request_echoes_its_id_exactly(port, rid):
    status, out = post(port, {"jsonrpc": "2.0", "id": rid, "method": "ping"})
    assert status == 200 and same(out["id"], rid) and "result" in out


@pytest.mark.parametrize("rid", VALID_IDS, ids=repr)
def test_an_invalid_request_echoes_a_valid_id_exactly_too(port, rid):
    """The same id on the invalid-request path (no method): the float 1.5 used to come back as null here and as 1.5 above."""
    status, out = post(port, {"jsonrpc": "2.0", "id": rid, "params": {}})
    assert status == 400 and same(out["id"], rid) and out["error"]["code"] == -32600


# ----------------------------------------------------------------------------------------------------- bad ids
@pytest.mark.parametrize("rid", BAD_IDS, ids=repr)
def test_an_object_array_or_boolean_id_is_an_invalid_request_with_id_null(port, rid):
    status, out = post(port, {"jsonrpc": "2.0", "id": rid, "method": "ping"})
    assert status == 400, "it used to be answered 200 with the object, array or boolean echoed back"
    assert out["id"] is None and out["error"]["code"] == -32600
    assert '"id" must be a string, a number or null' in out["error"]["message"]


@pytest.mark.parametrize("rid,kind", [(True, "a boolean"), ({"a": 1}, "an object"), ([1], "an array")])
def test_the_refusal_names_what_the_id_was(port, rid, kind):
    _, out = post(port, {"jsonrpc": "2.0", "id": rid, "method": "tools/list"})
    assert f"(it is {kind})" in out["error"]["message"]


def test_a_bad_id_does_not_reach_a_tool_and_nothing_is_charged(port):
    status, out = post(port, {"jsonrpc": "2.0", "id": {"a": 1}, "method": "tools/call",
                              "params": {"name": "gridforge_qualify", "arguments": {"contracted_MW": 12, "current_site_peak_MW": 7.4, "busway_ampacity_A": 400}}})
    assert status == 400 and out["id"] is None and "result" not in out


# ----------------------------------------------------------------------------------------------------- batches
def test_a_batch_answers_each_item_by_the_same_rule_and_the_others_are_still_served(port):
    batch = [{"jsonrpc": "2.0", "id": 1.5, "method": "ping"}, {"jsonrpc": "2.0", "id": [1], "method": "ping"}, {"jsonrpc": "2.0", "id": "a", "method": "ping"},
             {"jsonrpc": "2.0", "id": True, "method": "ping"}, {"jsonrpc": "2.0", "id": None, "method": "ping"}, {"jsonrpc": "2.0", "method": "notifications/initialized"}]
    status, out = post(port, batch)
    assert status == 200 and len(out) == 5
    assert same(out[0]["id"], 1.5) and "result" in out[0]
    assert out[1]["id"] is None and out[1]["error"]["code"] == -32600
    assert out[2]["id"] == "a" and "result" in out[2]
    assert out[3]["id"] is None and out[3]["error"]["code"] == -32600
    assert out[4]["id"] is None and "result" in out[4]
