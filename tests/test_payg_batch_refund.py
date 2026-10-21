"""A refund reverses the call that failed, never a sibling that succeeded; and ledger idempotency keys are
bounded so the website's ingest can never be wedged by one.

Regression for the reproduced bypass: in an MCP batch, a failing call refunded the LATEST reservation of the
whole HTTP request, so `[study, estimate{bad}]` delivered a study and charged nothing; a trial key capped at 5
units got 15 studies in three requests.
"""
import json
import random

import pytest

from gridforge.api import server as S
from payg_rig import INTAKE, rig  # noqa: F401  (fixture)

QUALIFY = {"contracted_MW": 12, "current_site_peak_MW": 7.4, "current_it_load_MW": 4.9,
           "busway_ampacity_A": 400, "tapoff_max_A": 63, "plant_supply_C": 6, "positions_available": 180}
BAD_INTAKE = {"grid": {"contracted_MW": "abc"}}


def tool(i, name, args):
    return {"jsonrpc": "2.0", "id": i, "method": "tools/call", "params": {"name": name, "arguments": args}}


def study(i):
    return tool(i, "gridforge_study", {"intake": INTAKE})


def bad_estimate(i):
    return tool(i, "gridforge_estimate", {"endpoint": "/nope"})


def net(rig):
    return sum(e["units"] * (1 if e["kind"] == "charge" else -1) for e in rig.events())


def delivered(responses):
    return [r for r in responses if "error" not in r]


# --- the reproduced bypass -----------------------------------------------------------------------
def test_a_failing_free_call_cannot_refund_a_paid_sibling_in_a_batch(rig):
    key = rig.key("payg", quota=500)
    batch = [study(1), bad_estimate(2)]
    s, b, h = rig.post("/mcp", batch, key=key)
    assert s == 200 and "error" not in b[0] and b[1]["error"]
    assert net(rig) == 5 == rig.meter.current("acme").units, "the delivered study must stay charged"
    assert [e["kind"] for e in rig.events()] == ["charge"], "nothing was refunded"
    assert h["X-GridForge-Charge-Cents"] == "1000"


def test_the_exact_repro_cannot_get_past_a_five_unit_cap(rig):
    key = rig.key("trial", quota=5, account="free1")
    batch = [study(1)] + [bad_estimate(i) for i in range(2, 7)]
    total_delivered = 0
    for _ in range(3):
        s, b, _ = rig.post("/mcp", batch, key=key)
        assert s == 200
        total_delivered += len([r for r in delivered(b) if "structuredContent" in r.get("result", {})
                                and r["result"]["structuredContent"].get("scenarios")])
    assert total_delivered == 1, f"a 5-unit cap delivered {total_delivered} studies"
    assert rig.meter.current("free1").units == 5 and net(rig) == 5


def test_a_failing_qualify_after_a_paid_call_does_not_refund_it(rig):
    key = rig.key("payg", quota=500)
    s, b, _ = rig.post("/mcp", [study(1), tool(2, "gridforge_qualify", {})], key=key)
    assert "error" not in b[0] and b[1]["error"]
    assert net(rig) == 5


def test_a_failing_paid_call_refunds_itself_and_only_itself(rig):
    key = rig.key("payg", quota=500)
    batch = [study(1), tool(2, "gridforge_screen", {"intake": BAD_INTAKE}), tool(3, "gridforge_screen", {"intake": INTAKE})]
    s, b, h = rig.post("/mcp", batch, key=key)
    assert "error" not in b[0] and b[1]["error"] and "error" not in b[2]
    assert net(rig) == 5 + 1
    evs = rig.events()
    refund = next(e for e in evs if e["kind"] == "refund")
    charge = next(e for e in evs if e["id"] == refund["ref"])
    assert charge["endpoint"] == "/v1/screen" and charge["units"] == 1
    assert h["X-GridForge-Charge-Cents"] == str(6 * 200)


def test_a_paid_failure_followed_by_a_free_failure_refunds_once(rig):
    key = rig.key("payg", quota=500)
    batch = [tool(1, "gridforge_screen", {"intake": BAD_INTAKE}), bad_estimate(2), study(3)]
    rig.post("/mcp", batch, key=key)
    assert net(rig) == 5
    assert [e["kind"] for e in rig.events()].count("refund") == 1


def test_a_refund_is_never_written_twice_for_one_charge(rig):
    key = rig.key("payg", quota=500)
    rig.post("/mcp", [tool(i, "gridforge_screen", {"intake": BAD_INTAKE}) for i in range(1, 6)], key=key)
    evs = rig.events()
    refs = [e["ref"] for e in evs if e["kind"] == "refund"]
    assert len(refs) == len(set(refs)) == 5 and net(rig) == 0


# --- randomized: ledger net == units of the delivered, billable calls ------------------------------
MENU = {
    "paid_ok_1": (lambda i: tool(i, "gridforge_screen", {"intake": INTAKE}), 1, True),
    "paid_ok_2": (lambda i: tool(i, "gridforge_portfolio", {"intakes": [INTAKE, INTAKE]}), 2, True),
    "paid_fail": (lambda i: tool(i, "gridforge_screen", {"intake": BAD_INTAKE}), 0, False),
    "paid_fail_portfolio": (lambda i: tool(i, "gridforge_portfolio", {"intakes": [INTAKE, BAD_INTAKE]}), 0, False),
    "free_ok": (lambda i: tool(i, "gridforge_qualify", QUALIFY), 0, True),
    "free_fail": (lambda i: tool(i, "gridforge_qualify", {}), 0, False),
    "est_ok": (lambda i: tool(i, "gridforge_estimate", {"endpoint": "/v1/study"}), 0, True),
    "est_bad": (lambda i: bad_estimate(i), 0, False),
}


@pytest.mark.parametrize("seed", [1, 2, 3])
def test_randomized_batches_net_ledger_units_equal_delivered_billable_units(rig, seed):
    rnd = random.Random(seed)
    key = rig.key("payg", quota=100_000)
    expected = 0
    for n in range(14):
        picks = [rnd.choice(sorted(MENU)) for _ in range(rnd.randint(1, 10))]
        batch = [MENU[p][0](i + 1) for i, p in enumerate(picks)]
        headers = {"Idempotency-Key": f"r{seed}-{n}"} if rnd.random() < 0.5 else {}
        for attempt in range(2 if rnd.random() < 0.4 else 1):
            s, b, h = rig.post("/mcp", batch, key=key, headers=headers)
            assert s == 200 and len(b) == len(batch)
            by_id = {r["id"]: r for r in b}
            for i, p in enumerate(picks):
                ok = "error" not in by_id[i + 1]
                assert ok == MENU[p][2], (picks, i, by_id[i + 1])
            delivered_units = sum(MENU[p][1] for p in picks)
            if attempt == 0 or not headers:
                expected += delivered_units          # a keyed retry is a replay: no new units
        assert net(rig) == expected == rig.meter.current("acme").units, (seed, n, picks, headers)
    evs = rig.events()
    charges = {e["id"] for e in evs if e["kind"] == "charge"}
    refunds = [e["ref"] for e in evs if e["kind"] == "refund"]
    assert set(refunds) <= charges and len(refunds) == len(set(refunds))
    assert [e["seq"] for e in evs] == list(range(1, len(evs) + 1))


@pytest.mark.parametrize("seed", [4, 5])
def test_randomized_batches_hold_a_cap_exactly(rig, seed):
    """Whatever the mix, a capped key never has more net units than its cap and never delivers beyond it."""
    rnd = random.Random(seed)
    cap = 12
    key = rig.key("trial", quota=cap, account="free1")
    delivered_units = 0
    for _ in range(10):
        picks = [rnd.choice(sorted(MENU)) for _ in range(rnd.randint(1, 10))]
        _, b, _ = rig.post("/mcp", [MENU[p][0](i + 1) for i, p in enumerate(picks)], key=key)
        by_id = {r["id"]: r for r in b}
        for i, p in enumerate(picks):
            if MENU[p][1] and "error" not in by_id[i + 1]:
                delivered_units += MENU[p][1]
        assert net(rig) <= cap
    assert net(rig) == delivered_units <= cap


def test_rest_still_refunds_its_own_failed_call(rig):
    key = rig.key("payg", quota=50)
    s, _, h = rig.post("/v1/screen", BAD_INTAKE, key=key)
    assert s == 422 and h["X-GridForge-Units"] == "0"
    assert [e["kind"] for e in rig.events()] == ["charge", "refund"] and net(rig) == 0


# --- F3: idempotency keys on the ledger are bounded ---------------------------------------------------
def test_the_published_limit_is_one_number_everywhere(rig):
    assert S.MAX_IDEM_KEY_CHARS == 150
    _, b, _ = rig.get("/v1/version")
    assert b["idempotency_key_max_chars"] == 150 and "150" in b["idempotency"]


def test_a_key_over_the_limit_is_refused_by_rest_and_mcp_with_a_clear_error(rig):
    key = rig.key("payg", quota=50)
    long = {"Idempotency-Key": "k" * 151}
    s, b, _ = rig.post("/v1/screen", INTAKE, key=key, headers=long)
    assert s == 400 and "150 characters" in b["error"] and b["max_chars"] == 150
    _, b, _ = rig.post("/mcp", tool(1, "gridforge_screen", {"intake": INTAKE}), key=key, headers=long)
    assert b["error"]["code"] == -32602 and "150 characters" in b["error"]["message"]
    assert rig.events() == []


def test_a_key_at_the_limit_is_accepted_and_replays_across_a_restart_over_rest(rig):
    key = rig.key("payg", quota=50)
    h = {"Idempotency-Key": "k" * 150}
    assert rig.post("/v1/screen", INTAKE, key=key, headers=h)[0] == 200
    rig.restart()
    s, _, h2 = rig.post("/v1/screen", INTAKE, key=key, headers=h)
    assert s == 200 and h2["X-GridForge-Idempotent-Replay"] == "true"
    assert len([e for e in rig.events() if e["kind"] == "charge"]) == 1
    assert all(len(e["idem"]) <= 150 for e in rig.events())


def test_a_long_key_in_a_batch_is_stored_as_a_digest_and_still_replays_after_a_restart(rig):
    key = rig.key("payg", quota=50)
    h = {"Idempotency-Key": "k" * 150}
    batch = [tool(1, "gridforge_screen", {"intake": INTAKE}), tool(2, "gridforge_screen", {"intake": INTAKE})]
    rig.post("/mcp", batch, key=key, headers=h)
    idems = [e["idem"] for e in rig.events()]
    assert len(idems) == 2 and all(i.startswith("sha256:") and len(i) == 71 for i in idems) and len(set(idems)) == 2
    rig.restart()
    s, b, h2 = rig.post("/mcp", batch, key=key, headers=h)
    assert s == 200 and all("error" not in r for r in b)
    assert h2["X-GridForge-Idempotent-Replay"] == "true"
    assert len([e for e in rig.events() if e["kind"] == "charge"]) == 2


def test_no_ledger_idem_ever_exceeds_the_websites_limit(rig):
    key = rig.key("payg", quota=500)
    for n in (1, 10, 100, 149, 150):
        rig.post("/mcp", [tool(i, "gridforge_screen", {"intake": INTAKE}) for i in range(1, 4)], key=key,
                 headers={"Idempotency-Key": "z" * n})
        rig.post("/v1/screen", INTAKE, key=key, headers={"Idempotency-Key": "y" * n})
    assert rig.events() and all(len(e["idem"]) <= 150 for e in rig.events())
    assert max(len(json.dumps(e)) for e in rig.events()) < 600


def test_short_keys_are_stored_verbatim(rig):
    assert S._ledger_idem("order-42") == "order-42" and S._ledger_idem("order-42#3") == "order-42#3"
    assert S._ledger_idem("é" * 80).startswith("sha256:"), "bounded in bytes, not just characters"
