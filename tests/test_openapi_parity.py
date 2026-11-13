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
from openapi_example_support import example_bodies

from gridforge.api import server as S
from gridforge.api.ledger import IDEMPOTENCY_WINDOW_SECONDS
from gridforge.api.ledger import Ledger
from gridforge.api.metering import METER, UNIT_COST
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
    elif endpoint == "/v1/compare":
        out = S.handle_compare({"intake": DUBLIN}, Tier.CLIENT)
    else:
        # every other documented route, on its own published example request, through the one place a solve starts
        tier = Tier.PUBLIC if endpoint == "/v1/estimate" else Tier.CLIENT
        out = S._invoke(endpoint, S.ROUTES[endpoint][0], next(iter(example_bodies(endpoint).values())), tier)
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


def call(base, path, body=None, key=KEY, idem=None, method="POST", raw=None):
    data = raw if raw is not None else (None if method == "GET" else json.dumps(body if body is not None else {}).encode())
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


def rpc(name, args, rid=1):
    return {"jsonrpc": "2.0", "id": rid, "method": "tools/call", "params": {"name": name, "arguments": args}}


def test_over_mcp_the_refusals_are_json_rpc_errors_inside_http_200(base):
    n = HONESTY["engine_constants"]["idempotency_key_max_chars"]
    s, _, b = call(base, "/mcp", rpc("gridforge_screen", {"intake": DUBLIN}), idem="k" * (n + 1))
    assert s == 200 and b["error"]["code"] == -32602 and b["error"]["data"]["status"] == 400
    first = call(base, "/mcp", rpc("gridforge_screen", {"intake": DUBLIN}), idem="parity-mcp-conflict")
    assert first[0] == 200 and "result" in first[2]
    other = json.loads(json.dumps(DUBLIN))
    other["grid"]["contracted_MW"] += 1
    s, _, b = call(base, "/mcp", rpc("gridforge_screen", {"intake": other}), idem="parity-mcp-conflict")
    assert s == 200 and b["error"]["code"] == -32602 and b["error"]["data"]["status"] == 422


def test_on_rest_the_same_body_means_the_same_bytes_and_over_mcp_the_same_arguments(base):
    before = units_now(base)
    compact = json.dumps({"intake": DUBLIN}).encode()
    indented = json.dumps({"intake": DUBLIN}, indent=2).encode()
    assert json.loads(compact) == json.loads(indented)
    assert call(base, "/v1/screen", raw=compact, idem="parity-bytes")[0] == 200
    s, _, b = call(base, "/v1/screen", raw=indented, idem="parity-bytes")
    assert s == 422 and "different request body" in b["error"]
    s, h, _ = call(base, "/v1/screen", raw=compact, idem="parity-bytes")
    assert s == 200 and h["X-GridForge-Idempotent-Replay"] == "true"
    assert units_now(base) - before == UNIT_COST["/v1/screen"]
    # MCP hashes the canonical arguments: key order does not matter.
    a1 = {"intake": DUBLIN, "objective": "max_compute"}
    a2 = {"objective": "max_compute", "intake": DUBLIN}
    assert call(base, "/mcp", rpc("gridforge_screen", a1), idem="parity-canon")[0] == 200
    s, h, b = call(base, "/mcp", rpc("gridforge_screen", a2), idem="parity-canon")
    assert s == 200 and "error" not in b and h["X-GridForge-Idempotent-Replay"] == "true"


def test_a_mixed_mcp_batch_reports_replay_with_the_units_actually_charged(base):
    first = [rpc("gridforge_screen", {"intake": DUBLIN}, 1), rpc("gridforge_compare", {"intake": DUBLIN}, 2)]
    s, h, _ = call(base, "/mcp", first, idem="parity-batch")
    assert s == 200 and "X-GridForge-Idempotent-Replay" not in h
    assert h["X-GridForge-Units"] == str(UNIT_COST["/v1/screen"] + UNIT_COST["/v1/compare"])
    mixed = [rpc("gridforge_screen", {"intake": DUBLIN}, 1), rpc("gridforge_study", {"intake": DUBLIN}, 2)]
    before = units_now(base)
    s, h, b = call(base, "/mcp", mixed, idem="parity-batch")
    assert s == 200 and all("result" in m for m in b)
    assert h["X-GridForge-Idempotent-Replay"] == "true"
    assert h["X-GridForge-Units"] == str(UNIT_COST["/v1/study"]) != "0"
    assert units_now(base) - before == UNIT_COST["/v1/study"]
    allreplay = [rpc("gridforge_screen", {"intake": DUBLIN}, 1), rpc("gridforge_compare", {"intake": DUBLIN}, 2)]
    s, h, _ = call(base, "/mcp", allreplay, idem="parity-batch")
    assert h["X-GridForge-Idempotent-Replay"] == "true" and h["X-GridForge-Units"] == "0"


def _diff(a, b, path=""):
    out = []
    if isinstance(a, dict) and isinstance(b, dict):
        for k in set(a) | set(b):
            out += _diff(a.get(k), b.get(k), f"{path}/{k}")
    elif isinstance(a, list) and isinstance(b, list) and len(a) == len(b):
        for i, (x, y) in enumerate(zip(a, b)):
            out += _diff(x, y, f"{path}[{i}]")
    elif a != b:
        out.append(path)
    return out


DATE_STAMPED = ("generated", "report_date", "code_sha256", "digest")


@pytest.mark.parametrize("endpoint", ["/v1/screen", "/v1/compare"])
def test_after_eviction_a_durable_ledger_replays_without_a_second_charge_and_the_answer_matches(base, tmp_path, monkeypatch, endpoint):
    monkeypatch.setattr(METER, "ledger", Ledger(tmp_path / "ledger.jsonl"))
    s, _, v = call(base, "/v1/version", key=None, method="GET")
    assert v["metering"]["ledger_durable"] is True
    before = units_now(base)
    s1, h1, b1 = call(base, endpoint, {"intake": DUBLIN}, idem="parity-evict")
    assert s1 == 200 and units_now(base) - before == UNIT_COST[endpoint]
    S.IDEMPOTENCY._items.clear()          # the engine's memory no longer holds the answer
    s2, h2, b2 = call(base, endpoint, {"intake": DUBLIN}, idem="parity-evict")
    assert s2 == 200 and h2["X-GridForge-Idempotent-Replay"] == "true" and h2["X-GridForge-Units"] == "0"
    assert units_now(base) - before == UNIT_COST[endpoint], "not charged twice"
    changed = _diff(b1, b2)
    assert all(p.rsplit("/", 1)[-1] in DATE_STAMPED for p in changed), f"a recomputed answer differs beyond date-stamped fields: {changed}"


def test_without_a_durable_ledger_a_retry_after_eviction_is_a_new_charged_request(base, monkeypatch):
    monkeypatch.setattr(METER, "ledger", Ledger(None))
    s, _, v = call(base, "/v1/version", key=None, method="GET")
    assert v["metering"]["ledger_durable"] is False
    before = units_now(base)
    assert call(base, "/v1/screen", {"intake": DUBLIN}, idem="parity-noledger")[0] == 200
    s, h, _ = call(base, "/v1/screen", {"intake": DUBLIN}, idem="parity-noledger")
    assert h["X-GridForge-Idempotent-Replay"] == "true", "while the answer is in memory it is replayed"
    S.IDEMPOTENCY._items.clear()
    s, h, _ = call(base, "/v1/screen", {"intake": DUBLIN}, idem="parity-noledger")
    assert s == 200 and "X-GridForge-Idempotent-Replay" not in h
    assert units_now(base) - before == 2 * UNIT_COST["/v1/screen"], "charged again: nothing durable remembered the first charge"


def test_a_replay_still_counts_toward_the_rate_limit(base):
    S.Handler.limiter.per_minute = 2
    try:
        codes = [call(base, "/v1/screen", {"intake": DUBLIN}, idem="parity-rate")[0] for _ in range(3)]
    finally:
        S.Handler.limiter.per_minute = 0
    assert codes == [200, 200, 429]


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


def test_get_estimate_is_a_real_free_route_with_the_documented_query(base):
    s, _, b = call(base, "/v1/estimate?endpoint=/v1/study", key=None, method="GET")
    assert s == 200 and b["units"] == UNIT_COST["/v1/study"] and b["estimated_cents"] == b["units"] * b["unit_price_cents"]
    s, _, b = call(base, "/v1/estimate?endpoint=/v1/portfolio&hall_count=7", key=None, method="GET")
    assert s == 200 and b["units"] == 7 * UNIT_COST["/v1/portfolio"]
    s, _, _ = call(base, "/v1/estimate?endpoint=/v1/portfolio&hall_count=0", key=None, method="GET")
    assert s == 422
    s, _, b = call(base, "/v1/estimate?endpoint=/nope", key=None, method="GET")
    assert s == 422 and "available" in b
    # a key is optional and adds where it stands
    s, _, b = call(base, "/v1/estimate?endpoint=/v1/study", key=KEY, method="GET")
    assert s == 200 and "fits" in b and "used_units" in b
    # it is never metered
    before = units_now(base)
    call(base, "/v1/estimate?endpoint=/v1/study", key=KEY, method="GET")
    assert units_now(base) == before


# --- the free reads' response schemas are the real responses' ----------------------------------------------------------------
DISCOVERY = json.loads((ROOT / "lib" / "openapi-discovery.json").read_text())["routes"]
#: Keys the engine returns that the document does not list, with the reason. Empty on purpose: document a key rather than allow it here.
UNDOCUMENTED_KEYS: dict[str, set[str]] = {}
_TYPES = {"string": str, "integer": int, "number": (int, float), "boolean": bool, "array": list, "object": dict, "null": type(None)}


def _is(value, type_name):
    if type_name == "integer" and isinstance(value, bool):
        return False
    if type_name == "number" and isinstance(value, bool):
        return False
    return isinstance(value, _TYPES[type_name])


def _validate(real, schema, where, allow, problems):
    """Every documented type matches; every `required` key is present; every returned key is documented (or explicitly allowed)."""
    types = schema.get("type")
    if types is not None:
        names = types if isinstance(types, list) else [types]
        if not any(_is(real, n) for n in names):
            problems.append(f"{where}: expected {names}, got {type(real).__name__}")
            return
    if isinstance(real, dict) and "properties" in schema:
        props = schema["properties"]
        for name in schema.get("required", []):
            if name not in real:
                problems.append(f"{where}: required key {name!r} is missing from the real response")
        for name, value in real.items():
            if name in props:
                _validate(value, props[name], f"{where}.{name}", allow, problems)
            elif isinstance(schema.get("additionalProperties"), dict):
                _validate(value, schema["additionalProperties"], f"{where}.{name}", allow, problems)
            elif schema.get("additionalProperties") is False or "additionalProperties" not in schema:
                if name not in allow:
                    problems.append(f"{where}: the engine returns {name!r}, which the document does not list")
    elif isinstance(real, dict) and isinstance(schema.get("additionalProperties"), dict):
        for name, value in real.items():
            _validate(value, schema["additionalProperties"], f"{where}.{name}", allow, problems)
    elif isinstance(real, list) and "items" in schema:
        for i, item in enumerate(real[:5]):
            _validate(item, schema["items"], f"{where}[{i}]", allow, problems)


def _spec(path):
    spec = DISCOVERY[path]
    props = dict(spec["properties"])
    required = list(spec["required"])
    if spec.get("includes"):
        for f in HONESTY[spec["includes"]]:
            props.setdefault(f, {})
            required.append(f)
    return {"type": "object", "properties": props, "required": required, "additionalProperties": True}


def _check(path, real):
    spec = _spec(path)
    # additionalProperties must be false for the "returned but not listed" check to bite; the document keeps it open for the reader.
    strict = dict(spec, additionalProperties=False)
    problems: list = []
    _validate(real, strict, path, UNDOCUMENTED_KEYS.get(path, set()), problems)
    return problems


@pytest.mark.parametrize("path", ["/health", "/v1/version", "/v1/tools", "/v1/platforms", "/v1/intake/template", "/v1/calibration", "/v1/calibration/residuals"])
def test_each_free_read_matches_its_documented_schema(base, path):
    s, _, real = call(base, path, key=None, method="GET")
    assert s == 200
    assert _check(path, real) == []


def test_usage_matches_its_documented_schema_for_a_key_and_for_a_pay_as_you_go_key(base):
    s, _, real = call(base, "/v1/usage", key=KEY, method="GET")
    assert s == 200
    assert _check("/v1/usage", real) == []
    from gridforge.api.metering import KeyPlan
    payg = METER.statement(KeyPlan(key="sk_payg_schema", label="p", monthly_quota=50, scope="payg", key_id="k1"))
    assert "accrued_cents" in payg and "unit_price_cents" in payg
    assert _check("/v1/usage", json.loads(json.dumps({"schema_version": "x", **payg}))) == []
    # the pay-as-you-go-only keys are optional: absent for an ordinary key, documented for a pay-as-you-go one
    assert "accrued_cents" not in real and "accrued_cents" not in DISCOVERY["/v1/usage"]["required"]


def test_the_validator_bites_on_a_renamed_or_unlisted_key(base):
    s, _, real = call(base, "/v1/usage", key=KEY, method="GET")
    renamed = {("units_remaining_x" if k == "units_remaining" else k): v for k, v in real.items()}
    out = _check("/v1/usage", renamed)
    assert any("units_remaining" in p and "missing" in p for p in out) and any("units_remaining_x" in p for p in out)
    s, _, v = call(base, "/v1/version", key=None, method="GET")
    v2 = {("rate_limit_per_second" if k == "rate_limit_per_minute" else k): x for k, x in v.items()}
    assert any("rate_limit_per_minute" in p for p in _check("/v1/version", v2))


def test_the_intake_fields_in_the_qualify_and_screen_responses_are_the_documented_ones():
    for endpoint, out in (("/v1/qualify", S.handle_qualify(QUALIFY, Tier.PUBLIC)), ("/v1/screen", S.handle_screen({"intake": DUBLIN}, Tier.CLIENT))):
        assert sorted(out["intake"]) == sorted(HONESTY["responses"][endpoint]["intake_fields"]), endpoint
