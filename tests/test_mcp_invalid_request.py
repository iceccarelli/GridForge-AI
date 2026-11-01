"""/mcp answers a malformed JSON-RPC message with an error; it never silently accepts one.

JSON-RPC 2.0: a message that is not a request object is an Invalid Request (-32600) and is answered even when it carries no id. The server
instead treated any object without an id as a notification and answered 202 with nothing, and replaced a non-object batch item with {}: so
`{}`, `{"a":1}`, `[1]` and a 20,000-level nested body all got a silent 202 (observed on Python 3.13, which production runs). A client with
a bug got no signal. Valid requests and valid notifications are exactly as before.
"""
import http.client
import json
import threading

import pytest

from gridforge.api.server import Handler, make_server

INVALID = "invalid request"


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


def is_invalid_request(entry, expect_id=None):
    return (isinstance(entry, dict) and entry.get("jsonrpc") == "2.0" and entry.get("id") == expect_id
            and entry["error"]["code"] == -32600 and INVALID in entry["error"]["message"])


# --- a single message ------------------------------------------------------------------------------------------------------


@pytest.mark.parametrize("body", [{}, {"a": 1}, {"jsonrpc": "2.0"}, {"jsonrpc": "2.0", "id": 1}, {"method": ""}, {"method": None},
                                  {"method": 5}, {"method": ["tools/list"]}, {"method": {"x": 1}}, {"id": "x", "params": {}}])
def test_an_object_without_a_string_method_is_an_invalid_request_not_a_silent_notification(port, body):
    status, out = post(port, body)
    assert status == 400, "it used to be 202 with an empty body"
    assert out["error"]["code"] == -32600 and INVALID in out["error"]["message"]


@pytest.mark.parametrize("rid,echoed", [(1, 1), ("abc", "abc"), (0, 0), (None, None), (True, None), (1.5, None), ([1], None), ({"a": 1}, None)])
def test_the_id_is_echoed_only_when_json_rpc_allows_it(port, rid, echoed):
    status, out = post(port, {"jsonrpc": "2.0", "id": rid, "params": {}})
    assert status == 400 and out["id"] == echoed


@pytest.mark.parametrize("body", [17, "x", None, True, 1.5])
def test_a_body_that_is_not_an_object_or_array_is_still_the_existing_400(port, body):
    status, out = post(port, body)
    assert status == 400 and out["error"]["code"] == -32600


# --- a batch ---------------------------------------------------------------------------------------------------------------


def test_every_invalid_batch_item_gets_its_own_error_in_order_and_the_valid_ones_are_still_answered(port):
    batch = [{}, 1, [1], "x", None, {"jsonrpc": "2.0", "id": 7, "method": "ping"}, {"jsonrpc": "2.0", "method": "notifications/initialized"},
             {"jsonrpc": "2.0", "id": 8}]
    status, out = post(port, batch)
    assert status == 200 and isinstance(out, list)
    # five non-objects/objects without a method, then the ping, (the notification answers nothing), then an id-bearing invalid one
    assert [is_invalid_request(e) for e in out[:5]] == [True] * 5
    assert out[5]["id"] == 7 and "result" in out[5]
    assert is_invalid_request(out[6], expect_id=8)
    assert len(out) == 7


def test_a_batch_of_only_valid_notifications_is_still_202_with_no_body(port):
    status, out = post(port, [{"jsonrpc": "2.0", "method": "notifications/initialized"}, {"jsonrpc": "2.0", "method": "initialized"}])
    assert status == 202 and out is None


def test_a_batch_that_is_all_invalid_is_a_200_of_errors_never_a_202(port):
    status, out = post(port, [{}, {}, 3])
    assert status == 200 and all(is_invalid_request(e) for e in out) and len(out) == 3


def test_the_existing_batch_limits_are_unchanged(port):
    assert post(port, [])[0] == 400
    assert post(port, [{"jsonrpc": "2.0", "method": "ping", "id": i} for i in range(11)])[0] == 400


# --- what is unchanged ----------------------------------------------------------------------------------------------------


def test_a_valid_request_is_answered_exactly_as_before(port):
    status, out = post(port, {"jsonrpc": "2.0", "id": 1, "method": "ping"})
    assert status == 200 and out["id"] == 1 and "result" in out


def test_an_unknown_method_is_still_method_not_found_not_invalid_request(port):
    status, out = post(port, {"jsonrpc": "2.0", "id": 2, "method": "no/such/method"})
    assert status == 200 and out["error"]["code"] == -32601


def test_a_valid_notification_is_still_202_with_no_body(port):
    assert post(port, {"jsonrpc": "2.0", "method": "notifications/initialized"}) == (202, None)


def test_tools_list_still_works(port):
    status, out = post(port, {"jsonrpc": "2.0", "id": 3, "method": "tools/list"})
    assert status == 200 and out["result"]["tools"]


# --- hostile ---------------------------------------------------------------------------------------------------------------


@pytest.mark.parametrize("depth", [100, 5_000])
def test_deeply_nested_garbage_is_an_error_never_a_202(port, depth):
    for raw in (("[" * depth + "]" * depth), ('{"a":' * depth + "1" + "}" * depth)):
        status, out = post(port, raw.encode())
        assert status in (200, 400), (depth, status)
        assert out is not None, "a silent 202/empty body for garbage is the defect"
        entries = out if isinstance(out, list) else [out]
        assert all(isinstance(e, dict) and e.get("error") for e in entries)
