"""Measured cost of serving a billable call: wall time per endpoint, kept so unit economics rest on
measurement instead of a guess.

What is recorded, and the only thing: for each SUCCESSFUL, CHARGED call, the wall time and the process CPU
time spent inside the handler (the solve and the rendering; not request parsing, JSON encoding of the reply or
the network). Per (UTC month, endpoint): the count, total/max wall milliseconds, a fixed-bucket histogram of wall
time, and total process CPU milliseconds.

Why the CPU figure is a total and not a per-call number: `time.process_time()` is the CPU time of the whole
process, every thread. The engine serves requests on threads, so two overlapping calls each see the other's CPU
in their own delta. Summed across calls it over-attributes under concurrency and is exact only when calls do not
overlap. Wall time (`time.perf_counter`) is per call and is what the histogram and the percentiles use.

What is NOT recorded: refused calls (401, 402, 503), failed calls (refunded), idempotent replays (recomputed
free, never billed) and free-tier calls. A cost record that counted calls nobody was charged for could not be
set against the ledger's revenue.

Durability follows the usage file: GRIDFORGE_COST_FILE, else `costs.json` next to GRIDFORGE_USAGE_FILE, else
memory only (reported as not durable). It is flushed after every recorded call, like the usage file. It never
raises into a request path, and a torn or corrupt file is set aside and the engine starts clean.

Zero dependencies, thread-safe.
"""
from __future__ import annotations

import json
import math
import os
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

SCHEMA = "gridforge/costs/1"
#: Upper bounds of the wall-time buckets, milliseconds. A final overflow bucket catches anything slower.
BUCKET_BOUNDS_MS: tuple[float, ...] = (5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000)


def _month() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m")


class _Row:
    __slots__ = ("count", "wall_ms_total", "wall_ms_max", "cpu_ms_total", "buckets")

    def __init__(self) -> None:
        self.count = 0
        self.wall_ms_total = 0.0
        self.wall_ms_max = 0.0
        self.cpu_ms_total = 0.0
        self.buckets = [0] * (len(BUCKET_BOUNDS_MS) + 1)

    def to_json(self, month: str, endpoint: str) -> dict:
        return {"month": month, "endpoint": endpoint, "count": self.count,
                "wall_ms_total": round(self.wall_ms_total, 3), "wall_ms_max": round(self.wall_ms_max, 3),
                "cpu_ms_total": round(self.cpu_ms_total, 3), "buckets": list(self.buckets)}


def quantile_ms(buckets: list[int], q: float, observed_max_ms: float) -> float | None:
    """The `q` quantile of wall time as the UPPER BOUND of the bucket it falls in, never above the slowest call
    actually seen. A bucket upper bound is a ceiling, not an exact percentile, and is documented as such."""
    total = sum(buckets)
    if total <= 0:
        return None
    rank = max(1, math.ceil(q * total))
    seen = 0
    for i, n in enumerate(buckets):
        seen += n
        if seen >= rank:
            bound = BUCKET_BOUNDS_MS[i] if i < len(BUCKET_BOUNDS_MS) else observed_max_ms
            return round(min(bound, observed_max_ms), 3)
    return round(observed_max_ms, 3)


class CostMeter:
    def __init__(self, path: str | os.PathLike | None = None) -> None:
        self._lock = threading.Lock()
        self._rows: dict[tuple[str, str], _Row] = {}
        self._path = Path(path) if path else None
        self._problem = ""
        self._probe()
        self._load()

    # -- state ---------------------------------------------------------------------------------
    @property
    def durable(self) -> bool:
        return self._path is not None

    @property
    def note(self) -> str:
        if self._problem:
            return self._problem
        if not self.durable:
            return ("Timings are held in memory on this instance and are lost on restart. Set "
                    "GRIDFORGE_COST_FILE (or GRIDFORGE_USAGE_FILE) on a mounted volume.")
        return "Timings are written through to durable storage after every recorded call."

    def _probe(self) -> None:
        if self._path is None:
            return
        try:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            probe = self._path.parent / (self._path.name + ".probe")
            probe.write_text("ok")
            probe.unlink()
        except Exception as exc:
            self._problem = (f"{self._path} is not writable ({type(exc).__name__}); timings are held in "
                             f"memory only.")
            self._path = None

    def _load(self) -> None:
        if self._path is None or not self._path.exists():
            return
        try:
            doc = json.loads(self._path.read_text())
            if not isinstance(doc, dict) or doc.get("schema") != SCHEMA or not isinstance(doc.get("rows"), list):
                raise ValueError("not a cost file")
        except Exception:
            # A torn or corrupt file must not stop the engine serving. Keep it for inspection, start clean.
            try:
                self._path.replace(self._path.with_name(self._path.name + f".corrupt-{int(time.time())}"))
            except Exception:
                pass
            self._problem = "the cost file was unreadable and was set aside; timings restarted from zero"
            return
        for r in doc["rows"]:
            try:
                row = _Row()
                row.count = int(r["count"])
                row.wall_ms_total = float(r["wall_ms_total"])
                row.wall_ms_max = float(r["wall_ms_max"])
                row.cpu_ms_total = float(r.get("cpu_ms_total", 0.0))
                buckets = [int(x) for x in r["buckets"]]
                if len(buckets) != len(row.buckets) or row.count < 0 or min(buckets) < 0:
                    continue
                row.buckets = buckets
                self._rows[(str(r["month"]), str(r["endpoint"]))] = row
            except Exception:
                continue

    def _flush(self) -> None:
        if self._path is None:
            return
        try:
            rows = [r.to_json(m, e) for (m, e), r in sorted(self._rows.items())]
            tmp = self._path.with_suffix(self._path.suffix + ".tmp")
            tmp.write_text(json.dumps({"schema": SCHEMA, "bucket_bounds_ms": list(BUCKET_BOUNDS_MS),
                                       "rows": rows}))
            tmp.replace(self._path)
        except Exception:
            pass

    # -- recording -----------------------------------------------------------------------------
    def record(self, endpoint: str, wall_s: float, cpu_s: float) -> None:
        """One successful charged call. Never raises."""
        try:
            wall_ms = max(0.0, wall_s * 1000.0)
            cpu_ms = max(0.0, cpu_s * 1000.0)
            i = len(BUCKET_BOUNDS_MS)
            for n, bound in enumerate(BUCKET_BOUNDS_MS):
                if wall_ms <= bound:
                    i = n
                    break
            with self._lock:
                row = self._rows.setdefault((_month(), endpoint), _Row())
                row.count += 1
                row.wall_ms_total += wall_ms
                row.wall_ms_max = max(row.wall_ms_max, wall_ms)
                row.cpu_ms_total += cpu_ms
                row.buckets[i] += 1
                self._flush()
        except Exception:
            pass

    def month(self, month: str) -> dict[str, dict]:
        """Per-endpoint timing summary for one UTC month."""
        out: dict[str, dict] = {}
        with self._lock:
            for (m, endpoint), r in self._rows.items():
                if m != month or r.count <= 0:
                    continue
                out[endpoint] = {
                    "timed_calls": r.count,
                    "wall_ms_total": round(r.wall_ms_total, 3),
                    "wall_ms_mean": round(r.wall_ms_total / r.count, 3),
                    "wall_ms_p50": quantile_ms(r.buckets, 0.50, r.wall_ms_max),
                    "wall_ms_p95": quantile_ms(r.buckets, 0.95, r.wall_ms_max),
                    "wall_ms_max": round(r.wall_ms_max, 3),
                    "process_cpu_ms_total": round(r.cpu_ms_total, 3),
                    "wall_ms_histogram": dict(zip([f"<={int(b)}" for b in BUCKET_BOUNDS_MS] + [">10000"],
                                                  r.buckets)),
                }
        return out


def timer() -> tuple[float, float]:
    """(wall, process cpu) clocks, read together."""
    return time.perf_counter(), time.process_time()
