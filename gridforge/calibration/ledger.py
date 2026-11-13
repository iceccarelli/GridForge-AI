from __future__ import annotations

import hashlib
import json
import math
import os
import re
import time
from contextlib import contextmanager
from dataclasses import dataclass, field, replace
from datetime import date
from pathlib import Path

from .schema import Observation, ObservationError, SHA256_RE
from .siteref import SiteRefError, alias_path, canonical, read_alias_file
from ..validation.evidence import EvidenceClass

try:                                  # POSIX. Elsewhere a lock-file fallback keeps two writers apart.
    import fcntl
except ImportError:                   # pragma: no cover
    fcntl = None                      # type: ignore[assignment]

BUNDLED_PATH = Path(__file__).resolve().parents[1] / "data" / "calibration.json"
PRIVATE_FILENAME = "calibration.local.json"

#: A ledger file with at least one record is a hash chain: every record carries the hash of the one before it, and
#: its own hash covers its whole body (including that link). Editing, deleting, inserting or reordering any record
#: makes every later link wrong, and loading names the first record that no longer fits. The empty ledger is the
#: bare `{"observations": []}` it always was: nothing to chain, and its serialisation (hence the engine provenance
#: digest that pins it) does not move.
CHAIN_SCHEMA = "gridforge/calibration-chain/1"
GENESIS = "0" * 64
EXPORT_SCHEMA = "gridforge/calibration-export/1"
#: What a reviewer's measurement may be, in the admin export (see supabase/migrations/0038_calibration_capture.sql).
MEASUREMENT_KINDS = ("metered", "bms_trend", "commissioning_record")
_UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\Z")

#: What a PUBLISHED row says in place of the free text a reviewer or an operator typed. A published row is the one kind that ends up in the
#: bundled ledger, which ships with the engine in a public repository: so it carries a measurement kind from the closed list above, a role
#: instead of a person, a hash instead of the database id, and months instead of days. Nothing a person wrote reaches it.
PUBLISHED_REVIEWER_ROLE = "calibration reviewer"
UNCLASSIFIED_METHOD = "unclassified measurement"
_REPORT_DATE_NOTE = re.compile(r"^model report_date (\d{4}-\d{2})-\d{2}\Z")


def _month_start(iso: str) -> str:
    """The first day of the month of an ISO date or timestamp: the day a site was measured, or a reviewer signed, identifies the visit."""
    try:
        return date.fromisoformat(iso[:10]).replace(day=1).isoformat()
    except ValueError:
        return iso


def published_source_ref(observation_id: str, evidence_sha256: str) -> str:
    """"<hash of the observation id>:<evidence sha256>". The same observation always gets the same reference, so a second import of it is
    still refused, but the database id itself is not in the row."""
    digest = hashlib.sha256(f"gridforge.calibration.observation:{observation_id}".encode()).hexdigest()[:32]
    return f"{digest}:{evidence_sha256}"


_HASHED_HEAD = re.compile(r"^[0-9a-f]{32}\Z")


def _published_ref(source_ref: str) -> str:
    """The closed form of a source reference: 32 hex characters (the hash ``published_source_ref`` makes) then the evidence digest. Anything
    else before the colon (a uuid, or a name someone typed such as "AcmeDublinDC1") is hashed, so what was typed is never published."""
    head, _, sha = source_ref.partition(":")
    return source_ref if _HASHED_HEAD.match(head) else published_source_ref(head, sha)


def published_form(o: Observation) -> Observation:
    """The row as it may be published: controlled vocabulary, hashes and months only. Idempotent. Rows imported before this existed carry
    the raw text on disk (the file and its hash chain are not rewritten); this is how they are shown."""
    kind = next((k for k in MEASUREMENT_KINDS if o.method == k or o.method.startswith(k + ":")), UNCLASSIFIED_METHOD)
    month = _REPORT_DATE_NOTE.match(o.note or "")
    return replace(
        o, method=kind, platform="", note=f"model report month {month.group(1)}" if month else "",
        source_ref=_published_ref(o.source_ref) if o.source_ref else "",
        reviewed_by=PUBLISHED_REVIEWER_ROLE if o.reviewed_by else "",
        reviewed_at=_month_start(o.reviewed_at) if o.reviewed_at else "", observed_on=_month_start(o.observed_on))


class LedgerIntegrityError(ObservationError):
    """The ledger file does not match its own hash chain. Nothing is loaded and nothing is appended."""


def private_path() -> Path:
    env = os.environ.get("GRIDFORGE_CALIBRATION_LEDGER")
    return Path(env) if env else Path.cwd() / PRIVATE_FILENAME


class AliasFileUnreadable(ObservationError):
    """The site-reference alias file exists but cannot be trusted. Anything that needs the aliases to count sites correctly stops; `where` reports it."""


def site_alias_file(ledger: Path | None = None) -> tuple[dict[str, str], dict | None]:
    """(aliases, acknowledgement) that apply to a ledger file (see siteref.py: MIXED REFERENCES). Empty/None when there is no alias file."""
    try:
        return read_alias_file(alias_path(private=Path(ledger) if ledger else private_path()))
    except SiteRefError as exc:
        raise AliasFileUnreadable(str(exc))


def site_aliases(ledger: Path | None = None) -> dict[str, str]:
    """The legacy -> keyed site-reference aliases that apply to a ledger file. Empty when there is no alias file."""
    return site_alias_file(ledger)[0]


def _canonicalised(obs: list[Observation], aliases: dict[str, str]) -> list[Observation]:
    """The same observations with a legacy (unsalted) site reference replaced by the keyed one the alias file declares to be the SAME site. The file
    on disk, and its hash chain, are untouched: this is how the ledger is READ."""
    if not aliases:
        return obs
    return [replace(o, site_ref=canonical(o.site_ref, aliases)) if canonical(o.site_ref, aliases) != o.site_ref else o for o in obs]


@dataclass
class Ledger:
    observations: list[Observation] = field(default_factory=list)
    sources: list[str] = field(default_factory=list)
    #: True when a private ledger was found and merged.
    private_loaded: bool = False
    #: Chain head (hash of the last chained record) per source file; None when the file has no chained record.
    heads: dict[str, str | None] = field(default_factory=dict)

    def keys(self) -> list[str]:
        return sorted({o.key for o in self.observations})

    def for_key(self, key: str) -> list[Observation]:
        return [o for o in self.observations if o.key == key]

    def to_dict(self) -> dict:
        return {"observations": [o.to_dict() for o in self.observations]}


# ---------------------------------------------------------------------------------------------- hash chain

def _canonical(obj) -> bytes:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False, default=str).encode("utf-8")


def _sha(obj) -> str:
    return hashlib.sha256(_canonical(obj)).hexdigest()


def _chain_record(body: dict, prev_hash: str) -> dict:
    linked = {**body, "prev_hash": prev_hash}
    return {**linked, "record_hash": _sha(linked)}


def _load(path: Path) -> tuple[list[dict], int]:
    """The raw records of a ledger file, with the chain verified. Returns (records, legacy_prefix_length).

    Fails closed: any break raises LedgerIntegrityError naming the (1-based) record, and nothing is returned.
    """
    if not path.exists():
        return [], 0
    text = path.read_text().strip()
    if not text:
        return [], 0                       # a touched-but-empty ledger is empty, not corrupt
    try:
        doc = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ObservationError(f"{path}: not valid JSON ({exc})")
    raw = doc.get("observations") if isinstance(doc, dict) else doc
    if raw is None:
        return [], 0
    if not isinstance(raw, list) or not all(isinstance(r, dict) for r in raw):
        raise ObservationError(f"{path}: 'observations' must be a list of records")
    marked = isinstance(doc, dict) and doc.get("chain") is not None
    if marked and doc.get("chain") != CHAIN_SCHEMA:
        raise LedgerIntegrityError(f"{path}: unknown chain schema {doc.get('chain')!r}")
    if marked:
        legacy = doc.get("legacy_prefix", 0)
        if not isinstance(legacy, int) or isinstance(legacy, bool) or not 0 <= legacy <= len(raw):
            raise LedgerIntegrityError(f"{path}: invalid legacy_prefix {legacy!r}")
    else:
        legacy = 0
        while legacy < len(raw) and "record_hash" not in raw[legacy]:
            legacy += 1
    prev = _sha(raw[:legacy]) if legacy else GENESIS
    for i in range(legacy, len(raw)):
        rec = raw[i]
        n = i + 1
        if "record_hash" not in rec or "prev_hash" not in rec:
            raise LedgerIntegrityError(
                f"{path}: record {n} carries no hash link, but the ledger is chained from record {legacy + 1}")
        if rec["prev_hash"] != prev:
            raise LedgerIntegrityError(
                f"{path}: record {n} breaks the hash chain (its link does not match record {n - 1}); the file "
                f"has been edited, reordered or had a record removed")
        body = {k: v for k, v in rec.items() if k != "record_hash"}
        if _sha(body) != rec["record_hash"]:
            raise LedgerIntegrityError(f"{path}: record {n} has been altered after it was written")
        prev = rec["record_hash"]
    for i in range(legacy):
        if "record_hash" in raw[i]:
            raise LedgerIntegrityError(f"{path}: record {i + 1} is inside the declared legacy prefix but is chained")
    return raw, legacy


def _head(raw: list[dict], legacy: int) -> str | None:
    return raw[-1]["record_hash"] if len(raw) > legacy else None


def read_chain(path: Path) -> tuple[list[Observation], str | None]:
    """The observations of one ledger file and its chain head (None when nothing in it is chained yet)."""
    raw, legacy = _load(Path(path))
    return [Observation.from_dict(d) for d in raw], _head(raw, legacy)


def _read(path: Path) -> list[Observation]:
    return read_chain(path)[0]


def load_ledger(published_only: bool = False, use_aliases: bool = True) -> Ledger:
    """The ledger in effect. `published_only` drops the private overlay — used when
    the output is going somewhere public, so client site data cannot escape through
    a build script that forgot which ledger it was reading. Entries not marked published are
    dropped too: a hand-typed row is not something to publish."""
    obs, head = read_chain(BUNDLED_PATH)
    sources = [str(BUNDLED_PATH)] if BUNDLED_PATH.exists() else []
    heads: dict[str, str | None] = {str(BUNDLED_PATH): head} if BUNDLED_PATH.exists() else {}
    if published_only:
        return Ledger(observations=[published_form(o) for o in obs if o.published], sources=sources,
                      private_loaded=False, heads=heads)
    p = private_path()
    private, phead = read_chain(p)
    # use_aliases=False exists for `calibrate where` alone, to report an unreadable alias file instead of stopping; every count of sites wants the aliases.
    private = _canonicalised(private, site_aliases(p) if use_aliases else {})
    if private:
        sources.append(str(p))
        heads[str(p)] = phead
    return Ledger(observations=obs + private, sources=sources,
                  private_loaded=bool(private), heads=heads)


# ---------------------------------------------------------------------------------------------- writing

@contextmanager
def _locked(target: Path):
    """One writer at a time per ledger file. Read-verify-append-replace happens entirely inside the lock, so two
    writers cannot both read the same head and fork the chain, or overwrite each other's record."""
    target.parent.mkdir(parents=True, exist_ok=True)
    lock = target.with_name(target.name + ".lock")
    if fcntl is not None:
        with open(lock, "a+") as fh:
            fcntl.flock(fh, fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(fh, fcntl.LOCK_UN)
        return
    deadline = time.monotonic() + 30      # pragma: no cover
    while True:                           # pragma: no cover
        try:
            fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            break
        except FileExistsError:
            if time.monotonic() > deadline:
                raise ObservationError(f"{target}: could not take the ledger lock")
            time.sleep(0.05)
    try:                                  # pragma: no cover
        yield
    finally:                              # pragma: no cover
        os.close(fd)
        os.unlink(lock)


def _atomic_write(target: Path, doc: dict) -> None:
    tmp = target.with_name(f".{target.name}.{os.getpid()}.tmp")
    data = json.dumps(doc, indent=2) + "\n"
    with open(tmp, "w") as fh:
        fh.write(data)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, target)
    if hasattr(os, "O_DIRECTORY"):
        try:
            dfd = os.open(target.parent, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(dfd)
            finally:
                os.close(dfd)
        except OSError:                   # pragma: no cover
            pass


def _refuse_bundled(target: Path) -> None:
    if target.resolve() == BUNDLED_PATH.resolve():
        raise ObservationError(
            "the bundled ledger is published with the engine and may not hold client "
            f"site data. Write to {PRIVATE_FILENAME} (gitignored) instead.")


def _append_many(new: list[Observation], target: Path) -> Path:
    """Append observations atomically: all of them or none, under the file lock, onto a verified chain."""
    if not new:
        return target
    _refuse_bundled(target)
    with _locked(target):
        raw, legacy = _load(target)
        existing = [Observation.from_dict(d) for d in raw]
        aliases = site_aliases(target)
        refs = {o.source_ref for o in existing if o.source_ref}
        refs |= {_published_ref(r) for r in refs}          # a row imported before references were hashed still blocks its own re-import
        # One site is one site whichever of its two references (unsalted before migration 0053, keyed after) a row carries, once the operator declared it.
        ident = {(o.key, canonical(o.site_ref, aliases), o.observed_on) for o in existing}
        batch_refs: set[str] = set()
        for o in new:
            if o.source_ref:
                if o.source_ref in refs:
                    raise ObservationError(
                        f"source_ref {o.source_ref} is already recorded — the same reviewed observation "
                        f"cannot enter the ledger twice")
                if o.source_ref in batch_refs:
                    raise ObservationError(f"duplicate source_ref {o.source_ref} in this batch")
                batch_refs.add(o.source_ref)
            k = (o.key, canonical(o.site_ref, aliases), o.observed_on)
            if k in ident:
                raise ObservationError(
                    f"{o.key} for {o.site_ref} on {o.observed_on} is already recorded — "
                    f"an observation counted twice inflates n and understates the spread")
            ident.add(k)
        prev = _head(raw, legacy) or (_sha(raw[:legacy]) if legacy else GENESIS)
        records = list(raw)
        for o in new:
            rec = _chain_record(o.to_dict(), prev)
            records.append(rec)
            prev = rec["record_hash"]
        _atomic_write(target, {"chain": CHAIN_SCHEMA, "legacy_prefix": legacy, "observations": records})
    return target


def append_observation(obs: Observation, path: Path | None = None) -> Path:
    """Write one observation to the private ledger, append-only and hash-chained.

    Refuses the bundled file outright. There is no flag to override this: the one
    way client site data ends up published is a hurried engineer reaching for a
    convenient default, so the convenient default must be impossible.
    """
    return _append_many([obs], Path(path) if path else private_path())


# ---------------------------------------------------------------------------------------------- import

def _num(v, name: str, i: int) -> float:
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v):
        raise ObservationError(f"export row {i}: {name} must be a finite number")
    return float(v)


def _row_to_observation(row, i: int) -> Observation:
    if not isinstance(row, dict):
        raise ObservationError(f"export row {i}: not an object")
    rid = row.get("id")
    if not isinstance(rid, str) or not _UUID_RE.match(rid):
        raise ObservationError(f"export row {i}: id must be the observation's uuid")
    tag = f"export row {i} ({rid})"
    if row.get("measurement_kind") not in MEASUREMENT_KINDS:
        raise ObservationError(
            f"{tag}: measurement_kind {row.get('measurement_kind')!r} is not one of {MEASUREMENT_KINDS}; "
            f"a quote, an assumption or a simulation is not a measurement")
    if row.get("evidence_class") != "E5":
        raise ObservationError(
            f"{tag}: evidence_class {row.get('evidence_class')!r}; a reviewed measurement enters the ledger as E5 "
            f"only (E6/E7 are outputs of computation, not of review)")
    sha = row.get("evidence_sha256")
    if not isinstance(sha, str) or not SHA256_RE.match(sha):
        raise ObservationError(f"{tag}: evidence_sha256 must be the 64-hex digest of the evidence artifact")
    dig = row.get("engine_provenance_digest")
    if not isinstance(dig, str) or not SHA256_RE.match(dig):
        raise ObservationError(f"{tag}: engine_provenance_digest must be the 64-hex provenance digest of the prediction")
    reviewer = row.get("reviewed_by")
    if not isinstance(reviewer, str) or not reviewer.strip():
        raise ObservationError(f"{tag}: reviewed_by is required")
    method = row.get("method")
    if not isinstance(method, str) or not method.strip():
        raise ObservationError(f"{tag}: method is required")
    note = ""
    if row.get("report_date") is not None:
        try:
            note = f"model report_date {date.fromisoformat(str(row['report_date'])).isoformat()}"
        except ValueError:
            raise ObservationError(f"{tag}: report_date is not an ISO date")
    try:
        # Validated as the export gave it (a method, a reviewer, a date must be there), then written in its published form: the free text a
        # reviewer typed (a person, a site, a URL), the database id and the exact dates are not copied into a row that may be published.
        return published_form(Observation(
            key=str(row.get("key") or ""), site_ref=str(row.get("site_ref") or ""),
            predicted=_num(row.get("predicted_value"), "predicted_value", i),
            observed=_num(row.get("observed_value"), "observed_value", i),
            unit=str(row.get("unit") or ""), observed_on=str(row.get("observed_on") or ""),
            evidence=EvidenceClass.E5_CUSTOMER_DATA, method=f"{row['measurement_kind']}: {method.strip()}",
            note=note, kind="measured", source_ref=f"{rid}:{sha}", model_digest=dig,
            reviewed_by=reviewer.strip(), reviewed_at=str(row.get("reviewed_at") or ""),
            source="import", published=True))
    except ObservationError as exc:
        raise ObservationError(f"{tag}: {exc}")


def import_export(doc, path: Path | None = None, *, accept_mixed_refs: bool = False) -> dict:
    """Append the rows of an admin calibration export, and only those that pass the ledger's own policy.

    All or nothing: one row that fails the policy, or repeats a source_ref, refuses the whole export and writes
    nothing. Nothing is read from the network and nothing is imported unless a person ran this on a file.
    """
    target = Path(path) if path else private_path()
    _refuse_bundled(target)
    if not isinstance(doc, dict) or doc.get("schema") != EXPORT_SCHEMA or not isinstance(doc.get("rows"), list):
        raise ObservationError(f"not a calibration export: expected {{'schema': '{EXPORT_SCHEMA}', 'rows': [...]}}")
    rows = doc["rows"]
    new = [_row_to_observation(r, i + 1) for i, r in enumerate(rows)]
    # An export row carries a site_<12 hex> in EITHER of two forms: the unsalted hash (rows made before migration 0053 is applied) or the keyed HMAC
    # (after). Nothing in the row says which, and the ledger holds no label, so the two can be told to be one site only from what the operator declared
    # (`gridforge calibrate alias`). A declared legacy reference is stored as the keyed one, so the two are ONE site; any other is stored as exported.
    aliases, acknowledgement = site_alias_file(target)
    if new:
        # CONSERVATIVE DEFAULT. The number of independent sites is what lifts a key to CALIBRATED, and a site seen under both kinds of reference would be
        # counted twice. So nothing is imported until a person has decided how mixed references are to be treated, in one of three recorded ways.
        decision = ("aliases" if aliases else "none_needed" if acknowledgement else "accept_mixed_refs" if accept_mixed_refs else None)
        if decision is None:
            sites = {o.site for o in new}
            raise ObservationError(
                f"this export carries {len(sites)} distinct site reference(s) in {len(new)} row(s). A reference made before migration 0053 is applied is UNSALTED "
                f"and one made after is KEYED, and a reference does not say which: a site exported under both would be counted as TWO independent sites, which "
                f"can lift a key over the n_sites >= 3 line for CALIBRATED. Decide first, once: `gridforge calibrate alias --site 'NAME'` (or --legacy-ref) for "
                f"each site that spans the boundary; `gridforge calibrate alias --none-needed` if none does (dated in the alias file); or --accept-mixed-refs "
                f"for this one import. Nothing was imported.")
    rekeyed = 0
    if aliases:
        fixed = []
        for o in new:
            c = canonical(o.site_ref, aliases)
            if c != o.site_ref:
                rekeyed += 1
                o = replace(o, site_ref=c, note=(o.note + "; " if o.note else "") + "site_ref re-keyed from its unsalted form by the alias file")
            fixed.append(o)
        new = fixed
    if new:
        _append_many(new, target)
    total = len(read_chain(target)[0]) if target.exists() else 0
    return {"imported": len(new), "ledger_observations": total, "path": str(target), "rekeyed": rekeyed,
            "aliases": len(aliases), "distinct_sites_imported": len({o.site for o in new}),
            "mixed_ref_decision": (decision if new else None)}
