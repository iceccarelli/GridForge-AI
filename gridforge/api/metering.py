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

import hashlib
import json
import os
import threading
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

from ..commercial import PAYG
from .keys import CAPPED_SCOPES, ApiKey, KeyError_, looks_signed, verify
from .ledger import Ledger, LedgerError, parse_ts

#: Billable units per call. One unit is one engine solve of one hall.
UNIT_COST: dict[str, int] = {
    "/v1/qualify": 0,        # free tier: the demo
    "/v1/screen": 1,
    "/v1/compare": 1,        # the same single solve as a screen, laid side by side
    "/v1/study": 5,          # five architectures, the ladder, sensitivity, the pack
    "/v1/proposal": 2,
    "/v1/deck": 3,
    "/v1/diff": 2,           # two solves plus one per attributed driver
    "/v1/portfolio": 1,      # per hall in the request; see units_for()
    "/v1/spec": 3,           # a solve plus a derived, tender-ready document
    "/v1/bids": 2,           # a solve plus the comparison against it
    "/v1/power/assess": 5,   # every scenario solved, the full ladder, calibration
    "/v1/power/deploy/assess": 5,  # a load profile plus up to four architectures compared
    "/v1/power/deploy/spec": 3,    # a derived, tender-ready document, same basis as /v1/spec
    "/v1/power/deploy/bids": 2,    # the tender package plus the comparison, same basis as /v1/bids
    "/v1/calibration": 0,
    "/v1/tools": 0,
    "/v1/usage": 0,
    "/mcp": 0,               # the transport is free; the tool it calls is not
    "/v1/estimate": 0,       # asking what a call would cost is never itself a cost
}

#: The routes that are free ON PURPOSE (weight 0). tests/test_payg_unmetered.py pins this set, so a new route
#: cannot become free by omission: it must either carry a positive weight or be added here with a reason.
FREE_ENDPOINTS = frozenset(p for p, u in UNIT_COST.items() if u == 0)

#: The one billing rule, worded once. Published at /v1/version and /v1/tools (`payg.billing_rule`) and mirrored
#: in the website copy; change it here and everywhere together.
BILLING_RULE = (
    "A month's charge is the net ledger units for the UTC month (charges minus refunds) times the unit price, "
    "invoiced in arrears; a month below the minimum invoice is carried forward to the next. Requests that "
    "produce no answer (rejected, unauthorised, invalid or failed) are refunded and never charged, and a retry "
    "carrying the same Idempotency-Key is never charged twice. Free-allowance usage is never invoiced. The "
    "customer's own monthly cap is a hard stop: beyond it the engine answers 402 and nothing more accrues."
)


def payg_public() -> dict:
    """What an integrator may know about pay-as-you-go before signing up. From the one commercial source."""
    return {"unit_price_cents": PAYG.unit_price_cents, "currency": PAYG.currency,
            "min_invoice_cents": PAYG.min_invoice_cents,
            "free_allowance_units": PAYG.free_allowance_units,
            "billing_rule": BILLING_RULE}

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
            self.account = self.label or "k_" + hashlib.sha256(self.key.encode()).hexdigest()[:10]

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
        # A key with no label used to account under its first six characters, so `sk_live_a` and
        # `sk_live_b` shared one usage and quota bucket. An unlabelled key is its own account.
        label = parts[1].strip() if len(parts) > 1 else \
            "k_" + hashlib.sha256(key.encode()).hexdigest()[:10]
        quota = 0
        if len(parts) > 2:
            try:
                quota = max(0, int(parts[2]))
            except ValueError:
                quota = 0
        return KeyPlan(key=key, label=label,
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


@dataclass
class Reservation:
    """The outcome of Meter.reserve_ex.

    status: ok          units taken (and, when the ledger is recording, a charge event written)
            over        the call does not fit the cap / allowance; nothing taken
            unavailable payg/trial key and the ledger cannot be written: nothing taken, no work to be done
            replay      this Idempotency-Key was already charged (this process or a previous one): not charged again
            conflict    this Idempotency-Key was charged for a different request body
    """
    status: str
    usage: "Usage | None" = None
    account: str = ""
    endpoint: str = ""
    units: int = 0
    month: str = ""
    event: dict | None = None
    reason: str = ""


class Meter:
    """In-memory usage with optional durable flush. Never raises into a request.

    With a Ledger attached, every charge and refund is also appended to it INSIDE the same critical section
    as the counter change, so the two cannot disagree about a call. Counters are rebuilt from the ledger at
    startup. The one deliberate exception to "never raise into a request path" is a payg/trial key whose
    charge cannot be made durable: that is refused (reserve_ex -> `unavailable`) because doing the work for
    nothing is a free product nobody agreed to ship."""

    def __init__(self, path: str | None = None, ledger: Ledger | None = None) -> None:
        self._lock = threading.Lock()
        self._usage: dict[tuple[str, str], Usage] = {}
        self._path = Path(path) if path else None
        self._problem = ""
        self.ledger: Ledger = ledger if ledger is not None else Ledger(None)
        self._pending_refunds: list[dict] = []
        self._probe()
        self._load()
        self._seed_from_ledger()

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

    def _seed_from_ledger(self) -> None:
        """Counters and ledger must agree after a restart. For payg/trial accounts the ledger is the truth
        (it is what the invoice is derived from), so it replaces the counter even when that lowers it, e.g. a
        refund that was in the ledger but not yet in the flushed usage file. For other accounts the larger of
        the two wins: the ledger may have been switched on mid-month, and an undercount is the costlier error."""
        try:
            for (account, month), t in self.ledger.totals().items():
                cur = self._usage.get((account, month))
                exact = bool(t.scopes & CAPPED_SCOPES)
                if cur is None or exact or cur.units < t.units:
                    self._usage[(account, month)] = Usage(
                        month=month, units=max(0, t.units), calls=max(0, t.calls),
                        by_endpoint={k: v for k, v in t.by_endpoint.items() if v > 0},
                        first_seen=t.first, last_seen=t.last)
        except Exception:      # a ledger problem must not stop the engine serving
            pass

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

    def reserve(self, account: str, path: str, units: int, quota: int = 0) -> "Usage | None":
        """Check the allowance and take the units in one critical section. Two concurrent calls can
        no longer both pass would_exceed() and then both record, overshooting the quota.
        Returns the new usage, or None when the call does not fit."""
        r = self.reserve_ex(account, path, units, quota)
        return r.usage if r.status in ("ok", "replay") else None

    def reserve_ex(self, account: str, path: str, units: int, quota: int = 0, *, scope: str = "client",
                   key_id: str = "", project: str = "", idem: str = "", body_sha: str = "") -> Reservation:
        """reserve() with the whole story: the ledger event, idempotency and fail-closed durability."""
        now_epoch = datetime.now(timezone.utc).timestamp()
        now = datetime.fromtimestamp(now_epoch, timezone.utc).isoformat(timespec="seconds")
        m = _month()
        capped = scope in CAPPED_SCOPES
        with self._lock:
            led = self.ledger
            if idem:
                hit = led.idem_lookup(account, path, idem)
                if hit is not None:
                    if hit[2] and body_sha and hit[2] != body_sha:
                        return Reservation("conflict", account=account, endpoint=path, units=units, month=m,
                                           reason="this Idempotency-Key was already used with a different request body")
                    u = self._usage.get((account, m)) or Usage(month=m)
                    return Reservation("replay", usage=self._snap(u), account=account, endpoint=path,
                                       units=0, month=m)
            if capped and not quota:
                # Defence in depth: verify() already refuses these, and a cap of 0 must never mean unlimited.
                return Reservation("unavailable", account=account, endpoint=path, units=units, month=m,
                                   reason="this key carries no unit cap")
            if capped and not led.available():
                return Reservation("unavailable", account=account, endpoint=path, units=units, month=m,
                                   reason=led.status())
            u = self._usage.setdefault((account, m), Usage(month=m, first_seen=now))
            if quota and u.units + units > quota:
                return Reservation("over", usage=self._snap(u), account=account, endpoint=path,
                                   units=units, month=m)
            event = None
            if led.available():
                try:
                    self._drain_pending_refunds()
                    event = led.append(kind="charge", account=account, key_id=key_id, scope=scope,
                                       endpoint=path, units=units, project=project, idem=idem,
                                       body_sha=body_sha, ts_epoch=now_epoch)
                except LedgerError as exc:
                    if capped:
                        return Reservation("unavailable", account=account, endpoint=path, units=units,
                                           month=m, reason=str(exc))
                    event = None       # static/machine keys keep today's behaviour: the call still runs
            u.units += units
            u.calls += 1
            u.by_endpoint[path] = u.by_endpoint.get(path, 0) + units
            u.last_seen = now
            snapshot = self._snap(u)
        self._flush()
        return Reservation("ok", usage=snapshot, account=account, endpoint=path, units=units, month=m,
                           event=event)

    @staticmethod
    def _snap(u: Usage) -> Usage:
        return Usage(month=u.month, units=u.units, calls=u.calls, by_endpoint=dict(u.by_endpoint),
                     first_seen=u.first_seen, last_seen=u.last_seen)

    def _drain_pending_refunds(self) -> None:
        """Refunds that could not be written when they happened are retried before any new event, so a
        transient disk fault delays a compensating event instead of losing it. Caller holds the lock."""
        while self._pending_refunds:
            kw = self._pending_refunds[0]
            self.ledger.append(**kw)          # raises LedgerError if still unwritable: left queued
            self._pending_refunds.pop(0)

    def refund_reservation(self, r: Reservation) -> None:
        """Give back what reserve_ex took, and write the compensating `refund` event. Calling it twice for
        one reservation is the caller's bug; the handler clears its reference after one refund."""
        if r.status != "ok":
            return
        with self._lock:
            u = self._usage.get((r.account, r.month))
            if u is not None:
                u.units = max(0, u.units - r.units)
                u.calls = max(0, u.calls - 1)
                if r.endpoint in u.by_endpoint:
                    u.by_endpoint[r.endpoint] = max(0, u.by_endpoint[r.endpoint] - r.units)
            ev = r.event
            if ev is not None:
                # A refund that lands after midnight UTC is stamped with the charge's own timestamp so each
                # month nets to what was actually billable in it (never a negative month).
                same_month = _month() == ev["ts"][:7]
                kw = dict(kind="refund", account=ev["account"], key_id=ev["key_id"], scope=ev["scope"],
                          endpoint=ev["endpoint"], units=ev["units"], project=ev["project"],
                          idem=ev["idem"], ref=ev["id"],
                          ts_epoch=None if same_month else parse_ts(ev["ts"]))
                try:
                    self._drain_pending_refunds()
                    self.ledger.append(**kw)
                except LedgerError:
                    self._pending_refunds.append(kw)
        self._flush()

    @property
    def pending_refunds(self) -> int:
        return len(self._pending_refunds)

    def close(self) -> None:
        """Last chance to write refunds that could not be written when they happened. Idempotent and safe to
        call from a signal path or atexit; never raises.

        What this cannot do: if the process is killed outright (SIGKILL, OOM, power loss) while a refund is
        still queued, the queue dies with it and the ledger keeps a charge for a call that produced no answer.
        That needs two faults at once (a failed refund write, then a hard kill before the next successful
        write), the queue is retried before every later ledger write, and the cost to the customer is the
        units of one failed call, which support can reverse by hand. It is not silent: the unrefunded charge
        is in the ledger with its id, and `Meter.pending_refunds` reports the queue."""
        try:
            with self._lock:
                if self._pending_refunds and self.ledger.available():
                    try:
                        self._drain_pending_refunds()
                    except LedgerError:
                        pass
                left = len(self._pending_refunds)
            if left:
                import sys
                print(f"gridforge: {left} refund(s) could not be written to the ledger at shutdown",
                      file=sys.stderr)
        except Exception:
            pass

    def refund(self, account: str, path: str, units: int) -> None:
        """Give back units for a call that produced no answer (the work failed on our side or the
        request was invalid). A caller is billed for results, not for errors."""
        m = _month()
        with self._lock:
            u = self._usage.get((account, m))
            if u is None:
                return
            u.units = max(0, u.units - units)
            u.calls = max(0, u.calls - 1)
            if path in u.by_endpoint:
                u.by_endpoint[path] = max(0, u.by_endpoint[path] - units)
        self._flush()

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
            "ledger_durable": self.ledger.available(),
            **({"unit_price_cents": PAYG.unit_price_cents, "accrued_cents": PAYG.charge_cents(u.units)}
               if plan and plan.scope == "payg" else {}),
        }


METER = Meter(os.environ.get("GRIDFORGE_USAGE_FILE"), Ledger(os.environ.get("GRIDFORGE_LEDGER_FILE")))
