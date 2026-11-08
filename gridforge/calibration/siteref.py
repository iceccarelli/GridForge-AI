"""The reference to a SITE that goes into the calibration ledger: keyed (HMAC), with the unsalted form kept only to recognise old rows.

Until migration 0053 a site reference was ``site_`` + the first 12 hex of the UNSALTED SHA-256 of the lower-cased label, so anyone who could
guess a label ("Hall A") could confirm it by hashing. The website now computes

    site_ref = "site_" + first 12 hex of HMAC-SHA256(key, lower(trim(label)))

(lib/site-ref.ts) and `gridforge calibrate add` computes THE SAME VALUE here from the same environment variables, so a hand-entered row and an
exported row for one site agree. tests/site_ref_vectors.json holds the shared vectors; tests/site/site-ref.test.ts and tests/test_site_ref_hmac.py
both reproduce every one.

THE KEY: GRIDFORGE_SITE_REF_SECRET (16+ characters), else GRIDFORGE_KEY_SECRET, else a fixed PUBLIC fallback key with a warning (a developer
machine, never a real ledger: a reference made with the public key is exactly as guessable as the old unsalted hash). ROTATING THE KEY CHANGES EVERY
REFERENCE FROM THEN ON, so the same site would look like a new site: keep GRIDFORGE_SITE_REF_SECRET, and keep it the same on the website and wherever
this CLI is run. The key is never printed or logged.

MIXED REFERENCES. Rows exported before 0053 is applied (or stored before it) carry the unsalted reference; later rows carry the keyed one. The
ledger holds no label, so nothing can tell that two references are one site. Counting them as two would silently inflate the number of independent
sites, which is the figure the calibration states rest on. So the operator, who knows the label, declares it:

    gridforge calibrate alias --site "Dublin DC1"

records legacy -> keyed in a local alias file; import and load then treat both references as ONE site (the stored chain is never edited). Until
that is done for a site, the two references ARE counted as two, and every import says so.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import sys
from pathlib import Path
from typing import Mapping

ENV_DEDICATED = "GRIDFORGE_SITE_REF_SECRET"
ENV_SIGNING = "GRIDFORGE_KEY_SECRET"
SECRET_MIN = 16
#: PUBLIC and fixed: for local runs and tests only. lib/site-ref.ts holds the same string.
FALLBACK_KEY = "gridforge-site-ref-fallback-key-public-NOT-A-SECRET-local-and-test-only"

#: A bare site reference as the website stores and exports it.
SITE_ONLY_RE = re.compile(r"^site_[0-9a-f]{12}\Z")          # \Z, not $: "$" also matches before a trailing newline

ALIAS_SCHEMA = "gridforge/site-ref-aliases/1"
ALIAS_FILENAME = "site_ref_aliases.local.json"
ALIAS_ENV = "GRIDFORGE_SITE_REF_ALIASES"

#: The characters trimmed from both ends of a label. An explicit set: str.strip() and JavaScript's trim() disagree about a few code points.
_EDGE = re.compile("^[\t-\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+|[\t-\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+$")


class SiteRefError(ValueError):
    pass


def normalise_label(label: str) -> str:
    """lower(trim(label)): two spellings of one site agree on it. Empty means there is no label."""
    if not isinstance(label, str):
        raise SiteRefError("a site label must be text")
    return _EDGE.sub("", label).lower()


def _utf8(text: str) -> bytes:
    # A lone surrogate (never in a real label) becomes U+FFFD, as JavaScript's TextEncoder / Node's Buffer does, so both sides hash the same bytes.
    return text.encode("utf-16", "surrogatepass").decode("utf-16", "replace").encode("utf-8")


def resolve_key(env: Mapping[str, str] | None = None) -> tuple[str, str]:
    """(key, source): source is ENV_DEDICATED, ENV_SIGNING or 'fallback'. The key is never to be printed."""
    e = os.environ if env is None else env
    dedicated = e.get(ENV_DEDICATED) or ""
    if len(dedicated) >= SECRET_MIN:
        return dedicated, ENV_DEDICATED
    signing = e.get(ENV_SIGNING) or ""
    if signing:
        return signing, ENV_SIGNING
    return FALLBACK_KEY, "fallback"


def key_warning(source: str) -> str | None:
    """The sentence to show the operator when the key is not the dedicated one, or None."""
    if source == "fallback":
        return (f"neither {ENV_DEDICATED} nor {ENV_SIGNING} is set: this site reference uses a fixed PUBLIC fallback key, so it is as guessable as the "
                f"old unsalted hash and will NOT match the references the website produces. Set {ENV_DEDICATED} to the website's value.")
    if source == ENV_SIGNING:
        return (f"{ENV_DEDICATED} is not set (or is shorter than {SECRET_MIN} characters): keyed with {ENV_SIGNING}, so every reference changes if "
                f"that is rotated. Set {ENV_DEDICATED} and keep it.")
    return None


def keyed_site_only_ref(label: str, key: str) -> str:
    """The website's reference for a site: site_ + 12 hex of HMAC-SHA256(key, lower(trim(label)))."""
    n = normalise_label(label)
    if not n:
        raise SiteRefError("a site name is required: there is no reference for an empty one")
    return "site_" + hmac.new(key.encode("utf-8"), _utf8(n), hashlib.sha256).hexdigest()[:12]


def keyed_hall_suffix(label: str, hall: str, key: str) -> str:
    """8 hex naming one hall of a site. Keyed like the site part (a guessable hall id must not confirm a guessable site) and domain-separated from it."""
    s, h = normalise_label(label), normalise_label(hall)
    if not s or not h:
        raise SiteRefError("a site name and a hall id are required")
    return hmac.new(key.encode("utf-8"), b"hall\x00" + _utf8(s) + b"\x00" + _utf8(h), hashlib.sha256).hexdigest()[:8]


def keyed_site_ref(label: str, hall: str, key: str) -> str:
    """One hall of a site: the keyed site reference, then a keyed hall suffix. The part before '-' is the SITE."""
    return f"{keyed_site_only_ref(label, key)}-{keyed_hall_suffix(label, hall, key)}"


def legacy_site_only_ref(label: str) -> str:
    """The UNSALTED reference migrations 0038-0052 derived and `gridforge calibrate add` produced before 0053: kept only to recognise old rows."""
    from .schema import site_only_ref
    if not isinstance(label, str) or not label.strip():
        raise SiteRefError("a site name is required: there is no reference for an empty one")
    return site_only_ref(label)


# ---------------------------------------------------------------------------------------------- aliases (legacy -> keyed)

def alias_path(ledger: Path | None = None, private: Path | None = None) -> Path:
    env = os.environ.get(ALIAS_ENV)
    if env:
        return Path(env)
    base = Path(ledger) if ledger else private
    if base is None:
        raise SiteRefError("no ledger path to put the alias file beside")
    return base.with_name(ALIAS_FILENAME)


def read_aliases(path: Path) -> dict[str, str]:
    """The legacy -> keyed map in `path` (empty when there is no file). Refuses a file that could not be trusted to merge sites correctly."""
    if not path.exists():
        return {}
    try:
        doc = json.loads(path.read_text() or "{}")
    except json.JSONDecodeError as exc:
        raise SiteRefError(f"{path}: not valid JSON ({exc})")
    if not isinstance(doc, dict) or doc.get("schema") != ALIAS_SCHEMA or not isinstance(doc.get("aliases"), dict):
        raise SiteRefError(f"{path}: not a site-reference alias file (expected schema {ALIAS_SCHEMA!r} and an 'aliases' object)")
    out: dict[str, str] = {}
    for old, new in doc["aliases"].items():
        if not (isinstance(old, str) and isinstance(new, str) and SITE_ONLY_RE.match(old) and SITE_ONLY_RE.match(new)):
            raise SiteRefError(f"{path}: every alias must map a site_<12 hex> to a site_<12 hex>")
        if old == new:
            raise SiteRefError(f"{path}: {old} is aliased to itself")
        out[old] = new
    if any(new in out for new in out.values()):
        raise SiteRefError(f"{path}: an alias target is itself aliased; aliases must not chain")
    return out


def add_alias(path: Path, legacy: str, keyed: str) -> bool:
    """Record legacy -> keyed. True when it was new, False when it was already there. Refuses a conflicting mapping."""
    current = read_aliases(path)
    if legacy == keyed:
        raise SiteRefError("the unsalted and keyed references are the same: nothing to alias (the key is probably the public fallback)")
    if current.get(legacy) == keyed:
        return False
    if legacy in current:
        raise SiteRefError(f"{legacy} is already aliased to a different reference ({current[legacy]}); the key may have changed. Nothing was written.")
    if keyed in current:
        raise SiteRefError(f"{keyed} is already an unsalted reference of another site; nothing was written.")
    if legacy in current.values():
        raise SiteRefError(f"{legacy} is already a keyed reference of another alias; aliases must not chain. Nothing was written.")
    current[legacy] = keyed
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    tmp.write_text(json.dumps({"schema": ALIAS_SCHEMA, "aliases": dict(sorted(current.items()))}, indent=2) + "\n")
    os.replace(tmp, path)
    return True


def canonical(ref: str, aliases: Mapping[str, str]) -> str:
    """`ref` with its SITE part replaced by the keyed reference when an alias says it is the same site (the hall suffix, if any, is kept)."""
    site, dash, rest = ref.partition("-")
    return aliases.get(site, site) + dash + rest


def warn(message: str) -> None:
    print(f"warning: {message}", file=sys.stderr)
