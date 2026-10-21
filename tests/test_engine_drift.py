"""scripts/check-engine-drift.py: what "the running engine matches this repository" means, pinned (no network)."""
import importlib.util
from pathlib import Path

from gridforge.api.metering import UNIT_COST
from gridforge.api.server import ROUTES, VERSION
from gridforge.provenance import code_sha256

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("check_engine_drift", ROOT / "scripts" / "check-engine-drift.py")
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


def current():
    return {"version": VERSION, "endpoints": sorted(ROUTES) + ["/health"], "unit_rates": dict(UNIT_COST),
            "provenance": {"code_sha256": code_sha256()}, "metering": {"durable": True, "ledger_durable": True}}


def test_an_engine_built_from_this_tree_has_no_drift():
    assert mod.drift(current()) == []


def test_identical_routes_with_a_different_code_digest_is_drift():
    d = current()
    d["provenance"] = {"code_sha256": "0" * 64}
    out = mod.drift(d)
    assert len(out) == 1 and "different tree" in out[0]


def test_an_engine_that_publishes_no_digest_is_drift():
    d = current()
    del d["provenance"]
    assert any("no code digest" in p for p in mod.drift(d))


def test_an_engine_that_predates_the_ledger_is_drift():
    d = current()
    d["metering"] = {"durable": True}
    assert any("predates the usage ledger" in p for p in mod.drift(d))


def test_a_missing_route_and_a_changed_unit_rate_are_each_named():
    d = current()
    d["endpoints"] = [e for e in d["endpoints"] if e != "/v1/compare"]
    d["unit_rates"] = {**d["unit_rates"], "/v1/study": 99}
    out = " | ".join(mod.drift(d))
    assert "/v1/compare" in out and "unit rate for /v1/study" in out
