"""The HTTP API, exercised against a real server on a real socket.

The commercial gate lives here: a public caller must get a genuinely useful
engineering answer and must never receive a priced figure. A test that only
checked the happy path would let a refactor quietly give the deliverable away.
"""
import json
import os
import threading
import urllib.error
import urllib.request

import pytest

from gridforge.api.server import Handler, make_server, qualify_to_intake
from gridforge.api.tiers import PUBLIC_REDACTED_KEYS, Tier, redact

KEY = "test-key-123"


@pytest.fixture(scope="module")
def server():
    os.environ["GRIDFORGE_API_KEYS"] = KEY
    os.environ["GRIDFORGE_RATE_LIMIT"] = "0"          # disabled for the suite
    Handler.limiter.per_minute = 0
    httpd = make_server("127.0.0.1", 0)
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    yield f"http://127.0.0.1:{httpd.server_address[1]}"
    httpd.shutdown()
    os.environ.pop("GRIDFORGE_API_KEYS", None)


def call(base, path, body=None, key=None, method=None):
    url = f"{base}{path}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method or ("POST" if data else "GET"))
    if data is not None:
        req.add_header("Content-Type", "application/json")
    if key:
        req.add_header("X-API-Key", key)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


GOOD = {
    "site_name": "Test DC", "metro": "Frankfurt",
    "contracted_MW": 12, "current_site_peak_MW": 7.4, "current_it_load_MW": 4.9,
    "busway_ampacity_A": 400, "tapoff_max_A": 63, "plant_supply_C": 6,
    "positions_available": 180,
}


def _walk(obj):
    if isinstance(obj, dict):
        for k, v in obj.items():
            yield k
            yield from _walk(v)
    elif isinstance(obj, list):
        for v in obj:
            yield from _walk(v)


def _strings(obj):
    if isinstance(obj, dict):
        for v in obj.values():
            yield from _strings(v)
    elif isinstance(obj, list):
        for v in obj:
            yield from _strings(v)
    elif isinstance(obj, str):
        yield obj


# --- liveness and discovery --------------------------------------------------
def test_health(server):
    status, body = call(server, "/health")
    assert status == 200 and body["ok"]


def test_version_reports_auth_configuration(server):
    status, body = call(server, "/v1/version")
    assert status == 200
    assert body["auth_configured"] is True
    assert "/v1/qualify" in body["endpoints"]


def test_platform_library_names_what_is_deliberately_absent(server):
    status, body = call(server, "/v1/platforms")
    assert status == 200
    ids = {p["id"] for p in body["platforms"]}
    assert "gb300_nvl72" in ids
    assert "vr200_nvl144" in body["deliberately_absent"], (
        "an unpublished rack power must never appear in the library"
    )
    assert "vr200_nvl144" not in ids


def test_intake_template_is_valid_json_and_complete(server):
    status, body = call(server, "/v1/intake/template")
    assert status == 200
    assert "grid" in body and "scenarios" in body


def test_unknown_path_lists_the_endpoints(server):
    status, body = call(server, "/v1/nope", {})
    assert status == 404 and body["endpoints"]


# --- the public qualifier ----------------------------------------------------
def test_qualify_returns_a_real_binding_constraint(server):
    status, body = call(server, "/v1/qualify", GOOD)
    assert status == 200, body
    assert body["as_found"]["binding_constraint"]
    assert body["as_found"]["basis"]
    assert body["after_relief"]["racks"] >= body["as_found"]["racks"]
    assert body["intake"]["gaps"], "the list of assumed inputs is the point of the free tier"


def test_qualify_never_leaks_a_priced_figure(server):
    status, body = call(server, "/v1/qualify", GOOD)
    assert status == 200
    keys = set(_walk(body))
    leaked = keys & PUBLIC_REDACTED_KEYS
    assert not leaked, f"public payload leaked paid content: {leaked}"
    blob = json.dumps(body)
    assert "EUR" not in blob, "no currency figure may reach a public caller"


def test_qualify_says_what_it_is_not(server):
    _, body = call(server, "/v1/qualify", GOOD)
    assert "not a bankable number" in body["notice"]


def test_qualify_refuses_when_there_is_too_little_to_say(server):
    status, body = call(server, "/v1/qualify", {"contracted_MW": 10})
    assert status == 422
    assert "missing" in body


def test_qualify_expands_into_a_sparse_intake_not_a_fabricated_one():
    doc = qualify_to_intake(GOOD)
    assert doc["grid"]["contracted_MW"] == 12
    assert "transformers" not in doc, (
        "the qualifier must not invent a transformer schedule; it must be recorded as missing"
    )


def test_qualify_assumes_connection_parity_rather_than_headroom():
    doc = qualify_to_intake({"contracted_MW": 12})
    assert doc["grid"]["firm_capacity_MVA"] == pytest.approx(12 / 0.97)


# --- the paid tier -----------------------------------------------------------
def test_paid_endpoints_require_a_key(server):
    for path in ("/v1/screen", "/v1/study", "/v1/portfolio"):
        status, body = call(server, path, {"intake": {}})
        assert status == 401, path
        assert body["public_endpoint"] == "/v1/qualify"


def test_screen_with_a_key_returns_the_priced_content(server):
    status, body = call(server, "/v1/screen", {"intake": qualify_to_intake(GOOD)}, key=KEY)
    assert status == 200, body
    blob = json.dumps(body)
    assert "capex_total_eur" in blob
    assert "lead_time_weeks" in blob


def test_study_with_a_key_returns_a_model_pack(server):
    status, body = call(server, "/v1/study", {"intake": qualify_to_intake(GOOD)}, key=KEY)
    assert status == 200, body
    assert body["schema"].startswith("gridforge/model-pack")
    assert body["scenarios"]


def test_portfolio_ranks_several_halls(server):
    doc = qualify_to_intake(GOOD)
    other = qualify_to_intake({**GOOD, "contracted_MW": 26, "tapoff_max_A": 400,
                               "busway_ampacity_A": 1000, "plant_supply_C": 18})
    status, body = call(server, "/v1/portfolio", {"intakes": [doc, other]}, key=KEY)
    assert status == 200, body
    assert [h["rank"] for h in body["halls"]] == [1, 2]
    assert body["total_racks"] >= 0


def test_portfolio_rejects_a_missing_list(server):
    status, body = call(server, "/v1/portfolio", {"intakes": []}, key=KEY)
    assert status == 422


# --- failure modes -----------------------------------------------------------
def test_bad_json_is_a_400_not_a_500(server):
    req = urllib.request.Request(f"{server}/v1/qualify", data=b"{not json",
                                 headers={"Content-Type": "application/json"}, method="POST")
    try:
        urllib.request.urlopen(req, timeout=10)
        raise AssertionError("expected an error")
    except urllib.error.HTTPError as e:
        assert e.code == 400


def test_unknown_platform_is_a_422_with_the_available_list(server):
    status, body = call(server, "/v1/qualify", {**GOOD, "platform": "vr200_nvl144"})
    assert status == 422
    assert "unknown platform" in body["error"]


def test_unknown_objective_is_rejected(server):
    status, body = call(server, "/v1/qualify", {**GOOD, "objective": "vibes"})
    assert status == 422
    assert body["allowed"]


def test_rate_limit_returns_429(server):
    Handler.limiter.per_minute = 2
    Handler.limiter._hits.clear()
    try:
        codes = [call(server, "/v1/qualify", GOOD)[0] for _ in range(4)]
        assert 429 in codes
    finally:
        Handler.limiter.per_minute = 0
        Handler.limiter._hits.clear()


def test_cors_preflight_is_answered(server):
    status, _ = call(server, "/v1/qualify", method="OPTIONS")
    assert status == 204


# --- the redactor itself -----------------------------------------------------
def test_redactor_strips_at_any_depth():
    payload = {"a": {"b": [{"capex_eur": 1, "keep": 2}]}}
    out = redact(payload, Tier.PUBLIC)
    assert out == {"a": {"b": [{"keep": 2}]}}
    assert redact(payload, Tier.CLIENT) == payload
