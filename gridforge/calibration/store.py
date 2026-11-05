"""Durable storage for calibration observation records: append-only, hash-chained, reviewed by a second person.

``records.py`` defines the record and ``residuals.py`` turns APPROVED records into statistics. This module is the
part in between: where records live, and how one becomes approved.

The file is JSONL. Every line is one chain entry:

  * ``ingest``  a validated record, always stored as ``draft``, with the name of whoever submitted it;
  * ``review``  a decision (``approved`` or ``rejected``) about one stored record, with a named reviewer and a reason.

Nothing is ever edited or removed. A record's current state is its latest entry: the ingest entry, overlaid by the
latest review of that observation id. Each entry carries the hash of the one before it and a hash over its own whole
body, so editing, deleting, inserting or reordering any line breaks every later link. A broken chain raises
``LedgerIntegrityError`` and nothing is read, reported or appended: it is never skipped past.

Rules that are enforced here and not left to the caller:

  * a batch is all or nothing: one invalid row refuses the whole batch and writes nothing;
  * ingest cannot create an approved record (a row that already claims ``approved`` / a reviewer is refused);
  * approve and reject need a reviewer name and a reason;
  * the person who submitted a record cannot approve it (compared on the normalised name: case and spacing are
    not a second person);
  * the store refuses to live inside the package directory, which ships with the engine.

Privacy: this file holds site data. It is private (``GRIDFORGE_CALIBRATION_RECORDS``, default next to the private
ledger), gitignored, and never part of the package.
"""
from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, replace
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

from .ledger import GENESIS, LedgerIntegrityError, _locked, _sha, private_path
from .records import APPROVAL_STATUSES, ObservationRecord, RecordError, load_batch
from .schema import ObservationError

ENV_VAR = "GRIDFORGE_CALIBRATION_RECORDS"
RECORDS_FILENAME = "calibration.records.local.jsonl"
CHAIN_SCHEMA = "gridforge/calibration-records-chain/1"
PACKAGE_DIR = Path(__file__).resolve().parents[1]

DECISIONS = ("approved", "rejected")
MAX_NAME = 120
MAX_REASON = 500
_CTRL_RE = re.compile(r"[\x00-\x1f\x7f]")


class StoreError(ObservationError):
    """A request the store refuses. Nothing was written."""


@dataclass(frozen=True)
class StoredRecord:
    """One record as it stands now, with the trail that got it there."""
    record: ObservationRecord          # current state: approval_status / reviewer reflect the latest review
    content_hash: str                  # of the record as submitted (a draft)
    submitted_by: str
    reviews: tuple[dict, ...] = ()     # every review, oldest first: decision, reviewer, reason, at


def store_path() -> Path:
    env = os.environ.get(ENV_VAR)
    return Path(env) if env else private_path().parent / RECORDS_FILENAME


def _refuse_package(target: Path) -> None:
    resolved = target.resolve()
    if resolved == PACKAGE_DIR or PACKAGE_DIR in resolved.parents:
        raise StoreError(
            "the package directory is published with the engine and may not hold site data. "
            f"Set {ENV_VAR} to a private path outside it.")


def _name(field: str, value: Any, max_len: int) -> str:
    if not isinstance(value, str) or not value.strip():
        raise StoreError(f"{field} is required")
    s = " ".join(value.split())
    if len(s) > max_len or _CTRL_RE.search(value):
        raise StoreError(f"{field} is too long or contains control characters")
    return s


def _same_person(a: str, b: str) -> bool:
    return " ".join(a.split()).casefold() == " ".join(b.split()).casefold()


def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _parse_iso(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


# ---------------------------------------------------------------------------------------------- chain

def _entry(body: dict, prev: str) -> dict:
    linked = {**body, "prev_hash": prev}
    return {**linked, "entry_hash": _sha(linked)}


def _current(rec: ObservationRecord, content_hash: str, submitter: str, reviews: list[dict]) -> StoredRecord:
    if reviews:
        last = reviews[-1]
        rec = replace(rec, approval_status=last["decision"], reviewer=last["reviewer"])
    return StoredRecord(rec, content_hash, submitter, tuple(reviews))


def _replay(path: Path) -> tuple[dict[str, StoredRecord], str, int]:
    """Verify the whole chain and rebuild current state. Fails closed: any break raises, nothing is returned."""
    if not path.exists():
        return {}, GENESIS, 0
    text = path.read_text(encoding="utf-8")
    if not text.strip():
        return {}, GENESIS, 0
    if not text.endswith("\n"):
        raise LedgerIntegrityError(f"{path}: the last line is incomplete; the file was cut short or edited")
    prev = GENESIS
    base: dict[str, tuple[ObservationRecord, str, str]] = {}
    reviews: dict[str, list[dict]] = {}
    order: list[str] = []
    for n, line in enumerate(text.split("\n")[:-1], start=1):
        try:
            e = json.loads(line)
        except json.JSONDecodeError:
            raise LedgerIntegrityError(f"{path}: line {n} is not valid JSON; the file has been edited")
        if not isinstance(e, dict) or "entry_hash" not in e or "prev_hash" not in e:
            raise LedgerIntegrityError(f"{path}: line {n} carries no hash link")
        if e["prev_hash"] != prev:
            raise LedgerIntegrityError(
                f"{path}: line {n} breaks the hash chain (its link does not match line {n - 1}); the file has "
                "been edited, reordered or had a line removed")
        body = {k: v for k, v in e.items() if k != "entry_hash"}
        if _sha(body) != e["entry_hash"]:
            raise LedgerIntegrityError(f"{path}: line {n} has been altered after it was written")
        if e.get("chain") != CHAIN_SCHEMA or e.get("seq") != n:
            raise LedgerIntegrityError(f"{path}: line {n} has the wrong chain schema or sequence number")
        prev = e["entry_hash"]
        try:
            at = _parse_iso(e["at"])
            if e.get("kind") == "ingest":
                rec = ObservationRecord.from_dict(e["record"], now=at)
                if (rec.approval_status != "draft" or rec.reviewer is not None
                        or rec.content_hash() != e.get("content_hash") or rec.observation_id in base):
                    raise ValueError("ingest entry does not match its record")
                _name("submitted_by", e.get("submitted_by"), MAX_NAME)
                base[rec.observation_id] = (rec, e["content_hash"], e["submitted_by"])
                order.append(rec.observation_id)
            elif e.get("kind") == "review":
                oid = e.get("observation_id")
                if oid not in base or e.get("decision") not in DECISIONS:
                    raise ValueError("review of an unknown record or with an unknown decision")
                _name("reviewer", e.get("reviewer"), MAX_NAME)
                _name("reason", e.get("reason"), MAX_REASON)
                if e["decision"] == "approved" and _same_person(e["reviewer"], base[oid][2]):
                    raise ValueError("a record approved by the person who submitted it")
                reviews.setdefault(oid, []).append(
                    {k: e[k] for k in ("decision", "reviewer", "reason", "at")})
            else:
                raise ValueError("unknown entry kind")
        except (KeyError, TypeError, ValueError, RecordError, StoreError) as exc:
            raise LedgerIntegrityError(f"{path}: line {n} is not a valid entry ({exc})")
    out = {oid: _current(base[oid][0], base[oid][1], base[oid][2], reviews.get(oid, [])) for oid in order}
    return out, prev, n


def _append(path: Path, bodies: list[dict], prev: str, seq: int) -> None:
    """Write existing bytes + new lines to a temp file, fsync, and replace: all of the new lines or none."""
    existing = path.read_bytes() if path.exists() else b""
    lines = []
    for body in bodies:
        seq += 1
        entry = _entry({"chain": CHAIN_SCHEMA, "seq": seq, **body}, prev)
        prev = entry["entry_hash"]
        lines.append(json.dumps(entry, sort_keys=True, separators=(",", ":"), ensure_ascii=True) + "\n")
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    with open(tmp, "wb") as fh:
        fh.write(existing + "".join(lines).encode("ascii"))
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, path)
    if hasattr(os, "O_DIRECTORY"):
        try:
            dfd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(dfd)
            finally:
                os.close(dfd)
        except OSError:                       # pragma: no cover
            pass


# ---------------------------------------------------------------------------------------------- writing

def ingest(rows: Iterable[Any], *, submitter: str, path: Path | None = None,
           now: datetime | None = None) -> dict:
    """Validate a batch and store it as draft. All or nothing. Returns counts and nothing else.

    A row that is invalid, that already claims to be approved or reviewed, or that reuses an existing
    observation id with different content, refuses the whole batch. A row identical to one already stored
    (same content hash) is a duplicate: skipped and counted, not an error.
    """
    who = _name("submitter", submitter, MAX_NAME)
    target = Path(path) if path else store_path()
    _refuse_package(target)
    rows = list(rows)
    if not rows:
        raise StoreError("the batch contains no records")
    clock = now if now is not None else datetime.now(timezone.utc)
    result = load_batch(rows, now=clock)
    if result.rejected:
        detail = "; ".join(f"row {i + 1}: {why}" for i, why in result.rejected[:5])
        more = f" (and {len(result.rejected) - 5} more)" if len(result.rejected) > 5 else ""
        raise StoreError(f"{len(result.rejected)} of {len(rows)} row(s) are invalid, so the whole batch is refused: "
                         f"{detail}{more}")
    for r in result.accepted:
        if r.approval_status != "draft" or r.reviewer is not None:
            raise StoreError(f"{r.observation_id}: ingest stores records as draft only; approval happens through "
                             "`review`, by a second person")
    with _locked(target):
        state, prev, seq = _replay(target)
        known_hashes = {s.content_hash for s in state.values()}
        fresh: list[ObservationRecord] = []
        duplicates = 0
        for r in result.accepted:
            h = r.content_hash()
            if h in known_hashes:
                duplicates += 1
            elif r.observation_id in state:
                raise StoreError(f"{r.observation_id}: already stored with different content; an observation id "
                                 "names one measurement and cannot be reused")
            else:
                fresh.append(r)
        if fresh:
            at = _iso(clock)
            _append(target, [{"kind": "ingest", "at": at, "submitted_by": who, "record": r.to_dict(),
                              "content_hash": r.content_hash()} for r in fresh], prev, seq)
    return {"submitted": len(rows), "stored": len(fresh), "duplicates_skipped": duplicates, "path": str(target)}


def review(record_id: str, decision: str, *, reviewer: str, reason: str, path: Path | None = None,
           now: datetime | None = None) -> dict:
    """Append a decision about one record. History is never edited; the latest decision is the record's state."""
    if decision not in DECISIONS:
        raise StoreError(f"decision must be one of {list(DECISIONS)}")
    who = _name("reviewer", reviewer, MAX_NAME)
    why = _name("reason", reason, MAX_REASON)
    target = Path(path) if path else store_path()
    _refuse_package(target)
    with _locked(target):
        state, prev, seq = _replay(target)
        cur = state.get(record_id)
        if cur is None:
            raise StoreError(f"no stored record has observation id {record_id!r}")
        if decision == "approved" and _same_person(who, cur.submitted_by):
            raise StoreError("a record cannot be approved by the person who submitted it; a second person "
                             "must review it")
        if cur.record.approval_status == decision:
            raise StoreError(f"{record_id} is already {decision}")
        clock = now if now is not None else datetime.now(timezone.utc)
        # The overlaid record must itself be valid (an approved record needs its named reviewer).
        replace(cur.record, approval_status=decision, reviewer=who).validated(now=clock)
        _append(target, [{"kind": "review", "at": _iso(clock), "observation_id": record_id,
                          "decision": decision, "reviewer": who, "reason": why}], prev, seq)
    return {"observation_id": record_id, "status": decision, "previous_status": cur.record.approval_status}


# ---------------------------------------------------------------------------------------------- reading

def load_all(path: Path | None = None) -> list[StoredRecord]:
    """Every stored record in its current state, in submission order. Raises LedgerIntegrityError on a broken chain."""
    state, _, _ = _replay(Path(path) if path else store_path())
    return list(state.values())


def current_records(path: Path | None = None) -> list[ObservationRecord]:
    return [s.record for s in load_all(path)]


def approved_records(path: Path | None = None) -> list[ObservationRecord]:
    return [s.record for s in load_all(path) if s.record.approval_status == "approved"]


def chain_head(path: Path | None = None) -> str | None:
    _, head, n = _replay(Path(path) if path else store_path())
    return head if n else None


__all__ = ["ENV_VAR", "RECORDS_FILENAME", "StoreError", "StoredRecord", "store_path", "ingest", "review",
           "load_all", "current_records", "approved_records", "chain_head", "APPROVAL_STATUSES"]
