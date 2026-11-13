"""A response never carries NaN or Infinity: a non-finite figure is withheld (null), named in `warnings`, and is never a 500 or a zero.

`json.dumps` writes `Infinity` for an infinite float, which is not JSON: a strict parser rejects the whole answer and a lenient one reads it as
a number. The loader refuses the inputs that can cause one (another change adds ceilings); this is the defence behind it, tested with a payload
that carries one on purpose.
"""
from __future__ import annotations

import http.client
import json
import math
import threading

import pytest

from gridforge.api import server as S
from gridforge.api.server import Handler, _encode, make_server, withhold_non_finite
from gridforge.api.tiers import Tier


def strict_loads(raw: bytes):
    def refuse(token):
        raise AssertionError(f"the response carries the non-JSON token {token}")
    return json.loads(raw, parse_constant=refuse)


# --- the encoder ---------------------------------------------------------------------------------------------------------------------------
def test_a_clean_payload_is_encoded_exactly_as_before():
    payload = {"a": 1, "b": [1.5, None, {"c": "x"}], "d": {"e": True}}
    assert _encode(payload) == json.dumps(payload).encode()


@pytest.mark.parametrize("bad", [math.inf, -math.inf, math.nan])
def test_a_non_finite_figure_becomes_null_and_is_named(bad):
    out = strict_loads(_encode({"racks": 3, "headline": {"weeks": bad, "ok": 2.5}, "rows": [{"x": 1}, {"x": bad}]}))
    assert out["headline"] == {"weeks": None, "ok": 2.5} and out["rows"][1]["x"] is None and out["rows"][0]["x"] == 1
    assert out["racks"] == 3
    assert out["warnings"] == ["non-finite figure withheld at headline.weeks", "non-finite figure withheld at rows[1].x"]


def test_a_warning_the_payload_already_carries_is_kept_and_the_new_ones_follow():
    out = strict_loads(_encode({"warnings": ["one thing"], "weeks": math.inf}))
    assert out["warnings"] == ["one thing", "non-finite figure withheld at weeks"]


def test_a_payload_whose_warnings_is_not_a_list_is_not_overwritten():
    out = strict_loads(_encode({"warnings": "text", "weeks": math.inf}))
    assert out["warnings"] == "text" and out["non_finite_warnings"] == ["non-finite figure withheld at weeks"]


def test_the_figure_is_null_never_zero():
    out = strict_loads(_encode({"weeks": math.inf, "capex": -math.inf}))
    assert out["weeks"] is None and out["capex"] is None
    assert 0 not in (out["weeks"], out["capex"])


def test_a_jsonrpc_response_carries_the_warning_inside_its_result():
    out = strict_loads(_encode({"jsonrpc": "2.0", "id": 1, "result": {"structuredContent": {"w": math.inf}}}))
    assert set(out) == {"jsonrpc", "id", "result"}
    assert out["result"]["structuredContent"]["w"] is None
    assert out["result"]["warnings"] == ["non-finite figure withheld at result.structuredContent.w"]


def test_a_batch_names_the_warning_in_the_message_it_belongs_to():
    out = strict_loads(_encode([{"jsonrpc": "2.0", "id": 1, "result": {"a": 1}},
                                {"jsonrpc": "2.0", "id": 2, "result": {"a": math.inf}}]))
    assert "warnings" not in out[0]["result"] and out[1]["result"]["a"] is None and out[1]["result"]["warnings"]


def test_withholding_does_not_modify_the_payload_it_was_given():
    original = {"w": math.inf, "rows": [math.nan]}
    clean, paths = withhold_non_finite(original)
    assert paths == ["w", "rows[0]"] and clean == {"w": None, "rows": [None]}
    assert original["w"] == math.inf and math.isnan(original["rows"][0])


def test_a_failure_that_is_not_a_non_finite_number_is_still_an_error():
    loop: dict = {}
    loop["self"] = loop
    with pytest.raises(ValueError):
        _encode(loop)


# --- on the wire ------------------------------------------------------------------------------------------------------------------------------
@pytest.fixture()
def server(monkeypatch):
    monkeypatch.setenv("GRIDFORGE_RATE_LIMIT", "0")
    monkeypatch.setattr(Handler.limiter, "per_minute", 0)
    httpd = make_server("127.0.0.1", 0)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield httpd.server_address[1], monkeypatch
    httpd.shutdown()


def post(port, path, body):
    c = http.client.HTTPConnection("127.0.0.1", port, timeout=20)
    try:
        c.request("POST", path, body=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
        r = c.getresponse()
        return r.status, r.read()
    finally:
        c.close()


def test_a_route_that_computes_an_infinity_answers_200_with_the_figure_withheld(server):
    port, mp = server
    mp.setitem(S.ROUTES, "/v1/qualify", (lambda body, tier: {"as_found": {"racks": 4, "weeks": math.inf}, "rows": [-math.inf]}, Tier.PUBLIC))
    status, raw = post(port, "/v1/qualify", {})
    assert status == 200, raw
    assert b"Infinity" not in raw and b"NaN" not in raw
    out = strict_loads(raw)
    assert out["as_found"] == {"racks": 4, "weeks": None} and out["rows"] == [None]
    assert out["schema_version"] == S.API_SCHEMA
    assert out["warnings"] == ["non-finite figure withheld at as_found.weeks", "non-finite figure withheld at rows[0]"]


def test_a_tool_call_that_computes_a_nan_over_mcp_is_withheld_too(server):
    port, mp = server
    mp.setitem(S.ROUTES, "/v1/qualify", (lambda body, tier: {"as_found": {"racks": 1, "weeks": math.nan}}, Tier.PUBLIC))
    status, raw = post(port, "/mcp", {"jsonrpc": "2.0", "id": 7, "method": "tools/call",
                                       "params": {"name": "gridforge_qualify", "arguments": {}}})
    assert status == 200 and b"NaN" not in raw
    out = strict_loads(raw)
    assert out["id"] == 7 and "error" not in out
    assert out["result"]["structuredContent"]["as_found"]["weeks"] is None
    assert out["result"]["warnings"] == ["non-finite figure withheld at result.structuredContent.as_found.weeks"]
