"""Who a caller is, for the engine's rate limiter, and what else the limiter covers.

Defect (stress review, 2026-11-06): the caller was ``X-Forwarded-For[-1]`` with one trusted hop by DEFAULT, so on any deployment without a
proxy of ours in front the "last entry" was whatever the client typed: 80 calls, each with a different single-entry X-Forwarded-For, all got
200 against a 60 per minute cap. Also: only POST was limited (every GET, including the operator routes, was free to hammer), and a one-
character GRIDFORGE_ADMIN_KEY was accepted at startup.

Local servers on port 0 and real HTTP, as the other API tests do.
"""
from __future__ import annotations

import http.client
import json
import threading

import pytest

from gridforge.api import server as S

GOOD = {"contracted_MW": 12, "current_site_peak_MW": 7, "current_it_load_MW": 4, "busway_ampacity_A": 400, "tapoff_max_A": 63,
        "plant_supply_C": 6, "positions_available": 100}


CAP = 20          # requests per minute per caller in these tests (the production setting is 60; the first test uses 60 to reproduce the report)


@pytest.fixture
def base(monkeypatch):
    for name in ("GRIDFORGE_TRUSTED_PROXY_HOPS", "GRIDFORGE_TRUSTED_IP_HEADER", "FLY_APP_NAME"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr(S.Handler, "limiter", S._RateLimiter(CAP))
    monkeypatch.setattr(S.Handler, "discovery_limiter", S._RateLimiter(600))
    httpd = S.make_server("127.0.0.1", 0)
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    try:
        yield httpd.server_address[1]
    finally:
        httpd.shutdown()
        httpd.server_close()


def req(port, method, path, body=None, headers=None):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=20)
    try:
        data = json.dumps(body).encode() if body is not None else None
        h = {"Content-Type": "application/json", **(headers or {})}
        conn.request(method, path, body=data, headers=h)
        r = conn.getresponse()
        r.read()
        return r.status
    finally:
        conn.close()


def codes(port, n, headers_for, method="POST", path="/v1/qualify", body=GOOD):
    return [req(port, method, path, body if method == "POST" else None, headers_for(i)) for i in range(n)]


# --- the reproduced defect ---------------------------------------------------------------------------------------------------------
def test_rotating_single_entry_forwarded_for_no_longer_buys_a_fresh_allowance(base, monkeypatch):
    monkeypatch.setattr(S.Handler, "limiter", S._RateLimiter(60))                      # the production cap, as in the report
    got = codes(base, 80, lambda i: {"X-Forwarded-For": f"198.51.100.{i + 1}"})      # base b649b3e: all 80 answered 200
    assert got.count(200) == 60 and got.count(429) == 20


@pytest.mark.parametrize("header", ["X-Forwarded-For", "X-Real-IP", "Forwarded", "Fly-Client-IP", "CF-Connecting-IP", "True-Client-IP"])
def test_with_no_declared_proxy_no_client_supplied_header_changes_the_identity(base, header):
    got = codes(base, CAP + 10, lambda i: {header: f"203.0.113.{i + 1}" if header != "Forwarded" else f"for=203.0.113.{i + 1}"})
    assert 429 in got and got.count(200) == CAP


# --- a declared proxy: the entry it appended, counted from the right ------------------------------------------------------------------
def test_one_declared_hop_counts_the_entry_our_proxy_appended_not_what_the_client_prepended(base, monkeypatch):
    monkeypatch.setenv("GRIDFORGE_TRUSTED_PROXY_HOPS", "1")
    got = codes(base, CAP + 10, lambda i: {"X-Forwarded-For": f"10.9.{i}.1, 203.0.113.9"})          # the client rotates; our proxy saw one host
    assert got.count(200) == CAP and got.count(429) == 10
    # a different real address has its own allowance
    assert req(base, "POST", "/v1/qualify", GOOD, {"X-Forwarded-For": "1.2.3.4, 203.0.113.10"}) == 200


def test_two_declared_hops_count_from_the_right_twice(base, monkeypatch):
    monkeypatch.setenv("GRIDFORGE_TRUSTED_PROXY_HOPS", "2")
    got = codes(base, CAP + 10, lambda i: {"X-Forwarded-For": f"spoof-{i}, 203.0.113.9, 192.0.2.1"})   # [-2] is the client address our edge proxy saw
    assert got.count(200) == CAP
    assert req(base, "POST", "/v1/qualify", GOOD, {"X-Forwarded-For": "x, 203.0.113.77, 192.0.2.1"}) == 200


def test_a_declared_proxy_with_too_short_a_header_falls_back_to_the_socket_peer(base, monkeypatch):
    monkeypatch.setenv("GRIDFORGE_TRUSTED_PROXY_HOPS", "2")
    got = codes(base, CAP + 10, lambda i: {"X-Forwarded-For": f"198.51.100.{i + 1}"})          # one entry is fewer than two hops: not an identity
    assert got.count(200) == CAP


# --- Fly.io -----------------------------------------------------------------------------------------------------------------------------
def test_on_fly_the_fly_client_ip_header_is_the_identity_and_a_forwarded_for_spoof_is_ignored(base, monkeypatch):
    monkeypatch.setenv("FLY_APP_NAME", "gridforge-engine")
    got = codes(base, CAP + 10, lambda i: {"Fly-Client-IP": "203.0.113.5", "X-Forwarded-For": f"9.9.9.{i + 1}, 203.0.113.5"})
    assert got.count(200) == CAP and got.count(429) == 10
    assert req(base, "POST", "/v1/qualify", GOOD, {"Fly-Client-IP": "203.0.113.6"}) == 200


def test_on_fly_without_the_header_the_forwarded_for_entry_our_proxy_appended_is_used(base, monkeypatch):
    monkeypatch.setenv("FLY_APP_NAME", "gridforge-engine")             # the platform default is one hop
    got = codes(base, CAP + 10, lambda i: {"X-Forwarded-For": f"spoof-{i}, 203.0.113.5"})
    assert got.count(200) == CAP


def test_off_fly_the_fly_client_ip_header_is_just_text_a_client_typed(base):
    got = codes(base, CAP + 10, lambda i: {"Fly-Client-IP": f"203.0.113.{i + 1}"})
    assert got.count(200) == CAP


# --- an operator-named header -------------------------------------------------------------------------------------------------------------
def test_a_header_the_operator_names_is_trusted_and_others_are_not(base, monkeypatch):
    monkeypatch.setenv("GRIDFORGE_TRUSTED_IP_HEADER", "CF-Connecting-IP")
    got = codes(base, CAP + 10, lambda i: {"CF-Connecting-IP": "203.0.113.5", "X-Forwarded-For": f"9.9.9.{i + 1}"})
    assert got.count(200) == CAP
    assert req(base, "POST", "/v1/qualify", GOOD, {"CF-Connecting-IP": "203.0.113.6"}) == 200


# --- the identity itself (no network) ----------------------------------------------------------------------------------------------------
class _H(S.Handler):
    def __init__(self, headers, peer="10.0.0.1"):
        self.headers = type("Hd", (), {"get": lambda _s, k, d=None: {x.lower(): v for x, v in headers.items()}.get(k.lower(), d)})()
        self.client_address = (peer, 1)


def test_default_identity_is_the_socket_peer(monkeypatch):
    for name in ("GRIDFORGE_TRUSTED_PROXY_HOPS", "GRIDFORGE_TRUSTED_IP_HEADER", "FLY_APP_NAME"):
        monkeypatch.delenv(name, raising=False)
    assert _H({"X-Forwarded-For": "1.1.1.1, 2.2.2.2"})._client_key() == "10.0.0.1"


@pytest.mark.parametrize("junk", ["not-an-ip", "999.1.1.1", "", "1.1.1.1:80", "'; drop table", "a" * 500])
def test_text_that_is_not_an_address_is_never_an_identity(monkeypatch, junk):
    monkeypatch.setenv("GRIDFORGE_TRUSTED_PROXY_HOPS", "1")
    assert _H({"X-Forwarded-For": junk})._client_key() == "10.0.0.1"


def test_ipv6_is_counted_per_slash_64_and_a_mapped_v4_is_the_v4(monkeypatch):
    monkeypatch.setenv("GRIDFORGE_TRUSTED_PROXY_HOPS", "1")
    a = _H({"X-Forwarded-For": "2001:db8:1:2::1"})._client_key()
    b = _H({"X-Forwarded-For": "2001:db8:1:2:ffff:ffff:ffff:ffff"})._client_key()
    c = _H({"X-Forwarded-For": "2001:db8:1:3::1"})._client_key()
    assert a == b and a != c
    assert _H({"X-Forwarded-For": "::ffff:203.0.113.9"})._client_key() == "203.0.113.9"


@pytest.mark.parametrize("bad", ["x", "-1", "1.5", ""])
def test_a_malformed_hop_count_is_treated_as_unset_not_as_trust(monkeypatch, bad):
    monkeypatch.setenv("GRIDFORGE_TRUSTED_PROXY_HOPS", bad)
    monkeypatch.delenv("FLY_APP_NAME", raising=False)
    monkeypatch.delenv("GRIDFORGE_TRUSTED_IP_HEADER", raising=False)
    assert _H({"X-Forwarded-For": "1.1.1.1, 2.2.2.2"})._client_key() == "10.0.0.1"


# --- GET routes ---------------------------------------------------------------------------------------------------------------------------
@pytest.mark.parametrize("path", ["/v1/platforms", "/v1/intake/template", "/v1/calibration", "/v1/calibration/residuals", "/v1/usage",
                                  "/v1/estimate?endpoint=/v1/screen", "/v1/admin/ledger", "/v1/admin/economics", "/nope"])
def test_every_get_that_is_not_discovery_is_charged_to_the_limiter(base, monkeypatch, path):
    monkeypatch.setattr(S.Handler, "limiter", S._RateLimiter(5))
    got = codes(base, 9, lambda i: {}, method="GET", path=path)
    assert got[-1] == 429 and 429 not in got[:5], (path, got)       # five answered (whatever they were), then the limit


def test_the_operator_routes_cannot_be_guessed_at_machine_speed(base, monkeypatch):
    monkeypatch.setattr(S.Handler, "limiter", S._RateLimiter(5))
    got = [req(base, "GET", "/v1/admin/ledger", None, {"X-API-Key": f"guess-{i}"}) for i in range(12)]
    assert got[:5] == [404] * 5 and set(got[5:]) == {429}


def test_the_post_and_get_limits_share_one_allowance(base, monkeypatch):
    monkeypatch.setattr(S.Handler, "limiter", S._RateLimiter(4))
    assert [req(base, "POST", "/v1/qualify", GOOD) for _ in range(2)] == [200, 200]
    assert [req(base, "GET", "/v1/platforms") for _ in range(2)] == [200, 200]
    assert req(base, "GET", "/v1/platforms") == 429 and req(base, "POST", "/v1/qualify", GOOD) == 429


@pytest.mark.parametrize("path", ["/health", "/v1/version", "/v1/tools"])
def test_discovery_routes_are_not_charged_to_the_main_limiter_but_are_bounded(base, monkeypatch, path):
    monkeypatch.setattr(S.Handler, "limiter", S._RateLimiter(5))
    monkeypatch.setattr(S, "DISCOVERY_MIN_PER_MINUTE", 25)
    monkeypatch.setattr(S, "DISCOVERY_FACTOR", 1)
    monkeypatch.setattr(S.Handler, "discovery_limiter", S._RateLimiter(25))
    got = codes(base, 30, lambda i: {}, method="GET", path=path)
    assert got[:25] == [200] * 25 and got[25:] == [429] * 5          # far past the main limit of 5, then the discovery bound
    # and the main allowance is untouched by them
    assert req(base, "GET", "/v1/platforms") == 200


def test_the_limiter_off_leaves_discovery_off_too(base, monkeypatch):
    monkeypatch.setattr(S.Handler, "limiter", S._RateLimiter(0))
    assert set(codes(base, 40, lambda i: {}, method="GET", path="/health")) == {200}


# --- weak secrets --------------------------------------------------------------------------------------------------------------------------
@pytest.mark.parametrize("name", ["GRIDFORGE_ADMIN_KEY", "GRIDFORGE_KEY_SECRET"])
@pytest.mark.parametrize("value", ["x", "admin", "a" * 23, " " + "b" * 22 + " "])
def test_a_short_secret_is_reported_by_name_and_length_never_by_value(name, value):
    msgs = S.weak_secrets({name: value})
    assert len(msgs) == 1 and name in msgs[0] and "at least 24" in msgs[0]


def test_the_message_never_contains_the_secret():
    msgs = S.weak_secrets({"GRIDFORGE_ADMIN_KEY": "Zq9-rotate-me"})
    assert len(msgs) == 1 and "Zq9" not in msgs[0] and "13 characters" in msgs[0]


@pytest.mark.parametrize("value", ["a" * 24, "0123456789abcdef0123456789abcdef", "openssl-rand-hex-32-style-string-ok"])
def test_a_24_character_secret_is_accepted(value):
    assert S.weak_secrets({"GRIDFORGE_ADMIN_KEY": value, "GRIDFORGE_KEY_SECRET": value}) == []


def test_unset_and_empty_secrets_are_not_weak_they_mean_the_surface_is_off():
    assert S.weak_secrets({}) == [] and S.weak_secrets({"GRIDFORGE_ADMIN_KEY": "", "GRIDFORGE_KEY_SECRET": ""}) == []


def test_serve_refuses_to_start_with_a_weak_secret_before_binding_anything(monkeypatch, capsys):
    monkeypatch.setenv("GRIDFORGE_ADMIN_KEY", "short")
    monkeypatch.delenv("GRIDFORGE_KEY_SECRET", raising=False)
    with pytest.raises(SystemExit) as e:
        S.serve("127.0.0.1", 0)
    assert e.value.code == 2
    err = capsys.readouterr().err
    assert "GRIDFORGE_ADMIN_KEY is 5 characters" in err and "short" not in err.replace("GRIDFORGE_ADMIN_KEY is 5 characters", "")


def test_make_server_for_tests_and_embedders_is_not_gated(monkeypatch):
    monkeypatch.setenv("GRIDFORGE_ADMIN_KEY", "short")
    httpd = S.make_server("127.0.0.1", 0)
    httpd.server_close()
