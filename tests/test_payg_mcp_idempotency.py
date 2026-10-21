"""Idempotency-Key over MCP: the same no-double-charge guarantee REST has, including across an engine restart,
and the shutdown path that flushes refunds still owed to a customer."""
import signal

import pytest

from gridforge.api import server as S
from gridforge.api.ledger import Ledger, LedgerError
from gridforge.api.metering import Meter
from payg_rig import INTAKE, rig  # noqa: F401  (fixture)

H = {"Idempotency-Key": "agent-run-1"}


def call(i, intake=INTAKE, name="gridforge_screen"):
    return {"jsonrpc": "2.0", "id": i, "method": "tools/call",
            "params": {"name": name, "arguments": {"intake": intake}}}


def charges(rig):
    return [e for e in rig.events() if e["kind"] == "charge"]


OTHER = {"grid": {"contracted_MW": 9, "firm_capacity_MVA": 9}}


def test_a_retried_mcp_call_is_charged_once_and_answered_identically(rig):
    key = rig.key("payg", quota=50)
    s1, b1, h1 = rig.post("/mcp", call(1), key=key, headers=H)
    s2, b2, h2 = rig.post("/mcp", call(1), key=key, headers=H)
    assert s1 == s2 == 200 and "error" not in b1 and b2 == b1
    assert "X-GridForge-Idempotent-Replay" not in h1 and h1["X-GridForge-Charge-Cents"] == "200"
    assert h2["X-GridForge-Idempotent-Replay"] == "true" and h2["X-GridForge-Charge-Cents"] == "0"
    assert len(charges(rig)) == 1 and rig.meter.current("acme").units == 1
    assert charges(rig)[0]["idem"] == "agent-run-1"


def test_an_mcp_retry_is_free_after_an_engine_restart(rig):
    key = rig.key("payg", quota=50)
    _, b1, _ = rig.post("/mcp", call(1), key=key, headers=H)
    rig.restart()                         # response cache gone; only the ledger remembers
    s, b2, h2 = rig.post("/mcp", call(1), key=key, headers=H)
    assert s == 200 and "error" not in b2 and b2["result"] == b1["result"]
    assert h2["X-GridForge-Idempotent-Replay"] == "true" and h2["X-GridForge-Units"] == "0"
    assert len(charges(rig)) == 1 and rig.meter.current("acme").units == 1


@pytest.mark.parametrize("restart", [False, True])
def test_reusing_a_key_for_another_mcp_request_is_refused(rig, restart):
    key = rig.key("payg", quota=50)
    rig.post("/mcp", call(1), key=key, headers=H)
    if restart:
        rig.restart()
    s, b, _ = rig.post("/mcp", call(2, OTHER), key=key, headers=H)
    assert s == 200 and b["error"]["code"] == -32602
    assert "different request body" in b["error"]["message"]
    assert len(charges(rig)) == 1


def test_a_batch_derives_a_key_per_call_from_its_index(rig):
    key = rig.key("payg", quota=50)
    batch = [call(1), call(2, OTHER)]
    _, b1, _ = rig.post("/mcp", batch, key=key, headers=H)
    assert all("error" not in r for r in b1)
    assert sorted(e["idem"] for e in charges(rig)) == ["agent-run-1#0", "agent-run-1#1"]
    rig.restart()
    s, b2, h2 = rig.post("/mcp", batch, key=key, headers=H)
    assert s == 200 and [r["result"] for r in b2] == [r["result"] for r in b1]
    assert h2["X-GridForge-Idempotent-Replay"] == "true"
    assert len(charges(rig)) == 2 and rig.meter.current("acme").units == 2
    assert h2["X-GridForge-Charge-Cents"] == "0"


def test_a_batch_retry_with_one_changed_call_refuses_only_that_call(rig):
    key = rig.key("payg", quota=50)
    rig.post("/mcp", [call(1), call(2, OTHER)], key=key, headers=H)
    rig.restart()
    _, b, _ = rig.post("/mcp", [call(1), call(2, INTAKE)], key=key, headers=H)
    assert "error" not in b[0] and b[1]["error"]["code"] == -32602
    assert len(charges(rig)) == 2


def test_the_same_call_at_another_batch_position_is_a_different_request(rig):
    key = rig.key("payg", quota=50)
    rig.post("/mcp", [call(1), call(2)], key=key, headers=H)
    assert len(charges(rig)) == 2


def test_a_failed_mcp_call_is_refunded_and_its_key_can_be_used_again(rig):
    key = rig.key("payg", quota=50)
    bad = call(1, {"grid": {"contracted_MW": "abc"}})
    _, b, _ = rig.post("/mcp", bad, key=key, headers=H)
    assert b["error"]
    _, b, _ = rig.post("/mcp", call(2, OTHER), key=key, headers=H)
    assert "error" not in b, "the failed attempt released the key"
    assert [e["kind"] for e in rig.events()] == ["charge", "refund", "charge"]
    assert rig.meter.current("acme").units == 1


def test_an_mcp_key_is_scoped_to_the_account(rig):
    a, b = rig.key("payg", quota=50, account="acme"), rig.key("payg", quota=50, account="globex")
    rig.post("/mcp", call(1), key=a, headers=H)
    _, r, h = rig.post("/mcp", call(1), key=b, headers=H)
    assert "error" not in r and "X-GridForge-Idempotent-Replay" not in h
    assert len(charges(rig)) == 2


def test_the_header_is_ignored_without_an_api_key_and_for_the_estimator(rig):
    q = {"jsonrpc": "2.0", "id": 1, "method": "tools/call",
         "params": {"name": "gridforge_estimate", "arguments": {"endpoint": "/v1/study"}}}
    key = rig.key("payg", quota=50)
    for _ in range(2):
        s, b, h = rig.post("/mcp", q, key=key, headers=H)
        assert s == 200 and "error" not in b and "X-GridForge-Idempotent-Replay" not in h
    for _ in range(2):
        assert rig.post("/mcp", q, headers=H)[0] == 200
    assert rig.events() == []


def test_an_overlong_mcp_key_is_refused_and_charges_nothing(rig):
    _, b, _ = rig.post("/mcp", call(1), key=rig.key(), headers={"Idempotency-Key": "k" * 201})
    assert b["error"]["code"] == -32602 and "200" in b["error"]["message"]
    assert rig.events() == []


def test_a_keyed_trial_call_over_mcp_replays_without_a_second_unit(rig):
    key = rig.key("trial", quota=25, account="free1")
    rig.post("/mcp", call(1), key=key, headers=H)
    rig.restart()
    _, b, h = rig.post("/mcp", call(1), key=key, headers=H)
    assert "error" not in b and h["X-GridForge-Idempotent-Replay"] == "true"
    assert rig.meter.current("free1").units == 1 and len(charges(rig)) == 1


def test_a_keyed_replay_at_the_cap_is_still_served_free(rig):
    """The retry of a call that was paid for must not be turned into a 402 because the cap is now full."""
    key = rig.key("trial", quota=1, account="free1")
    _, b1, _ = rig.post("/mcp", call(1), key=key, headers=H)
    rig.restart()
    _, b2, h2 = rig.post("/mcp", call(1), key=key, headers=H)
    assert "error" not in b2 and b2["result"] == b1["result"] and h2["X-GridForge-Idempotent-Replay"] == "true"
    _, b3, _ = rig.post("/mcp", call(3, OTHER), key=key, headers={"Idempotency-Key": "agent-run-2"})
    assert b3["error"]["code"] == -32002


# --- shutdown: a refund owed to a customer is flushed on the way down -----------------------------
def _meter_with_a_queued_refund(tmp_path, monkeypatch):
    m = Meter(None, Ledger(tmp_path / "ledger.jsonl"))
    res = m.reserve_ex("acme", "/v1/screen", 2, 50, scope="payg", key_id="kid00001")
    real = m.ledger.append
    state = {"down": True}

    def flaky(**kw):
        if state["down"]:
            raise LedgerError("transient")
        return real(**kw)
    monkeypatch.setattr(m.ledger, "append", flaky)
    m.refund_reservation(res)
    assert m.pending_refunds == 1
    state["down"] = False
    return m


def _kinds(tmp_path):
    import json
    return [json.loads(x)["kind"] for x in (tmp_path / "ledger.jsonl").read_text().splitlines()]


def test_close_flushes_a_queued_refund(tmp_path, monkeypatch):
    m = _meter_with_a_queued_refund(tmp_path, monkeypatch)
    assert _kinds(tmp_path) == ["charge"]
    m.close()
    assert m.pending_refunds == 0 and _kinds(tmp_path) == ["charge", "refund"]
    m.close()                                           # idempotent
    assert _kinds(tmp_path) == ["charge", "refund"]
    assert Meter(None, Ledger(tmp_path / "ledger.jsonl")).current("acme").units == 0


def test_graceful_stop_flushes_through_the_shutdown_path_the_server_uses(tmp_path, monkeypatch):
    m = _meter_with_a_queued_refund(tmp_path, monkeypatch)
    httpd = S.make_server("127.0.0.1", 0)
    S.graceful_stop(httpd, m)
    assert _kinds(tmp_path) == ["charge", "refund"]


def test_close_never_raises_when_the_ledger_is_still_down(tmp_path, monkeypatch, capsys):
    m = _meter_with_a_queued_refund(tmp_path, monkeypatch)
    monkeypatch.setattr(m.ledger, "append", lambda **kw: (_ for _ in ()).throw(LedgerError("down")))
    m.close()
    assert m.pending_refunds == 1
    assert "could not be written" in capsys.readouterr().err


def test_sigterm_is_turned_into_the_graceful_path_not_a_hard_kill():
    old = signal.getsignal(signal.SIGTERM)
    try:
        S.install_signal_handlers()
        handler = signal.getsignal(signal.SIGTERM)
        assert callable(handler) and handler is not old
        with pytest.raises(KeyboardInterrupt):
            handler(signal.SIGTERM, None)
    finally:
        signal.signal(signal.SIGTERM, old)
