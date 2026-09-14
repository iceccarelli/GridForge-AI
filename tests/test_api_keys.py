"""Signed keys, and the two things that must never be true about them.

A self-serve key is a bearer credential minted by one language and verified by
another, with no shared runtime and no database between them. Two failure modes
matter more than any feature:

  1. A key that verifies when it should not — forged, expired, revoked, or signed
     with the wrong secret. That one loses money quietly.
  2. A key the website mints that the engine rejects. That one is worse: it fails
     at the moment a stranger has just paid, and nothing in either codebase notices
     because both halves work perfectly on their own.

The second is why the cross-language test exists.
"""
import json
import os
import shutil
import subprocess
import sys
from datetime import date, timedelta
from pathlib import Path

import pytest

from gridforge.api import keys as K
from gridforge.api.metering import Meter, plan_for, refusal

ROOT = Path(__file__).resolve().parents[1]
SECRET = "test-secret-do-not-use"


@pytest.fixture(autouse=True)
def secret(monkeypatch):
    monkeypatch.setenv("GRIDFORGE_KEY_SECRET", SECRET)
    monkeypatch.delenv("GRIDFORGE_REVOKED_KEYS", raising=False)
    monkeypatch.delenv("GRIDFORGE_API_KEYS", raising=False)


# --- minting ---------------------------------------------------------------

def test_a_key_round_trips_with_its_plan_intact():
    tok = K.issue("acme-ops", quota=2500, scope="machine")
    k = K.verify(tok)
    assert k.account == "acme-ops"
    assert k.quota == 2500
    assert k.scope == "machine"
    assert k.days_left > 30


def test_no_secret_means_no_key_rather_than_an_unsigned_one(monkeypatch):
    monkeypatch.delenv("GRIDFORGE_KEY_SECRET")
    with pytest.raises(K.KeyError_, match="not set"):
        K.issue("acme", quota=10)
    with pytest.raises(K.KeyError_, match="not enabled"):
        K.verify("gfk1.aaa.bbb")


def test_a_key_must_name_an_account():
    with pytest.raises(K.KeyError_, match="account"):
        K.issue("   ", quota=10)


def test_validity_overlaps_the_billing_period():
    """35 days, not 30. A subscription renewing on the 1st must not leave a
    customer's agents dark for the hours between the renewal and the webhook."""
    k = K.verify(K.issue("acme", quota=10))
    assert 30 < k.days_left <= 40


# --- rejection -------------------------------------------------------------

def test_a_tampered_payload_does_not_verify():
    tok = K.issue("acme", quota=10)
    prefix, payload, sig = tok.split(".")
    forged = K.issue("acme", quota=1_000_000)
    bad = f"{prefix}.{forged.split('.')[1]}.{sig}"
    with pytest.raises(K.KeyError_, match="signature"):
        K.verify(bad)


def test_a_key_signed_with_another_secret_does_not_verify(monkeypatch):
    tok = K.issue("acme", quota=10)
    monkeypatch.setenv("GRIDFORGE_KEY_SECRET", "a-different-secret")
    with pytest.raises(K.KeyError_, match="signature"):
        K.verify(tok)


def test_an_expired_key_says_so_rather_than_saying_invalid():
    """'Invalid key' sends an integrator hunting a typo when their subscription
    lapsed three days ago."""
    old = K.issue("acme", quota=10, days=1, issued_on=date.today() - timedelta(days=10))
    with pytest.raises(K.KeyError_, match="expired on"):
        K.verify(old)


def test_a_revoked_key_stops_immediately(monkeypatch):
    tok = K.issue("acme", quota=10)
    monkeypatch.setenv("GRIDFORGE_REVOKED_KEYS", K.verify(tok).key_id + ",someone-else")
    with pytest.raises(K.KeyError_, match="revoked"):
        K.verify(tok)


@pytest.mark.parametrize("junk", ["", "nonsense", "gfk1.only-two", "gfk9.a.b", "gfk1..",
                                  "gfk1.!!!.###"])
def test_junk_is_refused_without_raising_anything_unexpected(junk):
    with pytest.raises(K.KeyError_):
        K.verify(junk)


def test_pinning_the_report_date_cannot_extend_a_key(monkeypatch):
    """GRIDFORGE_REPORT_DATE exists so documents regenerate identically. If it also
    moved this clock, a build flag would quietly become a security control."""
    expired = K.issue("acme", quota=10, days=1, issued_on=date.today() - timedelta(days=30))
    monkeypatch.setenv("GRIDFORGE_REPORT_DATE", "2000-01-01")
    with pytest.raises(K.KeyError_, match="expired"):
        K.verify(expired)


# --- what the caller is told ----------------------------------------------

def test_refusal_distinguishes_the_three_reasons(monkeypatch):
    assert "API key is required" in refusal("")["error"]
    expired = K.issue("acme", quota=1, days=1, issued_on=date.today() - timedelta(days=9))
    assert "expired" in refusal(expired)["error"]
    live = K.issue("acme", quota=1)
    monkeypatch.setenv("GRIDFORGE_REVOKED_KEYS", K.verify(live).key_id)
    assert "revoked" in refusal(live)["error"]


def test_inspect_reads_a_key_without_trusting_it(monkeypatch):
    tok = K.issue("acme", quota=99)
    assert K.inspect(tok)["valid"] is True
    monkeypatch.setenv("GRIDFORGE_KEY_SECRET", "other")
    d = K.inspect(tok)
    assert d["valid"] is False
    assert d["account"] == "acme", "inspect must still read a key it cannot trust"
    assert d["monthly_quota"] == 99


# --- metering integration --------------------------------------------------

def test_a_signed_key_carries_its_plan_into_the_meter():
    tok = K.issue("bigco", quota=2500)
    plan = plan_for(tok)
    assert plan is not None
    assert plan.account == "bigco"
    assert plan.monthly_quota == 2500
    assert plan.scope == "machine"


def test_static_keys_win_over_signed_ones(monkeypatch):
    """An operator pasting a key into the environment at 2am to get a customer
    working again must not be overridden by anything cleverer."""
    tok = K.issue("bigco", quota=10)
    monkeypatch.setenv("GRIDFORGE_API_KEYS", f"{tok}:rescue:999999")
    assert plan_for(tok).monthly_quota == 999999


def test_usage_follows_the_account_not_the_key():
    """A customer who rotates a key mid-month has not started a new month."""
    m = Meter(None)
    first = K.issue("acme", quota=100)
    second = K.issue("acme", quota=100)
    assert first != second
    m.record(plan_for(first).account, "/v1/study", 5)
    m.record(plan_for(second).account, "/v1/study", 5)
    assert m.current("acme").units == 10, "rotation handed out a second free allowance"


def test_quota_is_enforced_against_the_account():
    m = Meter(None)
    tok = K.issue("acme", quota=10)
    plan = plan_for(tok)
    m.record(plan.account, "/v1/study", 5)
    assert m.would_exceed(plan.account, 5, plan.monthly_quota) is False
    assert m.would_exceed(plan.account, 6, plan.monthly_quota) is True


# --- the cross-language contract -------------------------------------------

NODE_MINT = r"""
const crypto = require('node:crypto');
const PREFIX = 'gfk1';
const secret = process.env.GRIDFORGE_KEY_SECRET;
const payload = JSON.parse(process.argv[1]);
const canonical = JSON.stringify(payload, Object.keys(payload).sort());
const body = PREFIX + '.' + Buffer.from(canonical).toString('base64url');
const sig = crypto.createHmac('sha256', secret).update(body).digest().toString('base64url');
process.stdout.write(body + '.' + sig);
"""


@pytest.mark.skipif(shutil.which("node") is None, reason="node is not installed")
def test_a_key_minted_by_the_website_verifies_here():
    """lib/api-access.ts and gridforge/api/keys.py must agree byte for byte.

    They have no shared runtime, so a divergence would not fail loudly — it would
    issue keys that quietly do not work, to customers who have just paid.
    """
    # Dates relative to today, not literals. A fixture pinned to a calendar date
    # is a test that passes until the date passes — and this one would then fail
    # on expiry, which looks exactly like the divergence it exists to catch.
    issued = date.today()
    expires = issued + timedelta(days=35)
    payload = {"a": "acme", "k": "deadbeef", "q": 2500, "s": "machine",
               "i": issued.isoformat(), "e": expires.isoformat()}
    r = subprocess.run(["node", "-e", NODE_MINT, json.dumps(payload)],
                       capture_output=True, text=True,
                       env={**os.environ, "GRIDFORGE_KEY_SECRET": SECRET})
    assert r.returncode == 0, r.stderr
    from_node = r.stdout.strip()

    k = K.verify(from_node)
    assert (k.account, k.quota, k.scope) == ("acme", 2500, "machine")

    from_python = K.issue("acme", quota=2500, scope="machine", key_id="deadbeef",
                          issued_on=issued, days=35)
    assert from_python == from_node, (
        "the two implementations no longer produce the same bytes:\n"
        f"  python: {from_python}\n  node:   {from_node}")


@pytest.mark.skipif(shutil.which("node") is None, reason="node is not installed")
def test_the_website_and_the_engine_use_the_same_canonical_form():
    """Key order and separators, specifically. Both sides sort keys and use tight
    separators; if either changes, every key the site issues stops verifying."""
    src = (ROOT / "lib" / "api-access.ts").read_text()
    assert "Object.keys(payload).sort()" in src, (
        "the website no longer sorts payload keys before signing")
    assert 'PREFIX = "gfk1"' in src
    py = (ROOT / "gridforge" / "api" / "keys.py").read_text()
    assert 'sort_keys=True' in py
    assert 'separators=(",", ":")' in py
