"""scripts/check-engine-drift.py --baseline FILE: the rollback check.

After a rollback the question is not "does the engine match main" (main is ahead, by design) but "is it what it was before the deploy". The
workflow records the answer's reference as engine-before.json (a --write-snapshot file); --baseline compares the live /v1/version with it.
Exit 0 identical, 1 different, 2 the baseline or the engine could not be read. Offline: an injected `fetch`, or a stub HTTP server on 127.0.0.1.
"""
import http.server
import importlib.util
import json
import subprocess
import sys
import threading
from pathlib import Path

import pytest

from gridforge.api.metering import UNIT_COST
from gridforge.api.server import ROUTES, VERSION
from gridforge.provenance import code_sha256

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "check-engine-drift.py"
spec = importlib.util.spec_from_file_location("check_engine_drift_baseline", SCRIPT)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

BASE = "http://engine.test"


def live(**over):
    d = {"version": "0.8.0", "endpoints": ["/health", "/v1/compare", "/v1/version"], "unit_rates": {"/v1/compare": 5},
         "provenance": {"code_sha256": "a" * 64}}
    d.update(over)
    return d


def write_baseline(tmp_path, deployed=None, name="engine-before.json"):
    path = tmp_path / name
    mod.write_snapshot(str(path), mod.snapshot(deployed or live(), BASE))
    return str(path)


def fetch_of(version):
    def fetch(url):
        if url.endswith("/v1/version"):
            if isinstance(version, Exception):
                raise version
            return version
        raise AssertionError(f"--baseline must only read /v1/version, not {url}")
    return fetch


def run(tmp_path, capsys, deployed, *extra, baseline=None):
    path = baseline or write_baseline(tmp_path)
    rc = mod.main([BASE, "--baseline", path, *extra], fetch=fetch_of(deployed))
    return rc, capsys.readouterr().out


# ---- the pure comparison --------------------------------------------------------------------------------------------
def test_identical_snapshots_have_no_differences():
    snap = mod.snapshot(live(), BASE)
    assert mod.baseline_differences(snap, mod.snapshot(live(), BASE)) == []


def test_a_different_digest_is_named():
    out = mod.baseline_differences(mod.snapshot(live(), BASE), mod.snapshot(live(provenance={"code_sha256": "b" * 64}), BASE))
    assert len(out) == 1 and "code digest" in out[0] and "aaaaaaaaaaaa" in out[0] and "bbbbbbbbbbbb" in out[0]


def test_a_different_version_is_named():
    out = mod.baseline_differences(mod.snapshot(live(), BASE), mod.snapshot(live(version="0.9.0"), BASE))
    assert out == ["version: baseline '0.8.0', live '0.9.0'"]


def test_endpoints_added_and_removed_are_each_named():
    after = live(endpoints=["/health", "/v1/version", "/v1/screen"])
    out = mod.baseline_differences(mod.snapshot(live(), BASE), mod.snapshot(after, BASE))
    assert "endpoint /v1/compare: in the baseline, not served live" in out
    assert "endpoint /v1/screen: served live, not in the baseline" in out
    assert len(out) == 2


def test_a_changed_added_or_removed_unit_rate_is_named():
    after = live(unit_rates={"/v1/compare": 6, "/v1/screen": 2})
    out = mod.baseline_differences(mod.snapshot(live(), BASE), mod.snapshot(after, BASE))
    assert out == ["unit rate for /v1/compare: baseline 5, live 6", "unit rate for /v1/screen: baseline None, live 2"]


def test_an_engine_that_publishes_no_digest_equals_a_baseline_that_recorded_none_but_not_one_that_recorded_a_digest():
    none = live(provenance={})
    assert mod.baseline_differences(mod.snapshot(none, BASE), mod.snapshot(none, BASE)) == []
    out = mod.baseline_differences(mod.snapshot(live(), BASE), mod.snapshot(none, BASE))
    assert out and "none published" in out[0]


def test_endpoint_order_does_not_matter():
    a = live(endpoints=["/v1/version", "/health", "/v1/compare"])
    assert mod.baseline_differences(mod.snapshot(live(), BASE), mod.snapshot(a, BASE)) == []


# ---- the exit codes -------------------------------------------------------------------------------------------------
def test_identical_exits_zero(tmp_path, capsys):
    rc, out = run(tmp_path, capsys, live())
    assert rc == 0 and "IDENTICAL" in out and "does not roll back usage, ledger or revocation data" in out


def test_different_exits_one_and_lists_every_difference(tmp_path, capsys):
    deployed = live(version="0.9.0", provenance={"code_sha256": "c" * 64}, endpoints=["/health", "/v1/version"], unit_rates={})
    rc, out = run(tmp_path, capsys, deployed)
    assert rc == 1 and "DIFFERENT from the baseline (4)" in out and "IDENTICAL" not in out
    for needle in ("code digest", "version:", "endpoint /v1/compare", "unit rate for /v1/compare"):
        assert needle in out, out


def test_a_missing_baseline_file_exits_two_without_contacting_the_engine(tmp_path, capsys):
    called = []
    rc = mod.main([BASE, "--baseline", str(tmp_path / "nope.json")], fetch=lambda u: called.append(u))
    out = capsys.readouterr().out
    assert rc == 2 and "cannot be read" in out and "Nothing was verified" in out and not called


@pytest.mark.parametrize("text, why", [
    ("{not json", "not valid JSON"),
    ("[1, 2]", "not a JSON object"),
    ("{}", "lacks"),
    ('{"version": "1", "endpoints": "x", "unit_rates": {}, "code_sha256": null, "base": "http://engine.test"}', "endpoints must be a list of strings"),
    ('{"version": "1", "endpoints": [1], "unit_rates": {}, "code_sha256": null, "base": "http://engine.test"}', "endpoints must be a list of strings"),
    ('{"version": "1", "endpoints": [], "unit_rates": [], "code_sha256": null, "base": "http://engine.test"}', "unit_rates must be an object"),
    ('{"version": "1", "endpoints": [], "unit_rates": {}, "code_sha256": 5, "base": "http://engine.test"}', "code_sha256 must be a string or null"),
    ('{"version": "1", "endpoints": [], "unit_rates": {}, "code_sha256": null}', "lacks base"),
    ('{"version": "1", "endpoints": [], "unit_rates": {}, "code_sha256": null, "base": ""}', "base must be the URL"),
    ('{"version": "1", "endpoints": [], "unit_rates": {"/v1/x": NaN}, "code_sha256": null, "base": "http://engine.test"}', "NaN is not valid in a snapshot"),
    ('{"version": "1", "endpoints": [], "unit_rates": {"/v1/x": Infinity}, "code_sha256": null, "base": "http://engine.test"}', "Infinity is not valid in a snapshot"),
    ('{"unreadable": true, "reason": "the live engine could not be read", "recorded_at": "2026-11-07T00:00:00Z"}', "there is no baseline to compare with"),
    ("[" * 100000, "nested too deeply"),
    ("", "not valid JSON"),
])
def test_a_malformed_baseline_exits_two(tmp_path, capsys, text, why):
    p = tmp_path / "b.json"
    p.write_text(text)
    called = []
    rc = mod.main([BASE, "--baseline", str(p)], fetch=lambda u: called.append(u))
    out = capsys.readouterr().out
    assert rc == 2 and why in out and "Nothing was verified" in out and not called


def test_an_unreachable_engine_exits_two_never_identical(tmp_path, capsys):
    rc, out = run(tmp_path, capsys, OSError("connection refused"))
    assert rc == 2 and "could not read /v1/version" in out and "Nothing was verified" in out and "IDENTICAL" not in out


def test_a_non_object_version_document_exits_two(tmp_path, capsys):
    rc, out = run(tmp_path, capsys, ["not", "an", "object"])
    assert rc == 2 and "not a JSON object" in out


def test_a_baseline_from_another_base_url_exits_two_without_contacting_the_engine(tmp_path, capsys):
    path = tmp_path / "b.json"
    mod.write_snapshot(str(path), mod.snapshot(live(), "http://other.test"))
    called = []
    rc = mod.main([BASE, "--baseline", str(path)], fetch=lambda u: called.append(u))
    out = capsys.readouterr().out
    assert rc == 2 and not called
    assert "recorded from http://other.test, not from http://engine.test" in out and "Nothing was verified" in out


def test_a_base_url_that_differs_only_by_a_trailing_slash_is_the_same_engine(tmp_path, capsys):
    path = tmp_path / "b.json"
    mod.write_snapshot(str(path), mod.snapshot(live(), BASE + "/"))
    rc = mod.main([BASE, "--baseline", str(path)], fetch=fetch_of(live()))
    assert rc == 0, capsys.readouterr().out


def test_a_baseline_from_another_base_url_is_reported_in_json(tmp_path, capsys):
    path = tmp_path / "b.json"
    mod.write_snapshot(str(path), mod.snapshot(live(), "http://other.test"))
    rc = mod.main([BASE, "--baseline", str(path), "--json"], fetch=fetch_of(live()))
    doc = json.loads(capsys.readouterr().out)
    assert rc == 2 and doc["ok"] is False and doc["baseline_base"] == "http://other.test" and "recorded from" in doc["error"]


def test_both_digests_missing_is_identical_only_on_version_endpoints_and_rates_and_says_so(tmp_path, capsys):
    none = live(provenance={})
    path = write_baseline(tmp_path, none)
    rc = mod.main([BASE, "--baseline", path], fetch=fetch_of(none))
    out = capsys.readouterr().out
    assert rc == 0 and "IDENTICAL on version, endpoints and unit rates" in out and "NEITHER side publishes a code digest" in out
    assert "IDENTICAL on code digest" not in out
    rc = mod.main([BASE, "--baseline", path, "--json"], fetch=fetch_of(none))
    assert json.loads(capsys.readouterr().out)["digest_compared"] is False
    s = tmp_path / "s.md"
    mod.main([BASE, "--baseline", path, "--summary-file", str(s)], fetch=fetch_of(none))
    assert "NEITHER side publishes a code digest" in s.read_text()


def test_with_a_digest_on_both_sides_the_digest_is_named_as_compared(tmp_path, capsys):
    rc, out = run(tmp_path, capsys, live())
    assert rc == 0 and "IDENTICAL on code digest, version, endpoints and unit rates" in out
    rc, out = run(tmp_path, capsys, live(), "--json")
    assert json.loads(out)["digest_compared"] is True


def test_an_unwritable_summary_file_is_exit_two_with_a_message_not_a_traceback(tmp_path, capsys):
    bad = tmp_path / "no-such-dir" / "summary.md"
    rc = mod.main([BASE, "--baseline", write_baseline(tmp_path), "--summary-file", str(bad)], fetch=fetch_of(live()))
    cap = capsys.readouterr()
    assert rc == 2 and "could not write --summary-file" in cap.err and str(bad) in cap.err
    assert "IDENTICAL" in cap.out, "the comparison itself is still printed"
    # also when the comparison found a difference (it must not be exit 1), and when the engine is unreadable
    rc = mod.main([BASE, "--baseline", write_baseline(tmp_path), "--summary-file", str(bad)], fetch=fetch_of(live(version="9")))
    assert rc == 2
    rc = mod.main([BASE, "--baseline", write_baseline(tmp_path), "--summary-file", str(bad)], fetch=fetch_of(OSError("down")))
    cap = capsys.readouterr()
    assert rc == 2 and "could not write --summary-file" in cap.err


def test_a_summary_path_that_is_a_directory_is_also_exit_two(tmp_path, capsys):
    rc = mod.main([BASE, "--baseline", write_baseline(tmp_path), "--summary-file", str(tmp_path)], fetch=fetch_of(live()))
    assert rc == 2 and "could not write --summary-file" in capsys.readouterr().err


def test_a_baseline_with_non_utf8_bytes_exits_two(tmp_path, capsys):
    p = tmp_path / "b.json"
    p.write_bytes(b"\xff\xfe\x00 not utf-8")
    rc = mod.main([BASE, "--baseline", str(p)], fetch=lambda u: None)
    assert rc == 2 and "Nothing was verified" in capsys.readouterr().out


def test_the_cli_exits_two_not_one_with_a_traceback_on_a_deeply_nested_baseline(tmp_path):
    p = tmp_path / "deep.json"
    p.write_text("[" * 200000)
    r = subprocess.run([sys.executable, "-B", str(SCRIPT), BASE, "--baseline", str(p)], capture_output=True, text=True, cwd=tmp_path)
    assert r.returncode == 2 and "Traceback" not in r.stderr and "nested too deeply" in r.stdout


# ---- json, summary, option rules --------------------------------------------------------------------------------------
def test_json_output(tmp_path, capsys):
    rc, out = run(tmp_path, capsys, live(version="0.9.0"), "--json")
    doc = json.loads(out)
    assert rc == 1 and doc["mode"] == "baseline" and doc["ok"] is False and doc["count"] == 1
    assert doc["differences"] == ["version: baseline '0.8.0', live '0.9.0'"] and doc["baseline_file"].endswith("engine-before.json")
    rc, out = run(tmp_path, capsys, live(), "--json")
    assert rc == 0 and json.loads(out)["ok"] is True


def test_json_output_when_unreadable(tmp_path, capsys):
    rc, out = run(tmp_path, capsys, OSError("down"), "--json")
    doc = json.loads(out)
    assert rc == 2 and doc["ok"] is False and doc["mode"] == "baseline" and "Nothing was verified" in doc["error"]


def test_summary_file_gets_a_markdown_block(tmp_path, capsys):
    s = tmp_path / "summary.md"
    run(tmp_path, capsys, live(), "--summary-file", str(s))
    assert "Rollback check: identical to the baseline" in s.read_text()
    run(tmp_path, capsys, live(version="0.9.0"), "--summary-file", str(s))
    assert "Rollback check: 1 difference(s) from the baseline" in s.read_text()
    run(tmp_path, capsys, OSError("down"), "--summary-file", str(s))
    assert "Rollback check: unreadable" in s.read_text()


def test_baseline_needs_a_path(capsys):
    assert mod.main(["--baseline"], fetch=fetch_of(live())) == 2
    assert "--baseline needs a path" in capsys.readouterr().err


@pytest.mark.parametrize("flag", [["--write-snapshot", "x.json"], ["--require-clean-tree"]])
def test_baseline_refuses_flags_that_belong_to_the_repository_comparison(tmp_path, capsys, flag):
    rc = mod.main([BASE, "--baseline", write_baseline(tmp_path), *flag], fetch=fetch_of(live()))
    assert rc == 2 and "cannot be combined" in capsys.readouterr().err


def test_baseline_mode_is_get_only_and_reads_only_version(tmp_path, capsys):
    seen = []

    def fetch(url):
        seen.append(url)
        return live()

    mod.main([BASE, "--baseline", write_baseline(tmp_path)], fetch=fetch)
    assert seen == [BASE + "/v1/version"]


def test_the_repository_comparison_is_unchanged_without_the_flag(capsys):
    d = {"version": VERSION, "endpoints": sorted(ROUTES) + ["/health"], "unit_rates": dict(UNIT_COST),
         "provenance": {"code_sha256": code_sha256()}, "metering": {"durable": True, "ledger_durable": True}}
    from gridforge.api.tools import catalogue

    def fetch(url):
        return d if url.endswith("/v1/version") else catalogue()

    assert mod.main([BASE], fetch=fetch, tree=lambda: ("clean", [])) == 0


# ---- a round trip through the real script and a stub engine ---------------------------------------------------------------
def test_round_trip_through_the_cli_against_a_stub_engine(tmp_path):
    body = json.dumps(live()).encode()

    class H(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200 if self.path == "/v1/version" else 404)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(body if self.path == "/v1/version" else b"{}")

        def log_message(self, *a):
            pass

    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        url = f"http://127.0.0.1:{srv.server_address[1]}"
        before = tmp_path / "engine-before.json"
        mod.write_snapshot(str(before), mod.snapshot(live(), url))

        def cli(path):
            return subprocess.run([sys.executable, "-B", str(SCRIPT), url, "--baseline", str(path)], capture_output=True, text=True,
                                  cwd=tmp_path)
        assert cli(before).returncode == 0
        edited = json.loads(before.read_text())
        edited["version"] = "9.9.9"
        changed = tmp_path / "changed.json"
        changed.write_text(json.dumps(edited))
        r = cli(changed)
        assert r.returncode == 1 and "version: baseline '9.9.9'" in r.stdout
        assert cli(tmp_path / "missing.json").returncode == 2
    finally:
        srv.shutdown()
