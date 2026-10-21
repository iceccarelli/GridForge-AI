"""A cost file that is syntactically fine but impossible (NaN, negative, a count that disagrees with its histogram)
must never reach /v1/admin/economics, and the endpoint can never emit NaN/Infinity."""
import json
import math
from datetime import datetime, timezone

import pytest

from gridforge.api import server as S
from gridforge.api.costs import BUCKET_BOUNDS_MS, CostMeter
from payg_rig import ADMIN, INTAKE, rig  # noqa: F401  (fixture)

MONTH = datetime.now(timezone.utc).strftime("%Y-%m")
N = len(BUCKET_BOUNDS_MS) + 1


def good(**kw):
    row = {"month": MONTH, "endpoint": "/v1/study", "count": 2, "wall_ms_total": 10.0, "wall_ms_max": 6.0,
           "cpu_ms_total": 9.0, "buckets": [0, 2] + [0] * (N - 2)}
    row.update(kw)
    return row


def write(path, *rows, text=None):
    path.write_text(text if text is not None else json.dumps({"schema": "gridforge/costs/1", "rows": list(rows)}))


BAD_ROWS = {
    "negative wall total": good(wall_ms_total=-1.0),
    "negative max": good(wall_ms_max=-0.5),
    "negative cpu": good(cpu_ms_total=-3.0),
    "negative count": good(count=-2, buckets=[0] * N),
    "count above bucket sum": good(count=5),
    "count below bucket sum": good(count=1),
    "negative bucket": good(buckets=[3, -1] + [0] * (N - 2)),
    "float bucket": good(buckets=[0, 2.0] + [0] * (N - 2)),
    "bool count": good(count=True, buckets=[1] + [0] * (N - 1)),
    "string number": good(wall_ms_total="10"),
    "short buckets": good(buckets=[2]),
    "long buckets": good(buckets=[0, 2] + [0] * N),
    "max below mean": good(wall_ms_total=100.0, wall_ms_max=6.0),
    "time with no calls": good(count=0, buckets=[0] * N, wall_ms_total=5.0),
    "bad month": good(month="2026-13"),
    "short month": good(month="2026-1"),
    "empty endpoint": good(endpoint=""),
    "numeric endpoint": good(endpoint=7),
    "not an object": 7,
    "null": None,
}


@pytest.mark.parametrize("name", sorted(BAD_ROWS))
def test_an_impossible_row_is_skipped_never_served(tmp_path, name):
    p = tmp_path / "costs.json"
    other = good(endpoint="/v1/screen")
    write(p, BAD_ROWS[name], other)
    c = CostMeter(p)
    m = c.month(MONTH)
    assert "/v1/study" not in m
    assert list(m) == ["/v1/screen"] and m["/v1/screen"]["timed_calls"] == 2
    assert "invalid row" in c.note
    assert any(x.name.startswith("costs.json.corrupt-") for x in tmp_path.iterdir()), "kept for inspection"
    for v in json.loads(json.dumps(m, allow_nan=False)).values():
        assert all(not isinstance(x, float) or math.isfinite(x) for x in v.values() if not isinstance(x, dict))


@pytest.mark.parametrize("text", ['{"schema":"gridforge/costs/1","rows":[{"month":"%s","endpoint":"/v1/x","count":1,'
                                  '"wall_ms_total":NaN,"wall_ms_max":1,"cpu_ms_total":0,"buckets":[1,0,0,0,0,0,0,0,0,0,0,0]}]}' % MONTH,
                                  '{"schema":"gridforge/costs/1","rows":[{"wall_ms_total":Infinity}]}',
                                  '{"schema":"gridforge/costs/1","rows":[{"wall_ms_total":-Infinity}]}'])
def test_nan_and_infinity_literals_make_the_whole_file_corrupt(tmp_path, text):
    p = tmp_path / "costs.json"
    write(p, text=text)
    c = CostMeter(p)
    assert c.month(MONTH) == {}
    assert any(x.name.startswith("costs.json.corrupt-") for x in tmp_path.iterdir())
    c.record("/v1/screen", 0.01, 0.01)
    json.loads(p.read_text(), parse_constant=lambda n: (_ for _ in ()).throw(ValueError(n)))   # strict JSON


def test_a_consistent_file_loads_unchanged(tmp_path):
    p = tmp_path / "costs.json"
    write(p, good(), good(endpoint="/v1/screen", count=0, buckets=[0] * N, wall_ms_total=0.0, wall_ms_max=0.0))
    c = CostMeter(p)
    assert c.note.startswith("Timings are written")
    assert c.month(MONTH)["/v1/study"]["timed_calls"] == 2 and "/v1/screen" not in c.month(MONTH)


def test_a_round_trip_through_the_file_is_always_valid(tmp_path):
    p = tmp_path / "costs.json"
    c = CostMeter(p)
    for w in (0.0001, 0.003, 0.2, 7.0, 31.0):
        c.record("/v1/study", w, w / 2)
    again = CostMeter(p)
    assert "invalid" not in again.note and again.month(MONTH)["/v1/study"]["timed_calls"] == 5


def test_non_finite_clock_readings_are_never_stored(tmp_path):
    p = tmp_path / "costs.json"
    c = CostMeter(p)
    for bad in (float("nan"), float("inf"), float("-inf")):
        c.record("/v1/screen", bad, 0.01)
        c.record("/v1/screen", 0.01, bad)
    assert c.month(MONTH) == {}
    c.record("/v1/screen", 0.01, 0.01)
    assert "NaN" not in p.read_text() and "Infinity" not in p.read_text()
    assert c.month(MONTH)["/v1/screen"]["timed_calls"] == 1


def test_the_endpoint_never_emits_nan_or_infinity_even_from_a_poisoned_meter(rig):
    key = rig.key("payg", quota=50)
    rig.post("/v1/screen", INTAKE, key=key)
    row = rig.meter.costs._rows[(MONTH, "/v1/screen")]
    row.wall_ms_total = float("nan")                      # simulate a bug or an in-memory corruption
    row.wall_ms_max = float("inf")
    row.cpu_ms_total = float("-inf")
    import urllib.request
    r = urllib.request.Request(rig.base + "/v1/admin/economics", headers={"X-API-Key": ADMIN})
    with urllib.request.urlopen(r, timeout=30) as resp:
        raw = resp.read().decode()
    for token in ("NaN", "Infinity"):
        assert token not in raw
    doc = json.loads(raw, parse_constant=lambda n: (_ for _ in ()).throw(ValueError(n)))
    assert doc["endpoints"]["/v1/screen"]["wall_ms_total"] is None


def test_the_engine_serves_with_an_impossible_cost_file_on_disk(rig):
    key = rig.key("payg", quota=50)
    rig.post("/v1/screen", INTAKE, key=key)
    write(rig.cost_path, good(endpoint="/v1/screen", wall_ms_total=-9.0, count=3))
    rig.restart()
    assert rig.post("/v1/screen", INTAKE, key=key)[0] == 200
    s, b, _ = rig.get("/v1/admin/economics", key=ADMIN)
    assert s == 200 and b["endpoints"]["/v1/screen"]["timed_calls"] == 1
    assert b["endpoints"]["/v1/screen"]["calls"] == 2 and "invalid row" in b["timings_note"]
