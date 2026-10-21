"""The usage ledger: an append-only record of every unit the engine charged or gave back.

The meter (metering.py) answers "how much has this account used this month". The ledger
answers "show me every call that made that number", which is the thing an invoice has to be
able to do. A customer who disputes a line is owed an itemised list they can reconcile against
their own logs, and the invoice is derived from the ledger, never the other way round.

Shape: one JSON object per line, UTF-8, `\\n` terminated, never rewritten.

    {"seq":1,"id":"<uuid4 hex>","ts":"2026-10-21T09:00:00Z","kind":"charge","account":"acme",
     "key_id":"ab12cd34","scope":"payg","endpoint":"/v1/study","units":5,"project":"hall-7",
     "idem":"retry-1","ref":"","body_sha":"3f9a1c2e5b7d4a60"}

`kind` is `charge` or `refund`. A refund is a compensating event naming the charge it reverses in
`ref`; nothing is ever edited or deleted, so the history of why a number moved is the file itself.
`seq` is monotonic and gapless: a consumer that holds the last seq it ingested can detect a hole.
`body_sha` is the first 16 hex characters of the SHA-256 of the request body (additive to the
published field list): it lets an idempotency key be recognised as "the same request" after a restart
without the ledger holding any of the customer's content.

Durability is a property that must be PROVED, not configured. A ledger path on a machine with no
volume mounted looks identical to a working one until the first invoice. So an append is write +
fsync on a file opened per call (a volume that vanishes mid-run is noticed), a failed write is
truncated back so a torn line can never sit in front of the next event, and on a Fly machine the
directory must be on a different device than the root filesystem. When any of that fails the ledger
reports `available == False` and the engine refuses to run billable work for payg/trial keys rather
than doing it for free (see Meter.reserve_ex).

Zero dependencies. Thread-safe.
"""
from __future__ import annotations

import json
import os
import sys
import secrets
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

#: How long a charged Idempotency-Key is remembered, across restarts. Same window as the response cache.
IDEMPOTENCY_WINDOW_SECONDS = 24 * 3600
#: Every Nth event's byte offset is remembered so the operator's paged read does not rescan the file.
_INDEX_EVERY = 1000
KINDS = ("charge", "refund")


class LedgerError(RuntimeError):
    """The event could not be made durable. Nothing was recorded."""


def _uuid4_hex() -> str:
    """A version-4 UUID as 32 hex characters, from the OS CSPRNG (no `uuid` import: the architecture test pins
    the engine's import list, and this is four lines)."""
    b = bytearray(secrets.token_bytes(16))
    b[6] = (b[6] & 0x0F) | 0x40
    b[8] = (b[8] & 0x3F) | 0x80
    return b.hex()


def _now_iso(epoch: float | None = None) -> str:
    dt = datetime.fromtimestamp(epoch, timezone.utc) if epoch is not None else datetime.now(timezone.utc)
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def _epoch(ts: str) -> float:
    try:
        return datetime.strptime(ts, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc).timestamp()
    except Exception:
        return 0.0


def parse_ts(ts: str) -> float:
    return _epoch(ts)


def month_of(ts: str) -> str:
    return ts[:7]


class Totals:
    """Net usage for one (account, month), rebuilt from the file."""
    __slots__ = ("units", "calls", "by_endpoint", "first", "last", "scopes")

    def __init__(self) -> None:
        self.units = 0
        self.calls = 0
        self.by_endpoint: dict[str, int] = {}
        self.first = ""
        self.last = ""
        self.scopes: set[str] = set()


class Ledger:
    def __init__(self, path: str | os.PathLike | None = None) -> None:
        self._lock = threading.RLock()
        self._path = Path(path) if path else None
        self._seq = 0
        self._offsets: list[int] = []          # offsets[k] = byte offset of seq k*_INDEX_EVERY + 1
        self._size = 0
        self._idem: dict[tuple[str, str, str], tuple[float, str, str, int]] = {}
        self._totals: dict[tuple[str, str], Totals] = {}
        self._econ: dict[tuple[str, str, str], list[int]] = {}      # (month, endpoint, scope) -> [calls, units], net
        self._problem = ""
        self._corrupt = False
        if self._path is None:
            self._problem = "GRIDFORGE_LEDGER_FILE is not set"
            return
        self._probe()
        if not self._problem:
            self._load()

    # -- state -------------------------------------------------------------
    @property
    def configured(self) -> bool:
        return self._path is not None

    @property
    def last_seq(self) -> int:
        return self._seq

    @property
    def problem(self) -> str:
        return self._problem

    def available(self) -> bool:
        """True only if an event appended NOW would be durable. Cheap: two stats and a flag."""
        if self._path is None or self._corrupt:
            return False
        try:
            d = self._path.parent
            if os.environ.get("FLY_MACHINE_ID") and os.stat(d).st_dev == os.stat("/").st_dev:
                return False
            if not os.access(d, os.W_OK):
                return False
            return (not self._path.exists()) or (self._path.is_file() and os.access(self._path, os.W_OK))
        except OSError:
            return False

    def status(self) -> str:
        if self._path is None:
            return "GRIDFORGE_LEDGER_FILE is not set; the ledger is not recording"
        if self._corrupt:
            return self._problem
        if not self.available():
            return ("the ledger path is not writable here (on Fly: no volume is mounted at "
                    f"{self._path.parent})")
        return "ok"

    # -- startup -----------------------------------------------------------
    def _probe(self) -> None:
        """Prove a durable write works before anything is billed against it."""
        assert self._path is not None
        try:
            d = self._path.parent
            d.mkdir(parents=True, exist_ok=True)
            if os.environ.get("FLY_MACHINE_ID") and os.stat(d).st_dev == os.stat("/").st_dev:
                raise OSError("no volume mounted")
            probe = d / f".{self._path.name}.probe-{os.getpid()}-{secrets.token_hex(3)}"
            fd = os.open(probe, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            try:
                os.write(fd, b"ok")
                os.fsync(fd)
            finally:
                os.close(fd)
                try:
                    probe.unlink()
                except OSError:
                    pass
        except Exception as exc:
            self._problem = (f"{self._path} is not writable ({type(exc).__name__}). On Fly.io this "
                             f"usually means no volume is mounted at {self._path.parent}.")

    def _load(self) -> None:
        assert self._path is not None
        if not self._path.exists():
            return
        try:
            raw = self._path.read_bytes()
        except OSError as exc:
            self._corrupt, self._problem = True, f"the ledger cannot be read ({type(exc).__name__})"
            return
        pos = 0
        good = 0                       # byte length of the verified prefix
        now = time.time()
        while pos < len(raw):
            nl = raw.find(b"\n", pos)
            if nl < 0:
                break                  # an unterminated tail: a torn write, dropped below
            line = raw[pos:nl]
            try:
                ev = json.loads(line)
                if not isinstance(ev, dict) or ev.get("seq") != self._seq + 1 or ev.get("kind") not in KINDS:
                    raise ValueError("out of sequence")
                int(ev["units"]), str(ev["account"]), str(ev["ts"])
            except Exception:
                # A bad line in the MIDDLE means the history cannot be trusted, and appending after it would
                # hide that. Fail closed; the operator repairs the file.
                if nl + 1 < len(raw) and raw[nl + 1:].strip():
                    self._corrupt = True
                    self._problem = (f"the ledger is corrupt at byte {pos} (expected seq {self._seq + 1}); "
                                     f"payg/trial metering is refused until it is repaired")
                    return
                break                  # the last line only: a torn write, dropped below
            if self._seq % _INDEX_EVERY == 0:
                self._offsets.append(pos)
            self._absorb(ev, now)
            self._seq += 1
            pos = nl + 1
            good = pos
        self._size = good
        if good < len(raw):
            # Drop the torn tail so the next append starts on a clean line. Anything in it was never
            # acknowledged to a caller (the append failed or the process died mid-write).
            try:
                with open(self._path, "r+b") as fh:
                    fh.truncate(good)
                    fh.flush()
                    os.fsync(fh.fileno())
            except OSError as exc:
                self._corrupt, self._problem = True, f"a torn ledger tail could not be removed ({type(exc).__name__})"

    def _absorb(self, ev: dict, now: float) -> None:
        """Fold one event into the in-memory views (totals, idempotency)."""
        account, kind = str(ev["account"]), ev["kind"]
        units = int(ev["units"])
        ts = str(ev["ts"])
        endpoint = str(ev.get("endpoint") or "")
        t = self._totals.setdefault((account, month_of(ts)), Totals())
        sign = 1 if kind == "charge" else -1
        t.units += sign * units
        t.calls += sign
        t.by_endpoint[endpoint] = t.by_endpoint.get(endpoint, 0) + sign * units
        t.first = t.first or ts
        t.last = ts
        t.scopes.add(str(ev.get("scope") or ""))
        e = self._econ.setdefault((month_of(ts), endpoint, str(ev.get("scope") or "")), [0, 0])
        e[0] += sign
        e[1] += sign * units
        idem = str(ev.get("idem") or "")
        if len(self._idem) > 20_000:           # bounded: only the live window is ever consulted
            for k in [k for k, v in self._idem.items() if now - v[0] > IDEMPOTENCY_WINDOW_SECONDS]:
                del self._idem[k]
        if kind == "charge":
            if idem:
                at = _epoch(ts)
                if now - at <= IDEMPOTENCY_WINDOW_SECONDS:
                    self._idem[(account, endpoint, idem)] = (at, str(ev["id"]), str(ev.get("body_sha") or ""), units)
        else:
            # A refund repeats the charge's endpoint and idem, so the reversed charge can be forgotten: a
            # retry of a request that produced no answer must be chargeable again.
            ref = str(ev.get("ref") or "")
            hit = self._idem.get((account, endpoint, idem)) if idem else None
            if hit and hit[1] == ref:
                del self._idem[(account, endpoint, idem)]

    # -- the write path ----------------------------------------------------
    def append(self, *, kind: str, account: str, key_id: str, scope: str, endpoint: str, units: int,
               project: str = "", idem: str = "", ref: str = "", body_sha: str = "",
               ts_epoch: float | None = None) -> dict:
        """Append one event durably, or raise LedgerError having changed nothing."""
        if kind not in KINDS or units <= 0:
            raise LedgerError("a ledger event needs a kind of charge/refund and positive units")
        with self._lock:
            if not self.available():
                raise LedgerError(self.status())
            assert self._path is not None
            ev = {"seq": self._seq + 1, "id": _uuid4_hex(), "ts": _now_iso(ts_epoch), "kind": kind,
                  "account": account, "key_id": key_id, "scope": scope, "endpoint": endpoint,
                  "units": int(units), "project": project, "idem": idem, "ref": ref}
            if body_sha:
                ev["body_sha"] = body_sha
            line = (json.dumps(ev, separators=(",", ":"), ensure_ascii=False) + "\n").encode("utf-8")
            fd = -1
            before = 0
            try:
                fd = os.open(self._path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
                before = os.fstat(fd).st_size
                if before != self._size:
                    # Someone else wrote to (or truncated) the file under us: the seq we hold is no longer
                    # trustworthy. Refuse rather than fork the history.
                    self._corrupt = True
                    self._problem = "the ledger file changed outside the engine; restart to rebuild it"
                    raise LedgerError(self._problem)
                view = memoryview(line)
                while view:
                    n = os.write(fd, view)
                    view = view[n:]
                os.fsync(fd)
            except LedgerError:
                raise
            except OSError as exc:
                if fd >= 0:
                    try:
                        os.ftruncate(fd, before)
                    except OSError:
                        pass
                raise LedgerError(f"the ledger write failed ({type(exc).__name__})") from None
            finally:
                if fd >= 0:
                    os.close(fd)
            if self._seq % _INDEX_EVERY == 0:
                self._offsets.append(before)
            self._seq += 1
            self._size = before + len(line)
            self._absorb(ev, time.time())
            return ev

    # -- reads -------------------------------------------------------------
    def totals(self) -> dict[tuple[str, str], Totals]:
        with self._lock:
            return dict(self._totals)

    def economics(self, month: str) -> dict[str, dict[str, tuple[int, int]]]:
        """Net (charges minus refunds) calls and units for one UTC month: {endpoint: {scope: (calls, units)}}.
        The same events the invoice is derived from, so a revenue figure built on it matches the bill."""
        out: dict[str, dict[str, tuple[int, int]]] = {}
        with self._lock:
            for (m, endpoint, scope), (calls, units) in self._econ.items():
                if m == month and (calls or units):
                    out.setdefault(endpoint, {})[scope] = (max(0, calls), max(0, units))
        return out

    def idem_lookup(self, account: str, endpoint: str, idem: str):
        """A charge for this (account, endpoint, idempotency key) that is live and not refunded:
        (epoch, charge_id, body_sha, units), else None."""
        if not idem:
            return None
        with self._lock:
            hit = self._idem.get((account, endpoint, idem))
            if hit is None:
                return None
            if time.time() - hit[0] > IDEMPOTENCY_WINDOW_SECONDS:
                del self._idem[(account, endpoint, idem)]
                return None
            return hit

    def read_after(self, after_seq: int = 0, limit: int = 1000) -> list[dict]:
        """Events with seq > after_seq, oldest first, at most `limit` (<= 1000)."""
        limit = max(1, min(int(limit), 1000))
        after_seq = max(0, int(after_seq))
        with self._lock:
            if self._path is None or self._seq == 0 or after_seq >= self._seq:
                return []
            head, size = self._seq, self._size
            slot = min(after_seq // _INDEX_EVERY, len(self._offsets) - 1)
            start = self._offsets[slot]
            seq_at_start = slot * _INDEX_EVERY + 1
        out: list[dict] = []
        try:
            with open(self._path, "rb") as fh:
                fh.seek(start)
                data = fh.read(max(0, size - start))
        except OSError:
            return []
        seq = seq_at_start
        for line in data.split(b"\n"):
            if not line:
                continue
            if seq > after_seq:
                try:
                    out.append(json.loads(line))
                except Exception:
                    break
                if len(out) >= limit or seq >= head:
                    break
            seq += 1
        return out


def warn(message: str) -> None:  # pragma: no cover - operator log line
    print(f"gridforge ledger: {message}", file=sys.stderr)
