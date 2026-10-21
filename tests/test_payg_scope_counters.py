"""Caps are counted per (account, month, SCOPE).

The free allowance (trial scope) is free and separate: it must never eat into a pay-as-you-go cap, and the
reverse. A customer who spent 25 free units and then enabled a EUR 20 cap (10 units) gets 10 billable units,
not zero. Regression for the defect found by the real-engine journey test.
"""
import json
import threading
from concurrent.futures import ThreadPoolExecutor

import pytest

from gridforge.api.ledger import Ledger
from gridforge.api.metering import Meter, Usage
from gridforge.commercial import PAYG
from payg_rig import INTAKE, rig  # noqa: F401  (fixture)

FREE = PAYG.free_allowance_units          # 25
EUR20 = PAYG.cap_units(20)                # 10 units
EUR100 = PAYG.cap_units(100)              # 50 units


def make(tmp_path, usage=None):
    return Meter(str(usage) if usage else None, Ledger(tmp_path / "ledger.jsonl"))


def take(m, scope, units=1, quota=0, account="acme", **kw):
    return m.reserve_ex(account, "/v1/screen", units, quota, scope=scope, key_id=f"k-{scope}", **kw)


# --- the meter ---------------------------------------------------------------------------------------
def test_free_units_do_not_count_against_a_payg_cap(tmp_path):
    m = make(tmp_path)
    for _ in range(FREE):
        assert take(m, "trial", quota=FREE).status == "ok"
    assert take(m, "trial", quota=FREE).status == "over"
    for _ in range(EUR20):
        assert take(m, "payg", quota=EUR20).status == "ok", "the first billable call must succeed"
    r = take(m, "payg", quota=EUR20)
    assert r.status == "over"
    u = m.current("acme")
    assert (u.by_scope, u.units) == ({"trial": 25, "payg": 10}, 35)


def test_a_larger_cap_buys_its_full_unit_count_after_the_free_allowance(tmp_path):
    m = make(tmp_path)
    for _ in range(FREE):
        take(m, "trial", quota=FREE)
    ok = sum(take(m, "payg", quota=EUR100).status == "ok" for _ in range(80))
    assert ok == EUR100 == 50, "a EUR 100 cap buys 50 billable units, not 25"


def test_payg_units_do_not_count_against_the_free_allowance(tmp_path):
    m = make(tmp_path)
    for _ in range(EUR20):
        take(m, "payg", quota=EUR20)
    assert sum(take(m, "trial", quota=FREE).status == "ok" for _ in range(40)) == FREE


def test_subscription_quota_counts_only_its_own_scope(tmp_path):
    m = make(tmp_path)
    take(m, "trial", units=20, quota=25)
    take(m, "payg", units=7, quota=50)
    assert take(m, "machine", units=5, quota=5).status == "ok"
    assert take(m, "machine", units=1, quota=5).status == "over"
    assert m.current("acme").by_scope == {"trial": 20, "payg": 7, "machine": 5}


def test_a_refund_reverses_the_scope_of_the_charge_it_references(tmp_path):
    m = make(tmp_path)
    free = take(m, "trial", units=3, quota=25)
    pay = take(m, "payg", units=4, quota=50)
    m.refund_reservation(free)
    u = m.current("acme")
    assert u.by_scope == {"trial": 0, "payg": 4} and u.units == 4
    m.refund_reservation(pay)
    assert m.current("acme").by_scope == {"trial": 0, "payg": 0} and m.current("acme").units == 0
    evs = [json.loads(x) for x in (tmp_path / "ledger.jsonl").read_text().splitlines()]
    assert [(e["kind"], e["scope"]) for e in evs] == [("charge", "trial"), ("charge", "payg"),
                                                      ("refund", "trial"), ("refund", "payg")]


def test_a_refund_after_the_key_changed_scope_still_reverses_the_original_scope(tmp_path):
    """Charge as trial; the customer then upgrades (a payg key now exists); the failed call's refund must give
    the units back to the free allowance, not to the new cap."""
    m = make(tmp_path)
    free = take(m, "trial", units=2, quota=25)
    take(m, "payg", units=6, quota=50)
    m.refund_reservation(free)
    assert m.current("acme").scope_units("trial") == 0 and m.current("acme").scope_units("payg") == 6


def test_concurrent_calls_on_a_key_with_ten_units_left_succeed_exactly_ten_times(tmp_path):
    m = make(tmp_path)
    for _ in range(FREE):
        take(m, "trial", quota=FREE)                  # the free units are already spent
    with ThreadPoolExecutor(20) as ex:
        out = list(ex.map(lambda _: take(m, "payg", quota=EUR20).status, range(20)))
    assert out.count("ok") == 10 and out.count("over") == 10
    net = sum(e["units"] * (1 if e["kind"] == "charge" else -1)
              for e in map(json.loads, (tmp_path / "ledger.jsonl").read_text().splitlines()) if e["scope"] == "payg")
    assert net == 10 == m.current("acme").scope_units("payg")


def test_an_idempotent_replay_changes_no_scope_counter(tmp_path):
    m = make(tmp_path)
    take(m, "payg", units=3, quota=50, idem="k1", body_sha="aa")
    r = take(m, "payg", units=3, quota=50, idem="k1", body_sha="aa")
    assert r.status == "replay" and m.current("acme").by_scope == {"payg": 3}
    assert r.usage.scope_units("payg") == 3


# --- restart rebuild ---------------------------------------------------------------------------------
def test_a_restart_rebuilds_mixed_scopes_from_the_ledger(tmp_path):
    m = make(tmp_path)
    take(m, "trial", units=9, quota=25)
    gone = take(m, "payg", units=4, quota=50)
    take(m, "payg", units=2, quota=50)
    take(m, "machine", units=3, quota=100)
    m.refund_reservation(gone)
    again = make(tmp_path)                            # no usage file: the ledger alone
    u = again.current("acme")
    assert u.by_scope == {"trial": 9, "payg": 2, "machine": 3} and u.units == 14
    assert take(again, "payg", units=EUR20 - 2, quota=EUR20).status == "ok"
    assert take(again, "payg", quota=EUR20).status == "over"
    assert take(again, "trial", units=FREE - 9, quota=FREE).status == "ok"


def test_the_ledger_beats_a_stale_usage_file_per_scope(tmp_path):
    usage = tmp_path / "usage.json"
    m = make(tmp_path, usage)
    take(m, "trial", units=5, quota=25)
    r = take(m, "payg", units=4, quota=50)
    stale = usage.read_text()                         # what a crash would have left
    m.refund_reservation(r)
    usage.write_text(stale)
    again = make(tmp_path, usage)
    assert again.current("acme").by_scope == {"trial": 5, "payg": 0}


def test_by_scope_is_persisted_in_the_usage_file(tmp_path):
    usage = tmp_path / "usage.json"
    m = make(tmp_path, usage)
    take(m, "trial", units=5, quota=25)
    take(m, "payg", units=4, quota=50)
    (row,) = json.loads(usage.read_text())["usage"]
    assert row["by_scope"] == {"trial": 5, "payg": 4} and row["legacy_units"] == 0 and row["units"] == 9
    # a plain restart with no ledger events needed reads the same split back
    assert Meter(str(usage), Ledger(None)).current("acme").by_scope == {"trial": 5, "payg": 4}


def test_a_legacy_usage_file_counts_its_units_against_every_scope_conservatively(tmp_path):
    usage = tmp_path / "usage.json"
    from gridforge.api.metering import _month
    usage.write_text(json.dumps({"usage": [{"key": "acme", "month": _month(), "units": 8, "calls": 8,
                                            "by_endpoint": {"/v1/screen": 8}}]}))
    m = Meter(str(usage), Ledger(None))
    u = m.current("acme")
    assert u.units == 8 and u.legacy == 8 and u.scope_units("payg") == 8 and u.scope_units("trial") == 8
    assert m.reserve_ex("acme", "/v1/screen", 3, 10, scope="machine").status == "over"
    assert m.reserve_ex("acme", "/v1/screen", 2, 10, scope="machine").status == "ok"
    assert m.current("acme").by_scope == {"machine": 2} and m.current("acme").scope_units("machine") == 10


def test_a_legacy_row_is_not_counted_twice_once_the_ledger_attributes_it(tmp_path):
    from gridforge.api.metering import _month
    led = Ledger(tmp_path / "ledger.jsonl")
    for scope, n in (("trial", 10), ("payg", 5)):
        led.append(kind="charge", account="acme", key_id="k", scope=scope, endpoint="/v1/screen", units=n)
    usage = tmp_path / "usage.json"
    usage.write_text(json.dumps({"usage": [{"key": "acme", "month": _month(), "units": 15, "calls": 2,
                                            "by_endpoint": {"/v1/screen": 15}}]}))
    u = Meter(str(usage), Ledger(tmp_path / "ledger.jsonl")).current("acme")
    assert u.by_scope == {"trial": 10, "payg": 5} and u.legacy == 0 and u.units == 15


def test_usage_dataclass_keeps_its_old_constructor_shape():
    u = Usage(month="2026-10")
    assert u.units == 0 and u.by_scope == {} and u.scope_units("payg") == 0


# --- over HTTP: the exact journey, statements, headers, 402 bodies, estimates -------------------------
def spend_free(rig, key, n=FREE):
    for _ in range(n):
        assert rig.post("/v1/screen", INTAKE, key=key)[0] == 200


def test_the_exact_journey_25_free_units_then_a_20_euro_cap(rig):
    account = "journey"
    free = rig.key("trial", quota=FREE, account=account)
    spend_free(rig, free)
    s, b, _ = rig.post("/v1/screen", INTAKE, key=free)
    assert s == 402 and b["reason"] == "free_allowance_exhausted" and b["units_used"] == 25

    payg = rig.key("payg", quota=EUR20, account=account)              # the customer enables EUR 20 = 10 units
    s, b, h = rig.post("/v1/screen", INTAKE, key=payg)
    assert s == 200, "the first billable call must not be refused by the free units"
    assert h["X-GridForge-Units-Month"] == "1" and h["X-GridForge-Units-Remaining"] == "9"
    assert h["X-GridForge-Charge-Cents"] == "200"
    for _ in range(9):
        assert rig.post("/v1/screen", INTAKE, key=payg)[0] == 200
    s, b, _ = rig.post("/v1/screen", INTAKE, key=payg)                # the 11th
    assert s == 402 and b["reason"] == "spending_cap_reached" and b["plan"] == "api_payg"
    assert (b["units_used"], b["cap_units"], b["monthly_quota"], b["cap_eur"]) == (10, 10, 10, 20.0)
    net = {}
    for e in rig.events():
        net[e["scope"]] = net.get(e["scope"], 0) + e["units"] * (1 if e["kind"] == "charge" else -1)
    assert net == {"trial": 25, "payg": 10}
    # the free key is still exhausted, and was never refilled by the payg spend
    assert rig.post("/v1/screen", INTAKE, key=free)[0] == 402


def test_usage_statement_is_scope_specific_and_shows_by_scope(rig):
    account = "stmt"
    free, payg = rig.key("trial", quota=FREE, account=account), rig.key("payg", quota=EUR20, account=account)
    spend_free(rig, free, 25)
    for _ in range(4):
        rig.post("/v1/screen", INTAKE, key=payg)
    s, b, _ = rig.get("/v1/usage", key=payg)
    assert s == 200
    assert (b["units"], b["units_remaining"], b["monthly_quota"], b["scope"]) == (4, 6, 10, "payg")
    assert b["account_units"] == 29 and b["by_scope"] == {"payg": 4, "trial": 25}
    assert (b["accrued_cents"], b["unit_price_cents"]) == (800, 200)
    s, b, _ = rig.get("/v1/usage", key=free)
    assert (b["units"], b["units_remaining"], b["monthly_quota"], b["scope"]) == (25, 0, 25, "trial")
    assert b["account_units"] == 29 and b["by_scope"] == {"payg": 4, "trial": 25} and "accrued_cents" not in b


def test_402_bodies_use_the_scope_specific_figure(rig):
    account = "bodies"
    payg = rig.key("payg", quota=2, account=account)
    free = rig.key("trial", quota=3, account=account)
    spend_free(rig, free, 3)
    for _ in range(2):
        rig.post("/v1/screen", INTAKE, key=payg)
    _, b, _ = rig.post("/v1/screen", INTAKE, key=payg)
    assert b["units_used"] == 2 and b["cap_units"] == 2 and b["reason"] == "spending_cap_reached"
    _, b, _ = rig.post("/v1/screen", INTAKE, key=free)
    assert b["units_used"] == 3 and b["cap_units"] == 3 and b["reason"] == "free_allowance_exhausted"


def test_estimate_fits_and_remaining_are_per_scope(rig):
    account = "est"
    free, payg = rig.key("trial", quota=FREE, account=account), rig.key("payg", quota=EUR20, account=account)
    spend_free(rig, free, 25)
    _, b, _ = rig.post("/v1/estimate", {"endpoint": "/v1/study"}, key=free)
    assert (b["used_units"], b["remaining_units"], b["fits"]) == (25, 0, False)
    assert b["would_cost_after_allowance"] == 5 * 200
    _, b, _ = rig.post("/v1/estimate", {"endpoint": "/v1/study"}, key=payg)
    assert (b["scope"], b["used_units"], b["remaining_units"], b["cap_units"], b["fits"]) == ("payg", 0, 10, 10, True)
    _, b, _ = rig.post("/v1/estimate", {"endpoint": "/v1/portfolio", "hall_count": 11}, key=payg)
    assert b["fits"] is False and b["remaining_units"] == 10


def test_an_mcp_batch_counts_each_call_in_its_own_scope(rig):
    account = "mcpb"
    free, payg = rig.key("trial", quota=FREE, account=account), rig.key("payg", quota=EUR20, account=account)
    spend_free(rig, free, 25)
    call = lambda i, args: {"jsonrpc": "2.0", "id": i, "method": "tools/call",   # noqa: E731
                            "params": {"name": "gridforge_screen", "arguments": args}}
    batch = [call(1, {"intake": INTAKE}), call(2, {"intake": {"grid": {"contracted_MW": "abc"}}}),
             call(3, {"intake": INTAKE})]
    _, b, h = rig.post("/mcp", batch, key=payg)
    assert [("error" in r) for r in b] == [False, True, False]
    assert h["X-GridForge-Units-Month"] == "2" and h["X-GridForge-Units-Remaining"] == "8"
    assert rig.meter.current(account).by_scope == {"trial": 25, "payg": 2}


def test_a_replay_header_reports_the_scope_specific_month_figure(rig):
    account = "rep"
    free, payg = rig.key("trial", quota=FREE, account=account), rig.key("payg", quota=EUR20, account=account)
    spend_free(rig, free, 25)
    h = {"Idempotency-Key": "once"}
    rig.post("/v1/screen", INTAKE, key=payg, headers=h)
    rig.restart()
    _, _, h2 = rig.post("/v1/screen", INTAKE, key=payg, headers=h)
    assert h2["X-GridForge-Idempotent-Replay"] == "true"
    assert h2["X-GridForge-Units-Month"] == "1" and h2["X-GridForge-Units-Remaining"] == "9"


def test_the_journey_survives_an_engine_restart(rig):
    account = "restart"
    free, payg = rig.key("trial", quota=FREE, account=account), rig.key("payg", quota=EUR20, account=account)
    spend_free(rig, free, 25)
    for _ in range(6):
        rig.post("/v1/screen", INTAKE, key=payg)
    rig.restart()
    ok = sum(rig.post("/v1/screen", INTAKE, key=payg)[0] == 200 for _ in range(8))
    assert ok == 4, "10 units minus the 6 already charged"
    assert rig.get("/v1/usage", key=payg)[1]["by_scope"] == {"payg": 10, "trial": 25}


def test_the_operator_economics_report_is_unchanged_by_scope_counting(rig):
    account = "econ"
    free, payg = rig.key("trial", quota=FREE, account=account), rig.key("payg", quota=EUR20, account=account)
    spend_free(rig, free, 25)
    rig.post("/v1/screen", INTAKE, key=payg)
    from payg_rig import ADMIN
    e = rig.get("/v1/admin/economics", key=ADMIN)[1]["endpoints"]["/v1/screen"]
    assert (e["free_units"], e["payg_units"], e["revenue_cents_at_payg_price"]) == (25, 1, 200)
