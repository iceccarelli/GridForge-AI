"""The usage ledger and the meter that writes it: caps, refunds, restarts, fail-closed durability.

These are the properties an invoice stands on. A cap that can be overshot is an uncapped bill, a refund that
leaves no trace is an unexplainable credit, and a ledger that silently stops recording is a free product.
"""
import json
import os
import threading
from concurrent.futures import ThreadPoolExecutor

import pytest

from gridforge.api import keys as K
from gridforge.api.ledger import Ledger
from gridforge.api.metering import Meter


def make(tmp_path, name="ledger.jsonl"):
    path = tmp_path / name
    return Meter(None, Ledger(path)), path


def events(path):
    return [json.loads(line) for line in path.read_text().splitlines()]


def reserve(m, account="acme", units=1, quota=0, scope="payg", **kw):
    return m.reserve_ex(account, "/v1/screen", units, quota, scope=scope, key_id="kid00001", **kw)


# --- the event shape ------------------------------------------------------------------------
def test_a_charge_event_has_exactly_the_published_shape(tmp_path):
    m, path = make(tmp_path)
    r = reserve(m, units=5, quota=50, project="hall-7", idem="k1")
    assert r.status == "ok"
    (ev,) = events(path)
    assert list(ev)[:11] == ["seq", "id", "ts", "kind", "account", "key_id", "scope", "endpoint",
                             "units", "project", "idem"]
    assert ev["ref"] == ""
    assert (ev["seq"], ev["kind"], ev["account"], ev["key_id"], ev["scope"], ev["endpoint"], ev["units"],
            ev["project"], ev["idem"]) == (1, "charge", "acme", "kid00001", "payg", "/v1/screen", 5,
                                           "hall-7", "k1")
    import uuid
    assert uuid.UUID(ev["id"]).version == 4 and ev["id"] == uuid.UUID(ev["id"]).hex
    assert ev["ts"].endswith("Z") and len(ev["ts"]) == 20


# --- caps -----------------------------------------------------------------------------------
def test_concurrent_reserves_never_exceed_the_cap_and_the_ledger_matches(tmp_path):
    m, path = make(tmp_path)
    cap = 20
    with ThreadPoolExecutor(16) as ex:
        out = list(ex.map(lambda _: reserve(m, quota=cap).status, range(120)))
    assert out.count("ok") == cap and out.count("over") == 100
    evs = events(path)
    assert len(evs) == cap
    assert [e["seq"] for e in evs] == list(range(1, cap + 1)), "seq must be monotonic and gapless"
    assert sum(e["units"] for e in evs) == cap == m.current("acme").units


def test_a_call_that_does_not_fit_is_not_partly_charged(tmp_path):
    m, path = make(tmp_path)
    assert reserve(m, units=4, quota=5).status == "ok"
    assert reserve(m, units=2, quota=5).status == "over"
    assert m.current("acme").units == 4 and len(events(path)) == 1


# --- refunds --------------------------------------------------------------------------------
def test_a_refund_writes_a_compensating_event_and_nets_to_zero(tmp_path):
    m, path = make(tmp_path)
    r = reserve(m, units=5, quota=50, idem="k1")
    m.refund_reservation(r)
    charge, refund = events(path)
    assert refund["kind"] == "refund" and refund["ref"] == charge["id"]
    assert (refund["account"], refund["units"], refund["endpoint"]) == ("acme", 5, "/v1/screen")
    assert refund["seq"] == 2
    assert m.current("acme").units == 0 and m.current("acme").calls == 0
    net = sum(e["units"] * (1 if e["kind"] == "charge" else -1) for e in events(path))
    assert net == 0


def test_a_refunded_idempotency_key_can_be_charged_again(tmp_path):
    """The first attempt produced no answer and was refunded, so the retry is the first real charge."""
    m, path = make(tmp_path)
    m.refund_reservation(reserve(m, idem="k1", quota=50))
    assert reserve(m, idem="k1", quota=50).status == "ok"
    assert reserve(m, idem="k1", quota=50).status == "replay"


# --- restart --------------------------------------------------------------------------------
def test_counters_and_seq_are_rebuilt_from_the_ledger_after_a_restart(tmp_path):
    m, path = make(tmp_path)
    reserve(m, units=3, quota=50)
    gone = reserve(m, units=4, quota=50)
    m.refund_reservation(gone)
    reserve(m, account="other", units=2, quota=50, scope="trial")

    again = Meter(None, Ledger(path))               # a new process: no usage file, only the ledger
    assert again.current("acme").units == 3 and again.current("acme").calls == 1
    assert again.current("other").units == 2
    r = reserve(again, units=1, quota=50)
    assert r.status == "ok" and again.current("acme").units == 4
    assert [e["seq"] for e in events(path)] == [1, 2, 3, 4, 5], "seq continues across the restart"


def test_the_ledger_wins_over_a_stale_usage_file_for_a_capped_account(tmp_path):
    """Crash between a refund being logged and the usage file being flushed: the invoice follows the ledger."""
    usage = tmp_path / "usage.json"
    led = tmp_path / "ledger.jsonl"
    m = Meter(str(usage), Ledger(led))
    r = reserve(m, units=5, quota=50)
    snapshot = usage.read_text()                    # what a crash would have left behind
    m.refund_reservation(r)
    usage.write_text(snapshot)
    again = Meter(str(usage), Ledger(led))
    assert again.current("acme").units == 0


def test_a_torn_final_line_is_dropped_and_the_next_event_lands_cleanly(tmp_path):
    m, path = make(tmp_path)
    reserve(m, units=2, quota=50)
    with open(path, "ab") as fh:
        fh.write(b'{"seq":2,"id":"deadbeef","ts":"2026-')           # a write that died midway
    again = Meter(None, Ledger(path))
    assert again.current("acme").units == 2
    assert reserve(again, units=1, quota=50).status == "ok"
    assert [e["seq"] for e in events(path)] == [1, 2]


def test_a_corrupt_ledger_in_the_middle_fails_closed_for_metered_keys(tmp_path):
    m, path = make(tmp_path)
    for _ in range(3):
        reserve(m, quota=50)
    lines = path.read_text().splitlines()
    lines[1] = "not json"
    path.write_text("\n".join(lines) + "\n")
    again = Meter(None, Ledger(path))
    assert reserve(again, quota=50).status == "unavailable"
    assert "corrupt" in again.ledger.status()
    assert reserve(again, scope="machine", quota=50).status == "ok", "a subscription key keeps today's behaviour"


# --- idempotency across a restart --------------------------------------------------------------
def test_an_idempotent_retry_is_not_charged_twice_even_after_a_restart(tmp_path):
    m, path = make(tmp_path)
    assert reserve(m, units=5, quota=50, idem="retry-1", body_sha="aaaa").status == "ok"
    again = Meter(None, Ledger(path))
    r = reserve(again, units=5, quota=50, idem="retry-1", body_sha="aaaa")
    assert r.status == "replay"
    assert again.current("acme").units == 5 and len(events(path)) == 1


def test_an_idempotency_key_reused_for_another_body_is_a_conflict_not_a_free_call(tmp_path):
    m, path = make(tmp_path)
    reserve(m, idem="retry-1", body_sha="aaaa", quota=50)
    again = Meter(None, Ledger(path))
    assert reserve(again, idem="retry-1", body_sha="bbbb", quota=50).status == "conflict"
    assert len(events(path)) == 1


def test_idempotency_keys_are_per_account_and_endpoint(tmp_path):
    m, _ = make(tmp_path)
    reserve(m, idem="k", quota=50)
    assert reserve(m, account="someone-else", idem="k", quota=50).status == "ok"
    assert m.reserve_ex("acme", "/v1/study", 5, 50, scope="payg", idem="k").status == "ok"


# --- fail closed ------------------------------------------------------------------------------
def test_a_payg_or_trial_charge_is_refused_when_the_ledger_cannot_be_written(tmp_path):
    m, path = make(tmp_path)
    assert reserve(m, units=1, quota=50).status == "ok"
    path.rename(tmp_path / "moved.jsonl")
    path.mkdir()                                     # the ledger path now cannot be opened for append
    for scope in ("payg", "trial"):
        r = reserve(m, units=1, quota=50, scope=scope)
        assert r.status == "unavailable", scope
    assert m.current("acme").units == 1, "a refused call must not change the counter"
    assert reserve(m, units=1, quota=50, scope="machine").status == "ok", "subscriptions keep running"


def test_unwritable_ledger_via_a_failing_append_is_refused_and_leaves_no_trace(tmp_path, monkeypatch):
    m, path = make(tmp_path)
    reserve(m, units=1, quota=50)

    def boom(*a, **k):
        raise OSError("disk full")
    monkeypatch.setattr(os, "fsync", boom)
    for scope in ("payg", "trial"):
        assert reserve(m, units=1, quota=50, scope=scope).status == "unavailable"
    monkeypatch.undo()
    assert m.current("acme").units == 1
    assert [e["seq"] for e in events(path)] == [1], "a failed append was truncated away, not left torn"
    assert reserve(m, units=1, quota=50).status == "ok"          # and the ledger recovers by itself
    assert [e["seq"] for e in events(path)] == [1, 2]


def test_no_ledger_configured_refuses_metered_keys_but_not_subscriptions():
    m = Meter(None, Ledger(None))
    assert reserve(m, quota=5, scope="payg").status == "unavailable"
    assert reserve(m, quota=5, scope="trial").status == "unavailable"
    assert reserve(m, quota=5, scope="machine").status == "ok"
    assert reserve(m, quota=0, scope="client").status == "ok"


def test_a_capped_scope_with_no_cap_is_never_unlimited(tmp_path):
    m, _ = make(tmp_path)
    for scope in ("payg", "trial"):
        assert reserve(m, quota=0, scope=scope).status == "unavailable"


def test_static_and_subscription_keys_are_logged_when_the_ledger_is_writable(tmp_path):
    m, path = make(tmp_path)
    assert reserve(m, scope="machine", units=3, quota=100).status == "ok"
    assert [(e["scope"], e["units"]) for e in events(path)] == [("machine", 3)]


def test_a_refund_that_cannot_be_written_is_retried_before_the_next_event(tmp_path, monkeypatch):
    m, path = make(tmp_path)
    r = reserve(m, units=2, quota=50)
    real = m.ledger.append
    state = {"fail": True}

    def flaky(**kw):
        if state["fail"]:
            from gridforge.api.ledger import LedgerError
            raise LedgerError("transient")
        return real(**kw)
    monkeypatch.setattr(m.ledger, "append", flaky)
    m.refund_reservation(r)
    assert m.current("acme").units == 0 and len(events(path)) == 1
    state["fail"] = False
    reserve(m, units=1, quota=50)
    kinds = [e["kind"] for e in events(path)]
    assert kinds == ["charge", "refund", "charge"], "the owed refund lands before the new charge"


# --- keys: payg scope and zero caps -----------------------------------------------------------
@pytest.fixture
def secret(monkeypatch):
    monkeypatch.setenv("GRIDFORGE_KEY_SECRET", "payg-test-secret")
    monkeypatch.delenv("GRIDFORGE_REVOKED_KEYS", raising=False)
    monkeypatch.delenv("GRIDFORGE_REVOKED_FILE", raising=False)


def test_payg_is_a_signed_key_scope(secret):
    tok = K.issue("acme", quota=50, scope="payg")
    k = K.verify(tok)
    assert (k.scope, k.quota) == ("payg", 50)
    assert K.inspect(tok)["valid"] is True


@pytest.mark.parametrize("scope", ["payg", "trial"])
def test_a_zero_quota_payg_or_trial_key_is_refused_at_issue(secret, scope):
    with pytest.raises(K.KeyError_) as exc:
        K.issue("acme", quota=0, scope=scope)
    assert "cap" in str(exc.value)
    with pytest.raises(K.KeyError_):
        K.issue("acme", quota=-3, scope=scope)


@pytest.mark.parametrize("scope", ["payg", "trial"])
def test_a_zero_quota_payg_or_trial_key_is_refused_at_verify(secret, scope):
    """A key minted by something else (an older website build, a hand-built token) is still refused."""
    import base64
    import hashlib
    import hmac
    payload = {"a": "acme", "k": "00ff00ff", "q": 0, "s": scope, "i": "2026-10-01", "e": "2099-01-01"}
    enc = base64.urlsafe_b64encode(json.dumps(payload, separators=(",", ":"), sort_keys=True).encode()).decode().rstrip("=")
    body = f"gfk1.{enc}"
    sig = base64.urlsafe_b64encode(hmac.new(K.secret(), body.encode(), hashlib.sha256).digest()).decode().rstrip("=")
    with pytest.raises(K.KeyError_) as exc:
        K.verify(f"{body}.{sig}")
    assert "no unit cap" in str(exc.value)


def test_subscription_keys_may_still_be_unlimited(secret):
    assert K.verify(K.issue("acme", quota=0, scope="machine")).quota == 0


def test_the_ts_twin_accepts_the_payg_scope():
    src = open(os.path.join(os.path.dirname(__file__), "..", "lib", "api-access.ts")).read()
    assert '"machine" | "client" | "trial" | "payg"' in src


def test_a_python_issued_payg_key_matches_the_canonical_payload(secret):
    tok = K.issue("acme", quota=50, scope="payg", key_id="deadbeef", issued_on=__import__("datetime").date(2026, 10, 1))
    import base64
    payload = tok.split(".")[1]
    raw = base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)).decode()
    assert raw == '{"a":"acme","e":"2026-11-05","i":"2026-10-01","k":"deadbeef","q":50,"s":"payg"}'


def test_the_ledger_is_safe_under_parallel_writers_of_different_accounts(tmp_path):
    m, path = make(tmp_path)

    def work(i):
        for _ in range(25):
            reserve(m, account=f"a{i}", quota=1000)
    ts = [threading.Thread(target=work, args=(i,)) for i in range(8)]
    [t.start() for t in ts]
    [t.join() for t in ts]
    evs = events(path)
    assert [e["seq"] for e in evs] == list(range(1, 201))
    assert Meter(None, Ledger(path)).current("a3").units == 25
