"""Killing a leaked key now, rather than at expiry.

Keys expire on their own, and for a lapsed subscription that is the whole answer:
the webhook stops reissuing and the key dies inside the period the customer paid
for. A LEAKED key is the case that cannot wait, and the only lever used to be
GRIDFORGE_REVOKED_KEYS — an environment variable, which means a redeploy, which
means the leaked key kept working until somebody did one by hand.

The constraint this had to respect is the reason the key design exists at all:
verification is offline. No database, no network call, no lookup per request. So
revocation is a local file the engine owns, read through an mtime check, written
once at the moment of revocation.
"""
import json

import pytest

from gridforge.api import keys as K


@pytest.fixture(autouse=True)
def clean_env(monkeypatch, tmp_path):
    monkeypatch.delenv("GRIDFORGE_REVOKED_KEYS", raising=False)
    monkeypatch.setenv("GRIDFORGE_REVOKED_FILE", str(tmp_path / "revoked.json"))
    monkeypatch.setenv("GRIDFORGE_KEY_SECRET", "test-revocation-secret")
    # The module caches on mtime; each test starts from nothing.
    K._revoked_cache = (-1.0, frozenset())
    yield


def test_a_revoked_key_stops_verifying_without_a_redeploy():
    token = K.issue("acme", quota=100)
    live = K.verify(token)
    assert K.revoke(live.key_id) is True
    with pytest.raises(K.KeyError_) as exc:
        K.verify(token)
    assert "revoked" in str(exc.value)


def test_the_environment_variable_keeps_working_exactly_as_before(monkeypatch):
    """Deployments that revoke by env var must not be broken by adding a store."""
    token = K.issue("acme", quota=100)
    kid = K.verify(token).key_id
    monkeypatch.setenv("GRIDFORGE_REVOKED_KEYS", kid)
    with pytest.raises(K.KeyError_):
        K.verify(token)


def test_both_sources_are_honoured_together(monkeypatch):
    a = K.verify(K.issue("a", quota=1, key_id="aaaaaaaa")).key_id
    monkeypatch.setenv("GRIDFORGE_REVOKED_KEYS", a)
    K.revoke("bbbbbbbb")
    assert K.revoked_ids() == {"aaaaaaaa", "bbbbbbbb"}


def test_revocation_survives_a_restart(tmp_path, monkeypatch):
    K.revoke("deadbeef")
    # A fresh process: clear the cache and read the file again.
    K._revoked_cache = (-1.0, frozenset())
    assert "deadbeef" in K.revoked_ids()
    stored = json.loads((tmp_path / "revoked.json").read_text())
    assert stored["revoked"] == ["deadbeef"]


def test_revoking_is_idempotent():
    assert K.revoke("cafebabe") is True
    assert K.revoke("cafebabe") is True
    assert sorted(K.revoked_ids()) == ["cafebabe"]


def test_revoking_one_key_does_not_touch_another():
    keep = K.issue("keep", quota=1, key_id="11111111")
    kill = K.issue("kill", quota=1, key_id="22222222")
    K.revoke("22222222")
    assert K.verify(keep).account == "keep"
    with pytest.raises(K.KeyError_):
        K.verify(kill)


def test_it_reports_failure_rather_than_a_revocation_that_did_not_happen(monkeypatch):
    """A caller told 'revoked' stops looking for the leaked key."""
    monkeypatch.delenv("GRIDFORGE_REVOKED_FILE", raising=False)
    K._revoked_cache = (-1.0, frozenset())
    assert K.revoke("deadbeef") is False


def test_an_empty_id_is_refused():
    assert K.revoke("") is False
    assert K.revoke("   ") is False


def test_an_unreadable_store_does_not_silently_un_revoke(tmp_path):
    K.revoke("deadbeef")
    assert "deadbeef" in K.revoked_ids()
    # Corrupt it. The last known set must survive rather than emptying, because
    # emptying would quietly bring a leaked key back to life.
    (tmp_path / "revoked.json").write_text("{ this is not json")
    K._revoked_cache = (K._revoked_cache[0] - 1, K._revoked_cache[1])
    assert "deadbeef" in K.revoked_ids()


def test_no_store_configured_is_simply_no_stored_revocations():
    """The default deployment has none, and must behave exactly as it always did."""
    import os
    os.environ.pop("GRIDFORGE_REVOKED_FILE", None)
    K._revoked_cache = (-1.0, frozenset())
    assert K.revoked_ids() == set()
    token = K.issue("acme", quota=1)
    assert K.verify(token).account == "acme"
