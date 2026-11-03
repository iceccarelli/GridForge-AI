"""Adversarial HTTP-layer tests over a REAL socket (the same Handler the deployment runs, a private ledger file and signed keys of any scope,
via tests/payg_rig.py). Independent QA pass; no product code, assumption or existing test is touched.

Convention (see tests/test_adversarial_intake.py): a passing test pins correct behaviour; ``xfail(strict=True, reason='confirmed defect: ...')``
pins a defect that is real on this commit and turns red the day it is fixed. The docstring of each test states what a correct system does:
REFUSE (structured 4xx, never a 5xx / hang / dropped connection), DEGRADE WITH DISCLOSURE, or QUALIFY.
"""
from __future__ import annotations

import http.client
import json
import threading
import time
from pathlib import Path

import pytest

from gridforge.api import keys as K
from gridforge.api import server as S
from gridforge.api.metering import UNIT_COST
from payg_rig import ADMIN, rig  # noqa: F401  (rig is a fixture)

ROOT = Path(__file__).resolve().parent.parent
REF = json.loads((ROOT / "examples" / "intake" / "reference_hall.json").read_text())
SCREEN_UNITS = UNIT_COST["/v1/screen"]
JSON_CT = {"Content-Type": "application/json"}


def raw(rig, path: str, data: bytes | None, headers: dict | None = None, key: str | None = None, method: str = "POST"):
    """One request with exactly the bytes and headers given: (status, parsed body or bytes, response headers)."""
    host, port = rig.base.removeprefix("http://").split(":")
    conn = http.client.HTTPConnection(host, int(port), timeout=60)
    h = dict(headers or {})
    if key:
        h["X-API-Key"] = key
    try:
        conn.request(method, path, body=data, headers=h)
        resp = conn.getresponse()
        payload = resp.read()
        try:
            parsed = json.loads(payload or b"{}")
        except ValueError:
            parsed = payload
        return resp.status, parsed, {k.lower(): v for k, v in resp.getheaders()}
    finally:
        conn.close()


def charges(rig):
    ev = rig.events()
    return [e for e in ev if e["kind"] == "charge"], [e for e in ev if e["kind"] == "refund"]


def net_units(rig) -> int:
    c, r = charges(rig)
    return sum(e["units"] for e in c) - sum(e["units"] for e in r)


BODY = json.dumps({"intake": REF}).encode()


@pytest.fixture
def key(rig):
    return rig.key("payg", quota=1000, account="acme")


# ===================================================================================================================================
# Hostile bodies
# ===================================================================================================================================


def test_an_oversize_body_is_413_and_costs_nothing(rig, key):
    """REFUSE: a body over the 512 KiB limit is a 413 with the limit stated, before any work, and nothing is billed."""
    status, out, _ = raw(rig, "/v1/screen", b'{"x":"' + b"a" * (S.MAX_BODY_BYTES + 10) + b'"}', JSON_CT, key)
    assert status == 413 and out["max_bytes"] == S.MAX_BODY_BYTES
    assert net_units(rig) == 0


def test_a_declared_length_beyond_the_limit_is_refused_without_reading_the_body(rig, key):
    """REFUSE: Content-Length of 1 TiB is a 413 immediately (the server must not try to read or allocate it)."""
    started = time.time()
    status, _, _ = raw(rig, "/v1/screen", b"{}", {"Content-Length": str(2 ** 40)}, key)
    assert status == 413 and time.time() - started < 5


@pytest.mark.parametrize("length", ["-5", "abc", "1.5", "0x10"], ids=repr)
def test_a_malformed_content_length_is_a_400(rig, key, length):
    """REFUSE: a Content-Length that is not a non-negative integer is a 400, not a 500 and not a hang."""
    status, _, _ = raw(rig, "/v1/screen", b"{}", {"Content-Length": length}, key)
    assert status == 400


@pytest.mark.parametrize("data,label", [(b"\xff\xfe\xfd", "bare invalid bytes"), (b'{"intake": "\xff\xfe"}', "invalid utf-8 inside a string"),
                                        (b'{"intake": "\xc0\xaf"}', "overlong encoding")])
def test_invalid_utf8_is_a_400_not_a_server_fault(rig, key, data, label):
    """REFUSE: bytes that are not UTF-8 are a 400 naming invalid JSON; the connection still answers."""
    status, out, _ = raw(rig, "/v1/screen", data, JSON_CT, key)
    assert status == 400 and "invalid JSON" in out["error"], label


def test_a_lone_surrogate_in_a_text_field_never_becomes_a_server_fault(rig, key):
    """REFUSE or QUALIFY: the UTF-8 bytes of a lone surrogate (CESU style) must not crash rendering or response encoding: any answer below 500,
    and the body that comes back is itself valid JSON."""
    d = json.loads(json.dumps(REF))
    d["project"]["client"] = "Lone\ud800Surrogate"
    for fmt in ("json", "md", "html"):
        status, out, _ = raw(rig, "/v1/screen", json.dumps({"intake": d, "format": fmt}).encode(), JSON_CT, key)
        assert status < 500 and isinstance(out, dict), (fmt, status)
    status, out, _ = raw(rig, "/v1/screen", b'{"intake": "\xed\xa0\x80"}', JSON_CT, key)
    assert status < 500


def test_a_raw_null_byte_inside_a_string_is_refused_as_a_control_character(rig, key):
    """REFUSE: an unescaped NUL inside a JSON string violates the grammar: 400, and the server keeps serving."""
    status, out, _ = raw(rig, "/v1/screen", BODY.replace(b"Reference Project", b"Ref\x00Project"), JSON_CT, key)
    assert status == 400 and "control character" in out["error"]
    assert raw(rig, "/v1/screen", BODY, JSON_CT, key)[0] == 200


@pytest.mark.parametrize("literal", [b"NaN", b"Infinity", b"-Infinity", b"1e999", b"-1e999"], ids=lambda b: b.decode())
def test_non_finite_json_numbers_are_refused(rig, key, literal):
    """REFUSE: NaN/Infinity are not JSON, and 1e999 parses to infinity: both are 4xx naming the value, never solved."""
    status, _, _ = raw(rig, "/v1/screen", b'{"intake": {"grid": {"contracted_MW": ' + literal + b"}}}", JSON_CT, key)
    assert 400 <= status < 500


def test_a_byte_order_mark_is_refused_or_answered_exactly_like_the_same_body_without_one(rig, key):
    """REFUSE or QUALIFY: a UTF-8 BOM must never change the meaning of a request (400, or the identical 200 payload)."""
    plain = raw(rig, "/v1/compare", json.dumps({"intake": REF}).encode(), JSON_CT, key)
    bom = raw(rig, "/v1/compare", b"\xef\xbb\xbf" + json.dumps({"intake": REF}).encode(), JSON_CT, key)
    assert bom[0] == 400 or (bom[0] == plain[0] == 200 and bom[1]["scenarios"] == plain[1]["scenarios"])


def test_a_utf16_body_is_refused_or_answered_exactly_like_utf8(rig, key):
    """REFUSE or QUALIFY: RFC 8259 JSON on the wire is UTF-8; a UTF-16 body must be a 400 or mean the same thing."""
    text = json.dumps({"intake": REF})
    plain = raw(rig, "/v1/compare", text.encode(), JSON_CT, key)
    u16 = raw(rig, "/v1/compare", text.encode("utf-16"), JSON_CT, key)
    assert 400 <= u16[0] < 500 or u16[1]["scenarios"] == plain[1]["scenarios"]


@pytest.mark.parametrize("shape", ["list", "object"])
def test_a_ten_thousand_level_body_on_a_keyed_route_is_refused_and_not_billed(rig, key, shape):
    """REFUSE: 10,000 levels of nesting on a paid route is a 4xx with a response (never a dropped connection), costs nothing, and the next
    request on the same server succeeds."""
    data = (b"[" * 10_000 + b"]" * 10_000) if shape == "list" else (b'{"a":' * 10_000 + b"1" + b"}" * 10_000)
    status, out, _ = raw(rig, "/v1/screen", data, JSON_CT, key)
    assert 400 <= status < 500 and out["error"]
    assert net_units(rig) == 0
    assert raw(rig, "/v1/screen", BODY, JSON_CT, key)[0] == 200


@pytest.mark.parametrize("top", [b"[]", b"null", b"7", b'"x"', b"true"], ids=lambda b: b.decode())
def test_a_non_object_top_level_is_a_400(rig, key, top):
    """REFUSE: every paid route needs a JSON object."""
    status, out, _ = raw(rig, "/v1/screen", top, JSON_CT, key)
    assert status == 400 and "object" in out["error"]


@pytest.mark.xfail(strict=True, reason="confirmed defect: duplicate JSON object keys are accepted and the LAST one wins silently (json.loads default), so a "
                   "proxy/WAF/validator that keeps the first sees a different request than the engine solves - gridforge/api/server.py:1707-1712 "
                   "(json.loads without object_pairs_hook)")
def test_duplicate_json_keys_are_refused(rig, key):
    """REFUSE (400 naming the duplicate key). Reproducer: POST /v1/screen with
        {"intake": {"grid": {"contracted_MW": 1}}, "intake": <reference hall>}  ->  200, solved on the second 'intake'."""
    data = b'{"intake": {"grid": {"contracted_MW": 1}}, "intake": ' + json.dumps(REF).encode() + b"}"
    status, _, _ = raw(rig, "/v1/screen", data, JSON_CT, key)
    assert status == 400


@pytest.mark.xfail(strict=True, reason="confirmed defect: Content-Type is never checked, so text/plain, application/x-www-form-urlencoded and a missing "
                   "header are all parsed as JSON (a browser can send text/plain cross-site without a preflight) - gridforge/api/server.py:1700-1712")
@pytest.mark.parametrize("ctype", ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", "application/xml"])
def test_a_wrong_content_type_is_refused_with_415(rig, ctype):
    """REFUSE (415 or 400). Reproducer: POST /v1/qualify with 'Content-Type: text/plain' and a JSON body -> 200."""
    q = json.dumps({"contracted_MW": 12, "current_site_peak_MW": 7.4, "current_it_load_MW": 4.9, "busway_ampacity_A": 400, "tapoff_max_A": 63,
                    "plant_supply_C": 6, "positions_available": 180}).encode()
    status, _, _ = raw(rig, "/v1/qualify", q, {"Content-Type": ctype})
    assert status in (400, 415)


@pytest.mark.xfail(strict=True, reason="confirmed defect: a NUL (or other C0 control character) inside a text field is accepted and echoed verbatim into the "
                   "rendered deliverable, where a C consumer, a CSV importer or a log line truncates at it - gridforge/intake/loader.py:290-310 "
                   "(text fields are not sanitised) / gridforge/reporting/render.py")
def test_a_control_character_in_a_text_field_does_not_reach_the_document(rig, key):
    """REFUSE or QUALIFY (strip). project.client 'Evil\\u0000Corp' must be refused or cleaned; it must not be printed with the NUL."""
    d = json.loads(json.dumps(REF))
    d["project"]["client"] = "Evil\u0000Corp"
    status, out, _ = raw(rig, "/v1/screen", json.dumps({"intake": d, "format": "md"}).encode(), JSON_CT, key)
    assert status in (400, 422) or "\x00" not in out["document"]


# ===================================================================================================================================
# Idempotency and billing
# ===================================================================================================================================


def test_concurrent_identical_requests_with_one_idempotency_key_bill_exactly_once(rig, key):
    """QUALIFY: eight simultaneous identical calls with one Idempotency-Key are charged once in the ledger (1 charge, 0 net extra) and
    all get the same answer. The meter, not the response cache, is what must make this true under a race."""
    results: list = []
    barrier = threading.Barrier(8)

    def worker():
        barrier.wait()
        results.append(raw(rig, "/v1/screen", BODY, {**JSON_CT, "Idempotency-Key": "one-key"}, key))

    threads = [threading.Thread(target=worker) for _ in range(8)]
    [t.start() for t in threads]
    [t.join(timeout=120) for t in threads]
    assert len(results) == 8 and {r[0] for r in results} == {200}
    c, r = charges(rig)
    assert len(c) == 1 and not r and net_units(rig) == SCREEN_UNITS
    assert len({json.dumps(r_[1], sort_keys=True) for r_ in results}) == 1, "every replay carries the same answer"
    assert rig.get("/v1/usage", key=key)[1]["units"] == SCREEN_UNITS


def test_a_replay_is_marked_and_free_and_a_different_body_under_the_same_key_is_refused(rig, key):
    """REFUSE: the same key with another body is a 422 and is not billed; the true replay says so in a header and costs 0 units."""
    h = {**JSON_CT, "Idempotency-Key": "k-1"}
    first = raw(rig, "/v1/screen", BODY, h, key)
    again = raw(rig, "/v1/screen", BODY, h, key)
    other = raw(rig, "/v1/screen", json.dumps({"intake": {**REF, "hall": {**REF["hall"], "positions_available": 100}}}).encode(), h, key)
    assert first[0] == again[0] == 200 and again[2].get("x-gridforge-idempotent-replay") == "true" and again[2].get("x-gridforge-units") == "0"
    assert other[0] == 422 and "different request body" in other[1]["error"]
    assert net_units(rig) == SCREEN_UNITS


def test_an_over_long_idempotency_key_is_a_400_and_not_billed(rig, key):
    """REFUSE: a key longer than the stated maximum is a 400 with the maximum, before any charge."""
    status, out, _ = raw(rig, "/v1/screen", BODY, {**JSON_CT, "Idempotency-Key": "k" * (S.MAX_IDEM_KEY_CHARS + 1)}, key)
    assert status == 400 and out["max_chars"] == S.MAX_IDEM_KEY_CHARS and net_units(rig) == 0


def test_a_failed_call_under_an_idempotency_key_is_refunded_and_the_key_can_be_retried(rig, key):
    """QUALIFY: a call that produces no answer (422) leaves net zero units, and the same key then works for a corrected body."""
    h = {**JSON_CT, "Idempotency-Key": "retry-me"}
    bad = raw(rig, "/v1/screen", json.dumps({"intake": {**REF, "hall": {**REF["hall"], "rack_positions": 0}}}).encode(), h, key)
    assert bad[0] == 422 and net_units(rig) == 0
    good = raw(rig, "/v1/screen", BODY, h, key)
    assert good[0] == 200 and net_units(rig) == SCREEN_UNITS


def test_the_same_idempotency_key_from_two_tenants_never_replays_across_them(rig):
    """REFUSE (isolation): tenant B using tenant A's Idempotency-Key value is billed on B's own account and gets B's own computation; A's
    cached answer is never served to B."""
    a, b = rig.key("payg", quota=100, account="tenant-a"), rig.key("payg", quota=100, account="tenant-b")
    h = {**JSON_CT, "Idempotency-Key": "shared-key"}
    ra = raw(rig, "/v1/screen", BODY, h, a)
    other_body = json.dumps({"intake": {**REF, "project": {**REF["project"], "client": "Tenant B Ltd"}}}).encode()
    rb = raw(rig, "/v1/screen", other_body, h, b)
    assert ra[0] == rb[0] == 200 and rb[2].get("x-gridforge-idempotent-replay") is None
    assert "Tenant B Ltd" in json.dumps(rb[1]) and "Tenant B Ltd" not in json.dumps(ra[1])
    assert rig.meter.current("tenant-a").units == SCREEN_UNITS and rig.meter.current("tenant-b").units == SCREEN_UNITS


# ===================================================================================================================================
# Tenant isolation, tier escalation, revocation
# ===================================================================================================================================


def test_usage_is_read_for_the_key_presented_and_never_for_another_tenant(rig):
    """REFUSE (isolation): GET /v1/usage reports only the presenting key's account, whatever query string or header says otherwise."""
    a, b = rig.key("payg", quota=100, account="tenant-a"), rig.key("payg", quota=100, account="tenant-b")
    for _ in range(2):
        assert raw(rig, "/v1/screen", BODY, JSON_CT, a)[0] == 200
    own = rig.get("/v1/usage", key=a)[1]
    assert own["account"] == "tenant-a" and own["units"] == 2 * SCREEN_UNITS
    for path, hdr in (("/v1/usage?account=tenant-a", {}), ("/v1/usage?account=tenant-a&key_id=x", {}), ("/v1/usage", {"X-GridForge-Account": "tenant-a"}),
                      ("/v1/usage", {"X-Account": "tenant-a", "X-Forwarded-For": "tenant-a"}), ("/v1/usage/tenant-a", {})):
        status, out, _ = rig.req("GET", path, key=b, headers=hdr)
        text = json.dumps(out)
        assert "tenant-a" not in text and out.get("units", 0) == 0 or status in (404, 422), (path, hdr, out)
    assert rig.get("/v1/usage")[0] == 401


@pytest.mark.parametrize("path", ["/v1/revoke", "/v1/admin/ledger", "/v1/admin/economics"])
def test_a_paying_key_cannot_reach_operator_surfaces_and_they_do_not_confirm_they_exist(rig, key, path):
    """REFUSE: the operator tier answers a customer key with a plain 404, identical to an unknown route's, never 401/403 that confirms it."""
    as_get = rig.req("GET", path, key=key)
    as_post = rig.post(path, {"key_id": "whatever"}, key=key)
    unknown = rig.req("GET", "/v1/no-such-thing", key=key)
    assert as_post[0] == 404 and as_post[1].get("error") == "not found"
    assert as_get[0] in (404,) and as_get[1].get("error") == "not found" and unknown[0] == 404


SPOOFS = [{"X-GridForge-Tier": "internal"}, {"X-Tier": "INTERNAL"}, {"X-Forwarded-User": "admin"}, {"X-Admin": "1"}, {"X-GridForge-Admin": "true"},
          {"Authorization": "Bearer admin"}, {"X-API-Key": "admin"}, {"X-Forwarded-For": "127.0.0.1"}, {"X-Real-IP": "127.0.0.1"}, {"Forwarded": "for=127.0.0.1"},
          {"X-Original-URL": "/v1/revoke"}, {"X-HTTP-Method-Override": "GET"}]


@pytest.mark.parametrize("spoof", SPOOFS, ids=lambda d: next(iter(d)) + "=" + next(iter(d.values())))
def test_headers_that_claim_a_higher_tier_change_nothing_without_a_key(rig, spoof):
    """REFUSE: with no valid key, no header escalates a caller to a paid or operator tier: paid routes are 401, operator routes 404."""
    assert raw(rig, "/v1/screen", BODY, {**JSON_CT, **spoof})[0] == 401
    assert raw(rig, "/v1/revoke", b'{"key_id":"x"}', {**JSON_CT, **spoof})[0] in (401, 404)
    assert raw(rig, "/v1/admin/ledger", None, spoof, method="GET")[0] in (401, 404)
    assert raw(rig, "/v1/usage", None, spoof, method="GET")[0] == 401


@pytest.mark.parametrize("variant", [ADMIN[:-1], ADMIN.upper(), ADMIN + "\x00x", "", ADMIN[:8]], ids=["prefix", "upper", "nul-suffix", "empty", "short"])
def test_a_near_miss_of_the_operator_key_is_not_the_operator(rig, variant):
    """REFUSE: only the exact operator secret opens the operator surface; truncations, case changes and padding do not (constant-time compare)."""
    for hdr in ({"X-API-Key": variant}, {"Authorization": "Bearer " + variant}):
        try:
            status, _, _ = raw(rig, "/v1/revoke", b'{"key_id":"x"}', {**JSON_CT, **hdr})
        except (ValueError, http.client.HTTPException):
            continue          # a header the client library itself refuses to send
        assert status in (401, 404)


def test_the_operator_key_in_the_query_string_or_body_is_not_accepted(rig):
    """REFUSE: credentials travel in headers only; the admin secret in a URL or a body opens nothing."""
    assert raw(rig, f"/v1/revoke?api_key={ADMIN}&key={ADMIN}", json.dumps({"key_id": "x", "api_key": ADMIN, "admin_key": ADMIN}).encode(), JSON_CT)[0] in (401, 404)


def test_a_key_issued_with_a_small_quota_cannot_exceed_it_by_changing_headers_or_projects(rig):
    """REFUSE: a 402 once the cap is reached, regardless of X-GridForge-Project labels or a spoofed tier header; nothing beyond the cap is billed."""
    small = rig.key("payg", quota=SCREEN_UNITS, account="capped")
    assert raw(rig, "/v1/screen", BODY, JSON_CT, small)[0] == 200
    for hdr in ({}, {"X-GridForge-Project": "other"}, {"X-GridForge-Tier": "internal"}):
        status, out, _ = raw(rig, "/v1/screen", BODY, {**JSON_CT, **hdr}, small)
        assert status == 402 and out["reason"] == "spending_cap_reached"
    assert rig.meter.current("capped").units == SCREEN_UNITS


def _revocation_rig(rig, tmp_path, monkeypatch):
    monkeypatch.setenv("GRIDFORGE_REVOKED_FILE", str(tmp_path / "revoked.json"))
    monkeypatch.setattr(K, "_revoked_cache", (-1.0, frozenset()))
    monkeypatch.setattr(K, "_store_seen", False)


def test_a_revoked_key_is_refused_on_the_next_request_and_a_replay_is_not_served_to_it(rig, tmp_path, monkeypatch):
    """REFUSE: after POST /v1/revoke the key gets 401 on paid routes and on /v1/usage, and an Idempotency-Key it used before does not hand
    its cached answer back."""
    _revocation_rig(rig, tmp_path, monkeypatch)
    k = rig.key("payg", quota=100, account="leaky")
    h = {**JSON_CT, "Idempotency-Key": "pre-revoke"}
    assert raw(rig, "/v1/screen", BODY, h, k)[0] == 200
    key_id = K.verify(k).key_id
    status, out, _ = raw(rig, "/v1/revoke", json.dumps({"key_id": key_id}).encode(), JSON_CT, ADMIN)
    assert status == 200 and out["revoked"] == key_id
    for path, method, data in (("/v1/screen", "POST", BODY), ("/v1/compare", "POST", json.dumps({"intake": REF}).encode()), ("/v1/usage", "GET", None)):
        status, out, _ = raw(rig, path, data, h, k, method=method)
        assert status == 401 and "revoked" in json.dumps(out), (path, out)
    assert net_units(rig) == SCREEN_UNITS, "nothing was billed after the revocation"


@pytest.mark.xfail(strict=True, reason="confirmed defect (TOCTOU): the key is resolved separately for the tier decision and again for billing, so a key revoked "
                   "(or expired) between the two is treated as 'no plan' by _charge and the PAID route runs and answers 200 with NO ledger charge - "
                   "gridforge/api/server.py:1583-1585 (_charge: `plan = self._plan(); if plan is None: return None`)")
def test_a_key_revoked_between_the_tier_check_and_the_charge_is_refused_not_served_free(rig, tmp_path, monkeypatch):
    """REFUSE (401) or QUALIFY (answer AND charge). The revocation lands at the worst instant: after the request was authorised as a client
    and before it is billed (injected by wrapping Handler._tier, so every other line is the real server). Reproducer under load: revoke a key
    while it has requests in flight; about one run in ten produces a 200 for /v1/study whose X-GridForge-Units header is absent and whose
    ledger has no charge."""
    _revocation_rig(rig, tmp_path, monkeypatch)
    k = rig.key("payg", quota=100, account="racy")
    key_id = K.verify(k).key_id
    real_tier = S.Handler._tier

    def tier_then_revoke(self):
        tier = real_tier(self)
        if tier is S.Tier.CLIENT and not getattr(tier_then_revoke, "done", False):
            tier_then_revoke.done = True
            assert K.revoke(key_id)
        return tier

    monkeypatch.setattr(S.Handler, "_tier", tier_then_revoke)
    status, _, _ = raw(rig, "/v1/study", json.dumps({"intake": REF, "format": "md"}).encode(), JSON_CT, k)
    assert status == 401 or net_units(rig) == UNIT_COST["/v1/study"], (status, net_units(rig))


def test_revoking_a_key_while_its_requests_are_in_flight_never_bills_a_refused_call(rig, tmp_path, monkeypatch):
    """QUALIFY: six slow requests start, the key is revoked mid-flight. Each is answered 200 or refused 401, a refused call is never billed
    (net units never exceed 200-count x units), no connection is dropped, and every request after the revocation is 401. (The opposite
    leak, a 200 that is not billed, is pinned deterministically by the xfail above, because it only happens in a narrow race.)"""
    _revocation_rig(rig, tmp_path, monkeypatch)
    k = rig.key("payg", quota=1000, account="inflight")
    study = json.dumps({"intake": REF, "format": "md"}).encode()
    results: list = []
    gate = threading.Barrier(7)

    def worker(i):
        gate.wait()
        results.append(raw(rig, "/v1/study", study, {**JSON_CT, "Idempotency-Key": f"k{i}"}, k))

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(6)]
    [t.start() for t in threads]
    gate.wait()
    status, _, _ = raw(rig, "/v1/revoke", json.dumps({"key_id": K.verify(k).key_id}).encode(), JSON_CT, ADMIN)
    assert status == 200
    [t.join(timeout=180) for t in threads]
    assert len(results) == 6 and {r[0] for r in results} <= {200, 401}
    ok = sum(1 for r in results if r[0] == 200)
    assert net_units(rig) <= ok * UNIT_COST["/v1/study"]
    assert raw(rig, "/v1/study", study, JSON_CT, k)[0] == 401


def test_revocation_by_a_customer_key_is_impossible_even_for_its_own_key(rig, tmp_path, monkeypatch):
    """REFUSE: a paying key cannot revoke anything, including itself or a competitor's key (operator surface only)."""
    _revocation_rig(rig, tmp_path, monkeypatch)
    mine, theirs = rig.key("payg", quota=10, account="me"), rig.key("payg", quota=10, account="them")
    for target in (mine, theirs):
        assert raw(rig, "/v1/revoke", json.dumps({"key_id": K.verify(target).key_id}).encode(), JSON_CT, mine)[0] == 404
    assert raw(rig, "/v1/screen", BODY, JSON_CT, theirs)[0] == 200
