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

from .keys import ApiKey, KeyError_, looks_signed, verify

#: Billable units per call. One unit is one engine solve of one hall.
UNIT_COST: dict[str, int] = {
    "/v1/qualify": 0,        # free tier: the demo
    "/v1/screen": 1,
    "/v1/study": 5,          # five architectures, the ladder, sensitivity, the pack
    "/v1/proposal": 2,
    "/v1/deck": 3,
    "/v1/diff": 2,           # two solves plus one per attributed driver
    "/v1/portfolio": 1,      # per hall in the request; see units_for()
    "/v1/spec": 3,           # a solve plus a derived, tender-ready document
    "/v1/bids": 2,           # a solve plus the comparison against it
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
    """One API key, its account and its monthly allowance.

    `account` is what usage aggregates under, not the key. A customer who rotates a
    key mid-month has not started a new month, and a meter that thinks otherwise
    hands them a second free allowance every time they rotate.

    GRIDFORGE_API_KEYS accepts three forms, oldest first, so no existing
    deployment breaks when this lands:

        sk_abc                      label defaults to the key prefix, quota unlimited
        sk_abc:acme                 labelled
        sk_abc:acme:5000            labelled, 5000 units a month
    """
    key: str
    label: str = ""
    monthly_quota: int = 0          # 0 -> unlimited
    account: str = ""               # billing identity; defaults to the label
    key_id: str = ""
    scope: str = "client"
    expires: str = ""

    def __post_init__(self) -> None:
        if not self.account:
            self.account = self.label or self.key[:6]

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
    """Static keys only: the ones an operator pasted into the environment."""
    out: dict[str, KeyPlan] = {}
    for spec in (os.environ.get("GRIDFORGE_API_KEYS") or "").split(","):
        plan = KeyPlan.parse(spec)
        if plan:
            out[plan.key] = plan
    return out


def from_signed(k: ApiKey, token: str) -> KeyPlan:
    return KeyPlan(key=token, label=k.account, monthly_quota=k.quota,
                   account=k.account, key_id=k.key_id, scope=k.scope,
                   expires=k.expires)


def plan_for(token: str) -> KeyPlan | None:
    """The plan behind a presented key, static or signed. None means not ours.

    Static first: an operator who has pasted a key into the environment to get a
    customer working again at 2am must not be overridden by anything cleverer.
    """
    if not token:
        return None
    static = key_plans().get(token)
    if static:
        return static
    if looks_signed(token):
        try:
            return from_signed(verify(token), token)
        except KeyError_:
            return None
    return None


def refusal(token: str) -> dict:
    """Why a key was refused, in terms a machine's operator can act on.

    'Invalid key' sends an integrator hunting a typo when their subscription
    lapsed three days ago. Expired, revoked and forged are different problems with
    different fixes, and saying which is not a security leak — the holder of a key
    already knows what it says.
    """
    if looks_signed(token):
        try:
            verify(token)
        except KeyError_ as exc:
            return {"error": str(exc), "key": "signed"}
    return {"error": "an API key is required for this endpoint"}


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
        self._problem = ""
        self._probe()
        self._load()

    # -- persistence -------------------------------------------------------
    def _probe(self) -> None:
        """Prove the usage file is actually writable, now, before anything is billed.

        GRIDFORGE_USAGE_FILE=/data/usage.json on a machine with no volume mounted
        looks identical to a working configuration until the first invoice, at
        which point a month of usage does not exist. So the meter writes a byte at
        startup and, if it cannot, says so at /v1/usage instead of reporting
        durable:true on a path that silently discards everything.
        """
        if self._path is None:
            return
        try:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            probe = self._path.parent / (self._path.name + ".probe")
            probe.write_text("ok")
            probe.unlink()
        except Exception as exc:
            self._problem = (f"{self._path} is not writable ({type(exc).__name__}). "
                             f"On Fly.io this usually means no volume is mounted at "
                             f"{self._path.parent}. Usage is being held in memory only.")
            self._path = None

    @property
    def durable(self) -> bool:
        return self._path is not None

    @property
    def durability_note(self) -> str:
        if self._problem:
            return self._problem
        if not self.durable:
            return ("Usage is held in memory on this instance and is not durable. "
                    "Set GRIDFORGE_USAGE_FILE, backed by a mounted volume, before "
                    "billing against it.")
        return "Usage is written through to durable storage on every call."

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
    def current(self, account: str) -> Usage:
        m = _month()
        with self._lock:
            return self._usage.get((account, m)) or Usage(month=m)

    def would_exceed(self, account: str, units: int, quota: int = 0) -> bool:
        if not quota:
            return False
        return self.current(account).units + units > quota

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

    def statement(self, plan: "KeyPlan | None", account: str = "") -> dict:
        account = account or (plan.account if plan else "unknown")
        u = self.current(account)
        quota = plan.monthly_quota if plan else 0
        return {
            "account": account,
            "key": plan.masked if plan else "…",
            "key_id": plan.key_id if plan else "",
            "scope": plan.scope if plan else "",
            "expires": (plan.expires or None) if plan else None,
            "month": u.month,
            "units": u.units,
            "calls": u.calls,
            "by_endpoint": dict(sorted(u.by_endpoint.items())),
            "monthly_quota": quota or None,
            "units_remaining": (quota - u.units) if quota else None,
            "unit_rates": dict(sorted(UNIT_COST.items())),
            "durable": self.durable,
            "note": self.durability_note,
        }


METER = Meter(os.environ.get("GRIDFORGE_USAGE_FILE"))
