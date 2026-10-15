"""The revocation store contract: a revocation is durable, or the engine says it is not.

`revocation_persistable()` is what lets the website refuse to SELL a key it could not later kill, so it must
prove durability by doing the same kind of write -- not by checking that a path looks writable -- and it must
do so without touching the live revoked-ID set.
"""
import json
import os
import stat

import pytest

from gridforge.api import keys


@pytest.fixture
def store(tmp_path, monkeypatch):
    path = tmp_path / "vol" / "revoked.json"
    monkeypatch.setenv("GRIDFORGE_REVOKED_FILE", str(path))
    monkeypatch.delenv("FLY_MACHINE_ID", raising=False)
    keys._revoked_cache = (-1.0, frozenset())
    monkeypatch.setattr(keys, "_store_seen", False)
    return path


def test_no_configured_store_is_not_persistable(monkeypatch):
    monkeypatch.delenv("GRIDFORGE_REVOKED_FILE", raising=False)
    assert keys.revocation_persistable() is False
    assert keys.revoke("abc12345") is False                      # and revoke() says so rather than pretend


def test_a_real_write_flush_rename_readback_is_what_qualifies(store):
    assert keys.revocation_persistable() is True
    assert list(store.parent.iterdir()) == []                    # the probe cleans up after itself


def test_the_probe_never_touches_the_live_revoked_set(store):
    assert keys.revoke("deadbeef") is True
    before = store.read_text()
    mtime = store.stat().st_mtime_ns
    for _ in range(3):
        assert keys.revocation_persistable() is True
    assert store.read_text() == before and store.stat().st_mtime_ns == mtime
    assert keys.revoked_ids() >= {"deadbeef"}


@pytest.mark.skipif(os.geteuid() == 0, reason="root ignores directory permissions")
def test_an_unwritable_directory_is_not_persistable(store):
    store.parent.mkdir(parents=True)
    store.parent.chmod(stat.S_IRUSR | stat.S_IXUSR)
    try:
        assert keys.revocation_persistable() is False
        assert keys.revoke("abc12345") is False
    finally:
        store.parent.chmod(stat.S_IRWXU)


def test_a_path_that_cannot_exist_is_not_persistable(monkeypatch):
    monkeypatch.setenv("GRIDFORGE_REVOKED_FILE", "/proc/definitely/not/here/revoked.json")
    assert keys.revocation_persistable() is False


def test_on_fly_an_ephemeral_directory_that_is_not_a_mounted_volume_is_not_persistable(store, monkeypatch):
    """A machine added without its own volume has an ephemeral /data that would drop every revocation."""
    monkeypatch.setenv("FLY_MACHINE_ID", "m-test")
    assert keys.revocation_persistable() is False                # tmp dir is on the root device


def test_a_revocation_is_on_disk_and_a_fresh_reader_sees_it(store):
    assert keys.revoke("cafe0001") is True
    assert json.loads(store.read_text())["revoked"] == ["cafe0001"]
    keys._revoked_cache = (-1.0, frozenset())                    # as a restarted process would start
    assert "cafe0001" in keys.revoked_ids()
    assert not list(store.parent.glob("*.tmp"))


def test_a_revocation_that_cannot_be_persisted_is_a_503_never_a_claimed_success(monkeypatch):
    from gridforge.api.server import ApiError, handle_revoke
    from gridforge.api.tiers import Tier
    monkeypatch.delenv("GRIDFORGE_REVOKED_FILE", raising=False)
    with pytest.raises(ApiError) as e:
        handle_revoke({"key_id": "abc12345"}, Tier.INTERNAL)
    assert e.value.status == 503


# --- fails closed: a store that cannot be trusted must not un-revoke anything ---------------------

def _signed(monkeypatch, kid="kid00001"):
    monkeypatch.setenv("GRIDFORGE_KEY_SECRET", "x" * 32)
    return keys.issue("acct", quota=10, key_id=kid)


def test_a_vanished_store_stops_signed_keys_rather_than_reviving_revoked_ones(store, monkeypatch):
    tok = _signed(monkeypatch)
    keys.verify(tok)                                   # fresh deployment, nothing revoked: fine
    assert keys.revoke("otherkey")
    keys.verify(tok)                                   # store now seen
    store.unlink()                                     # volume unmounted / replaced
    keys._revoked_cache = (-1.0, frozenset())
    with pytest.raises(keys.KeyError_, match="cannot be verified right now"):
        keys.verify(tok)


def test_a_corrupt_store_stops_signed_keys(store, monkeypatch):
    tok = _signed(monkeypatch)
    assert keys.revoke("kid00001")
    store.write_text('{"revoked":["kid00001"')          # truncated write
    keys._revoked_cache = (-1.0, frozenset())           # as after a restart
    with pytest.raises(keys.KeyError_, match="cannot be verified right now"):
        keys.verify(tok)
    store.write_text(json.dumps({"revoked": ["kid00001"]}))
    with pytest.raises(keys.KeyError_, match="revoked"):
        keys.verify(tok)


def test_a_non_ascii_signature_is_a_clean_rejection_not_a_crash(monkeypatch):
    tok = _signed(monkeypatch)
    head, _ = tok.rsplit(".", 1)
    with pytest.raises(keys.KeyError_):
        keys.verify(head + ".sigé")
