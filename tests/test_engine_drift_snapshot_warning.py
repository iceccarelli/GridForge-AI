"""scripts/check-engine-drift.py: a stale lib/engine-deployed.json is a WARNING, never drift, and never changes the exit status.

The committed snapshot lists the 23 endpoints the deployed engine served when it was last read; the live engine serves 24 (it adds
GET /v1/calibration/residuals). The registry may only call a route "live" if the snapshot lists it, so a stale snapshot silently
understates what is deployed. Offline: the live engine is an injected fetch and the snapshot is an injected list.
"""
import importlib.util
import json
from pathlib import Path

from gridforge.api.metering import UNIT_COST
from gridforge.api.server import GET_ROUTES, ROUTES, VERSION
from gridforge.api.tools import catalogue
from gridforge.provenance import code_sha256

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("check_engine_drift_snapshot", ROOT / "scripts" / "check-engine-drift.py")
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

SNAPSHOT = json.loads((ROOT / "lib" / "engine-deployed.json").read_text())["endpoints"]


def live_engine():
    """An engine built from this tree: serves every route the repository serves."""
    return {"version": VERSION, "endpoints": sorted(ROUTES) + sorted(GET_ROUTES), "unit_rates": dict(UNIT_COST),
            "provenance": {"code_sha256": code_sha256()}, "metering": {"durable": True, "ledger_durable": True}}


def run(argv, snapshot, capsys, engine=None):
    def fetch(url):
        if url.endswith("/v1/version"):
            return engine if engine is not None else live_engine()
        return catalogue()
    rc = mod.main(["http://engine.test", *argv], fetch=fetch, tree=lambda: ("clean", []), snapshot_endpoints=lambda: snapshot)
    return rc, capsys.readouterr().out


# ---- the pure comparison -------------------------------------------------------------------------------------------
def test_a_live_set_that_is_a_strict_superset_warns_and_names_the_extra_route():
    out = mod.snapshot_staleness(SNAPSHOT + ["/v1/calibration/residuals"], SNAPSHOT)
    assert len(out) == 1
    assert "STALE" in out[0] and "/v1/calibration/residuals" in out[0] and "strict superset" in out[0]
    assert "exit status is unchanged" in out[0] and "does not edit it" in out[0]


def test_an_identical_set_is_silent_whatever_the_order():
    assert mod.snapshot_staleness(list(reversed(SNAPSHOT)), SNAPSHOT) == []


def test_a_snapshot_that_lists_more_than_the_live_engine_is_not_this_warning():
    assert mod.snapshot_staleness(SNAPSHOT[:-1], SNAPSHOT) == []


def test_extras_and_a_retired_route_together_are_both_said():
    out = mod.snapshot_staleness(["/a", "/c"], ["/a", "/b"])
    assert len(out) == 1 and "different from" in out[0] and "/c" in out[0] and "no longer served: /b" in out[0]


def test_nothing_comparable_is_reported_as_skipped_never_as_fine():
    assert "skipped" in mod.snapshot_staleness(None, SNAPSHOT)[0]
    assert "skipped" in mod.snapshot_staleness(SNAPSHOT, None)[0]
    assert "skipped" in mod.snapshot_staleness("not a list", SNAPSHOT)[0]


def test_non_string_entries_are_ignored_not_crashed_on():
    assert mod.snapshot_staleness(["/a", 3, None], ["/a"]) == []


def test_the_committed_snapshot_is_what_the_warning_reads():
    assert mod.read_snapshot_endpoints() == SNAPSHOT
    assert mod.read_snapshot_endpoints(ROOT / "does-not-exist.json") is None


def test_the_repository_engine_serves_one_more_endpoint_than_the_committed_snapshot_lists():
    # The fact this warning exists for. When the owner refreshes lib/engine-deployed.json this assertion fails: delete it with the staleness.
    served = set(ROUTES) | set(GET_ROUTES)
    assert sorted(served - set(SNAPSHOT) - {"/mcp"}) == ["/v1/calibration/residuals"]


# ---- through main(): the exit status, JSON, text and Markdown --------------------------------------------------------
def test_a_stale_snapshot_warns_in_every_output_and_the_exit_status_stays_zero(tmp_path, capsys):
    stale = [e for e in SNAPSHOT if e != "/v1/calibration/residuals"]
    summary = tmp_path / "summary.md"
    rc, out = run(["--summary-file", str(summary)], stale, capsys, live_engine() | {"endpoints": sorted(ROUTES) + sorted(GET_ROUTES)})
    # No drift between the repository and the engine, so 0: the warning is not a failure.
    assert rc == 0
    assert "WARNING (not drift, exit status unchanged)" in out and "/v1/calibration/residuals" in out
    assert "no drift" in out
    md = summary.read_text()
    assert "Engine drift: none" in md and "Warning (not drift; the exit status is unchanged)" in md and "/v1/calibration/residuals" in md


def test_json_carries_the_warning_and_ok_stays_true(capsys):
    rc, out = run(["--json"], [e for e in SNAPSHOT if e != "/v1/calibration/residuals"], capsys)
    doc = json.loads(out)
    assert rc == 0 and doc["ok"] is True and doc["count"] == 0
    assert len(doc["warnings"]) == 1 and "/v1/calibration/residuals" in doc["warnings"][0]


def test_a_current_snapshot_prints_no_warning(capsys):
    snapshot = sorted(set(ROUTES) | set(GET_ROUTES))
    rc, out = run(["--json"], snapshot, capsys)
    assert rc == 0 and json.loads(out)["warnings"] == []


def test_real_drift_still_exits_one_and_the_warning_does_not_hide_it(capsys):
    behind = live_engine() | {"endpoints": [e for e in live_engine()["endpoints"] if e != "/v1/compare"] + ["/v1/brand-new"]}
    rc, out = run(["--json"], SNAPSHOT, capsys, behind)
    doc = json.loads(out)
    assert rc == 1 and doc["ok"] is False
    assert any("/v1/compare" in p for p in doc["differences"]["routes"])
    assert any("/v1/brand-new" in w for w in doc["warnings"])


def test_an_unreadable_engine_still_exits_two(capsys):
    def boom(url):
        raise OSError("down")
    rc = mod.main(["http://engine.test", "--json"], fetch=boom, tree=lambda: ("clean", []), snapshot_endpoints=lambda: SNAPSHOT)
    assert rc == 2
    capsys.readouterr()
