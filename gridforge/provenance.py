"""What produced a document: the engine build and every library that moves a number in it.

The website records a cost-evidence run under an identity that must change whenever the engine, the cost library or
the calibration ledger changes in a way that could change the document. `VERSION` is a hand-edited label and a
deployment URL names nothing, so neither can be that identity. This module hashes the actual content instead:

    code_sha256          every shipped source and data file of the package, by relative path and bytes
    cost_library_sha256  the cost library as resolved for a study (bundled seed + the operator's private lines)
    calibration_sha256   the calibration ledger as resolved (bundled + private)

`digest` covers exactly those three and the schema label. `report_date` is reported next to it but is deliberately
NOT part of `digest`: the date printed on a document is an incidental of when it was made, and a retry on another
day must not look like a different engine.

It reports digests only. It never reads, prints or returns a price, a supplier or an observation.
"""
from __future__ import annotations

import hashlib
import json
from functools import lru_cache
from pathlib import Path

from .clock import report_date_iso

SCHEMA = "gridforge/provenance/1"
_PACKAGE = Path(__file__).resolve().parent


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _canonical(obj) -> bytes:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False, default=str).encode("utf-8")


@lru_cache(maxsize=1)
def code_sha256() -> str:
    """Relative path + content of every .py/.json/.html/.css/.txt/.md file in the package, in path order."""
    h = hashlib.sha256()
    for p in sorted(_PACKAGE.rglob("*")):
        if not p.is_file() or "__pycache__" in p.parts or p.suffix in (".pyc", ".pyo"):
            continue
        rel = p.relative_to(_PACKAGE).as_posix()
        h.update(f"{rel}\0{_sha(p.read_bytes())}\n".encode("utf-8"))
    return h.hexdigest()


def cost_library_sha256() -> str:
    from .costs import CostLibrary
    lib = CostLibrary.resolved()
    return _sha(_canonical({k: lib.entries[k].__dict__ for k in sorted(lib.entries)}))


def calibration_sha256() -> str:
    from .calibration.ledger import load_ledger
    return _sha(_canonical(load_ledger().to_dict()))


def provenance(engine_version: str) -> dict:
    parts = {
        "engine_version": engine_version,
        "code_sha256": code_sha256(),
        "cost_library_sha256": cost_library_sha256(),
        "calibration_sha256": calibration_sha256(),
    }
    return {
        "schema": SCHEMA,
        **parts,
        "digest": _sha(_canonical({"schema": SCHEMA, **parts})),
        "report_date": report_date_iso(),
    }
