"""The engine's two flood controls: the IPv6 /48 bucket and the engine-wide cap on concurrent solves.

Defects (harness oracle review):
  1. An IPv6 caller was counted on its /64 only. A holder of a /48 (65,536 /64s) or a /32 got a fresh allowance for every /64 it used.
     Now the caller is limited by BOTH its /64 and its enclosing /48 (the /48 allows GRIDFORGE_RATE_LIMIT_IPV6_48_MULTIPLE x the /64 limit,
     default 8); IPv4 is unchanged. A /32 holder still gets one /48 allowance per /48 it spreads over: not covered here, and not claimed.
  2. Nothing bounded how many solves ran at once: ThreadingHTTPServer starts a thread per connection. Now a gate sheds the excess with
     503 + Retry-After + a JSON body, at once, never queued. Three bounds: 16 in all (GRIDFORGE_MAX_CONCURRENT_SOLVES), 2 per caller identity
     (..._PER_CALLER) and half of the total for keyless callers. The first version had the global bound only, and the reviewer showed one
     anonymous caller on three identities holding every slot so that a light legitimate caller saw 28% 503s where before it was only slow:
     the per-caller bound and the keyless share are the fix, and test_a_heavy_anonymous_caller_cannot_starve_a_light_one proves it.
     None of this bounds how LONG one solve takes.

Local servers on port 0 and real HTTP, as the other API tests do. The slow solve is a handler that waits on an Event, so no test sleeps to
"let a race happen".
"""
from __future__ import annotations

import http.client
import json
import threading
import time

import pytest

from gridforge.api import server as S
from gridforge.api.tiers import Tier

GOOD = {"contracted_MW": 12, "current_site_peak_MW": 7, "current_it_load_MW": 4, "busway_ampacity_A": 400, "tapoff_max_A": 63,
        "plant_supply_C": 6, "positions_available": 100}
CAP = 5            # per-/64 requests per minute in these tests
MULT = 2           # so the /48 allows 10


@pytest.fixture
def base(monkeypatch):
    """A server that trusts one X-Forwarded-For hop (so a test can present any caller address) with small limits."""
    for name in ("GRIDFORGE_TRUSTED_IP_HEADER", "FLY_APP_NAME"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("GRIDFORGE_TRUSTED_PROXY_HOPS", "1")
    monkeypatch.setattr(S.Handler, "limiter", S._RateLimiter(CAP, wide_multiple=MULT))
    monkeypatch.setattr(S.Handler, "discovery_limiter", S._RateLimiter(600))
    httpd = S.make_server("127.0.0.1", 0)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    try:
        yield httpd.server_address[1]
    finally:
        httpd.shutdown()
        httpd.server_close()


def req(port, method, path, body=None, headers=None):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=30)
    try:
        data = json.dumps(body).encode() if body is not None else None
        conn.request(method, path, body=data, headers={"Content-Type": "application/json", **(headers or {})})
        r = conn.getresponse()
        raw = r.read()
        return r.status, dict(r.getheaders()), (json.loads(raw) if raw else {})
    finally:
        conn.close()


def v6(i: int, net: str = "2001:db8:abcd") -> dict:
    """A caller in `net`::/48, in its own /64 number `i`."""
    return {"X-Forwarded-For": f"{net}:{i:x}::1"}


# --- the bucket identities ---------------------------------------------------------------------------------------------------------
def test_wide_bucket_is_the_slash_48_for_ipv6_and_nothing_for_everything_else():
    a, b = S._bucket_wide("2001:db8:abcd:1::1"), S._bucket_wide("2001:db8:abcd:ffff:ffff:ffff:ffff:ffff")
    assert a == b == "2001:db8:abcd::/48"
    assert S._bucket_wide("2001:db8:abce::1") != a
    for not_wide in ("203.0.113.9", "::ffff:203.0.113.9", "not-an-ip", "", "999.1.1.1"):
        assert S._bucket_wide(not_wide) == ""
    assert S._bucket("2001:db8:abcd:1::1") == "2001:db8:abcd:1::/64"      # the /64 identity is unchanged


# --- the limiter, directly ---------------------------------------------------------------------------------------------------------
def test_many_slash_64s_inside_one_slash_48_share_one_wider_allowance():
    lim = S._RateLimiter(3, wide_multiple=2)                                # /64: 3 a minute; /48: 6
    wide = S._bucket_wide("2001:db8:abcd::1")
    got = [lim.allow(S._bucket(f"2001:db8:abcd:{i:x}::1"), wide) for i in range(10)]    # ten different /64s, one request each
    assert got == [True] * 6 + [False] * 4                                 # without the /48 charge all ten pass: 10 fresh /64 allowances
    assert lim.allow(S._bucket("2001:db8:abce:1::1"), S._bucket_wide("2001:db8:abce:1::1"))      # another /48 is untouched


def test_a_caller_is_limited_by_both_buckets_and_a_refusal_is_charged_to_neither():
    lim = S._RateLimiter(3, wide_multiple=2)
    k, w = S._bucket("2001:db8:abcd:1::1"), S._bucket_wide("2001:db8:abcd:1::1")
    assert [lim.allow(k, w) for _ in range(4)] == [True, True, True, False]            # the /64 limit stops one caller first
    assert len(lim._hits[k]) == 3 and len(lim._hits[w]) == 3                          # the refused fourth was charged to neither bucket
    other = S._bucket("2001:db8:abcd:2::1")
    assert [lim.allow(other, w) for _ in range(3)] == [True] * 3                       # a second /64 takes the /48 to 3 + 3 = 6, its full allowance
    assert not lim.allow(S._bucket("2001:db8:abcd:9::1"), w)                           # /48 full: a brand-new /64 is refused
    assert len(lim._hits[S._bucket("2001:db8:abcd:9::1")]) == 0                        # and was not charged on its own /64


def test_one_ordinary_caller_is_stopped_by_its_own_limit_never_by_the_wider_one():
    lim = S._RateLimiter(60)                                                            # production setting, default multiple
    assert lim.wide_multiple == S.IPV6_WIDE_MULTIPLE_DEFAULT >= 2 and lim.wide_limit >= 2 * 60
    k, w = S._bucket("2001:db8:abcd:1::1"), S._bucket_wide("2001:db8:abcd:1::1")
    assert all(lim.allow(k, w) for _ in range(60))                                     # all sixty answered
    assert len(lim._hits[w]) == 60 < lim.wide_limit                                    # the /48 had room left when the /64 said no
    assert not lim.allow(k, w)


def test_ipv4_is_unchanged_one_bucket_per_address():
    lim = S._RateLimiter(3, wide_multiple=2)
    assert [lim.allow("203.0.113.9") for _ in range(4)] == [True, True, True, False]
    assert all(lim.allow(f"203.0.113.{i}") for i in range(10, 40))                     # other addresses are independent, as before


def test_off_means_off():
    lim = S._RateLimiter(0)
    assert all(lim.allow("2001:db8::/64", "2001:db8::/48") for _ in range(1000))


@pytest.mark.parametrize("env, expected", [("3", 3), ("0", 1), ("-4", 1), ("x", S.IPV6_WIDE_MULTIPLE_DEFAULT), ("", S.IPV6_WIDE_MULTIPLE_DEFAULT),
                                           (None, S.IPV6_WIDE_MULTIPLE_DEFAULT)])
def test_the_multiple_is_configurable_never_below_one_and_a_bad_value_is_the_default(monkeypatch, env, expected):
    if env is None:
        monkeypatch.delenv("GRIDFORGE_RATE_LIMIT_IPV6_48_MULTIPLE", raising=False)
    else:
        monkeypatch.setenv("GRIDFORGE_RATE_LIMIT_IPV6_48_MULTIPLE", env)
    assert S._RateLimiter(10).wide_multiple == expected


# --- over HTTP ---------------------------------------------------------------------------------------------------------------------
def _drive(port, n, net="2001:db8:abcd") -> list[int]:
    """n requests, each from a different /64 inside the same /48 (each is far below the per-/64 limit)."""
    return [req(port, "POST", "/v1/qualify", GOOD, v6(i, net))[0] for i in range(n)]


def test_a_caller_spreading_over_many_slash_64s_meets_the_slash_48_limit(base):
    got = _drive(base, 14)                                                             # /48 allows CAP x MULT = 10
    assert got[:10] == [200] * 10 and set(got[10:]) == {429}
    other = req(base, "POST", "/v1/qualify", GOOD, v6(0, "2001:db8:abce"))[0]
    assert other == 200                                                                # a different /48 is a different caller


def test_removing_the_slash_48_charge_lets_the_same_caller_through_which_is_what_the_test_above_catches(base, monkeypatch):
    """Mutation-style proof: with `_bucket_wide` neutralised (the /48 charge removed) the SAME drive gets no 429 at all, so the assertion in
    test_a_caller_spreading_over_many_slash_64s_meets_the_slash_48_limit fails against that mutation."""
    monkeypatch.setattr(S, "_bucket_wide", lambda addr: "")
    got = _drive(base, 14)
    assert 429 not in got                                                              # fourteen fresh /64 allowances: the defect
    assert not (got[:10] == [200] * 10 and set(got[10:]) == {429})                     # i.e. the unmutated test's assertion would be False


def test_the_same_caller_through_one_slash_64_is_stopped_at_the_slash_64_limit(base):
    got = [req(base, "POST", "/v1/qualify", GOOD, v6(7))[0] for _ in range(CAP + 3)]
    assert got[:CAP] == [200] * CAP and set(got[CAP:]) == {429}


def test_get_routes_are_counted_on_both_buckets_too(base):
    got = [req(base, "GET", "/v1/platforms", None, v6(i))[0] for i in range(14)]
    assert 429 not in got[:10] and set(got[10:]) == {429}


def test_discovery_routes_stay_generous(base):
    assert [req(base, "GET", "/health", None, v6(i))[0] for i in range(30)] == [200] * 30


def test_an_ipv4_caller_is_unaffected(base):
    got = [req(base, "POST", "/v1/qualify", GOOD, {"X-Forwarded-For": "203.0.113.9"})[0] for _ in range(CAP + 2)]
    assert got[:CAP] == [200] * CAP and set(got[CAP:]) == {429}


# --- the concurrency cap, directly ---------------------------------------------------------------------------------------------------
def test_the_gate_admits_its_limit_and_refuses_the_next_without_waiting():
    g = S._SolveGate(2)
    assert g.enter() and g.enter() and g.full()
    t0 = time.monotonic()
    assert not g.enter()
    assert time.monotonic() - t0 < 1.0                                                 # refused at once, not queued
    g.leave()
    assert not g.full() and g.enter() and g.full()


def test_the_gate_with_no_limit_never_refuses():
    g = S._SolveGate(0)
    assert all(g.enter() for _ in range(1000)) and not g.full()
    g.leave()                                                                          # a harmless no-op


def test_the_gate_is_bounded_a_double_release_is_an_error_not_a_free_slot():
    g = S._SolveGate(1)
    with pytest.raises(ValueError):
        g.leave()


def test_default_caps_are_high_and_configurable_and_a_bad_value_is_the_default_never_off(monkeypatch):
    assert S.MAX_CONCURRENT_SOLVES_DEFAULT >= 8 and S.MAX_CONCURRENT_SOLVES_PER_CALLER_DEFAULT == 2
    for name, default in (("GRIDFORGE_MAX_CONCURRENT_SOLVES", S.MAX_CONCURRENT_SOLVES_DEFAULT),
                          ("GRIDFORGE_MAX_CONCURRENT_SOLVES_PER_CALLER", S.MAX_CONCURRENT_SOLVES_PER_CALLER_DEFAULT)):
        monkeypatch.setenv(name, "3")
        assert S._env_cap(name, default) == 3
        for bad in ("x", "", "1.5", "-1", "-100"):
            monkeypatch.setenv(name, bad)
            assert S._env_cap(name, default) == default, (name, bad)           # a typo or a negative never switches the protection off
        monkeypatch.setenv(name, "0")
        assert S._env_cap(name, default) == 0                                 # 0 is the explicit "off"
        monkeypatch.delenv(name)
        assert S._env_cap(name, default) == default


def test_every_route_is_either_a_solving_route_or_one_of_the_two_that_do_not_solve():
    """A route added later is gated unless someone says it does not solve: this list is the whole decision."""
    assert set(S.ROUTES) - S.SOLVING_ROUTES == {"/v1/estimate", "/v1/revoke"}
    assert S.SOLVING_ROUTES <= set(S.ROUTES)


def test_invoke_refuses_with_a_503_when_full_and_gives_the_slot_back_when_a_handler_fails():
    gate = S._SolveGate(1)
    old = S.SOLVE_GATE
    S.SOLVE_GATE = gate
    try:
        def boom(body, tier):
            raise RuntimeError("handler failed")
        with pytest.raises(RuntimeError):
            S._invoke("/v1/screen", boom, {}, Tier.CLIENT)
        assert not gate.full()                                                         # released on the way out
        assert gate.enter()
        with pytest.raises(S.ApiError) as e:
            S._invoke("/v1/screen", lambda b, t: {}, {}, Tier.CLIENT)
        assert e.value.status == 503 and e.value.extra["retry_after_seconds"] == S.SOLVE_RETRY_AFTER_SECONDS
        assert S._invoke("/v1/estimate", lambda b, t: {"ok": 1}, {}, Tier.PUBLIC) == {"ok": 1}      # a route that does not solve is not gated
    finally:
        S.SOLVE_GATE = old


# --- the concurrency cap, over HTTP --------------------------------------------------------------------------------------------------
@pytest.fixture
def one_slot(monkeypatch):
    monkeypatch.setattr(S, "SOLVE_GATE", S._SolveGate(1))
    monkeypatch.setattr(S.Handler, "limiter", S._RateLimiter(0))              # these tests are about the cap, not the rate limit
    monkeypatch.setattr(S.Handler, "discovery_limiter", S._RateLimiter(0))


def _serve():
    httpd = S.make_server("127.0.0.1", 0)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


def test_a_second_solve_while_the_only_slot_is_busy_gets_503_retry_after_and_json_at_once(monkeypatch, one_slot):
    inside, release = threading.Event(), threading.Event()
    real = S.ROUTES["/v1/qualify"][0]

    def slow(body, tier):
        inside.set()
        assert release.wait(30)
        return real(body, tier)
    monkeypatch.setitem(S.ROUTES, "/v1/qualify", (slow, Tier.PUBLIC))
    httpd = _serve()
    port = httpd.server_address[1]
    first: list = []
    t = threading.Thread(target=lambda: first.append(req(port, "POST", "/v1/qualify", GOOD)))
    t.start()
    try:
        assert inside.wait(30)
        t0 = time.monotonic()
        status, headers, body = req(port, "POST", "/v1/qualify", GOOD)
        elapsed = time.monotonic() - t0
        assert status == 503 and elapsed < 5                                           # answered at once while the first is still running
        assert headers["Retry-After"] == str(S.SOLVE_RETRY_AFTER_SECONDS)
        assert headers["Content-Type"].startswith("application/json")
        assert body["retryable"] is True and body["retry_after_seconds"] == S.SOLVE_RETRY_AFTER_SECONDS
        assert "max_concurrent_solves" not in body and "1" not in body["error"]            # says busy and retry; discloses no capacity
        assert "refused, not queued" in body["fix"] and "nothing was charged" in body["error"]
        # what does not solve is not shed
        assert req(port, "GET", "/health")[0] == 200
        assert req(port, "POST", "/v1/estimate", {"endpoint": "/v1/study"})[0] == 200
        assert req(port, "GET", "/v1/tools")[0] == 200
    finally:
        release.set()
        t.join(30)
        httpd.shutdown()
        httpd.server_close()
    assert first and first[0][0] == 200                                                # the solve that held the slot finished normally
    assert S.SOLVE_GATE.enter()                                                        # and gave it back


def test_after_the_slot_is_free_the_next_request_is_served(monkeypatch, one_slot):
    httpd = _serve()
    try:
        assert req(httpd.server_address[1], "POST", "/v1/qualify", GOOD)[0] == 200
        assert req(httpd.server_address[1], "POST", "/v1/qualify", GOOD)[0] == 200     # sequential use never meets a cap of 1
    finally:
        httpd.shutdown()
        httpd.server_close()


def test_a_busy_engine_answers_mcp_tool_calls_with_a_jsonrpc_error_but_still_lists_tools(monkeypatch, one_slot):
    assert S.SOLVE_GATE.enter()                                                        # hold the only slot
    httpd = _serve()
    port = httpd.server_address[1]
    try:
        call = {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "gridforge_qualify", "arguments": GOOD}}
        status, headers, body = req(port, "POST", "/mcp", call)
        assert headers["Retry-After"] == str(S.SOLVE_RETRY_AFTER_SECONDS)          # the HTTP response carries it too, not only the JSON-RPC data
        assert status == 200 and body["error"]["code"] == -32003
        assert body["error"]["data"]["status"] == 503 and body["error"]["data"]["retry_after_seconds"] == S.SOLVE_RETRY_AFTER_SECONDS
        assert "result" in req(port, "POST", "/mcp", {"jsonrpc": "2.0", "id": 2, "method": "tools/list"})[2]
        assert "result" in req(port, "POST", "/mcp", {"jsonrpc": "2.0", "id": 3, "method": "initialize", "params": {}})[2]
    finally:
        S.SOLVE_GATE.leave()
        httpd.shutdown()
        httpd.server_close()
    status, _, body = req(_serve_once(), "POST", "/mcp", call)
    assert status == 200 and "result" in body                                          # free again: the same call is answered


def _serve_once() -> int:
    return _serve().server_address[1]


def test_the_default_gate_is_the_configured_default_and_a_normal_burst_never_meets_it():
    assert S.SOLVE_GATE.limit == S._env_cap("GRIDFORGE_MAX_CONCURRENT_SOLVES", S.MAX_CONCURRENT_SOLVES_DEFAULT)
    assert S.SOLVE_GATE.limit == 0 or S.SOLVE_GATE.limit >= 8
    assert S.SOLVE_GATE.per_caller == S._env_cap("GRIDFORGE_MAX_CONCURRENT_SOLVES_PER_CALLER", S.MAX_CONCURRENT_SOLVES_PER_CALLER_DEFAULT)
    assert S.SOLVE_GATE.public_limit == max(1, S.SOLVE_GATE.limit // 2)


# --- the gate's three bounds, directly ------------------------------------------------------------------------------------------------
def test_one_caller_identity_holds_at_most_its_share_and_others_are_untouched():
    g = S._SolveGate(16, per_caller=2)
    assert g.enter("a", True) and g.enter("a", True) and not g.enter("a", True) and g.full("a", True)
    assert g.enter("b", True) and not g.full("b", True)
    g.leave("a", True)
    assert g.enter("a", True)                                                          # its own slot came back
    g2 = S._SolveGate(16, per_caller=0)                                                # 0 = off
    assert all(g2.enter("a", True) for _ in range(8))


def test_a_keyed_caller_is_not_capped_per_identity():
    """The website's own qualifier and an API customer's backend call from a few addresses with many requests in flight (tests/test_payg_http.py
    sends six concurrent keyed requests from one address): only keyless identities are capped one by one."""
    g = S._SolveGate(16, per_caller=2)
    assert all(g.enter("website", False) for _ in range(6)) and g._callers == {}
    for _ in range(6):
        g.leave("website", False)


def test_keyless_callers_hold_at_most_half_the_slots_and_a_keyed_caller_always_has_headroom():
    g = S._SolveGate(8, per_caller=0)
    assert g.public_limit == 4
    assert [g.enter(f"p{i}", True) for i in range(6)] == [True] * 4 + [False] * 2     # the fifth keyless solve is refused...
    assert g.enter("k", False) and g.enter("k2", False) and g.enter("k3", False) and g.enter("k4", False)    # ...while keyed callers fill the rest
    assert not g.enter("k5", False)                                                    # and the global bound still holds
    assert S._SolveGate(1).public_limit == 1 and S._SolveGate(3).public_limit == 1 and S._SolveGate(0).public_limit == 0


def test_a_look_takes_nothing_and_cannot_hide_a_free_slot():
    g = S._SolveGate(1, per_caller=1)
    for _ in range(1000):
        assert not g.full("a", False)
    assert (g._active, g._public, dict(g._callers)) == (0, 0, {})                      # no slot was taken to look
    assert g.enter("a", False) and g.full("a", False) and g.full("b", False)
    g.leave("a", False)
    assert g._callers == {} and not g.full("b", False)


def test_leave_must_match_an_enter():
    g = S._SolveGate(4, per_caller=2)
    assert g.enter("a", True)
    with pytest.raises(ValueError):
        g.leave("b", True)                                                             # nobody named b holds one
    g.leave("a", True)


# --- the reviewer's scenario: a heavy anonymous caller must not starve a light one ----------------------------------------------------
def _scenario(monkeypatch, gate, attackers_per_identity=4, identities=3):
    """Real HTTP. A 'heavy' /v1/qualify solve blocks on an Event (it stands for a solve that takes seconds); every attacker request comes from one
    of `identities` keyless callers. Once the attackers' holds have settled, a light legitimate keyless caller from another address makes 10
    requests. Returns (attacker statuses while blocked, legit statuses, how many heavy solves were running at once)."""
    monkeypatch.setattr(S, "SOLVE_GATE", gate)
    monkeypatch.setattr(S.Handler, "limiter", S._RateLimiter(0))
    monkeypatch.setattr(S.Handler, "discovery_limiter", S._RateLimiter(0))
    monkeypatch.setenv("GRIDFORGE_TRUSTED_PROXY_HOPS", "1")
    real = S.ROUTES["/v1/qualify"][0]
    release, lock = threading.Event(), threading.Lock()
    running = {"now": 0, "max": 0}

    def handler(body, tier):
        if body.get("positions_available") != 50000:
            return real(body, tier)
        with lock:
            running["now"] += 1
            running["max"] = max(running["max"], running["now"])
        try:
            assert release.wait(60)
        finally:
            with lock:
                running["now"] -= 1
        return {"heavy": True}
    monkeypatch.setitem(S.ROUTES, "/v1/qualify", (handler, Tier.PUBLIC))
    httpd = S.make_server("127.0.0.1", 0)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    port = httpd.server_address[1]
    heavy = {"contracted_MW": 400, "positions_available": 50000, "busway_ampacity_A": 10000}
    out: list = []
    threads = [threading.Thread(target=lambda ip=f"10.0.0.{i % identities + 1}": out.append(req(port, "POST", "/v1/qualify", heavy, {"X-Forwarded-For": ip})[0]))
               for i in range(identities * attackers_per_identity)]
    for t in threads:
        t.start()
    try:
        cap = gate.per_caller * identities if gate.per_caller else gate.public_limit
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline and not (running["now"] >= min(cap, gate.public_limit or cap) and len(out) >= len(threads) - running["now"]):
            time.sleep(0.02)
        legit = [req(port, "POST", "/v1/qualify", GOOD, {"X-Forwarded-For": f"192.0.2.{k}"})[0] for k in range(1, 11)]
        shed = sorted(out)
    finally:
        release.set()
        for t in threads:
            t.join(60)
        httpd.shutdown()
        httpd.server_close()
    return shed, legit, running["max"]


def test_a_heavy_anonymous_caller_cannot_starve_a_light_one(monkeypatch):
    shed, legit, most = _scenario(monkeypatch, S._SolveGate(16, per_caller=2))
    assert legit == [200] * 10                                                         # the light caller is served every time
    assert most == 6                                                                   # three identities x 2: the attacker is capped at its share
    assert shed == [503] * 6                                                           # and its other six requests were shed at once, not queued


def test_removing_the_per_caller_cap_starves_the_light_caller_which_is_what_the_test_above_catches(monkeypatch):
    """Mutation-style proof: the same scenario with the per-caller bound off (the first version of the gate): the attacker takes every keyless
    slot and the light caller is shed, so `legit == [200] * 10` above fails against that mutation."""
    shed, legit, most = _scenario(monkeypatch, S._SolveGate(16, per_caller=0))
    assert most == 8 and 503 in legit
    assert legit != [200] * 10


def test_a_keyed_caller_is_served_while_keyless_callers_hold_their_whole_share(monkeypatch):
    key = "headroom-test-key-0123456789abcdef"
    monkeypatch.setenv("GRIDFORGE_API_KEYS", key)
    gate = S._SolveGate(4, per_caller=0)                                               # keyless share: 2
    assert gate.enter("x", True) and gate.enter("y", True)
    monkeypatch.setattr(S, "SOLVE_GATE", gate)
    monkeypatch.setattr(S.Handler, "limiter", S._RateLimiter(0))
    monkeypatch.setattr(S.Handler, "discovery_limiter", S._RateLimiter(0))
    httpd = S.make_server("127.0.0.1", 0)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    port = httpd.server_address[1]
    try:
        assert req(port, "POST", "/v1/qualify", GOOD)[0] == 503                        # a third keyless solve: shed
        assert req(port, "POST", "/v1/qualify", GOOD, {"X-API-Key": key})[0] == 200    # the same request with the engine key: served
    finally:
        httpd.shutdown()
        httpd.server_close()


def test_a_burst_of_simultaneous_connections_is_answered_never_reset(monkeypatch):
    """The listening backlog was 5: a burst of a couple of dozen connects was reset before the engine could answer (no 503, no Retry-After)."""
    assert S.make_server("127.0.0.1", 0).request_queue_size == 64
    monkeypatch.setattr(S.Handler, "limiter", S._RateLimiter(0))
    httpd = S.make_server("127.0.0.1", 0)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    port = httpd.server_address[1]
    results: list = []
    start = threading.Barrier(40)

    def one():
        start.wait()
        try:
            results.append(req(port, "GET", "/v1/platforms")[0])
        except Exception as exc:                                                       # a reset or a refusal would land here
            results.append(type(exc).__name__)
    try:
        ts = [threading.Thread(target=one) for _ in range(40)]
        [t.start() for t in ts]
        [t.join(60) for t in ts]
    finally:
        httpd.shutdown()
        httpd.server_close()
    assert results == [200] * 40


# --- the limiter's table is bounded -----------------------------------------------------------------------------------------------------
def test_the_rate_table_is_bounded_and_not_scanned_on_every_request():
    lim = S._RateLimiter(60)
    t0 = time.monotonic()
    for i in range(3 * S.RATE_TABLE_MAX_KEYS):
        lim.allow(f"2001:db8:{i >> 16:x}:{i & 0xffff:x}::/64", f"2001:db8:{i >> 16:x}::/48")
        assert len(lim._hits) <= S.RATE_TABLE_MAX_KEYS + 2
    assert time.monotonic() - t0 < 20
    assert lim.sweeps <= 3                                                             # swept at most once a second, not once per request
    assert lim.allow("203.0.113.1")                                                    # and it still answers


def test_eviction_forgets_the_oldest_first_and_never_refuses_anyone(monkeypatch):
    monkeypatch.setattr(S, "RATE_TABLE_MAX_KEYS", 100)
    monkeypatch.setattr(S, "RATE_TABLE_SOFT_KEYS", 50)
    lim = S._RateLimiter(2)
    assert lim.allow("first") and lim.allow("first") and not lim.allow("first")
    for i in range(200):
        lim.allow(f"k{i}")
    assert len(lim._hits) <= 101 and "first" not in lim._hits                          # the oldest-inserted went; the newest are kept
    assert "k199" in lim._hits
