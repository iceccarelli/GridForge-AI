"""One answer to "would this survive a restart?" for every piece of engine state (gridforge/api/keys.py on_volume).

On Fly a directory on the root device is the machine's ephemeral disk. The ledger and the revocation store already refused it; the
usage counter and the cost file reported themselves durable anyway, and POST /v1/revoke answered "revoked" on such a machine. All
of them now ask the same question, and these tests pin that."""
import os

import pytest

from gridforge.api import keys
from gridforge.api.costs import CostMeter
from gridforge.api.ledger import Ledger
from gridforge.api.metering import Meter
from gridforge.api.server import ApiError, handle_revoke
from gridforge.api.tiers import Tier


@pytest.fixture
def on_root_device(tmp_path, monkeypatch):
    """A Fly machine whose data directory is NOT a mounted volume: tmp_path reads as the root device."""
    monkeypatch.setenv("FLY_MACHINE_ID", "m-test")
    real = os.stat

    def fake(path, *a, **k):
        r = real(path, *a, **k)
        if str(path) == "/" or str(path).startswith(str(tmp_path)):
            return os.stat_result((r[0], r[1], 4242, *r[3:10]))
        return r

    monkeypatch.setattr(keys.os, "stat", fake)
    return tmp_path


@pytest.fixture
def on_a_volume(tmp_path, monkeypatch):
    """A Fly machine whose data directory is on its own device: a mounted volume."""
    monkeypatch.setenv("FLY_MACHINE_ID", "m-test")
    real = os.stat

    def fake(path, *a, **k):
        r = real(path, *a, **k)
        if str(path).startswith(str(tmp_path)):
            return os.stat_result((r[0], r[1], 7777, *r[3:10]))
        if str(path) == "/":
            return os.stat_result((r[0], r[1], 4242, *r[3:10]))
        return r

    monkeypatch.setattr(keys.os, "stat", fake)
    return tmp_path


def test_on_volume_is_false_for_the_root_device_on_fly_and_true_for_a_mounted_one(on_root_device):
    assert keys.on_volume(on_root_device) is False


def test_on_volume_is_true_for_a_mounted_volume(on_a_volume):
    assert keys.on_volume(on_a_volume) is True


def test_off_fly_there_is_nothing_to_prove(tmp_path, monkeypatch):
    monkeypatch.delenv("FLY_MACHINE_ID", raising=False)
    assert keys.on_volume(tmp_path) is True


def test_the_usage_counter_does_not_call_itself_durable_without_a_volume(on_root_device):
    m = Meter(str(on_root_device / "usage.json"))
    assert m.durable is False
    assert "not writable" in m.durability_note or "memory" in m.durability_note


def test_the_usage_counter_is_durable_on_a_volume(on_a_volume):
    assert Meter(str(on_a_volume / "usage.json")).durable is True


def test_the_cost_file_does_not_call_itself_durable_without_a_volume(on_root_device):
    c = CostMeter(str(on_root_device / "costs.json"))
    assert c.durable is False


def test_the_ledger_is_unavailable_without_a_volume_and_available_on_one(on_root_device, monkeypatch):
    assert Ledger(str(on_root_device / "ledger.jsonl")).available() is False


def test_the_ledger_is_available_on_a_volume(on_a_volume):
    assert Ledger(str(on_a_volume / "ledger.jsonl")).available() is True


def test_revoke_is_a_503_never_a_claimed_success_on_a_machine_with_no_volume(on_root_device, monkeypatch):
    monkeypatch.setenv("GRIDFORGE_REVOKED_FILE", str(on_root_device / "revoked.json"))
    with pytest.raises(ApiError) as e:
        handle_revoke({"key_id": "abc12345"}, Tier.INTERNAL)
    assert e.value.status == 503
    assert not (on_root_device / "revoked.json").exists(), "a revocation was written to an ephemeral disk and reported as done"


def test_revoke_succeeds_on_a_volume(on_a_volume, monkeypatch):
    monkeypatch.setenv("GRIDFORGE_REVOKED_FILE", str(on_a_volume / "revoked.json"))
    out = handle_revoke({"key_id": "abc12345"}, Tier.INTERNAL)
    assert out["revoked"] == "abc12345"
