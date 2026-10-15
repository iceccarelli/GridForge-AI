"""Engine API contract found by hitting a live socket: billing, validation, framing, identity."""
import json
import os
import socket
import threading
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

import pytest

from gridforge.api import server as S
from gridforge.api.metering import METER, KeyPlan

KEY = "sk_contract_a"
OTHER = "sk_contract_b"


@pytest.fixture(scope="module")
def base():
    os.environ["GRIDFORGE_API_KEYS"] = f"{KEY}::5,{OTHER}"
    S.Handler.limiter.per_minute = 0
    httpd = S.make_server("127.0.0.1", 0)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{httpd.server_address[1]}"
    httpd.shutdown()
    os.environ.pop("GRIDFORGE_API_KEYS", None)


def post(base, path, body, key=KEY, headers=None, raw=None):
    data = raw if raw is not None else json.dumps(body).encode()
    req = urllib.request.Request(base + path, data=data, method="POST")
    req.add_header("Content-Type", "application/json")
    if key:
        req.add_header("X-API-Key", key)
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def used(account):
    return METER.current(account).units


GOOD = {"site_name": "T", "metro": "Frankfurt", "contracted_MW": 12, "current_site_peak_MW": 7.4,
        "current_it_load_MW": 4.9, "busway_ampacity_A": 400, "tapoff_max_A": 63,
        "plant_supply_C": 6, "positions_available": 180}


def test_a_failed_call_is_not_billed(base):
    plans = {p.key: p for p in S.key_plans().values()}
    acct = plans[KEY].account
    before = used(acct)
    status, body = post(base, "/v1/screen", {"grid": {"contracted_MW": "abc", "firm_capacity_MVA": 12}})
    assert status == 422, body
    assert "Traceback" not in json.dumps(body)
    assert used(acct) == before
    status, body = post(base, "/v1/screen", GOOD)            # the short web form is not an intake
    assert status == 422 and "none of the intake fields" in body["error"]
    assert used(acct) == before


def test_nan_is_not_json(base):
    status, body = post(base, "/v1/screen", None, raw=b'{"contracted_MW": NaN}')
    assert status == 400 and "NaN" in body["error"]


def test_a_bad_content_length_is_a_400_not_a_hang_or_a_dropped_connection(base):
    host, port = base.replace("http://", "").split(":")
    for cl in ("-1", "abc"):
        s = socket.create_connection((host, int(port)), timeout=5)
        s.sendall((f"POST /v1/screen HTTP/1.1\r\nHost: x\r\nX-API-Key: {KEY}\r\n"
                   f"Content-Length: {cl}\r\n\r\n").encode())
        reply = s.recv(4096).decode()
        s.close()
        assert reply.startswith("HTTP/1.0 400") or reply.startswith("HTTP/1.1 400"), (cl, reply[:80])


def test_a_non_ascii_credential_is_a_401_not_a_dropped_connection(base):
    status, _ = post(base, "/v1/screen", GOOD, key="sk_é")
    assert status == 401


def test_bearer_scheme_is_case_insensitive(base):
    status, _ = post(base, "/v1/screen", {"grid": {"contracted_MW": 12, "firm_capacity_MVA": 12}},
                     key=None, headers={"Authorization": f"bearer {KEY}"})
    assert status == 200


def test_unlabelled_keys_do_not_share_an_account(base):
    plans = S.key_plans()
    assert plans[KEY].account != plans[OTHER].account
    a = KeyPlan.parse("sk_live_a")
    b = KeyPlan.parse("sk_live_b")
    assert a.account != b.account


def test_concurrent_calls_cannot_overshoot_the_quota():
    acct = "race-account"
    METER._usage.pop((acct, METER.current(acct).month), None)
    quota = 20
    with ThreadPoolExecutor(16) as ex:
        results = list(ex.map(lambda _: METER.reserve(acct, "/v1/screen", 1, quota) is not None,
                              range(100)))
    assert sum(results) == quota
    assert used(acct) == quota


def test_refund_returns_units():
    acct = "refund-account"
    METER.reserve(acct, "/v1/study", 23, 100)
    METER.refund(acct, "/v1/study", 23)
    assert used(acct) == 0 and METER.current(acct).calls == 0


def test_rate_limit_ignores_a_spoofed_leftmost_forwarded_address():
    class H(S.Handler):
        def __init__(self, xff, peer="10.0.0.1"):
            self.headers = {"X-Forwarded-For": xff}
            self.headers = type("Hd", (), {"get": lambda _s, k, d=None: self_headers.get(k, d)})()
            self.client_address = (peer, 1)
    self_headers = {}
    h = H.__new__(H)
    h.client_address = ("10.0.0.1", 1)
    for spoof in ("1.1.1.1", "2.2.2.2"):
        self_headers.clear()
        self_headers["X-Forwarded-For"] = f"{spoof}, 203.0.113.9"
        h.headers = type("Hd", (), {"get": lambda _s, k, d=None: self_headers.get(k, d)})()
        assert h._client_key() == "203.0.113.9"


INTAKE = {"grid": {"contracted_MW": 12, "firm_capacity_MVA": 12}}


def test_every_json_answer_declares_its_schema_version(base):
    status, body = post(base, "/v1/screen", INTAKE)
    assert status == 200 and body["schema_version"] == S.API_SCHEMA
    status, body = post(base, "/v1/screen", {"grid": {"contracted_MW": "abc"}})
    assert status == 422 and body["schema_version"] == S.API_SCHEMA


def test_a_retry_with_the_same_idempotency_key_is_not_billed_twice(base):
    acct = S.key_plans()[KEY].account
    h = {"Idempotency-Key": "retry-after-timeout-1"}
    before = used(acct)
    s1, b1 = post(base, "/v1/screen", INTAKE, headers=h)
    mid = used(acct)
    s2, b2 = post(base, "/v1/screen", INTAKE, headers=h)
    assert s1 == s2 == 200 and b1 == b2
    assert mid > before and used(acct) == mid, "the replay must cost nothing"


def test_reusing_an_idempotency_key_for_a_different_request_is_refused(base):
    h = {"Idempotency-Key": "reuse-with-other-body"}
    assert post(base, "/v1/screen", INTAKE, headers=h)[0] == 200
    s, body = post(base, "/v1/screen", {"grid": {"contracted_MW": 9, "firm_capacity_MVA": 9}}, headers=h)
    assert s == 422 and "different request body" in body["error"]
