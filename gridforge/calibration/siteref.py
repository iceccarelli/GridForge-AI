"""The reference to a SITE that goes into the calibration ledger: keyed (HMAC), with the unsalted form kept only to recognise old rows.

Until migration 0053 a site reference was ``site_`` + the first 12 hex of the UNSALTED SHA-256 of the lower-cased label, so anyone who could
guess a label ("Hall A") could confirm it by hashing. The website now computes

    site_ref = "site_" + first 12 hex of HMAC-SHA256(key, "site\\0" + normalised(label))      (normalised: trim, NFC, ASCII lower-case)

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

import datetime
import hashlib
import hmac
import json
import os
import re
import sys
import unicodedata
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
_EDGE = re.compile("^[\t-\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+|[\t-\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+\\Z")


class SiteRefError(ValueError):
    pass


_ASCII_LOWER = {c: c + 32 for c in range(ord("A"), ord("Z") + 1)}


def normalise_label(label: str) -> str:
    """The label as two spellings of one site agree on it: trim the explicit whitespace set, NFC, lower-case ASCII LETTERS ONLY. Empty = no label.

    Not a full Unicode lower-case on purpose: Python and Node carry different Unicode tables, so a letter that became cased in a later Unicode version would
    be lower-cased by one and not the other and the two sides would disagree silently. CONSEQUENCE: two spellings of a NON-ASCII label that differ only in the
    case of a non-ASCII letter are two different sites to the keyed reference; write such a label the same way every time. lib/site-ref.ts is identical.
    """
    if not isinstance(label, str):
        raise SiteRefError("a site label must be text")
    return unicodedata.normalize("NFC", _EDGE.sub("", label)).translate(_ASCII_LOWER)


def _utf8(text: str) -> bytes:
    # A lone surrogate (never in a real label) becomes U+FFFD, as JavaScript's TextEncoder / Node's Buffer does, so both sides hash the same bytes.
    return text.encode("utf-16", "surrogatepass").decode("utf-16", "replace").encode("utf-8")


def resolve_key(env: Mapping[str, str] | None = None) -> tuple[str, str]:
    """(key, source): source is ENV_DEDICATED, ENV_SIGNING or 'fallback'. The key is never to be printed."""
    e = os.environ if env is None else env
    dedicated = e.get(ENV_DEDICATED) or ""
    if len(dedicated) >= SECRET_MIN:                      # code points, as lib/site-ref.ts counts them
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
    """The website's reference for a site: site_ + 12 hex of HMAC-SHA256(key, "site\\0" + normalised(label))."""
    n = normalise_label(label)
    if not n:
        raise SiteRefError("a site name is required: there is no reference for an empty one")
    return "site_" + hmac.new(key.encode("utf-8"), b"site\x00" + _utf8(n), hashlib.sha256).hexdigest()[:12]


def keyed_hall_suffix(label: str, hall: str, key: str) -> str:
    """8 hex naming one hall of a site. Keyed like the site part (a guessable hall id must not confirm a guessable site) and domain-separated from it."""
    s, h = normalise_label(label), normalise_label(hall)
    if not s or not h:
        raise SiteRefError("a site name and a hall id are required")
    return hmac.new(key.encode("utf-8"), b"hall\x00" + _utf8(s) + b"\x00" + _utf8(h), hashlib.sha256).hexdigest()[:8]


def keyed_site_ref(label: str, hall: str, key: str) -> str:
    """One hall of a site: the keyed site reference, then a keyed hall suffix. The part before '-' is the SITE."""
    return f"{keyed_site_only_ref(label, key)}-{keyed_hall_suffix(label, hall, key)}"


#: The database's own derivation of the unsalted reference, copied from migrations 0038/0047 (gf_submit_observation); `label` is the project's site_label.
#: Its result depends on the database's locale (lower() and \s), which is why a non-ASCII label's legacy reference is read FROM THE DATABASE, never guessed.
LEGACY_REF_SQL = (
    "select 'site_' || substr(encode(sha256(convert_to(lower(regexp_replace(coalesce(site_label, ''), '^\\s+|\\s+$', '', 'g')), 'UTF8')), 'hex'), 1, 12) "
    "from projects where site_label is not null"
)


class LegacyRefNeedsDatabase(SiteRefError):
    """The label is not plain ASCII, so Python cannot know what the database derived (lower-casing, \\s and trimming differ: a final sigma, a dotted I,
    U+1E9E, the C0 separators, U+0085). The caller must take the reference from the database and pass it explicitly."""


def is_plain_ascii_label(label: str) -> bool:
    """True when every character is printable ASCII (0x20-0x7e): the only labels whose unsalted reference Python computes identically to the database
    in any locale."""
    return isinstance(label, str) and label != "" and all(0x20 <= ord(c) <= 0x7E for c in label)


def check_argv_text(label: str) -> None:
    """A command-line argument that was not valid UTF-8 reaches Python as text holding lone surrogates; it cannot name a site."""
    if any(0xD800 <= ord(c) <= 0xDFFF for c in label):
        raise SiteRefError("that site name is not valid UTF-8 (the command line carried bytes that are not text); nothing was done")


def legacy_site_only_ref(label: str) -> str:
    """The UNSALTED reference migrations 0038-0052 derived and `gridforge calibrate add` produced before 0053: kept only to recognise old rows.

    Computed here ONLY for a plain-ASCII label. Anything else raises LegacyRefNeedsDatabase: the database's lower() and \\s differ from Python's, so a guess
    would record the WRONG reference and merge nothing (or the wrong site). Read it from the database (LEGACY_REF_SQL) and pass it explicitly."""
    if not isinstance(label, str) or not label.strip():
        raise SiteRefError("a site name is required: there is no reference for an empty one")
    check_argv_text(label)
    # Trimmed with exactly the ASCII set the database's \\s trims (Python's own strip() also trims U+001C-U+001F, U+0085 and the Unicode spaces, which it does not).
    if not is_plain_ascii_label(label.strip(" \t\n\r\v\f")):
        raise LegacyRefNeedsDatabase(
            f"the unsalted reference of {label!r} cannot be computed here: it is not plain ASCII, and the database's lower-casing and trimming differ from "
            f"Python's, so a guess could be wrong. Compute it in the database that holds the project and pass it with --legacy-ref: "
            f"{LEGACY_REF_SQL} and 'site_label' = <the label>.")
    from .schema import site_only_ref
    return site_only_ref(label)


def validated_legacy_ref(ref: str) -> str:
    if not isinstance(ref, str) or not SITE_ONLY_RE.match(ref):
        raise SiteRefError("--legacy-ref must be a site reference: site_ followed by 12 lowercase hex characters")
    return ref


# ---------------------------------------------------------------------------------------------- aliases (legacy -> keyed)

def alias_path(ledger: Path | None = None, private: Path | None = None) -> Path:
    env = os.environ.get(ALIAS_ENV)
    if env:
        return Path(env)
    base = Path(ledger) if ledger else private
    if base is None:
        raise SiteRefError("no ledger path to put the alias file beside")
    return base.with_name(ALIAS_FILENAME)


def read_alias_file(path: Path) -> tuple[dict[str, str], dict | None]:
    """(aliases, acknowledgement) in `path`: both empty/None when there is no file. Refuses a file that could not be trusted to merge sites correctly.

    The acknowledgement is the operator's recorded decision that no site spans the migration-0053 boundary: {"none_needed_on": "YYYY-MM-DD"}."""
    if not path.exists():
        return {}, None
    try:
        doc = json.loads(path.read_text() or "{}")
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
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
    ack = doc.get("acknowledgement")
    if ack is not None:
        try:
            if not isinstance(ack, dict) or set(ack) != {"none_needed_on"}:
                raise ValueError
            datetime.date.fromisoformat(ack["none_needed_on"])
        except (ValueError, TypeError):
            raise SiteRefError(f"{path}: the acknowledgement must be {{\"none_needed_on\": \"YYYY-MM-DD\"}}")
    return out, ack


def read_aliases(path: Path) -> dict[str, str]:
    """The legacy -> keyed map in `path` (empty when there is no file)."""
    return read_alias_file(path)[0]


def _write_alias_file(path: Path, aliases: Mapping[str, str], ack: dict | None) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    doc: dict = {"schema": ALIAS_SCHEMA, "aliases": dict(sorted(aliases.items()))}
    if ack:
        doc["acknowledgement"] = ack
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    tmp.write_text(json.dumps(doc, indent=2) + "\n")
    os.replace(tmp, path)


def add_alias(path: Path, legacy: str, keyed: str) -> bool:
    """Record legacy -> keyed. True when it was new, False when it was already there. Refuses a conflicting mapping. One writer at a time (the ledger's
    lock), so two concurrent `calibrate alias` runs cannot lose each other's line."""
    from .ledger import _locked
    with _locked(path):
        current, ack = read_alias_file(path)
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
        _write_alias_file(path, current, ack)
        return True


def acknowledge_none_needed(path: Path, today: str | None = None) -> bool:
    """Record, dated, that the operator has decided no site spans the migration-0053 boundary (every site in the ledger and its exports has only one kind of
    reference). True when newly recorded. This is a statement by a person, not something the software can check."""
    from .ledger import _locked
    day = today or datetime.date.today().isoformat()
    datetime.date.fromisoformat(day)
    with _locked(path):
        current, ack = read_alias_file(path)
        if ack:
            return False
        _write_alias_file(path, current, {"none_needed_on": day})
        return True


def canonical(ref: str, aliases: Mapping[str, str]) -> str:
    """`ref` with its SITE part replaced by the keyed reference when an alias says it is the same site (the hall suffix, if any, is kept)."""
    site, dash, rest = ref.partition("-")
    return aliases.get(site, site) + dash + rest


def warn(message: str) -> None:
    print(f"warning: {message}", file=sys.stderr)
