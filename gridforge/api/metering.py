"""Metering: what a machine consumed, and what it owes.

The engine's next customer is not a person filling in a form. It is another
company's software — a portfolio tool, an underwriting model, an AI agent doing
site selection — calling this API in a loop. That customer will pay per call, but
only against a usage record it can reconcile against its own logs. So the record
comes first and the invoice follows it, never the other way round.

Design constraints, all deliberate:

* Units, not calls. A qualify and a 40-hall portfolio run are not the same cost
  and must not bill the same. Weights live in UNIT_COST and are published at
  /v1/version, because a meter whose rate is secret is a meter nobody trusts.
* The free tier bills zero units and is never metered into a quota. It is the
  demo, and a demo that can exhaust a quota is a trap.
* Over quota returns 402, not 429. They mean different things to a machine:
  429 says retry later, 402 says buy more. Getting this wrong makes an agent
  hammer an endpoint it can never succeed on.
* Durable by choice. Usage lives in memory and is flushed to GRIDFORGE_USAGE_FILE
  when one is configured. With no file the deployment is a demo deployment and
  says so at /v1/usage rather than pretending to have billed anything.

Zero dependencies, thread-safe, and it must never raise into a request path: a
metering failure loses an invoice line, and losing a customer's answer over an
accounting problem is worse than losing the line.
"""
from __future__ import annotations

import json
import os
import threading
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

#: Billable units per call. One unit is one engine solve of one hall.
UNIT_COST: dict[str, int] = {
    "/v1/qualify": 0,        # free tier: the demo
    "/v1/screen": 1,
    "/v1/study": 5,          # five architectures, the ladder, sensitivity, the pack
    "/v1/proposal": 2,
    "/v1/deck": 3,
    "/v1/diff": 2,           # two solves plus one per attributed driver
    "/v1/portfolio": 1,      # per hall in the request; see units_for()
    "/v1/calibration": 0,
    "/v1/tools": 0,
    "/v1/usage": 0,
    "/mcp": 0,               # the transport is free; the tool it calls is not
}

DEFAULT_MONTHLY_QUOTA = int(os.environ.get("GRIDFORGE_DEFAULT_QUOTA", "0") or 0)


def units_for(path: str, body: dict | None = None) -> int:
    base = UNIT_COST.get(path, 1)
    if path == "/v1/portfolio" and isinstance(body, dict):
        n = body.get("intakes")
        return base * max(1, len(n)) if isinstance(n, list) else base
    return base


def _month() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m")


@dataclass
class KeyPlan:
    """One API key, its label and its monthly allowance.

    GRIDFORGE_API_KEYS accepts three forms, oldest first, so no existing
    deployment breaks when this lands:

        sk_abc                      label defaults to the key prefix, quota unlimited
        sk_abc:acme                 labelled
        sk_abc:acme:5000            labelled, 5000 units a month
    """
    key: str
    label: str = ""
    monthly_quota: int = 0          # 0 -> unlimited

    @property
    def masked(self) -> str:
        return self.key[:6] + "…" if len(self.key) > 8 else "…"

    @staticmethod
    def parse(spec: str) -> "KeyPlan | None":
        spec = spec.strip()
        if not spec:
            return None
        parts = spec.split(":")
        key = parts[0].strip()
        if not key:
            return None
        label = parts[1].strip() if len(parts) > 1 else key[:6]
        quota = 0
        if len(parts) > 2:
            try:
                quota = max(0, int(parts[2]))
            except ValueError:
                quota = 0
        return KeyPlan(key=key, label=label or key[:6],
                       monthly_quota=quota or DEFAULT_MONTHLY_QUOTA)


def key_plans() -> dict[str, KeyPlan]:
    out: dict[str, KeyPlan] = {}
    for spec in (os.environ.get("GRIDFORGE_API_KEYS") or "").split(","):
        plan = KeyPlan.parse(spec)
        if plan:
            out[plan.key] = plan
    return out


@dataclass
class Usage:
    month: str
    units: int = 0
    calls: int = 0
    by_endpoint: dict[str, int] = field(default_factory=dict)
    first_seen: str = ""
    last_seen: str = ""


class Meter:
    """In-memory usage with optional durable flush. Never raises into a request."""

    def __init__(self, path: str | None = None) -> None:
        self._lock = threading.Lock()
        self._usage: dict[tuple[str, str], Usage] = {}
        self._path = Path(path) if path else None
        self._load()

    # -- persistence -------------------------------------------------------
    @property
    def durable(self) -> bool:
        return self._path is not None

    def _load(self) -> None:
        if not self._path or not self._path.exists():
            return
        try:
            doc = json.loads(self._path.read_text())
        except Exception:      # a corrupt meter file must not stop the engine serving
            return
        for row in doc.get("usage", []):
            try:
                u = Usage(month=row["month"], units=int(row["units"]),
                          calls=int(row["calls"]),
                          by_endpoint=dict(row.get("by_endpoint") or {}),
                          first_seen=row.get("first_seen", ""),
                          last_seen=row.get("last_seen", ""))
                self._usage[(row["key"], row["month"])] = u
            except Exception:
                continue

    def _flush(self) -> None:
        if not self._path:
            return
        try:
            rows = [{"key": k, "month": m, "units": u.units, "calls": u.calls,
                     "by_endpoint": u.by_endpoint, "first_seen": u.first_seen,
                     "last_seen": u.last_seen}
                    for (k, m), u in self._usage.items()]
            self._path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self._path.with_suffix(self._path.suffix + ".tmp")
            tmp.write_text(json.dumps({"usage": rows}, indent=2))
            tmp.replace(self._path)
        except Exception:
            pass

    # -- accounting --------------------------------------------------------
    def current(self, key: str) -> Usage:
        m = _month()
        with self._lock:
            return self._usage.get((key, m)) or Usage(month=m)

    def would_exceed(self, key: str, units: int) -> bool:
        plan = key_plans().get(key)
        if not plan or not plan.monthly_quota:
            return False
        return self.current(key).units + units > plan.monthly_quota

    def record(self, key: str, path: str, units: int) -> Usage:
        now = datetime.now(timezone.utc).isoformat(timespec="seconds")
        m = _month()
        with self._lock:
            u = self._usage.setdefault((key, m), Usage(month=m, first_seen=now))
            u.units += units
            u.calls += 1
            u.by_endpoint[path] = u.by_endpoint.get(path, 0) + units
            u.last_seen = now
            snapshot = Usage(month=u.month, units=u.units, calls=u.calls,
                             by_endpoint=dict(u.by_endpoint),
                             first_seen=u.first_seen, last_seen=u.last_seen)
        self._flush()
        return snapshot

    def statement(self, key: str) -> dict:
        plan = key_plans().get(key)
        u = self.current(key)
        quota = plan.monthly_quota if plan else 0
        return {
            "account": plan.label if plan else "unknown",
            "key": plan.masked if plan else "…",
            "month": u.month,
            "units": u.units,
            "calls": u.calls,
            "by_endpoint": dict(sorted(u.by_endpoint.items())),
            "monthly_quota": quota or None,
            "units_remaining": (quota - u.units) if quota else None,
            "unit_rates": dict(sorted(UNIT_COST.items())),
            "durable": self.durable,
            "note": ("Usage is held in memory on this instance and is not durable. "
                     "Set GRIDFORGE_USAGE_FILE before billing against it."
                     if not self.durable else
                     "Usage is written through to durable storage on every call."),
        }


METER = Meter(os.environ.get("GRIDFORGE_USAGE_FILE"))
