"""Self-serve API keys, verifiable offline.

To sell metered access without a salesperson, a stranger's payment has to become a
working key in seconds, and the engine has to be able to check that key without
asking anything else. Those two requirements fight: the usual answer is a database
the engine queries on every call, which couples the engine to a service that can be
slow, down, or in the wrong jurisdiction, and which turns a stateless container into
something with an operational dependency and a latency floor.

So the key carries its own plan and its own signature:

    gfk1.<payload>.<signature>

`payload` is compact JSON — account, key id, monthly unit quota, scope, issue and
expiry dates — base64url encoded. `signature` is HMAC-SHA256 over the prefixed
payload with GRIDFORGE_KEY_SECRET, the same secret the website signs with. The
engine verifies arithmetic it can do itself. No database, no network call, no
shared state, and a key that cannot be forged without the secret.

The cost of statelessness is revocation, and it is paid two ways. Keys expire —
the subscription webhook reissues monthly, so a cancelled subscription stops
being renewed and the key dies on its own within the period the customer paid
for. And GRIDFORGE_REVOKED_KEYS holds key ids for the cases that cannot wait,
which is why the payload carries a short id rather than requiring the whole key
to be pasted into a deny list.

Static keys in GRIDFORGE_API_KEYS keep working exactly as before. A deployment
with no GRIDFORGE_KEY_SECRET simply has no signed keys — it fails closed rather
than accepting anything unsigned, because the alternative failure is silent and
total.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone

PREFIX = "gfk1"
SCOPES = ("machine", "client", "trial")


class KeyError_(ValueError):
    """Raised with a message safe to return to the caller."""


def _b64e(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _b64d(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def secret() -> bytes:
    s = os.environ.get("GRIDFORGE_KEY_SECRET") or ""
    return s.encode()


def today() -> date:
    """Wall clock, deliberately not the pinnable report date.

    GRIDFORGE_REPORT_DATE exists so documents regenerate identically. If it also
    moved this clock, pinning a build date would extend or kill live credentials,
    and a date used for reproducibility would quietly become a security control.
    """
    return datetime.now(timezone.utc).date()


@dataclass(frozen=True)
class ApiKey:
    account: str
    key_id: str
    quota: int              # monthly units; 0 -> unlimited
    scope: str
    issued: str             # ISO date
    expires: str            # ISO date

    @property
    def days_left(self) -> int:
        return (date.fromisoformat(self.expires) - today()).days

    def to_payload(self) -> dict:
        return {"a": self.account, "k": self.key_id, "q": self.quota,
                "s": self.scope, "i": self.issued, "e": self.expires}

    def describe(self) -> dict:
        return {"account": self.account, "key_id": self.key_id,
                "monthly_quota": self.quota or None, "scope": self.scope,
                "issued": self.issued, "expires": self.expires,
                "days_left": self.days_left}


def issue(account: str, *, quota: int = 0, scope: str = "machine",
          days: int = 35, key_id: str | None = None,
          issued_on: date | None = None) -> str:
    """Mint a signed key. Only the website and the CLI do this; the engine never does.

    35 days by default, not 30: a subscription renewing on the 1st must not leave a
    customer's agents dark for a few hours while a webhook lands. The overlap is the
    difference between a renewal nobody notices and a support ticket.
    """
    if not secret():
        raise KeyError_("GRIDFORGE_KEY_SECRET is not set; refusing to mint an unsigned key")
    if scope not in SCOPES:
        raise KeyError_(f"unknown scope {scope!r}; one of {', '.join(SCOPES)}")
    if not account.strip():
        raise KeyError_("a key must name the account it bills to")
    start = issued_on or today()
    k = ApiKey(account=account.strip(), key_id=key_id or secrets.token_hex(4),
               quota=max(0, int(quota)), scope=scope,
               issued=start.isoformat(), expires=(start + timedelta(days=days)).isoformat())
    payload = _b64e(json.dumps(k.to_payload(), separators=(",", ":"), sort_keys=True).encode())
    body = f"{PREFIX}.{payload}"
    sig = _b64e(hmac.new(secret(), body.encode(), hashlib.sha256).digest())
    return f"{body}.{sig}"


def revoked_ids() -> set[str]:
    raw = os.environ.get("GRIDFORGE_REVOKED_KEYS", "")
    return {x.strip() for x in raw.split(",") if x.strip()}


def looks_signed(token: str) -> bool:
    return token.startswith(PREFIX + ".")


def verify(token: str) -> ApiKey:
    """Check a signed key. Raises KeyError_ with a message the caller may see.

    The messages distinguish forged, expired and revoked on purpose. A machine
    cannot ask what went wrong, and 'invalid key' sends an integrator hunting a
    typo when their subscription lapsed three days ago.
    """
    if not secret():
        raise KeyError_("signed keys are not enabled on this deployment")
    try:
        prefix, payload, sig = token.split(".")
    except ValueError:
        raise KeyError_("malformed key")
    if prefix != PREFIX:
        raise KeyError_(f"unsupported key version {prefix!r}")
    expected = _b64e(hmac.new(secret(), f"{prefix}.{payload}".encode(),
                              hashlib.sha256).digest())
    if not hmac.compare_digest(expected, sig):
        raise KeyError_("signature does not verify")
    try:
        d = json.loads(_b64d(payload))
        k = ApiKey(account=str(d["a"]), key_id=str(d["k"]), quota=int(d["q"]),
                   scope=str(d["s"]), issued=str(d["i"]), expires=str(d["e"]))
        date.fromisoformat(k.expires)
    except Exception:
        raise KeyError_("malformed key payload")
    if k.key_id in revoked_ids():
        raise KeyError_("this key has been revoked")
    if k.days_left < 0:
        raise KeyError_(f"this key expired on {k.expires}; renew the subscription "
                        f"or reissue from your account page")
    if k.scope not in SCOPES:
        raise KeyError_(f"unknown scope {k.scope!r}")
    return k


def inspect(token: str) -> dict:
    """Read a key without trusting it — for support, and for the CLI."""
    try:
        _, payload, _ = token.split(".")
        d = json.loads(_b64d(payload))
    except Exception:
        return {"valid": False, "error": "not a signed GridForge key"}
    out = {"account": d.get("a"), "key_id": d.get("k"), "monthly_quota": d.get("q") or None,
           "scope": d.get("s"), "issued": d.get("i"), "expires": d.get("e")}
    try:
        verify(token)
        out["valid"] = True
    except KeyError_ as exc:
        out["valid"] = False
        out["error"] = str(exc)
    return out
