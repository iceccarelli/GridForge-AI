"""What /openapi.json, /llms.txt and /developers say about the engine is what the engine does.

The site's machine-readable surfaces state the engine's constants (the longest Idempotency-Key, the body limit, the MCP batch limit),
where its honesty fields are (the calibration record, the assumption disclosure, the evidence class of a date) and exactly what an
Idempotency-Key guarantees. They read those from lib/openapi-honesty.json and lib/openapi.ts. This file runs the real engine and fails
if any of it is not true. It is the python half of tests/site/agent-surface-parity.test.ts.
"""
import json
import os
import re
import threading
import urllib.error
import urllib.request
from pathlib import Path

import pytest

from gridforge.api import server as S
from gridforge.api.ledger import IDEMPOTENCY_WINDOW_SECONDS
from gridforge.api.metering import UNIT_COST
from gridforge.api.tiers import Tier

ROOT = Path(__file__).resolve().parents[1]
HONESTY = json.loads((ROOT / "lib" / "openapi-honesty.json").read_text())
TOOLS_JSON = json.loads((ROOT / "public" / "reference" / "tools.json").read_text())
DUBLIN = json.loads((ROOT / "examples" / "intake" / "dublin_hall.json").read_text())
QUALIFY = json.loads((ROOT / "public" / "reference" / "examples" / "qualify-request.json").read_text())
KEY = "sk_openapi_parity"


# --- the constants the documents state --------------------------------------------------------------------------------------
def test_the_constants_the_documents_state_are_the_engines():
    c = HONESTY["engine_constants"]
    assert c["idempotency_key_max_chars"] == S.MAX_IDEM_KEY_CHARS
    assert c["idempotency_window_hours"] * 3600 == IDEMPOTENCY_WINDOW_SECONDS == S.IDEMPOTENCY.TTL
    assert c["max_body_bytes"] == S.MAX_BODY_BYTES
    assert c["max_mcp_batch"] == S.MAX_MCP_BATCH


def test_the_typescript_reads_those_constants_from_the_json_and_does_not_retype_them():
    src = (ROOT / "lib" / "openapi.ts").read_text()
    for name in ("idempotency_key_max_chars", "idempotency_window_hours", "max_body_bytes", "max_mcp_batch"):
        assert f"honesty.engine_constants.{name}" in src
    assert not re.search(r"IDEMPOTENCY_KEY_MAX_CHARS\s*(?::\s*number\s*)?=\s*\d", src)


# --- the honesty fields are where the documents say ---------------------------------------------------------------------------
def test_the_calibration_block_has_exactly_the_documented_fields():
    q = S.handle_qualify(QUALIFY, Tier.PUBLIC)
    assert list(q["calibration"]) == HONESTY["calibration_block_fields"]
    assert q["calibration"]["state"] in HONESTY["calibration_states"]
    screen = S.handle_screen({"intake": DUBLIN}, Tier.CLIENT)
    assert list(screen["calibration"]) == HONESTY["calibration_block_fields"]


@pytest.mark.parametrize("endpoint", sorted(HONESTY["responses"]))
def test_every_documented_honesty_field_is_in_the_real_response(endpoint):
    spec = HONESTY["responses"][endpoint]
    if endpoint == "/v1/qualify":
        out = S.handle_qualify(QUALIFY, Tier.PUBLIC)
    elif endpoint == "/v1/screen":
        out = S.handle_screen({"intake": DUBLIN}, Tier.CLIENT)
    else:
        out = S.handle_compare({"intake": DUBLIN}, Tier.CLIENT)
    for f in spec["top_level"]:
        assert f in out, f"{endpoint} does not return {f}"
    for f in spec.get("after_relief", []):
        assert f in out["after_relief"], f"{endpoint} after_relief has no {f}"
    if spec.get("intake_gaps"):
        gaps = out["intake"]["gaps"]
        assert gaps, "a sparse intake must disclose what was assumed"
        for g in gaps:
            assert set(HONESTY["assumption_gap_fields"]) <= set(g)


def test_the_residual_report_has_the_documented_fields_and_says_uncalibrated_with_nothing_approved():
    from gridforge.calibration.residuals import public_report
    r = public_report([])
    for f in HONESTY["residual_report_fields"]:
        assert f in r
    assert r["state"] == "uncalibrated" and r["n_records"] == 0


# --- the retry guarantee, exactly as stated ----------------------------------------------------------------------------------
@pytest.fixture(scope="module")
def base():
    os.environ["GRIDFORGE_API_KEYS"] = KEY
    S.Handler.limiter.per_minute = 0
    httpd = S.make_server("127.0.0.1", 0)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{httpd.server_address[1]}"
    httpd.shutdown()
    os.environ.pop("GRIDFORGE_API_KEYS", None)


def call(base, path, body=None, key=KEY, idem=None, method="POST"):
    data = None if method == "GET" else json.dumps(body if body is not None else {}).encode()
    req = urllib.request.Request(base + path, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if key:
        req.add_header("X-API-Key", key)
    if idem is not None:
        req.add_header("Idempotency-Key", idem)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, dict(r.headers), json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), json.loads(e.read() or b"{}")


def units_now(base):
    return call(base, "/v1/usage", key=KEY, method="GET")[2]["units"]


def test_a_retry_with_the_same_key_and_body_replays_the_first_answer_and_is_not_charged_again(base):
    before = units_now(base)
    body = {"intake": DUBLIN}
    s1, h1, b1 = call(base, "/v1/screen", body, idem="parity-A")
    assert s1 == 200 and h1["X-GridForge-Units"] == str(UNIT_COST["/v1/screen"])
    assert "X-GridForge-Idempotent-Replay" not in h1
    s2, h2, b2 = call(base, "/v1/screen", body, idem="parity-A")
    assert s2 == 200 and b2 == b1
    assert h2["X-GridForge-Idempotent-Replay"] == "true" and h2["Idempotent-Replay"] == "true"
    assert h2["X-GridForge-Units"] == "0"
    assert units_now(base) - before == UNIT_COST["/v1/screen"]


def test_the_same_key_with_a_different_body_is_refused_422_and_nothing_runs(base):
    before = units_now(base)
    other = json.loads(json.dumps(DUBLIN))
    other["grid"]["contracted_MW"] = other["grid"]["contracted_MW"] + 1
    s, _, b = call(base, "/v1/screen", {"intake": other}, idem="parity-A")
    assert s == 422 and "different request body" in b["error"]
    assert units_now(base) == before


def test_the_key_is_scoped_to_the_endpoint(base):
    before = units_now(base)
    s, h, _ = call(base, "/v1/compare", {"intake": DUBLIN}, idem="parity-A")
    assert s == 200 and "X-GridForge-Idempotent-Replay" not in h
    assert units_now(base) - before == UNIT_COST["/v1/compare"]


def test_a_key_over_the_limit_is_refused_400_and_one_at_the_limit_is_accepted(base):
    n = HONESTY["engine_constants"]["idempotency_key_max_chars"]
    s, _, b = call(base, "/v1/screen", {"intake": DUBLIN}, idem="k" * (n + 1))
    assert s == 400 and b["max_chars"] == n
    s, _, _ = call(base, "/v1/screen", {"intake": DUBLIN}, idem="k" * n)
    assert s == 200


def test_it_does_not_apply_to_a_keyless_free_call_or_to_the_estimator(base):
    for _ in range(2):
        s, h, _ = call(base, "/v1/qualify", QUALIFY, key=None, idem="parity-free")
        assert s == 200 and "X-GridForge-Idempotent-Replay" not in h
    for _ in range(2):
        s, h, _ = call(base, "/v1/estimate", {"endpoint": "/v1/study"}, idem="parity-est")
        assert s == 200 and "X-GridForge-Idempotent-Replay" not in h


def test_a_failed_call_is_not_remembered_so_the_same_key_runs_afresh(base):
    before = units_now(base)
    bad = {"intake": {"grid": "not an object"}}
    s1, h1, _ = call(base, "/v1/screen", bad, idem="parity-bad")
    s2, h2, _ = call(base, "/v1/screen", bad, idem="parity-bad")
    assert s1 >= 400 and s2 >= 400
    assert "X-GridForge-Idempotent-Replay" not in h1 and "X-GridForge-Idempotent-Replay" not in h2
    assert units_now(base) == before, "a failed call is refunded"


def test_over_mcp_a_tools_call_replays_the_same_way(base):
    before = units_now(base)
    rpc = {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "gridforge_screen", "arguments": {"intake": DUBLIN}}}
    s1, h1, b1 = call(base, "/mcp", rpc, idem="parity-mcp")
    s2, h2, b2 = call(base, "/mcp", rpc, idem="parity-mcp")
    assert s1 == s2 == 200 and "result" in b1 and b2["result"] == b1["result"]
    assert h2["X-GridForge-Idempotent-Replay"] == "true"
    assert units_now(base) - before == UNIT_COST["/v1/screen"]


# --- the discovery routes are free and need no key, except /v1/usage ----------------------------------------------------------
@pytest.mark.parametrize("path", ["/health", "/v1/version", "/v1/tools", "/v1/platforms", "/v1/intake/template", "/v1/calibration", "/v1/calibration/residuals"])
def test_the_free_reads_answer_without_a_key(base, path):
    s, _, b = call(base, path, key=None, method="GET")
    assert s == 200 and b


def test_usage_needs_a_key(base):
    s, _, b = call(base, "/v1/usage", key=None, method="GET")
    assert s == 401


def test_the_version_route_publishes_the_same_idempotency_limit_and_the_payg_terms(base):
    s, _, v = call(base, "/v1/version", key=None, method="GET")
    assert v["idempotency_key_max_chars"] == HONESTY["engine_constants"]["idempotency_key_max_chars"]
    assert v["payg"] == TOOLS_JSON["payg"]
    assert sorted(v["endpoints"]) == sorted(json.loads((ROOT / "lib" / "engine-deployed.json").read_text())["endpoints"])


def test_the_rate_card_in_the_catalogue_is_the_engines(base):
    s, _, b = call(base, "/v1/tools", key=None, method="GET")
    assert b["rate_card"] == TOOLS_JSON["rate_card"]
    assert any(r["endpoint"] == "/v1/deck" and r["tool"] is None and r["units"] == UNIT_COST["/v1/deck"] for r in b["rate_card"])
