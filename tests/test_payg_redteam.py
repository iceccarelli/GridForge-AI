"""Red-team regressions found against the engine: a revocation deadlock, an unbounded MCP batch and an
unbounded idempotency cache. Each test was written to fail before the fix."""
import json
import threading

from gridforge.api import keys as K


# --- F1: revoke() must not deadlock on a pre-existing store ------------------------------------
def test_revoke_with_a_preexisting_store_does_not_deadlock(tmp_path, monkeypatch):
    store = tmp_path / "revoked.json"
    store.write_text(json.dumps({"revoked": ["oldkey01"]}))
    monkeypatch.setenv("GRIDFORGE_REVOKED_FILE", str(store))
    monkeypatch.setenv("GRIDFORGE_KEY_SECRET", "redteam-secret")
    monkeypatch.delenv("GRIDFORGE_REVOKED_KEYS", raising=False)
    # A fresh process: nothing cached, the file already on disk (the first call after a restart).
    monkeypatch.setattr(K, "_revoked_cache", (-1.0, frozenset()))
    monkeypatch.setattr(K, "_store_seen", False)
    result = {}

    def work():
        result["revoked"] = K.revoke("newkey02")
        tok = K.issue("acme", quota=5)
        result["verified"] = K.verify(tok).account

    t = threading.Thread(target=work, daemon=True)
    t.start()
    t.join(5)
    assert not t.is_alive(), "revoke() deadlocked on its own lock when the store already existed"
    assert result["revoked"] is True and result["verified"] == "acme"
    assert K.revoked_ids() == {"oldkey01", "newkey02"}
