"""/mcp reads a JSON-RPC 2.0 message strictly: the version, the params of tools/call, and what a notification is.

The audit found: `tools/call` with no params answered 'unknown tool None' (the caller is told about a tool they never named); `"jsonrpc": "1.0"` and
a missing `jsonrpc` were accepted as 2.0; and `"id": null` was taken for a notification, so the caller got a 202 and nothing else. JSON-RPC 2.0
section 4.1: a notification is a message with NO `id` member. `"id": null` is a request.
"""
from __future__ import annotations

import http.client
import json
import threading

import pytest

from gridforge.api.server import Handler, make_server

HALL = {"contracted_MW": 12, "current_site_peak_MW": 7.4, "busway_ampacity_A": 400}


@pytest.fixture(scope="module")
def port():
    mp = pytest.MonkeyPatch()
    mp.setenv("GRIDFORGE_RATE_LIMIT", "0")
    mp.setattr(Handler.limiter, "per_minute", 0)
    httpd = make_server("127.0.0.1", 0)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield httpd.server_address[1]
    httpd.shutdown()
    mp.undo()


def post(port, message):
    c = http.client.HTTPConnection("127.0.0.1", port, timeout=30)
    try:
        c.request("POST", "/mcp", body=json.dumps(message).encode(), headers={"Content-Type": "application/json"})
        r = c.getresponse()
        data = r.read()
        return r.status, (json.loads(data) if data else None)
    finally:
        c.close()


# --- the version -------------------------------------------------------------------------------------------------------------------------------
@pytest.mark.parametrize("version", ["1.0", "2", "3.0", 2.0, 2, None, True, ["2.0"], {"v": "2.0"}, ""])
def test_a_wrong_jsonrpc_version_is_an_invalid_request(port, version):
    status, out = post(port, {"jsonrpc": version, "id": 1, "method": "ping"})
    assert status == 400 and out["error"]["code"] == -32600 and out["id"] == 1
    assert '"jsonrpc" must be the string "2.0"' in out["error"]["message"]


def test_a_missing_jsonrpc_is_an_invalid_request_that_says_it_is_missing(port):
    status, out = post(port, {"id": 1, "method": "ping"})
    assert status == 400 and out["error"]["code"] == -32600 and "(it is missing)" in out["error"]["message"]
    status, out = post(port, {"jsonrpc": "1.0", "id": 2, "method": "ping"})
    assert "(it is '1.0')" in out["error"]["message"]


def test_a_notification_with_the_wrong_version_is_still_an_error_never_a_silent_202(port):
    status, out = post(port, {"jsonrpc": "1.0", "method": "notifications/initialized"})
    assert status == 400 and out["error"]["code"] == -32600 and out["id"] is None


def test_in_a_batch_each_message_is_judged_on_its_own(port):
    status, out = post(port, [{"jsonrpc": "2.0", "id": 1, "method": "ping"}, {"id": 2, "method": "ping"}, {"jsonrpc": "1.0", "id": 3, "method": "ping"}])
    assert status == 200 and out[0]["result"] == {} and [e["error"]["code"] for e in out[1:]] == [-32600, -32600]
    assert [e["id"] for e in out] == [1, 2, 3]


def test_a_valid_2_0_message_is_unchanged(port):
    assert post(port, {"jsonrpc": "2.0", "id": 5, "method": "ping"}) == (200, {"jsonrpc": "2.0", "id": 5, "result": {}})


# --- tools/call params ---------------------------------------------------------------------------------------------------------------------------
@pytest.mark.parametrize("params", [None, "gridforge_qualify", ["gridforge_qualify"], 5])
def test_tools_call_without_params_object_is_invalid_params_naming_name(port, params):
    message = {"jsonrpc": "2.0", "id": 1, "method": "tools/call"}
    if params is not None:
        message["params"] = params
    status, out = post(port, message)
    assert status == 200 and out["error"]["code"] == -32602
    assert '"name"' in out["error"]["message"] and "unknown tool" not in out["error"]["message"]
    assert "gridforge_qualify" in out["error"]["data"]["available"]


@pytest.mark.parametrize("params,got", [({}, "missing"), ({"arguments": {}}, "missing"), ({"name": None}, "missing"), ({"name": ""}, "empty"),
                                        ({"name": 7}, "a int, not a string"), ({"name": ["a"]}, "a list, not a string"),
                                        ({"name": {"a": 1}}, "a dict, not a string")])
def test_tools_call_with_no_usable_name_is_invalid_params_naming_name(port, params, got):
    status, out = post(port, {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": params})
    assert status == 200 and out["error"]["code"] == -32602
    assert out["error"]["message"] == f"params.name is {got}: name the tool to call (a string)"
    assert "unknown tool" not in out["error"]["message"] and "error" in out and "result" not in out


def test_an_unknown_tool_name_is_still_reported_as_unknown(port):
    status, out = post(port, {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "gridforge_nope", "arguments": {}}})
    assert out["error"]["code"] == -32602 and "unknown tool 'gridforge_nope'" in out["error"]["message"]


def test_a_valid_tools_call_still_works(port):
    status, out = post(port, {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "gridforge_qualify", "arguments": HALL}})
    assert status == 200 and out["result"]["isError"] is False and out["result"]["structuredContent"]["as_found"]


def test_tools_call_params_are_validated_before_anything_is_charged_or_rate_counted(port):
    # a batch of ten bad calls would, if each took a rate-limit hit, be refused for the tenth; each is refused for its own reason instead
    status, out = post(port, [{"jsonrpc": "2.0", "id": i, "method": "tools/call"} for i in range(10)])
    assert status == 200 and {e["error"]["code"] for e in out} == {-32602}


# --- notifications -----------------------------------------------------------------------------------------------------------------------------
def test_a_message_with_no_id_member_is_a_notification_and_gets_no_body(port):
    status, out = post(port, {"jsonrpc": "2.0", "method": "notifications/initialized"})
    assert status == 202 and out is None
    status, out = post(port, {"jsonrpc": "2.0", "method": "ping"})
    assert status == 202 and out is None, "a request with no id is a notification whatever its method"


def test_an_id_of_null_is_a_request_and_is_answered_with_id_null(port):
    status, out = post(port, {"jsonrpc": "2.0", "id": None, "method": "ping"})
    assert status == 200 and out == {"jsonrpc": "2.0", "id": None, "result": {}}
    status, out = post(port, {"jsonrpc": "2.0", "id": None, "method": "tools/list"})
    assert status == 200 and out["id"] is None and out["result"]["tools"]


def test_an_error_for_an_id_of_null_is_answered_not_dropped(port):
    status, out = post(port, {"jsonrpc": "2.0", "id": None, "method": "no/such"})
    assert status == 200 and out["id"] is None and out["error"]["code"] == -32601
    status, out = post(port, {"jsonrpc": "2.0", "id": None, "method": "tools/call", "params": {"name": "gridforge_nope", "arguments": {}}})
    assert out["id"] is None and out["error"]["code"] == -32602


def test_a_notification_that_fails_is_still_silent(port):
    status, out = post(port, {"jsonrpc": "2.0", "method": "no/such"})
    assert status == 202 and out is None


def test_zero_and_empty_string_ids_are_requests(port):
    assert post(port, {"jsonrpc": "2.0", "id": 0, "method": "ping"})[1]["id"] == 0
    assert post(port, {"jsonrpc": "2.0", "id": "", "method": "ping"})[1]["id"] == ""


def test_a_batch_of_notifications_only_is_a_202_and_a_null_id_in_a_batch_is_answered(port):
    assert post(port, [{"jsonrpc": "2.0", "method": "ping"}, {"jsonrpc": "2.0", "method": "notifications/initialized"}]) == (202, None)
    status, out = post(port, [{"jsonrpc": "2.0", "id": None, "method": "ping"}, {"jsonrpc": "2.0", "method": "ping"}])
    assert status == 200 and out == [{"jsonrpc": "2.0", "id": None, "result": {}}]
