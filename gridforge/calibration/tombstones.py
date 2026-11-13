"""Withdrawn observations, on the ledger side of the line (D5).

When an organisation withdraws its consent the database (supabase/migrations/0056) keeps a TOMBSTONE for each of its observations: the sha256 of the
observation's id, the time, and nothing else. Its export view stops listing them, for good. But the private ledger file is a hash chain that is never edited,
and rows already imported into it keep counting in every statistic read from it; and an export file saved before the withdrawal can be imported after it.
Both are closed here, without touching the chain, in the way the site-alias file closes the unsalted-reference problem (siteref.py): a SIDE FILE beside the
ledger, read whenever the ledger is read.

  * ``load_ledger`` leaves out of the private ledger every observation whose source reference carries a tombstoned id (``is_withdrawn``). The bytes of the
    chained file are unchanged; the observation is no longer counted in any aggregate that reads the ledger through ``load_ledger``.
  * ``import_export`` RECORDS the ``tombstones`` list an export carries in this file (before it looks at the rows, so a withdrawal does not wait for the rest of
    the export to be valid), and refuses, writing no observation, an export that holds a tombstoned observation, so a re-import cannot resurrect it.
    ``gridforge calibrate withdraw <hash>...`` records them by hand. Nothing reads the network: a withdrawal reaches this file when an operator imports an export
    that lists it or runs that command, and not before.
  * ``ledger._read`` (the count ``calibrate add`` prints, the total an import reports) leaves them out too; the chain readers (``read_chain``, ``_load``) stay whole,
    because they verify the file.

The file is ``calibration.local.tombstones.json`` beside the private ledger (``GRIDFORGE_CALIBRATION_TOMBSTONES`` overrides it), private and git-ignored like the
ledger. An unreadable file STOPS everything that reads the ledger: ignoring it would count withdrawn observations again, which is the one thing it is for.

NOT COVERED: the bundled ledger (``data/calibration.json``) ships inside the package and a published row there is public; withdrawing one is a new commit and
a new release, not a tombstone. It is empty today.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable, Mapping

from .schema import ObservationError

SCHEMA = "gridforge/calibration-tombstones/1"
FILENAME = "calibration.local.tombstones.json"
ENV_VAR = "GRIDFORGE_CALIBRATION_TOMBSTONES"
_HEX64 = re.compile(r"^[0-9a-f]{64}\Z")
_HEX32 = re.compile(r"^[0-9a-f]{32}\Z")


class TombstoneError(ObservationError):
    """The tombstone file cannot be trusted or an entry is malformed. Nothing that reads the ledger proceeds on it."""


def observation_hash(observation_id: str) -> str:
    """sha256 of the observation id: what the database tombstones (``gf_calibration_observation_hash``) and the head of a published source reference."""
    return hashlib.sha256(f"gridforge.calibration.observation:{observation_id}".encode()).hexdigest()


def tombstone_path(private: Path) -> Path:
    env = os.environ.get(ENV_VAR)
    return Path(env) if env else Path(private).with_name(FILENAME)


def _entry_hash(e: object, where: str) -> str:
    h = e.get("observation_hash") if isinstance(e, Mapping) else e
    if not isinstance(h, str) or not _HEX64.match(h):
        raise TombstoneError(f"{where}: a tombstone is the 64-hex sha256 of an observation id, got {h!r}")
    return h


def read_tombstones(path: Path) -> frozenset[str]:
    """Every tombstoned observation hash in the file; empty when there is no file. Fails closed on anything it cannot read."""
    if not path.exists():
        return frozenset()
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        raise TombstoneError(f"{path}: the tombstone file is unreadable ({type(e).__name__}); nothing is read until it is repaired") from e
    if not isinstance(doc, dict) or doc.get("schema") != SCHEMA or not isinstance(doc.get("tombstones"), list):
        raise TombstoneError(f"{path}: not a tombstone file: expected {{'schema': '{SCHEMA}', 'tombstones': [...]}}")
    return frozenset(_entry_hash(e, str(path)) for e in doc["tombstones"])


def head_of(source_ref: str) -> str | None:
    """The 32-hex head of a published source reference, whichever form the row was written in: the hash ``published_source_ref`` makes, or (rows imported
    before it existed) the raw observation id, which is hashed here. None for a row with no source reference (a hand-entered one)."""
    head = (source_ref or "").partition(":")[0]
    if not head:
        return None
    return head if _HEX32.match(head) else observation_hash(head)[:32]


def heads(tombstones: Iterable[str]) -> frozenset[str]:
    """The 32-hex heads the tombstoned hashes stand for, for ``is_withdrawn`` (built once per ledger read, not once per row)."""
    return frozenset(t[:32] for t in tombstones)


def is_withdrawn(source_ref: str, withdrawn_heads: frozenset[str]) -> bool:
    """Does this observation's source reference carry a tombstoned id? ``withdrawn_heads`` is ``heads(read_tombstones(...))``."""
    head = head_of(source_ref)
    return head is not None and head in withdrawn_heads


def add_tombstones(path: Path, hashes: Iterable[str], *, withdrawn_at: datetime | None = None) -> int:
    """Add observation hashes to the file (created if absent), keeping what is there; returns how many were new. Atomic: the file is replaced, never
    half-written. Each entry is the hash and the time, no content."""
    existing: dict[str, str] = {}
    if path.exists():
        read_tombstones(path)                                   # refuses a file that is not ours (or unreadable) before anything is added to it
        doc = json.loads(path.read_text(encoding="utf-8"))
        existing = {_entry_hash(e, str(path)): (e.get("withdrawn_at", "") if isinstance(e, Mapping) else "") for e in doc["tombstones"]}
    at = (withdrawn_at or datetime.now(timezone.utc)).astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    new = {_entry_hash(h, "add_tombstones"): at for h in hashes if h not in existing}
    merged = {**existing, **new}
    doc = {"schema": SCHEMA, "tombstones": [{"observation_hash": h, "withdrawn_at": merged[h]} for h in sorted(merged)]}
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")                 # as ledger._atomic_write: written whole beside it, then renamed over it
    try:
        with open(tmp, "w", encoding="utf-8") as fh:
            fh.write(json.dumps(doc, indent=2) + "\n")
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
    except BaseException:
        if tmp.exists():
            tmp.unlink()
        raise
    return len(new)
