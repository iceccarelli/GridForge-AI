"""Red-team regressions (server side): an MCP batch as a way round the rate limiter, and an idempotency cache
bounded only by entry count. Companion to tests/test_payg_redteam.py (the revocation deadlock)."""
from gridforge.api import server as S
from payg_rig import rig  # noqa: F401  (fixture)

QUALIFY = {"contracted_MW": 12, "current_site_peak_MW": 7.4, "current_it_load_MW": 4.9,
           "busway_ampacity_A": 400, "tapoff_max_A": 63, "plant_supply_C": 6, "positions_available": 180}
SCREEN = {"intake": {"grid": {"contracted_MW": 12, "firm_capacity_MVA": 12}}}


def _call(i, name="gridforge_qualify", args=None):
    return {"jsonrpc": "2.0", "id": i, "method": "tools/call",
            "params": {"name": name, "arguments": QUALIFY if args is None else args}}


# --- F2: an MCP batch must not be a way round the rate limiter ---------------------------------
def test_an_mcp_batch_is_capped(rig):
    s, b, _ = rig.post("/mcp", [{"jsonrpc": "2.0", "id": i, "method": "ping"} for i in range(S.MAX_MCP_BATCH + 1)])
    assert s == 400 and b["error"]["code"] == -32600 and "batch too large" in b["error"]["message"]
    assert b["error"]["data"]["max_batch"] == S.MAX_MCP_BATCH == 10
    s, b, _ = rig.post("/mcp", [{"jsonrpc": "2.0", "id": i, "method": "ping"} for i in range(10)])
    assert s == 200 and len(b) == 10


def test_every_tools_call_in_a_batch_is_charged_to_the_rate_limiter(rig, monkeypatch):
    monkeypatch.setattr(S.Handler, "limiter", S._RateLimiter(4))
    s, b, _ = rig.post("/mcp", [_call(i) for i in range(10)])
    assert s == 200
    ok = [r for r in b if "error" not in r]
    limited = [r for r in b if r.get("error", {}).get("code") == -32005]
    # one HTTP hit covers the first call; calls 2..4 spend the other three tokens; the rest are refused.
    assert len(ok) == 4 and len(limited) == 6
    assert limited[0]["error"]["data"]["status"] == 429


def test_a_single_tools_call_costs_one_rate_limit_hit_as_before(rig, monkeypatch):
    monkeypatch.setattr(S.Handler, "limiter", S._RateLimiter(3))
    for i in range(3):
        s, b, _ = rig.post("/mcp", _call(i))
        assert s == 200 and "error" not in b
    assert rig.post("/mcp", _call(9))[0] == 429


def test_ping_and_initialize_are_free_of_the_per_call_charge(rig, monkeypatch):
    monkeypatch.setattr(S.Handler, "limiter", S._RateLimiter(2))
    batch = [{"jsonrpc": "2.0", "id": i, "method": "ping" if i % 2 else "initialize"} for i in range(10)]
    s, b, _ = rig.post("/mcp", batch)
    assert s == 200 and len(b) == 10 and all("error" not in r for r in b)


def test_a_rate_limited_paid_call_is_not_charged(rig, monkeypatch):
    monkeypatch.setattr(S.Handler, "limiter", S._RateLimiter(2))
    key = rig.key("payg", quota=50)
    _, b, _ = rig.post("/mcp", [_call(i, "gridforge_screen", SCREEN) for i in range(5)], key=key)
    assert len([r for r in b if "error" not in r]) == 2
    assert len([e for e in rig.events() if e["kind"] == "charge"]) == 2


# --- F15: the idempotency cache is bounded by bytes ---------------------------------------------
def test_the_idempotency_cache_is_bounded_by_total_bytes_not_just_entries():
    c = S._IdempotencyCache()
    c.MAX_BYTES = 1_000_000
    payload = {"document": "x" * 200_000}
    for i in range(40):
        c.put(("a", "/v1/study", str(i)), "h", 200, payload)
        assert c.total_bytes <= c.MAX_BYTES
    assert 1 <= len(c._items) <= 5
    assert c.get(("a", "/v1/study", "39"))[3] == payload, "the newest answer is the one kept"
    assert c.get(("a", "/v1/study", "0")) is None


def test_an_answer_larger_than_a_quarter_of_the_budget_is_not_cached_and_evicts_nobody():
    c = S._IdempotencyCache()
    c.MAX_BYTES = 1_000_000
    c.put(("a", "/v1/screen", "small"), "h", 200, {"ok": 1})
    c.put(("a", "/v1/study", "huge"), "h", 200, {"document": "x" * 600_000})
    assert c.get(("a", "/v1/study", "huge")) is None
    assert c.get(("a", "/v1/screen", "small")) is not None


def test_the_byte_count_follows_replacement_and_expiry():
    c = S._IdempotencyCache()
    c.put(("a", "p", "k"), "h", 200, {"v": "x" * 1000})
    first = c.total_bytes
    c.put(("a", "p", "k"), "h", 200, {"v": "x" * 1000})
    assert c.total_bytes == first
    c._items[("a", "p", "k")] = (0.0,) + c._items[("a", "p", "k")][1:]      # long expired
    assert c.get(("a", "p", "k")) is None and c.total_bytes == 0


def test_an_answer_too_big_to_cache_is_still_replayed_free_because_the_ledger_remembers(rig):
    key = rig.key("payg", quota=50)
    S.IDEMPOTENCY.MAX_BYTES = 40                        # nothing fits: every replay must come from the ledger
    h = {"Idempotency-Key": "big-1"}
    s1, b1, _ = rig.post("/v1/screen", SCREEN["intake"], key=key, headers=h)
    assert s1 == 200 and len(S.IDEMPOTENCY._items) == 0
    s2, b2, h2 = rig.post("/v1/screen", SCREEN["intake"], key=key, headers=h)
    assert s2 == 200 and b2 == b1 and h2["X-GridForge-Idempotent-Replay"] == "true"
    assert len([e for e in rig.events() if e["kind"] == "charge"]) == 1
