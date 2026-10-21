"""Unit-economics telemetry: measured handler time per billable endpoint, and the operator report that sets it
beside ledger-derived revenue. Counters move only on a successful charged call; revenue comes from the ledger."""
import json
import time
from datetime import datetime, timezone

import pytest

from gridforge.api import server as S
from gridforge.api.costs import BUCKET_BOUNDS_MS, CostMeter, quantile_ms
from gridforge.commercial import PAYG
from payg_rig import ADMIN, INTAKE, rig  # noqa: F401  (fixture)

MONTH = datetime.now(timezone.utc).strftime("%Y-%m")
BAD = {"grid": {"contracted_MW": "abc"}}
QUALIFY = {"contracted_MW": 12, "current_site_peak_MW": 7.4, "current_it_load_MW": 4.9,
           "busway_ampacity_A": 400, "tapoff_max_A": 63, "plant_supply_C": 6, "positions_available": 180}


def econ(rig, month=None):
    q = f"?month={month}" if month else ""
    s, b, _ = rig.get("/v1/admin/economics" + q, key=ADMIN)
    assert s == 200, b
    return b


def timed(rig, endpoint):
    return econ(rig)["endpoints"].get(endpoint, {}).get("timed_calls", 0)


def mcp(i, name, args):
    return {"jsonrpc": "2.0", "id": i, "method": "tools/call", "params": {"name": name, "arguments": args}}


# --- the recorder ---------------------------------------------------------------------------------
def test_record_keeps_count_total_max_histogram_and_cpu(tmp_path):
    c = CostMeter(tmp_path / "costs.json")
    c.record("/v1/study", 0.004, 0.003)       # 4 ms  -> <=5
    c.record("/v1/study", 0.040, 0.030)       # 40 ms -> <=50
    c.record("/v1/study", 12.0, 11.0)         # 12 s  -> overflow
    m = c.month(datetime.now(timezone.utc).strftime("%Y-%m"))["/v1/study"]
    assert m["timed_calls"] == 3
    assert m["wall_ms_total"] == pytest.approx(12044.0, abs=0.01) and m["wall_ms_max"] == pytest.approx(12000.0)
    assert m["process_cpu_ms_total"] == pytest.approx(11033.0, abs=0.01)
    assert m["wall_ms_histogram"]["<=5"] == 1 and m["wall_ms_histogram"]["<=50"] == 1
    assert m["wall_ms_histogram"][">10000"] == 1 and sum(m["wall_ms_histogram"].values()) == 3


def test_percentiles_are_bucket_ceilings_capped_at_the_slowest_call():
    buckets = [0] * (len(BUCKET_BOUNDS_MS) + 1)
    buckets[3] = 90                            # <=50 ms
    buckets[6] = 10                            # <=500 ms
    assert quantile_ms(buckets, 0.50, 480.0) == 50
    assert quantile_ms(buckets, 0.95, 480.0) == 480.0, "capped at what was actually seen, not the 500 ceiling"
    assert quantile_ms([0] * len(buckets), 0.5, 0.0) is None
    over = [0] * len(buckets)
    over[-1] = 4
    assert quantile_ms(over, 0.95, 31000.0) == 31000.0


def test_timings_persist_across_a_restart(tmp_path):
    p = tmp_path / "costs.json"
    CostMeter(p).record("/v1/screen", 0.02, 0.01)
    again = CostMeter(p)
    assert again.durable
    again.record("/v1/screen", 0.02, 0.01)
    assert again.month(datetime.now(timezone.utc).strftime("%Y-%m"))["/v1/screen"]["timed_calls"] == 2
    doc = json.loads(p.read_text())
    assert doc["schema"] == "gridforge/costs/1" and doc["bucket_bounds_ms"] == list(BUCKET_BOUNDS_MS)


@pytest.mark.parametrize("junk", ["{ not json", "", '{"schema":"other","rows":[]}', '{"schema":"gridforge/costs/1"}',
                                  "[]", '{"schema":"gridforge/costs/1","rows":[{"month":"x"}]}'])
def test_a_corrupt_cost_file_never_stops_serving_and_is_set_aside(tmp_path, junk):
    p = tmp_path / "costs.json"
    p.write_text(junk)
    c = CostMeter(p)                           # must not raise
    c.record("/v1/screen", 0.01, 0.01)
    assert c.month(datetime.now(timezone.utc).strftime("%Y-%m"))["/v1/screen"]["timed_calls"] == 1
    if junk.strip() and "rows\":[{" not in junk:
        assert any(x.name.startswith("costs.json.corrupt-") for x in tmp_path.iterdir())
    assert json.loads(p.read_text())["schema"] == "gridforge/costs/1"


def test_a_torn_row_is_skipped_but_good_rows_survive(tmp_path):
    p = tmp_path / "costs.json"
    good = {"month": MONTH, "endpoint": "/v1/study", "count": 2, "wall_ms_total": 10.0, "wall_ms_max": 6.0,
            "cpu_ms_total": 9.0, "buckets": [0, 2] + [0] * (len(BUCKET_BOUNDS_MS) - 1)}
    p.write_text(json.dumps({"schema": "gridforge/costs/1", "rows": [good, {"month": MONTH, "endpoint": "/v1/x"},
                                                                     dict(good, endpoint="/v1/y", buckets=[1])]}))
    m = CostMeter(p).month(MONTH)
    assert list(m) == ["/v1/study"] and m["/v1/study"]["timed_calls"] == 2


def test_an_unwritable_cost_path_degrades_to_memory_and_says_so(tmp_path):
    blocker = tmp_path / "file"
    blocker.write_text("x")
    c = CostMeter(blocker / "costs.json")      # a parent that is a file: cannot be created
    assert c.durable is False and "not writable" in c.note
    c.record("/v1/screen", 0.01, 0.01)         # still never raises
    assert CostMeter(None).durable is False


def test_record_never_raises(tmp_path):
    c = CostMeter(tmp_path / "costs.json")
    c.record("/v1/screen", float("nan"), float("inf"))
    c.record(None, "x", None)                  # type: ignore[arg-type]


def test_a_write_failure_after_startup_is_swallowed(tmp_path, monkeypatch):
    c = CostMeter(tmp_path / "costs.json")
    monkeypatch.setattr(type(tmp_path), "replace", lambda *a, **k: (_ for _ in ()).throw(OSError("full")))
    c.record("/v1/screen", 0.01, 0.01)
    monkeypatch.undo()
    assert c.month(MONTH)["/v1/screen"]["timed_calls"] == 1


# --- counters move only on a successful charged call ------------------------------------------------
def test_a_successful_charged_call_is_timed(rig):
    key = rig.key("payg", quota=50)
    assert rig.post("/v1/screen", INTAKE, key=key)[0] == 200
    e = econ(rig)["endpoints"]["/v1/screen"]
    assert e["timed_calls"] == 1 and e["wall_ms_total"] > 0 and e["wall_ms_max"] >= e["wall_ms_p50"] > 0


def test_refused_failed_and_over_cap_calls_are_not_timed(rig, monkeypatch):
    key = rig.key("trial", quota=1, account="free1")
    assert rig.post("/v1/screen", INTAKE)[0] == 401                       # no key
    assert rig.post("/v1/screen", BAD, key=key)[0] == 422                 # failed, refunded
    assert rig.post("/v1/screen", INTAKE, key=key)[0] == 200              # the one that counts
    assert rig.post("/v1/screen", INTAKE, key=key)[0] == 402              # over the cap
    assert timed(rig, "/v1/screen") == 1
    rig.ledger_path.unlink()
    rig.ledger_path.mkdir()                                               # ledger gone: fail closed
    assert rig.post("/v1/screen", INTAKE, key=rig.key("payg", quota=9, account="p"))[0] == 503
    assert timed(rig, "/v1/screen") == 1


def test_free_calls_replays_estimates_and_operator_calls_are_not_timed(rig):
    key = rig.key("payg", quota=50)
    rig.post("/v1/qualify", QUALIFY, key=key)
    rig.post("/v1/estimate", {"endpoint": "/v1/study"}, key=key)
    rig.post("/mcp", mcp(1, "gridforge_qualify", QUALIFY), key=key)
    rig.post("/v1/screen", INTAKE, key=ADMIN)                              # operator: never billed
    assert econ(rig)["endpoints"] == {}
    h = {"Idempotency-Key": "k1"}
    rig.post("/v1/screen", INTAKE, key=key, headers=h)
    rig.restart()
    rig.post("/v1/screen", INTAKE, key=key, headers=h)                    # ledger replay: recomputed, not billed
    assert timed(rig, "/v1/screen") == 1


def test_mcp_calls_are_timed_only_when_they_succeed(rig):
    key = rig.key("payg", quota=50)
    rig.post("/mcp", mcp(1, "gridforge_screen", {"intake": INTAKE}), key=key)
    rig.post("/mcp", mcp(2, "gridforge_screen", {"intake": BAD}), key=key)
    assert timed(rig, "/v1/screen") == 1


def test_a_batch_times_exactly_its_successful_charged_calls(rig):
    key = rig.key("payg", quota=500)
    rig.post("/mcp", [mcp(1, "gridforge_study", {"intake": INTAKE}), mcp(2, "gridforge_screen", {"intake": BAD}),
                      mcp(3, "gridforge_estimate", {"endpoint": "/nope"}), mcp(4, "gridforge_screen", {"intake": INTAKE})],
             key=key)
    e = econ(rig)["endpoints"]
    assert (e["/v1/study"]["timed_calls"], e["/v1/screen"]["timed_calls"]) == (1, 1)


def test_timings_survive_an_engine_restart(rig):
    key = rig.key("payg", quota=50)
    rig.post("/v1/screen", INTAKE, key=key)
    rig.restart()
    rig.post("/v1/screen", INTAKE, key=key)
    assert timed(rig, "/v1/screen") == 2 and econ(rig)["timings_durable"] is True


def test_a_corrupt_cost_file_does_not_stop_the_engine_serving_paid_calls(rig):
    key = rig.key("payg", quota=50)
    rig.post("/v1/screen", INTAKE, key=key)
    rig.cost_path.write_text("{ torn")
    rig.restart()
    assert rig.post("/v1/screen", INTAKE, key=key)[0] == 200
    e = econ(rig)
    assert e["endpoints"]["/v1/screen"]["timed_calls"] == 1 and e["endpoints"]["/v1/screen"]["calls"] == 2
    assert "set aside" in e["timings_note"]


# --- operator only --------------------------------------------------------------------------------
def test_economics_is_404_to_everyone_but_the_operator_and_in_no_listing(rig):
    key = rig.key("payg", quota=50)
    for k in (None, key, "nonsense", rig.key("machine", quota=5, account="sub")):
        assert rig.get("/v1/admin/economics", key=k)[0] == 404
        assert rig.get("/v1/admin/economics?month=2026-01", key=k)[0] == 404
    assert rig.get("/v1/admin/economics", key=ADMIN)[0] == 200
    for listing in (rig.get("/v1/version")[1]["endpoints"], rig.get("/nope")[1]["endpoints"],
                    [t["endpoint"] for t in rig.get("/v1/tools")[1]["tools"]],
                    [r["endpoint"] for r in rig.get("/v1/tools")[1]["rate_card"]]):
        assert "/v1/admin/economics" not in listing
    assert "admin/economics" not in json.dumps(rig.get("/v1/tools")[1]) + json.dumps(rig.get("/v1/version")[1])


def test_economics_validates_its_month(rig):
    for bad in ("2026-13", "202610", "2026-1", "latest", "2026-10-01"):
        assert rig.get(f"/v1/admin/economics?month={bad}", key=ADMIN)[0] == 400, bad
    assert rig.get("/v1/admin/economics?month=2020-01", key=ADMIN)[1]["endpoints"] == {}


def test_economics_never_charges_or_writes_the_ledger(rig):
    before = rig.events()
    econ(rig)
    assert rig.events() == before == []


# --- revenue from the net ledger -------------------------------------------------------------------
def test_revenue_is_payg_units_from_the_net_ledger_at_the_payg_price(rig):
    payg, trial, sub = (rig.key("payg", quota=500), rig.key("trial", quota=25, account="free1"),
                        rig.key("machine", quota=500, account="sub1"))
    rig.post("/v1/study", INTAKE, key=payg)                      # 5 payg units
    rig.post("/v1/screen", INTAKE, key=payg)                     # 1
    rig.post("/v1/screen", BAD, key=payg)                        # charged then refunded: nets to 0
    rig.post("/v1/screen", INTAKE, key=trial)                    # 1 free unit
    rig.post("/v1/study", INTAKE, key=sub)                       # 5 subscription units
    rig.post("/v1/portfolio", {"intakes": [INTAKE, INTAKE, INTAKE]}, key=payg)   # 3
    e = econ(rig)
    st, sc, pf = e["endpoints"]["/v1/study"], e["endpoints"]["/v1/screen"], e["endpoints"]["/v1/portfolio"]
    assert (st["calls"], st["units"], st["payg_units"], st["subscription_units"], st["free_units"]) == (2, 10, 5, 5, 0)
    assert st["revenue_cents_at_payg_price"] == 5 * PAYG.unit_price_cents == 1000
    assert (sc["calls"], sc["units"], sc["payg_units"], sc["free_units"]) == (2, 2, 1, 1)
    assert sc["revenue_cents_at_payg_price"] == 200 and sc["units_per_call"] == 1.0
    assert (pf["units"], pf["calls"], pf["units_per_call"]) == (3, 1, 3.0)
    t = e["totals"]
    assert (t["units"], t["payg_units"], t["free_units"], t["subscription_units"]) == (15, 9, 1, 5)
    assert t["revenue_cents_at_payg_price"] == 9 * 200 == 1800
    # and it is the ledger's own arithmetic, net of the refund
    evs = rig.events()
    net_payg = sum(x["units"] * (1 if x["kind"] == "charge" else -1) for x in evs if x["scope"] == "payg")
    assert net_payg == t["payg_units"] == 9


def test_revenue_does_not_depend_on_the_timing_file(rig):
    key = rig.key("payg", quota=50)
    rig.post("/v1/study", INTAKE, key=key)
    rig.cost_path.unlink()
    rig.restart()
    e = econ(rig)["endpoints"]["/v1/study"]
    assert e["calls"] == 1 and e["units"] == 5 and e["revenue_cents_at_payg_price"] == 1000
    assert e["timed_calls"] == 0 and e["wall_ms_p50"] is None and e["wall_ms_per_unit"] is None


def test_the_month_parameter_selects_ledger_months(rig):
    led = rig.meter.ledger
    sept = datetime(2026, 9, 15, 12, tzinfo=timezone.utc).timestamp()
    led.append(kind="charge", account="acme", key_id="k", scope="payg", endpoint="/v1/study", units=5, ts_epoch=sept)
    led.append(kind="charge", account="acme", key_id="k", scope="payg", endpoint="/v1/study", units=5, ts_epoch=sept)
    led.append(kind="refund", account="acme", key_id="k", scope="payg", endpoint="/v1/study", units=5, ts_epoch=sept)
    e = econ(rig, "2026-09")["endpoints"]["/v1/study"]
    assert (e["calls"], e["units"], e["revenue_cents_at_payg_price"]) == (1, 5, 1000)
    assert econ(rig, "2026-10")["endpoints"] == {} or MONTH == "2026-10"
    rig.restart()                                                   # rebuilt from the file, same answer
    assert econ(rig, "2026-09")["endpoints"]["/v1/study"]["units"] == 5


def test_the_exact_report_shape_and_the_basis_text(rig):
    key = rig.key("payg", quota=50)
    rig.post("/v1/screen", INTAKE, key=key)
    e = econ(rig)
    assert set(e) == {"month", "currency", "unit_price_cents", "endpoints", "totals", "durable", "ledger_durable",
                      "timings_durable", "timings_note", "bucket_bounds_ms", "basis", "schema_version"}
    assert e["month"] == MONTH and e["currency"] == "eur" and e["unit_price_cents"] == 200
    assert e["durable"] is True and e["bucket_bounds_ms"] == list(BUCKET_BOUNDS_MS)
    row = e["endpoints"]["/v1/screen"]
    assert set(row) == {"calls", "units", "units_per_call", "payg_units", "free_units", "subscription_units",
                        "revenue_cents_at_payg_price", "timed_calls", "wall_ms_total", "wall_ms_mean",
                        "wall_ms_p50", "wall_ms_p95", "wall_ms_max", "process_cpu_ms_total",
                        "wall_ms_histogram", "wall_ms_per_unit"}
    assert set(e["totals"]) == {"calls", "units", "payg_units", "free_units", "subscription_units",
                                "revenue_cents_at_payg_price", "wall_ms_total"}
    for must_say in ("fixed infrastructure", "Stripe", "model or LLM provider cost", "no model calls",
                     "support and engineering time", "net of refunds", "not from the timing file",
                     "whole process's (all threads)", "ceiling"):
        assert must_say in e["basis"], must_say


def test_durable_is_false_when_the_ledger_is_not_writable(rig):
    rig.ledger_path.mkdir()
    e = econ(rig)
    assert e["durable"] is False and e["ledger_durable"] is False and e["timings_durable"] is True


def test_the_handler_is_what_is_timed(rig, monkeypatch):
    def slow(body, tier):
        time.sleep(0.06)
        return {"ok": True}
    monkeypatch.setitem(S.ROUTES, "/v1/screen", (slow, S.Tier.CLIENT))
    rig.post("/v1/screen", INTAKE, key=rig.key("payg", quota=50))
    e = econ(rig)["endpoints"]["/v1/screen"]
    assert 55 <= e["wall_ms_total"] < 2000 and e["wall_ms_p50"] >= 50
