"""A `format` the route cannot render is refused with a 422 BEFORE the call is metered, on every route that has one.

The audit found `format: "pdf"` on /v1/screen, /v1/study, /v1/spec, /v1/proposal, /v1/deck and /v1/diff answered 200 (as if the format were the default)
and charged the units, while /v1/portfolio already answered 422 with the allowed names. One table (server.ROUTE_FORMATS, from the published schema
enums) now serves every route, on REST and on MCP, ahead of the charge: the proof is that the meter is never asked for a reservation and the ledger
records nothing, which is stronger than "charged then refunded".
"""
from __future__ import annotations

import pytest

from gridforge.api import server as S
from gridforge.api.server import ROUTE_FORMATS, ApiError, validate_format
from gridforge.api.tiers import Tier
from gridforge.api.tools import TOOLS_BY_NAME
from payg_rig import INTAKE, rig  # noqa: F401

ROUTES = sorted(ROUTE_FORMATS)


def body_for(path: str, **extra) -> dict:
    if path == "/v1/portfolio":
        return {"intakes": [INTAKE], **extra}
    if path == "/v1/diff":
        return {"before": INTAKE, "after": INTAKE, **extra}
    return {"intake": INTAKE, **extra}


def test_the_table_covers_every_route_that_renders_a_document_and_follows_the_published_enums():
    by_endpoint = {t["endpoint"]: t for t in TOOLS_BY_NAME.values()}
    for path, (allowed, default) in ROUTE_FORMATS.items():
        assert default in allowed
        tool = by_endpoint.get(path)
        if tool is None:
            assert path == "/v1/deck"          # REST only, no schema; it renders html and nothing else
            assert allowed == ("html",)
            continue
        fmt = tool["inputSchema"]["properties"]["format"]
        assert list(allowed) == fmt["enum"], path
        assert default == fmt["default"], path
    # and every published tool whose schema has a `format` is in the table, bar the behind-the-meter routes (their own handlers)
    for tool in TOOLS_BY_NAME.values():
        if "format" in tool["inputSchema"]["properties"] and not tool["endpoint"].startswith("/v1/power/"):
            assert tool["endpoint"] in ROUTE_FORMATS, tool["endpoint"]


@pytest.mark.parametrize("path", ROUTES)
def test_an_unsupported_format_is_a_422_that_names_the_allowed_ones_and_is_never_metered(rig, path, monkeypatch):  # noqa: F811
    key = rig.key(scope="payg", quota=50)
    reserved = []
    real = rig.meter.reserve_ex
    monkeypatch.setattr(rig.meter, "reserve_ex", lambda *a, **k: (reserved.append(a), real(*a, **k))[1])
    for bad in ("pdf", "PDF", "docx", 5, ["html"], {"a": 1}):
        status, out, headers = rig.post(path, body_for(path, format=bad), key=key)
        assert status == 422, (path, bad, status, out)
        assert out["allowed"] == list(ROUTE_FORMATS[path][0]) and "unknown format" in out["error"]
    assert reserved == [], "the refusal must come before the meter is asked for anything"
    assert rig.events() == [], "nothing was charged and nothing was refunded: the ledger has no entry"
    assert rig.meter.current("acme").units == 0
    assert "X-GridForge-Units" not in headers


@pytest.mark.parametrize("path", [p for p in ROUTES if p != "/v1/deck"])         # /v1/deck is REST only: it has no MCP tool
def test_an_unsupported_format_is_refused_over_mcp_before_the_charge_too(rig, path, monkeypatch):  # noqa: F811
    tool = next(t for t in TOOLS_BY_NAME.values() if t["endpoint"] == path)
    key = rig.key(scope="payg", quota=50)
    real = rig.meter.reserve_ex
    reserved = []
    monkeypatch.setattr(rig.meter, "reserve_ex", lambda *a, **k: (reserved.append(a), real(*a, **k))[1])
    status, out, _ = rig.post("/mcp", {"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                                       "params": {"name": tool["name"], "arguments": body_for(path, format="pdf")}}, key=key)
    assert status == 200 and out["error"]["code"] == -32602 and "unknown format" in out["error"]["message"], out
    assert out["error"]["data"]["allowed"] == list(ROUTE_FORMATS[path][0])
    assert reserved == [] and rig.events() == [] and rig.meter.current("acme").units == 0


def test_a_supported_format_is_still_charged_and_answered(rig):  # noqa: F811
    key = rig.key(scope="payg", quota=50)
    status, out, headers = rig.post("/v1/screen", body_for("/v1/screen", format="MD"), key=key)       # case is still ignored
    assert status == 200 and out["format"] == "md"
    assert headers["X-GridForge-Units"] == "1" and rig.meter.current("acme").units == 1


@pytest.mark.parametrize("path", ROUTES)
def test_absent_null_and_empty_format_are_the_default_and_every_allowed_one_passes_validation(path):
    allowed, _ = ROUTE_FORMATS[path]
    for ok in (None, "", *allowed, *(a.upper() for a in allowed)):
        validate_format(path, {"format": ok} if ok is not None else {})
    validate_format(path, {"format": None})


def test_a_route_with_no_format_and_a_body_that_is_not_an_object_are_not_looked_at():
    validate_format("/v1/compare", {"format": "pdf"})        # /v1/compare has no format: it is not this table's business
    validate_format("/v1/screen", ["format", "pdf"])
    validate_format("/v1/screen", None)


def test_a_caller_that_reaches_a_handler_through_invoke_without_the_transport_is_refused_too():
    with pytest.raises(ApiError) as e:
        S._invoke("/v1/screen", S.handle_screen, {"intake": INTAKE, "format": "pdf"}, Tier.CLIENT)
    assert e.value.status == 422 and e.value.extra["allowed"] == ["json", "md", "html"]


def test_the_portfolio_handler_keeps_its_own_check_for_a_direct_caller():
    with pytest.raises(ApiError) as e:
        S.handle_portfolio({"intakes": [INTAKE], "format": "pdf"}, Tier.CLIENT)
    assert e.value.status == 422 and e.value.extra["allowed"] == ["json", "md", "html"]
