"""An unexpected exception inside a tool call is OUR fault: the call is refunded, the caller is told only
"engine error" and a request id (never the exception text), and the rest of a batch is still answered."""
import json
import os

import pytest

from gridforge.api import server as S
from payg_rig import INTAKE, rig  # noqa: F401  (fixture)

SECRET = "boom: /srv/gridforge/private/path token=hunter2"


def tool(i, name, args):
    return {"jsonrpc": "2.0", "id": i, "method": "tools/call", "params": {"name": name, "arguments": args}}


def screen(i):
    return tool(i, "gridforge_screen", {"intake": INTAKE})


def study(i):
    return tool(i, "gridforge_study", {"intake": INTAKE})


def net(rig):
    return sum(e["units"] * (1 if e["kind"] == "charge" else -1) for e in rig.events())


def explode(monkeypatch, endpoint, exc=RuntimeError):
    def handler(body, tier):
        raise exc(SECRET)
    monkeypatch.setitem(S.ROUTES, endpoint, (handler, S.Tier.CLIENT))


@pytest.mark.parametrize("exc", [RuntimeError, OSError, MemoryError, AttributeError, ZeroDivisionError])
def test_a_single_mcp_call_that_blows_up_is_refunded_and_leaks_nothing(rig, monkeypatch, capsys, exc):
    explode(monkeypatch, "/v1/screen", exc)
    key = rig.key("payg", quota=50)
    s, b, h = rig.post("/mcp", screen(1), key=key, headers={"X-Request-Id": "req-abc-1"})
    assert s == 200
    if exc is ZeroDivisionError:                       # an ArithmeticError is the caller's input, as before
        assert b["error"]["code"] == -32602
    else:
        assert b["error"]["code"] == -32603 and b["error"]["message"] == "engine error"
        assert b["error"]["data"] == {"request_id": "req-abc-1"}
        assert SECRET not in json.dumps(b) and "hunter2" not in json.dumps(b) and "/srv/" not in json.dumps(b)
        err = capsys.readouterr().err
        assert "request_id=req-abc-1" in err and "hunter2" in err, "the detail is logged server-side"
    assert [e["kind"] for e in rig.events()] == ["charge", "refund"] and net(rig) == 0
    assert h["X-GridForge-Charge-Cents"] == "0" and rig.meter.current("acme").units == 0


def test_a_request_id_is_generated_when_the_caller_sent_none(rig, monkeypatch):
    explode(monkeypatch, "/v1/screen")
    _, b, _ = rig.post("/mcp", screen(1), key=rig.key("payg", quota=50))
    rid = b["error"]["data"]["request_id"]
    assert len(rid) == 12 and int(rid, 16) >= 0


def test_a_hostile_request_id_header_is_cleaned_before_it_is_echoed(rig, monkeypatch):
    explode(monkeypatch, "/v1/screen")
    _, b, _ = rig.post("/mcp", screen(1), key=rig.key("payg", quota=50),
                       headers={"X-Request-Id": "a b<script>" + "x" * 100})
    rid = b["error"]["data"]["request_id"]
    assert " " not in rid and "<" not in rid and len(rid) <= 64


def test_a_failure_in_the_middle_of_a_batch_does_not_cost_the_others_their_replies(rig, monkeypatch):
    explode(monkeypatch, "/v1/screen")
    key = rig.key("payg", quota=500)
    s, b, h = rig.post("/mcp", [study(1), screen(2), study(3)], key=key)
    assert s == 200 and len(b) == 3
    by_id = {r["id"]: r for r in b}
    assert "error" not in by_id[1] and "error" not in by_id[3]
    assert by_id[2]["error"]["code"] == -32603 and SECRET not in json.dumps(b)
    assert net(rig) == 10 == rig.meter.current("acme").units, "net units == the two delivered studies"
    assert h["X-GridForge-Charge-Cents"] == "2000"
    refunds = [e for e in rig.events() if e["kind"] == "refund"]
    assert len(refunds) == 1 and next(e for e in rig.events() if e["id"] == refunds[0]["ref"])["endpoint"] == "/v1/screen"


def test_a_failing_first_and_last_call_in_a_batch(rig, monkeypatch):
    explode(monkeypatch, "/v1/screen")
    key = rig.key("payg", quota=500)
    _, b, _ = rig.post("/mcp", [screen(1), study(2), screen(3)], key=key)
    assert [("error" in r) for r in b] == [True, False, True] and net(rig) == 5


def test_an_unexpected_failure_in_a_free_call_does_not_refund_a_paid_sibling(rig, monkeypatch):
    explode(monkeypatch, "/v1/qualify")
    key = rig.key("payg", quota=500)
    q = tool(2, "gridforge_qualify", {"contracted_MW": 12, "current_site_peak_MW": 7.4, "busway_ampacity_A": 400,
                                     "tapoff_max_A": 63})
    _, b, _ = rig.post("/mcp", [study(1), q], key=key)
    assert "error" not in b[0] and b[1]["error"]["code"] == -32603
    assert net(rig) == 5 and [e["kind"] for e in rig.events()] == ["charge"]


def test_a_failure_outside_the_handler_is_contained_per_message(rig, monkeypatch):
    """An exception from the metering layer itself (not a handler) still yields a reply for that message only."""
    real = rig.meter.reserve_ex
    calls = []

    def flaky(*a, **k):
        calls.append(1)
        if len(calls) == 2:
            raise RuntimeError(SECRET)
        return real(*a, **k)
    monkeypatch.setattr(rig.meter, "reserve_ex", flaky)
    key = rig.key("payg", quota=500)
    s, b, _ = rig.post("/mcp", [screen(1), screen(2), screen(3)], key=key)
    assert s == 200 and len(b) == 3
    assert [("error" in r) for r in b] == [False, True, False]
    assert b[1]["error"]["code"] == -32603 and SECRET not in json.dumps(b)
    assert net(rig) == 2


def test_a_notification_that_fails_gets_no_reply_and_no_leak(rig, monkeypatch):
    explode(monkeypatch, "/v1/screen")
    note = {"jsonrpc": "2.0", "method": "tools/call", "params": {"name": "gridforge_screen", "arguments": {"intake": INTAKE}}}
    s, b, _ = rig.post("/mcp", [note, study(2)], key=rig.key("payg", quota=500))
    assert s == 200 and len(b) == 1 and b[0]["id"] == 2 and net(rig) == 5


def test_the_known_caller_errors_are_unchanged(rig):
    key = rig.key("payg", quota=50)
    _, b, _ = rig.post("/mcp", tool(1, "gridforge_screen", {"intake": {"grid": {"contracted_MW": "abc"}}}), key=key)
    assert b["error"]["code"] == -32602 and net(rig) == 0


def test_rest_still_refunds_and_does_not_leak_an_unexpected_failure(rig, monkeypatch):
    explode(monkeypatch, "/v1/screen")
    key = rig.key("payg", quota=50)
    s, b, _ = rig.post("/v1/screen", INTAKE, key=key)
    assert s == 500 and b["error"] == "engine error" and SECRET not in json.dumps(b)
    assert [e["kind"] for e in rig.events()] == ["charge", "refund"]


def test_an_idempotency_key_is_released_after_an_unexpected_failure(rig, monkeypatch):
    original = S.ROUTES["/v1/screen"]
    explode(monkeypatch, "/v1/screen")
    key = rig.key("payg", quota=50)
    h = {"Idempotency-Key": "retry-me"}
    rig.post("/mcp", screen(1), key=key, headers=h)
    monkeypatch.setitem(S.ROUTES, "/v1/screen", original)
    _, b, _ = rig.post("/mcp", screen(1), key=key, headers=h)
    assert "error" not in b and net(rig) == 1
