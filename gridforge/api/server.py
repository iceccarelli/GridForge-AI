"""HTTP API for the envelope engine. Standard library only.

    python3 -m gridforge serve --port 8080

One engine, two surfaces: the CLI delivers engagements, the API answers the
website's qualifier and any client integration. There is deliberately no second
implementation of the physics — a TypeScript copy of these constraints would
drift from the Python one within a month, and a provenance-first product cannot
survive two versions of the truth.

Endpoints
    GET  /health                        liveness
    GET  /v1/version                    engine version and tier configuration
    GET  /v1/platforms                  the platform library, and what is deliberately absent
    GET  /v1/intake/template            blank intake document
    GET  /v1/estimate?endpoint=...      what a call would cost, before spending anything (public; POST takes the same, with a body)
    POST /v1/estimate                   the same, for a request body: units read exactly as the meter reads them (public)
    POST /v1/qualify                    seven fields -> binding constraint  (public)
    POST /v1/screen                     full intake -> screen payload       (key)
    POST /v1/compare                    full intake -> scenarios side by side, with only the dates the lead times support (key)
    POST /v1/study                      full intake -> model pack           (key)
    POST /v1/portfolio                  [intakes]  -> ranked halls          (key)
    POST /v1/proposal                   intake     -> priced proposal       (key)
    POST /v1/deck                       intake     -> walkthrough deck      (key)
    POST /v1/diff                       two intakes-> change note           (key)
    POST /v1/spec                       intake     -> tender specification  (key)
    POST /v1/bids                       intake+bids-> ranked comparison     (key)
    POST /v1/power/assess               intake     -> Power Readiness Case (key)
    POST /v1/power/deploy/assess        deployment request -> BTM assessment (key)
    POST /v1/power/deploy/spec          deployment request -> equipment tender (key)
    POST /v1/power/deploy/bids          deployment request+bids -> ranked comparison (key)
    GET  /v1/calibration                how far the model is reconciled      (public)
    GET  /v1/calibration/residuals      aggregate residuals, approved only   (public)
    GET  /v1/tools                      machine-callable tool schemas        (public)
    GET  /v1/usage                      this key's metered usage             (key)
    POST /mcp                           Model Context Protocol, JSON-RPC 2.0 (public
                                        transport; each tool keeps its own tier)
    (an operator-only route, /v1/revoke, exists and is in no listing: it answers 404 to everyone but the operator)
A route answers the methods it takes; any other method on a known route is 405 with an Allow header, HEAD answers a GET route as GET does
without the body, and every error is JSON with schema_version.

Auth: X-API-Key, or Authorization: Bearer <key>, against GRIDFORGE_API_KEYS
(comma separated, `key[:label[:monthly_units]]`). With no keys configured the paid
endpoints refuse rather than open — a misconfigured deployment must fail closed.

Metering: every paid call bills units (see /v1/version). Over quota returns 402,
not 429 — to a machine those mean buy more and try later respectively, and an
agent told to retry a call it can never afford will retry it forever.

Who a caller is (the rate limiter's identity). A forwarding header is only something the caller typed unless a proxy WE run wrote it, so
the identity is the socket peer unless the operator says otherwise:
    GRIDFORGE_TRUSTED_PROXY_HOPS   how many proxies of ours sit in front of the engine (whole number, 0 or more). The caller is then the
                                   X-Forwarded-For entry that many places from the RIGHT (each hop appends the address it saw; the
                                   entries to the left are whatever the client sent and are never read). Unset: 1 on Fly.io (the platform
                                   sets FLY_APP_NAME and its proxy appends), 0 everywhere else. A deployment behind another proxy
                                   (Render, nginx, a load balancer) must set it, or every caller shares the proxy's address.
    GRIDFORGE_TRUSTED_IP_HEADER    a single-address header that OUR proxy overwrites on every request (e.g. cf-connecting-ip). Unset on
                                   Fly.io, Fly-Client-IP is trusted. Anywhere else it is read only when named here.
    GRIDFORGE_RATE_LIMIT           requests per minute per caller on every route except the cheap discovery routes (default 30; 0 = off).
    GRIDFORGE_DISCOVERY_RATE_LIMIT requests per minute per caller on /health, /v1/version and /v1/tools, which cost almost nothing but are
                                   still bounded (default: ten times GRIDFORGE_RATE_LIMIT, at least 600; follows the main limiter off).
    GRIDFORGE_RATE_LIMIT_IPV6_48_MULTIPLE   an IPv6 caller is counted on TWO buckets, its /64 (the limit above) and its enclosing /48, whose
                                   allowance is this many times the /64 limit (default 32; a value below 1 is read as 1, so one ordinary caller
                                   is never throttled by the /48 before its /64). A holder of a /48 can mint 65,536 /64s and used to get a fresh
                                   allowance for each. A /48 may also hold unrelated users (residential prefixes are often a /56 or a /60, and a
                                   carrier may pool many subscribers in one), which is why the multiple is generous. IPv4 is unchanged: one bucket
                                   per address. A placeholder, not a measurement of any subscriber population.
    GRIDFORGE_MAX_CONCURRENT_SOLVES   solves (any route that runs the model, /mcp tool calls included) that may run at the same instant, in all
                                   (default 16; 0 = no cap; a negative or unreadable value is the default, never "off"). At most half of them
                                   (at least one) may be held by keyless (public-tier) callers, so a keyed caller always has headroom.
    GRIDFORGE_MAX_CONCURRENT_SOLVES_PER_CALLER   solves one KEYLESS caller identity (the rate limiter's: the IPv4 address, the IPv6 /64) may run at
                                   the same instant (default 2; keyed callers are not capped per identity; 0 = no per-caller cap; negative or unreadable = the default). A request that would exceed any
                                   of the three is answered 503 with a Retry-After header and a JSON body at once: it is never queued and never
                                   charged. These bound HOW MANY solves run, not how long one takes: there is no wall-clock limit on a single
                                   solve, and solves share the interpreter, so more at once means each is slower. Placeholders, not measured capacity.
An address that does not parse is not an identity: the socket peer is used instead. IPv6 callers are counted per /64 and per /48.
GRIDFORGE_ADMIN_KEY and GRIDFORGE_KEY_SECRET, when set, should be at least 24 characters (MIN_SECRET_CHARS). `serve` logs a WARNING naming the
variable and its length (never the value) and carries on, so a deployment whose secrets are older than this check does not go down.
    GRIDFORGE_ENFORCE_SECRET_STRENGTH   set to 1: `serve` refuses to start (exit 2) on a secret shorter than that. Set it once the live secrets
                                        are confirmed long enough; the check itself is `check_secret_strength`.
"""
from __future__ import annotations

import hashlib
import hmac
import ipaddress
import json
import math
import os
import secrets
import sys
import threading
import time
from collections import defaultdict, deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from datetime import datetime, timezone
from urllib.parse import parse_qs, urlparse

from ..calibration import accuracy_block, all_keys as calibration_keys, load_ledger
from ..calibration.ledger import LedgerIntegrityError
from ..calibration.residuals import public_report as public_residual_report
from ..calibration.store import approved_records as approved_observation_records
from ..compute.library import PLATFORMS, UNPUBLISHED_PLATFORMS
from ..intake.loader import PLAUSIBLE_MAX, IntakeError, blank_intake, ignored_top_level_keys, load_document, plausible_floor
from ..intake.schema import FIELD_BY_PATH as _INTAKE_FIELD_BY_PATH
from ..reporting import to_html, to_markdown
from ..reporting.gates import ReportMode, run_all_gates
from ..reporting.portfolio import SiteEntry, portfolio_rows, portfolio_summary, portfolio_warnings
from ..reporting.portfolio import build as build_portfolio
from ..commercial import ENGAGEMENTS, PAYG, engagement
from ..change import EnvelopeState, StateError, diff as envelope_diff, diff_from_state
from ..reporting.change_note import build as build_change_note_report
from ..reporting.deck import build as build_deck_report
from ..reporting.deck import to_html as deck_to_html
from ..reporting.proposal import build as build_proposal_report
from ..reporting.screen import build as build_screen_report
from ..envelope.time_to_power import date_record as _date_record
from ..reporting.study import build as build_study_report, watermark_for
from ..reporting.study import collect_claims
from ..reporting.study import Objective
from ..scenario import run_all
from ..scenario.knobs import SENSITIVITY_KNOBS
from ..serialize import csv_bundle, model_pack
from .keys import revocation_persistable, revoke, revoked_ids
from ..provenance import provenance
from .costs import BUCKET_BOUNDS_MS, timer
from .metering import (MAX_PORTFOLIO_HALLS, METER, UNIT_COST, key_plans, payg_public, plan_for, portfolio_cap_message, refusal,
                       units_for)
from .payloads import (btm_calibration_block, calibration_block, calibration_block_for_bindings, grid_queue_context_for, qualify_payload,
                       retail_price_context_for, screen_payload)
from .tiers import Tier, redact
from .tools import PROTOCOL_VERSION, TOOLS_BY_NAME, catalogue, mcp_tools

VERSION = "0.9.0"
from ..calibration import publication as _calibration_publication  # noqa: E402
_calibration_publication.register_running_build(VERSION)     # a calibration record made against this label is a record of the build answering
MAX_BODY_BYTES = 512 * 1024
RATE_LIMIT_PER_MINUTE = int(os.environ.get("GRIDFORGE_RATE_LIMIT", "30"))
#: GET routes that cost almost nothing and are the first thing a health check, a directory or an agent reads: they are not charged to the main
#: limiter, but they are bounded by their own (a generous multiple of it), so they cannot be hammered for ever.
#: An IPv6 caller is also counted on its /48; that bucket allows this many times the per-/64 limit (GRIDFORGE_RATE_LIMIT_IPV6_48_MULTIPLE).
#: 32 is a placeholder, not derived from any measured subscriber population: >= 1 so a single /64 is always stopped by its own limit first (a
#: normal caller is never throttled by the /48), generous because a /48 may hold UNRELATED users (residential prefixes are often a /56 or a /60,
#: a carrier may pool subscribers in one /48), and far below the 65,536 fresh /64 allowances a /48 holder had before. A /32 holder still gets one
#: /48 allowance per /48 it spreads over.
IPV6_WIDE_MULTIPLE_DEFAULT = 32
#: The rate limiter's table of tracked buckets is bounded: expired entries are swept at most once a second once it passes the soft size, and past
#: the hard size the oldest-inserted entries are dropped (a flood of fresh identities forgets its own oldest ones first). Dropping a live entry
#: only forgets its count, which never refuses anyone.
RATE_TABLE_SOFT_KEYS = 10_000
RATE_TABLE_MAX_KEYS = 20_000
#: Solves that may run at once (GRIDFORGE_MAX_CONCURRENT_SOLVES; 0 = no cap). 16 is a placeholder, not a measured capacity.
MAX_CONCURRENT_SOLVES_DEFAULT = 16
#: Solves one KEYLESS caller identity may run at once (GRIDFORGE_MAX_CONCURRENT_SOLVES_PER_CALLER; 0 = off; keyed callers are not capped per
#: identity). A placeholder: one anonymous caller at the rate limit sending heavy requests could otherwise hold every global slot, and a heavy solve
#: takes seconds, so slots are held long enough to matter.
MAX_CONCURRENT_SOLVES_PER_CALLER_DEFAULT = 2
#: Keyless (public-tier) callers may hold at most this share of the global slots (floor, at least one); the rest is headroom for keyed callers.
PUBLIC_SOLVE_SHARE = 0.5
#: Seconds named in Retry-After when a request is shed. A hint to a well-behaved client, not a prediction.
SOLVE_RETRY_AFTER_SECONDS = 2
DISCOVERY_PATHS = frozenset({"/", "/health", "/v1/version", "/v1/tools"})
DISCOVERY_MIN_PER_MINUTE = 600
DISCOVERY_FACTOR = 10
#: The shortest an operator or signing secret may be. 24 characters is 96 bits at 4 bits each (hex), the least that `openssl rand -hex 12` gives.
MIN_SECRET_CHARS = 24
SECRET_ENV_NAMES = ("GRIDFORGE_ADMIN_KEY", "GRIDFORGE_KEY_SECRET")


# --- the seven-question qualifier -------------------------------------------
# Chosen because between them they decide the answer for almost every European
# hall: the supply ceiling, what is already drawn, whether a rack can be fed,
# whether the water is cold enough, and how many positions exist.
QUALIFY_FIELDS = {
    "contracted_MW": "grid.contracted_MW",
    "current_site_peak_MW": "grid.current_site_peak_MW",
    "current_it_load_MW": "grid.current_it_load_MW",
    "busway_ampacity_A": "lv.busway_ampacity_A",
    "tapoff_max_A": "lv.tapoff_max_A",
    "plant_supply_C": "thermal.plant.design_supply_C",
    "positions_available": "hall.positions_available",
}


#: The note the engine records beside a qualify figure the caller declared assumed. The caller cannot write its own: this is the only
#: text that reaches the loader for such a figure, so a declaration can only ever say what it is.
QUALIFY_ASSUMED_NOTE = "Declared assumed by the caller (for example a reference-template value). It is not this hall's figure."
#: The class a declaration can carry. It is the LOWEST class (an assumption); there is no way through this route to name any other, so a
#: declaration can lower what a figure is claimed to be and can never raise it.
QUALIFY_ASSUMED_CLASS = "E0"


def qualify_assumed_fields(body: dict) -> list[str]:
    """The seven qualify fields the caller declares ASSUMED (class E0) rather than supplied, in the order the qualifier asks them.

    `assumed_fields` is optional. When present it is a list of qualify field names (QUALIFY_FIELDS keys), each at most once, each one the
    request actually gives. Anything else is refused with a 422 that names the entry, so a typo can never quietly leave a template's number
    classed as customer data. Absent or null is the plain request, answered exactly as before."""
    raw = body.get("assumed_fields")
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise ApiError(422, f"assumed_fields must be a list of field names, not {type(raw).__name__}", allowed=list(QUALIFY_FIELDS))
    if len(raw) > len(QUALIFY_FIELDS):
        raise ApiError(422, f"assumed_fields lists {len(raw)} entries; there are only {len(QUALIFY_FIELDS)} qualify fields",
                       allowed=list(QUALIFY_FIELDS))
    seen: set[str] = set()
    for n, name in enumerate(raw):
        if not isinstance(name, str):
            raise ApiError(422, f"assumed_fields[{n}] must be a field name (text), not {type(name).__name__}", allowed=list(QUALIFY_FIELDS))
        if name not in QUALIFY_FIELDS:
            raise ApiError(422, f"assumed_fields[{n}] {name[:60]!r} is not a qualify field", allowed=list(QUALIFY_FIELDS))
        if name in seen:
            raise ApiError(422, f"assumed_fields[{n}] repeats {name}; name each field once")
        if body.get(name) is None:
            raise ApiError(422, f"assumed_fields[{n}] names {name}, which the request does not give: only a figure that is sent can be declared assumed")
        seen.add(name)
    return [k for k in QUALIFY_FIELDS if k in seen]


#: The note the engine records beside the connection capacity the qualifier derived itself (no `firm_capacity_MVA` was given).
QUALIFY_DERIVED_FIRM_NOTE = ("Derived by the qualifier as contracted_MW / 0.97 because no firm_capacity_MVA was given: it assumes the connection is sized at "
                             "its contract, which no connection agreement states. It is not this hall's figure.")
#: The intake path of that figure, in the loader's spelling.
QUALIFY_FIRM_PATH = "grid.firm_capacity_MVA"
#: The derived connection is the contract divided by this (the site power factor the qualifier assumes); it is the divisor the note above names.
QUALIFY_DERIVED_FIRM_DIVISOR = 0.97
#: Every figure the qualifier reads as a number, by the name the caller sends it under, to the intake path whose bounds apply to it.
QUALIFY_FIGURE_PATHS = {**QUALIFY_FIELDS, "firm_capacity_MVA": QUALIFY_FIRM_PATH}
#: The least the qualifier answers: this many of the seven QUALIFY_FIELDS figures sent (a figure sent as null is not sent). One rule, stated the
#: same way in the published schema (api/tools.py), the 422 and the answer's `figures_not_supplied`.
QUALIFY_MIN_FIGURES = 3


def _declared_assumed(value: float, note: str = QUALIFY_ASSUMED_NOTE) -> dict:
    """A figure in the intake loader's annotated form, declared E0. The loader reads class and note from here and nowhere else."""
    return {"value": value, "evidence": QUALIFY_ASSUMED_CLASS, "note": note}


def qualify_derives_firm(body: dict) -> bool:
    """True when the qualifier will invent the firm connection capacity itself: a contract was given and the connection's own figure was not."""
    return body.get("firm_capacity_MVA") is None and body.get("contracted_MW") is not None


def qualify_to_intake(body: dict) -> dict:
    """Expand the short web form into a sparse intake document.

    Everything not asked becomes a library default and a recorded gap, which is
    exactly the list the prospect is shown at the end. The form is short because
    the gap list is the product, not because the model is.

    A caller that started from a reference template says so with `assumed_fields` (see qualify_assumed_fields): each named figure goes
    to the loader as {value, evidence: "E0", note}, the loader's own annotated form, so it is classed an assumption (E0) in the result's
    basis and evidence and never as customer data (E5). The class is fixed here; the request cannot choose it."""
    assumed = set(qualify_assumed_fields(body))
    doc: dict = {"project": {"client": str(body.get("client") or "Website qualifier"),
                            "reference": str(body.get("reference") or "web")},
                 "site": {"name": str(body.get("site_name") or "Unnamed site"),
                          "metro": str(body.get("metro") or "—"),
                          "country": str(body.get("country") or "—")},
                 "hall": {"id": str(body.get("hall_id") or "HALL-1")},
                 "compute": {"platform": str(body.get("platform") or "gb300_nvl72")},
                 "scenarios": ["hybrid_dlc", "full_dlc", "full_dlc_btm"]}
    for key, path in QUALIFY_FIELDS.items():
        if body.get(key) is None:
            continue
        cur = doc
        parts = path.split(".")
        for p in parts[:-1]:
            cur = cur.setdefault(p, {})
        number = _qualify_number(key, body[key])
        cur[parts[-1]] = _declared_assumed(number) if key in assumed else number
    if body.get("firm_capacity_MVA") is not None:
        doc["grid"]["firm_capacity_MVA"] = _qualify_number("firm_capacity_MVA", body["firm_capacity_MVA"])
    elif doc.get("grid", {}).get("contracted_MW") is not None:
        # A connection is normally sized at or above the contracted figure; assume
        # parity rather than inventing headroom the site may not have.
        contracted = doc["grid"]["contracted_MW"]
        contracted_value = float(contracted["value"] if isinstance(contracted, dict) else contracted)      # a dict when declared assumed
        derived = contracted_value / QUALIFY_DERIVED_FIRM_DIVISOR
        ceiling = PLAUSIBLE_MAX.get(QUALIFY_FIRM_PATH)
        if ceiling is not None and derived > ceiling:
            # The contract is inside its own cap, but the connection derived from it is not: say what was derived and what to send, in the
            # caller's own field name (they never sent a firm capacity, and the loader would have named one).
            raise ApiError(422, f"contracted_MW={contracted_value:g} implies a firm capacity of {derived:.2f} MVA, above the {ceiling:g} MVA "
                                f"the engine accepts; send a smaller contracted_MW", field="contracted_MW",
                           derived_firm_capacity_MVA=round(derived, 2), limit_MVA=ceiling)
        # Derived from a figure the caller gave (or declared assumed), but not a figure the caller gave: it is labelled an assumption (E0) in
        # BOTH cases, so it never becomes customer data by arithmetic, and `handle_qualify` lists it as a required gap. Declaring the contract
        # assumed changes the class labels of what the caller declared and nothing else.
        doc["grid"]["firm_capacity_MVA"] = _declared_assumed(derived, QUALIFY_DERIVED_FIRM_NOTE)
    return doc


#: What this engine does beyond what its route list says (served in GET /v1/version `capabilities`). A key is True only when the code
#: path exists AND tests/test_qualify_assumed.py proves it; remove the key rather than leave a claim the code no longer keeps.
CAPABILITIES: dict[str, bool] = {
    # POST /v1/qualify accepts `assumed_fields`: a figure so named is classed E0 (assumed) in the result, never E5.
    "qualify_assumed_fields": True,
}


def _qualify_number(name: str, raw) -> float:
    """A figure on the free route is a JSON number, checked here BY THE NAME THE CALLER SENT IT UNDER before anything is derived from it.
    float() would also accept `true` (as 1), the text "12" and digits from other scripts, so a form that sent the wrong type was answered as if
    it had sent a figure. The bounds are the intake loader's own (PLAUSIBLE_MAX, imported, not retyped): a figure the loader would refuse
    is refused here, naming the field the caller sent, never the intake path it would have become (`grid.firm_capacity_MVA`, which they did not send)."""
    if isinstance(raw, bool) or not isinstance(raw, (int, float)):
        raise ApiError(422, f"{name} must be a number, not {type(raw).__name__}")
    try:
        num = float(raw)
    except OverflowError:          # an integer of several hundred digits parses as a JSON number and does not fit a float
        raise ApiError(422, f"{name} is too large to be a number this tool can model") from None
    if not math.isfinite(num):
        raise ApiError(422, f"{name} must be a finite number, not {raw!r}")
    path = QUALIFY_FIGURE_PATHS.get(name)
    spec = _INTAKE_FIELD_BY_PATH.get(path) if path else None
    unit = spec.unit if spec is not None else ""
    shown = f"{num:g}" + (f" {unit}" if unit else "")
    if name == "positions_available":
        if num != int(num) or num < 0:
            raise ApiError(422, f"{name} is {raw!r}; it must be a whole number, zero or more")
    elif num < 0 and unit != "degC":
        raise ApiError(422, f"{name} is {shown}; it cannot be negative")
    # The loader's floors (a chilled-water supply below -5 degC, a temperature below absolute zero), applied by the caller's own name: the loader's
    # refusal would name `thermal.plant.design_supply_C`, an intake path the caller never sent, and carry no `field`.
    floor, floor_hint = plausible_floor(path, unit) if path else (None, "")
    if floor is not None and num < floor:
        raise ApiError(422, f"{name} is {shown}, below {floor:g}{(' ' + unit) if unit else ''}, the lowest this tool will model for one hall. "
                            + (floor_hint or "Check the unit and the sign."), field=name, limit=floor)
    ceiling = PLAUSIBLE_MAX.get(path) if path else None
    if ceiling is not None and num > ceiling:
        raise ApiError(422, f"{name} is {shown}, above {ceiling:g}{(' ' + unit) if unit else ''}, the most this tool will model for one hall. "
                            f"Check the unit and for a stray digit.", field=name, limit=ceiling)
    return num


class ApiError(Exception):
    def __init__(self, status: int, message: str, **extra):
        super().__init__(message)
        self.status = status
        self.message = message
        self.extra = extra


def _whole_number(body: dict, key: str, default: int | None, lo: int, hi: int) -> int | None:
    """A whole number the caller sent under `key`, or `default` when it is absent or null. A value that is not a whole number in [lo, hi] is
    refused BY NAME (422) rather than escaping as the raw `ValueError: invalid literal for int()` text; a numeric string that is a whole number
    is still accepted, as it always was, and a boolean is not a number here."""
    raw = body.get(key)
    if raw is None or raw == "":
        return default
    if isinstance(raw, bool):
        raise ApiError(422, f"{key} must be a whole number from {lo} to {hi}, not a boolean", field=key)
    try:
        n = int(float(raw)) if isinstance(raw, str) and raw.strip().lstrip("+-").replace(".", "", 1).isdigit() and float(raw) == int(float(raw)) else int(raw)
    except (TypeError, ValueError, OverflowError):
        raise ApiError(422, f"{key} must be a whole number from {lo} to {hi}", field=key)
    if isinstance(raw, float) and raw != n:
        raise ApiError(422, f"{key} must be a whole number from {lo} to {hi}", field=key)
    if not lo <= n <= hi:
        raise ApiError(422, f"{key} must be a whole number from {lo} to {hi}", field=key, minimum=lo, maximum=hi)
    return n


API_SCHEMA = "gridforge/api/1"


class _IdempotencyCache:
    """Remembers the answer to a keyed request, so a client that retries after a timeout is neither
    billed twice nor handed a different answer. Bounded in memory by TOTAL BYTES as well as entry count
    (a study bundle is ~0.24 MB, so a count bound alone let 2000 of them eat a 512 MB machine). It keeps
    the serialised JSON, not the object graph, which is several times smaller. It is a cache, not the
    record: the ledger remembers that a key was charged (24h, across restarts), so a response evicted or
    too large to cache is recomputed deterministically and replayed without a second charge."""
    TTL = 24 * 3600
    MAX = 2000
    MAX_BYTES = int(os.environ.get("GRIDFORGE_IDEMPOTENCY_MAX_BYTES", "") or 0) or 32 * 1024 * 1024

    def __init__(self):
        self._items: dict[tuple, tuple[float, str, int, str]] = {}
        self._bytes = 0
        self._lock = threading.Lock()

    @property
    def total_bytes(self) -> int:
        return self._bytes

    def _drop(self, key: tuple) -> None:
        old = self._items.pop(key, None)
        if old is not None:
            self._bytes -= len(old[3])

    def get(self, key: tuple):
        now = time.time()
        with self._lock:
            hit = self._items.get(key)
            if hit and now - hit[0] <= self.TTL:
                return (hit[0], hit[1], hit[2], json.loads(hit[3]))
            self._drop(key)
            return None

    def put(self, key: tuple, body_hash: str, status: int, payload: dict) -> None:
        try:
            text = json.dumps(payload)
        except (TypeError, ValueError):
            return
        size = len(text)
        if size > self.MAX_BYTES // 4:        # one answer must not be able to evict everyone else's
            return
        with self._lock:
            self._drop(key)
            while self._items and (len(self._items) >= self.MAX or self._bytes + size > self.MAX_BYTES):
                oldest = min(self._items, key=lambda k: self._items[k][0])
                self._drop(oldest)
            self._items[key] = (time.time(), body_hash, status, text)
            self._bytes += size


IDEMPOTENCY = _IdempotencyCache()


def _reject_constant(name: str):
    """json.loads accepts NaN/Infinity, which are not JSON and poison every comparison downstream."""
    raise ValueError(f"{name} is not a valid JSON number")


#: The duplicate-key refusal is shared with the command line's file loader (one helper, so a document means the same wherever it is read).
from ..intake.strict_json import refuse_duplicate_keys as _refuse_duplicate_keys  # noqa: E402


def _env_int(name: str, default: int, minimum: int = 0) -> int:
    """A whole-number environment setting, or `default` when it is unset, empty or not a whole number; never below `minimum`."""
    raw = os.environ.get(name)
    if raw in (None, ""):
        return default
    try:
        return max(minimum, int(str(raw).strip()))
    except ValueError:
        return default


def _env_cap(name: str, default: int) -> int:
    """A concurrency setting: a whole number, 0 meaning "no cap". Unset, empty, unreadable or NEGATIVE is the default, never "off": a typo must not
    switch a protection off."""
    raw = os.environ.get(name)
    if raw in (None, ""):
        return default
    try:
        v = int(str(raw).strip())
    except ValueError:
        return default
    return v if v >= 0 else default


class _RateLimiter:
    """Sliding one-minute counts per caller bucket. An IPv6 caller is charged on two buckets at once, its /64 (`per_minute`) and its enclosing
    /48 (`per_minute` x `wide_multiple`): it is limited by BOTH, and a refused request is charged to neither. The table of buckets is bounded
    (RATE_TABLE_SOFT_KEYS / RATE_TABLE_MAX_KEYS)."""

    def __init__(self, per_minute: int, wide_multiple: int | None = None):
        self.per_minute = per_minute
        self.wide_multiple = max(1, _env_int("GRIDFORGE_RATE_LIMIT_IPV6_48_MULTIPLE", IPV6_WIDE_MULTIPLE_DEFAULT)
                                 if wide_multiple is None else wide_multiple)
        self._hits: dict[str, deque] = defaultdict(deque)
        self._lock = threading.Lock()
        self._swept = 0.0
        self.sweeps = 0

    @property
    def wide_limit(self) -> int:
        return self.per_minute * self.wide_multiple

    def _window(self, key: str, now: float) -> deque:
        q = self._hits[key]
        while q and now - q[0] > 60:
            q.popleft()
        return q

    def _bound_table(self, now: float) -> None:
        """Keep the table small without scanning it on every request (lock held). Expired entries go at most once a second; past the hard size
        the oldest-inserted go until it is 10% under it, so the next scan is a long way off."""
        n = len(self._hits)
        if n > RATE_TABLE_SOFT_KEYS and now - self._swept >= 1.0:
            self._swept = now
            self.sweeps += 1
            for k in [k for k, d in self._hits.items() if not d or now - d[-1] > 60]:
                del self._hits[k]
        if len(self._hits) > RATE_TABLE_MAX_KEYS:
            drop = len(self._hits) - int(RATE_TABLE_MAX_KEYS * 0.9)
            for k in list(self._hits)[:drop]:
                del self._hits[k]

    def allow(self, key: str, wide: str = "") -> bool:
        if self.per_minute <= 0:
            return True
        now = time.time()
        with self._lock:
            self._bound_table(now)
            q = self._window(key, now)
            wq = self._window(wide, now) if wide else None
            if len(q) >= self.per_minute or (wq is not None and len(wq) >= self.wide_limit):
                return False
            q.append(now)
            if wq is not None:
                wq.append(now)
            return True


class _SolveGate:
    """Bounds how many solves run at the same instant, and never waits: a request that would exceed a bound is refused at once (the caller
    answers 503 + Retry-After), so load is shed, not queued. Three bounds, all counted under one lock:
      * `limit`       solves in all (0 = no cap);
      * `public_limit` of those may be held by keyless callers (default half, at least one), so keyed callers always have headroom;
      * `per_caller`  solves one KEYLESS caller identity may hold (0 = off), so one anonymous identity cannot take every slot. Keyed callers are
                      not capped per identity: the website's own qualifier and an API customer's backend call from a few addresses with
                      many requests in flight, and a key is accountable (metered, revocable) where an anonymous address is not.
    It bounds HOW MANY solves run, not how long one takes: there is no wall-clock limit on a solve."""

    def __init__(self, limit: int, per_caller: int = 0, public_limit: int | None = None):
        self.limit = limit
        self.per_caller = per_caller
        self.public_limit = ((max(1, int(limit * PUBLIC_SOLVE_SHARE)) if limit > 0 else 0) if public_limit is None else public_limit)
        self._lock = threading.Lock()
        self._active = 0
        self._public = 0
        self._callers: dict[str, int] = {}

    def _refused(self, caller: str, public: bool) -> bool:
        if self.limit > 0 and self._active >= self.limit:
            return True
        if public and self.limit > 0 and self._public >= self.public_limit:
            return True
        return bool(public and caller and self.per_caller > 0 and self._callers.get(caller, 0) >= self.per_caller)

    def enter(self, caller: str = "", public: bool = False) -> bool:
        with self._lock:
            if self._refused(caller, public):
                return False
            self._active += 1
            self._public += 1 if public else 0
            if public and caller:
                self._callers[caller] = self._callers.get(caller, 0) + 1
            return True

    def leave(self, caller: str = "", public: bool = False) -> None:
        with self._lock:
            if self._active <= 0 or (public and self._public <= 0) or (public and caller and self._callers.get(caller, 0) <= 0):
                raise ValueError("leave without a matching enter")
            self._active -= 1
            self._public -= 1 if public else 0
            if public and caller:
                left = self._callers[caller] - 1
                if left:
                    self._callers[caller] = left
                else:
                    del self._callers[caller]

    def full(self, caller: str = "", public: bool = False) -> bool:
        """Would `enter` be refused right now? A read of the counters: nothing is taken, so it cannot hide a free slot from a concurrent enter."""
        with self._lock:
            return self._refused(caller, public)


#: Every route that runs the model. /v1/estimate (arithmetic on a table) and /v1/revoke (a file write) do not, and an MCP call is gated by the
#: endpoint its tool maps to, in `_invoke`, so initialize / tools/list are never refused.
SOLVING_ROUTES = frozenset({"/v1/qualify", "/v1/screen", "/v1/compare", "/v1/study", "/v1/portfolio", "/v1/proposal", "/v1/deck", "/v1/diff",
                            "/v1/spec", "/v1/bids", "/v1/power/assess", "/v1/power/deploy/assess", "/v1/power/deploy/spec",
                            "/v1/power/deploy/bids"})
SOLVE_GATE = _SolveGate(_env_cap("GRIDFORGE_MAX_CONCURRENT_SOLVES", MAX_CONCURRENT_SOLVES_DEFAULT),
                        _env_cap("GRIDFORGE_MAX_CONCURRENT_SOLVES_PER_CALLER", MAX_CONCURRENT_SOLVES_PER_CALLER_DEFAULT))


def _busy_payload() -> dict:
    """The body of a shed request. It says the engine is busy and to retry, and nothing about how many slots there are or which bound was met."""
    return {"error": "the engine is busy; nothing was run and nothing was charged",
            "retryable": True, "retry_after_seconds": SOLVE_RETRY_AFTER_SECONDS,
            "fix": "retry after the Retry-After interval. The request was refused, not queued"}


def _bucket(addr: str) -> str:
    """The identity a rate limit is counted on for an address, or "" when it is not an address. IPv6 is counted per /64 (the smallest block one
    subscriber is handed: a host holding one can mint 2^64 addresses and would otherwise get a fresh allowance for each); an IPv4-mapped IPv6
    address is the IPv4 address it wraps. Text that is not an IP (a name a client made up) is never an identity."""
    try:
        ip = ipaddress.ip_address((addr or "").strip().split("%", 1)[0])
    except ValueError:
        return ""
    if isinstance(ip, ipaddress.IPv6Address):
        if ip.ipv4_mapped is not None:
            return str(ip.ipv4_mapped)
        return str(ipaddress.ip_network(f"{ip}/64", strict=False))
    return str(ip)


def _bucket_wide(addr: str) -> str:
    """The coarser identity an IPv6 address is ALSO counted on: its /48 (a site allocation: 65,536 /64s). "" for IPv4, an IPv4-mapped address
    and text that is not an address: those have one bucket only. Without it a holder of a /48 or a /32 minted a fresh /64 allowance per request."""
    try:
        ip = ipaddress.ip_address((addr or "").strip().split("%", 1)[0])
    except ValueError:
        return ""
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is None:
        return str(ipaddress.ip_network(f"{ip}/48", strict=False))
    return ""


def weak_secrets(env=None) -> list[str]:
    """The operator and signing secrets that are set but shorter than MIN_SECRET_CHARS, as messages that name the variable and the length
    (never the value). Unset is not weak: it means the surface does not exist."""
    env = os.environ if env is None else env
    out = []
    for name in SECRET_ENV_NAMES:
        val = (env.get(name) or "").strip()
        if val and len(val) < MIN_SECRET_CHARS:
            out.append(f"{name} is {len(val)} characters; it should be at least {MIN_SECRET_CHARS}. Generate one with `openssl rand -hex 32`.")
    return out


def check_secret_strength(env=None, enforce: bool | None = None) -> tuple[list[str], bool]:
    """(messages, refuse): the weak secrets in ``env`` and whether startup must be refused because of them. Pure: it reads only its arguments.

    ``enforce`` None reads GRIDFORGE_ENFORCE_SECRET_STRENGTH from ``env`` (refuse only when it is "1"). Default is to warn and continue: an outage
    caused by a secret that has worked for months is a worse failure than a short secret that is reported on every start."""
    env = os.environ if env is None else env
    if enforce is None:
        enforce = (env.get("GRIDFORGE_ENFORCE_SECRET_STRENGTH") or "").strip() == "1"
    msgs = weak_secrets(env)
    return msgs, bool(msgs) and bool(enforce)


def _api_keys() -> set[str]:
    """Parsed through the meter, so `sk_x`, `sk_x:acme` and `sk_x:acme:5000` all
    authenticate on `sk_x`. Plain keys configured before metering existed keep
    working unchanged, which is the only acceptable way to add billing to a
    running deployment."""
    return set(key_plans())


def _auth_configured() -> bool:
    """Either an operator has pasted keys in, or the deployment can verify signed
    ones. Both count: a self-serve deployment issues every key from the website and
    may hold none of them in its own environment."""
    return bool(key_plans()) or bool(os.environ.get("GRIDFORGE_KEY_SECRET"))


# Browser origins allowed to call the whole API when GRIDFORGE_ALLOWED_ORIGINS is unset: the site itself.
DEFAULT_ALLOWED_ORIGINS = ("https://timetopower.ai", "https://www.timetopower.ai")

# The free, keyless routes. A browser on ANY origin may read these (CORS "*"): they take no credential, set no cookie
# and cost compute only (per-IP rate limited). Non-browser clients (MCP, curl, the site's own server-side calls) are not
# subject to CORS at all. Everything else (keyed, metered, operator) is answered cross-origin only to
# GRIDFORGE_ALLOWED_ORIGINS. Set GRIDFORGE_PUBLIC_CORS=0 to close even these.
PUBLIC_CORS_PATHS = frozenset({"/health", "/v1/version", "/v1/qualify", "/v1/estimate"})


def _allowed_origins() -> list[str]:
    """Origins allowed on the credentialed API. Unset -> the site. A comma-separated override is for preview hosts
    (e.g. https://my-branch.vercel.app); "*" is still honoured if an operator writes it, but is no longer the default.
    Credentials here are headers (X-API-Key / Authorization), never cookies, so CORS is not what protects a key: it
    only decides which pages may read responses in a visitor's browser."""
    raw = os.environ.get("GRIDFORGE_ALLOWED_ORIGINS")
    if raw is None or not raw.strip():
        return list(DEFAULT_ALLOWED_ORIGINS)
    return [o.strip() for o in raw.split(",") if o.strip()]


def _public_cors_enabled() -> bool:
    return os.environ.get("GRIDFORGE_PUBLIC_CORS", "1").strip() != "0"


def _run(doc: dict):
    if not isinstance(doc, dict):
        raise ApiError(422, "expected an intake document (a JSON object)")
    intake = load_document(doc)
    if not intake.report.supplied:
        # Every number would be a library default: a study of a hall nobody described. The free
        # /v1/qualify route is the place to start from a handful of figures. The keys the engine did not read are named: they are what the caller sent.
        unread = ignored_top_level_keys(doc)
        named = (f" The key{'s' if len(unread) > 1 else ''} you sent ({', '.join(repr(k[:40]) for k in unread[:6])}) "
                 f"{'are' if len(unread) > 1 else 'is'} not read by this route: figures like these go to POST /v1/qualify, and an intake document "
                 f"carries them under its sections (grid, hall, ups, ...)." if unread else "")
        raise ApiError(422, "the request contains none of the intake fields, so there is nothing to "
                            "solve. Send an intake document (see GET /v1/tools for the schema) or use "
                            "/v1/qualify." + named, missing_required=[g.path for g in intake.report.required_gaps])
    return intake, run_all(intake.context, intake.scenarios)


def _objective(body: dict) -> Objective:
    name = str(body.get("objective") or "max_compute")
    try:
        return Objective(name)
    except ValueError:
        raise ApiError(422, f"unknown objective {name!r}",
                       allowed=[o.value for o in Objective])


# --- handlers ----------------------------------------------------------------
def handle_qualify(body: dict, tier: Tier) -> dict:
    """Free qualifier. Optional `assumed_fields` (a list of the seven QUALIFY_FIELDS names) declares figures ASSUMED: they are classed E0 in the
    result and listed in `inputs_declared_assumed`, `intake.assumed_count` says how many; completeness still counts them as supplied. A request
    without it is answered exactly as before.

    The qualifier derives the firm connection capacity (contracted_MW / 0.97, class E0) when a contract is given and `firm_capacity_MVA` is not: that
    figure is not the caller's, so it is a REQUIRED gap row (`grid.firm_capacity_MVA`; `required_inputs_missing` and `completeness` count it) and is
    listed under `inputs_derived_assumed`, never under `inputs_declared_assumed`, which holds exactly what the caller declared. Free and keyless as ever."""
    missing = [k for k in QUALIFY_FIELDS if body.get(k) is None]
    sent = len(QUALIFY_FIELDS) - len(missing)
    if sent < QUALIFY_MIN_FIGURES:
        nulls = [k for k in missing if k in body]
        raise ApiError(422, f"too little to say anything useful: send at least {QUALIFY_MIN_FIGURES} of the {len(QUALIFY_FIELDS)} qualify figures "
                            f"({', '.join(QUALIFY_FIELDS)}); this request has {sent}"
                            + (f" (a figure sent as null is not sent: {', '.join(nulls)})" if nulls else ""),
                       required_at_least=list(QUALIFY_FIELDS), minimum_figures=QUALIFY_MIN_FIGURES, figures_sent=sent, missing=missing)
    intake, results = _run(qualify_to_intake(body))
    derived = qualify_derives_firm(body)
    if derived:
        _record_derived_firm(intake)
    return qualify_payload(intake, results, _objective(body), declared_assumed=[QUALIFY_FIELDS[k] for k in qualify_assumed_fields(body)],
                           derived_assumed=[QUALIFY_FIRM_PATH] if derived else None, not_supplied=_qualify_not_supplied(body, intake))


def _qualify_not_supplied(body: dict, intake) -> list[dict]:
    """The qualify figures this request did not give, each as the assumption it became. A figure left out and a figure sent as an explicit
    null are the same thing (not supplied: the library default is used and named in `intake.gaps`), and the answer says which it was, so a
    null is never read as a value and never accepted without a word."""
    by_path = {g.path: g for g in intake.report.gaps}
    rows = []
    for name, path in QUALIFY_FIELDS.items():
        if body.get(name) is not None:
            continue
        gap = by_path.get(path)
        rows.append({"field": name, "path": path, "sent": "null" if name in body else "absent",
                     "assumed": gap.fallback_description if gap is not None else None})
    return rows


def _record_derived_firm(intake) -> None:
    """The firm connection capacity the qualifier derived from the contract is NOT a supplied figure: it moves from `supplied` to a required gap row,
    so `required_inputs_missing`, `completeness` and the data request all count it, whether or not the caller declared the contract assumed. The number
    the solver used is unchanged (this runs after the solve and touches the report only)."""
    from ..intake.schema import FIELD_BY_PATH, DataGap
    spec = FIELD_BY_PATH[QUALIFY_FIRM_PATH]
    rep = intake.report
    rep.supplied[:] = [p for p in rep.supplied if p != QUALIFY_FIRM_PATH]
    used = intake.context.power.grid.firm_capacity_MVA.value
    row = DataGap(path=QUALIFY_FIRM_PATH, label=spec.label, unit=spec.unit, required=spec.required,
                  fallback_description=(f"{used:.2f} MVA, derived as contracted_MW / 0.97 (E0): nobody gave the connection's firm capacity, and a "
                                        f"connection is not necessarily sized at its contract"),
                  why_it_binds=spec.why_it_binds, how_to_get_it=spec.how_to_get_it)
    after = {"grid.power_factor", "grid.contracted_MW", "grid.current_site_peak_MW", "grid.current_it_load_MW"}     # keep the loader's reading order
    at = next((i for i, g in enumerate(rep.gaps) if g.path in after), len(rep.gaps))
    rep.gaps.insert(at, row)


def _rendered(report, results, fmt: str) -> dict:
    """Render a deliverable and run the report gates over it before it leaves the
    building. A document that fails a gate is never returned - the point of the
    gates is that they stand between a modelled number and a customer."""
    md = to_markdown(report)
    run_all_gates(report, md, claims=collect_claims(results), mode=ReportMode.SCREENING)
    if fmt == "md":
        return {"format": "md", "title": report.title, "document": md}
    return {"format": "html", "title": report.title,
            "document": to_html(report, full_document=False),
            "document_full": to_html(report, full_document=True)}


def _queue_region(body: dict) -> str | None:
    """The optional `grid_queue_region`: one of the regions the measured queue statistic is available for, or absent for the pooled
    US figure. Refused before any solving, with the allowed names."""
    from ..context import grid_queue
    region = body.get("grid_queue_region")
    if region is None:
        return None
    if not isinstance(region, str) or region not in grid_queue.regions():
        raise ApiError(422, "grid_queue_region must be one of the regions below, or omitted for the pooled US statistic",
                       allowed=list(grid_queue.regions()))
    return region


def _price_state(body: dict) -> str | None:
    """The optional `electricity_price_state`: a US state (or DC) as EIA spells it, or absent for the US average. Refused before solving."""
    from ..context import energy_price
    state = body.get("electricity_price_state")
    if state is None:
        return None
    if not isinstance(state, str) or state not in energy_price.states():
        raise ApiError(422, "electricity_price_state must be one of the states below, or omitted for the US average",
                       allowed=list(energy_price.states()))
    return state


def _retail_price_context(intake, state: str | None) -> dict:
    return retail_price_context_for(intake, state=state)


def _site_country(doc) -> object:
    site = doc.get("site") if isinstance(doc, dict) else None
    return site.get("country") if isinstance(site, dict) else None


def handle_screen(body: dict, tier: Tier) -> dict:
    from ..context import grid_queue
    # `grid_queue_region` is read only when the intake is nested: a body that IS the intake carries intake fields, not request options.
    region = _queue_region(body) if "intake" in body else None
    price_state = _price_state(body) if "intake" in body else None
    doc = body.get("intake") or body
    intake, results = _run(doc)
    fmt = str(body.get("format") or "json").lower()
    objective = _objective(body)
    payload = screen_payload(intake, results, objective, tier=tier)
    # Context only: the measured queue statistic beside the assumed grid wait (client tier, which is where the assumption is carried).
    paid = tier is not Tier.PUBLIC       # schedule figures are paid content: the free tier carries none (tiers.PUBLIC_REDACTED_KEYS)
    if fmt in ("html", "md"):
        queue = grid_queue_context_for(results, objective, country=_site_country(doc), region=region) if paid else None
        report = build_screen_report(intake, results, objective=objective, grid_queue=queue,
                                     retail_price=_retail_price_context(intake, price_state) if paid else None)
        return _rendered(report, results, fmt)
    if paid:
        payload["grid_queue_context"] = grid_queue.context(
            region=region, country=_site_country(doc),
            assumed=grid_queue.assumption_from_scenarios(payload.get("scenarios"), prefer=payload.get("recommended")))
        payload["retail_price_context"] = _retail_price_context(intake, price_state)
    return redact(payload, tier)


def handle_compare(body: dict, tier: Tier) -> dict:
    """Time-to-Power scenario comparison over the scenarios an intake defines. One solve (``_run``), no second model:
    the numbers are the ones /v1/screen reports, laid side by side with only the dates the lead times support."""
    from ..power.plausibility import defaulted_date_findings, plausibility_findings
    from .compare_payload import CompareError, compare_payload, select
    doc = body.get("intake")
    if not isinstance(doc, dict):
        raise ApiError(422, 'expected {"intake": {...}, "scenarios": [...], "objective": "..."}')
    ids = body.get("scenarios")
    if ids is not None and (not isinstance(ids, list) or not all(isinstance(i, str) for i in ids)):
        raise ApiError(422, "scenarios must be a list of scenario ids")
    if ids is not None and len(ids) == 0:
        raise ApiError(422, "scenarios is an empty list: name at least two, or omit it to compare all")
    baseline = body.get("baseline")
    if baseline is not None and not isinstance(baseline, str):
        raise ApiError(422, "baseline must be a scenario id")
    objective = _objective(body)
    region = _queue_region(body)
    price_state = _price_state(body)
    intake, results = _run(doc)
    try:
        if ids and "full_dlc_btm" in ids and not intake.context.power.options:
            raise CompareError("full_dlc_btm compares behind-the-meter supply, and this intake declares none",
                               hint="declare btm_options (kind, capacity_MW, lead_time_weeks, capex_eur_per_kW)")
        chosen = select(results, ids)
        if not ids and "full_dlc_btm" in [r.spec.id for r in chosen] and not intake.context.power.options:
            chosen = [r for r in chosen if r.spec.id != "full_dlc_btm"]
            notes = ["full_dlc_btm is not compared: the intake declares no behind-the-meter options."]
        else:
            notes = []
        # /v1/screen reports these findings as warnings; a comparison built on inputs that disagree with each other (a unit slip
        # between MW, MVA and kW) must say so too, not rank scenarios as if the inputs were sound.
        # A comparison of halls whose transformer or UPS schedule is missing leaves those constraints unevaluated (not limiting), which
        # overstates every scenario's racks. The intake already says so; the comparison must too, not rank as if the inputs were complete.
        intake_warnings = list(dict.fromkeys(intake.report.warnings))
        notes = [*notes, *intake_warnings, *plausibility_findings(intake.context), *defaulted_date_findings(intake)]
        out = compare_payload(doc, chosen, objective=objective, baseline=baseline, notes=notes)
    except CompareError as exc:
        raise ApiError(422, str(exc), **{k: v for k, v in exc.detail.items() if v is not None})
    out["project"] = intake.project
    out["intake_completeness"] = round(intake.report.completeness, 3)
    out["calibration"] = calibration_block(chosen)       # how far this engine has been checked against real sites, including that it has not been
    # Grid reinforcement is deliberately not dated above. Set the MEASURED queue history beside that refusal: context only.
    if tier is not Tier.PUBLIC:
        from ..context import grid_queue
        out["grid_queue_context"] = grid_queue.context(region=region, country=_site_country(doc))
        out["caveats"].append("Context only: grid_queue_context shows how long US generation interconnection requests that reached "
                              "operation took. It is not a connection time for this site and changes no date here.")
        out["retail_price_context"] = _retail_price_context(intake, price_state)
        out["caveats"].append("Context only: retail_price_context shows what US customers in this sector paid on average in one month. It is "
                              "not this site's tariff and changes no cost here.")
    out["provenance"] = provenance(VERSION)
    return out


def handle_study(body: dict, tier: Tier) -> dict:
    region = _queue_region(body) if "intake" in body else None
    price_state = _price_state(body) if "intake" in body else None
    doc = body.get("intake") or body
    intake, results = _run(doc)
    fmt = str(body.get("format") or "json").lower()
    bundle = str(body.get("bundle") or "").lower()
    if bundle and bundle != "board":
        raise ApiError(422, f"unknown bundle {bundle!r}", allowed=["board"])
    if bundle and fmt not in ("html", "md"):
        raise ApiError(422, "bundle=board needs format html or md", allowed=["html", "md"])
    if bundle and str(body.get("view") or "").lower() == "board":
        raise ApiError(422, "bundle=board and view=board cannot be combined")
    if fmt == "csv":
        return {"format": "csv", "files": csv_bundle(intake, results), "calibration": calibration_block(results)}
    if fmt in ("html", "md"):
        objective = _objective(body)
        from ..reporting.study import _pick_recommended
        from ..scenario import sensitivity
        rec = _pick_recommended(results, objective)
        sens = sensitivity(rec, SENSITIVITY_KNOBS)
        if str(body.get("view") or "").lower() == "board":
            # the one-page summary a sponsor forwards (docs/01 §4D): same model, labels and gates as the study
            from ..reporting.board import build as build_board_report
            return _rendered(build_board_report(intake, results, sens, objective=objective), results, fmt)
        report = build_study_report(intake.context, results, sens,
                                    client=intake.client, objective=objective,
                                    watermark=watermark_for(intake), sourced=intake.report.sourced,
                                    grid_queue=(grid_queue_context_for(results, objective, country=_site_country(doc), region=region)
                                                if tier is not Tier.PUBLIC else None),
                                    retail_price=_retail_price_context(intake, price_state) if tier is not Tier.PUBLIC else None,
                                    date_record=(_date_record(rec.ladder, document=intake.document)
                                                 if tier is not Tier.PUBLIC else None))
        out = _rendered(report, results, fmt)
        out["calibration"] = calibration_block(results)
        if bundle:
            # The paid Envelope Study pack: the long study and the one-page board summary from ONE solve, so the
            # two cannot disagree about the model, the objective, the evidence classes or the watermark. Each
            # passes the report gates; if either fails nothing is returned, never half a pack.
            from ..reporting.board import build as build_board_report
            board_report = build_board_report(intake, results, sens, objective=objective)
            out["board"] = _rendered(board_report, results, fmt)
            # Both formats of both documents ride in this one response, so the caller never re-solves for the
            # other format. `bundle` is the engine's own statement of what it produced.
            out["document_md"] = out["document"] if fmt == "md" else _rendered(report, results, "md")["document"]
            out["board"]["document_md"] = (out["board"]["document"] if fmt == "md"
                                           else _rendered(board_report, results, "md")["document"])
            out["bundle"] = {"kind": "board", "solves": 1,
                             "artifacts": ["study", "board_summary"],
                             "formats": ["html", "md"]}
        return out
    pack = model_pack(intake, results)
    pack["calibration"] = calibration_block(results)
    return pack


def _headline_with_residual(d) -> str:
    """The change note's headline, and the part of the rack movement no single input explains, in the same sentence. The probes move one input at a
    time; when the inputs interact they explain only part of the movement (10 of +25), and a headline that said +25 racks beside a driver list
    that adds to 10 left the reader to find the rest in `unexplained_racks`. change.py's own headline is unchanged: this adds a sentence to the
    API's answer, and only when probes ran and left something over."""
    head = d.headline()
    if d.drivers and d.racks_delta and d.residual:
        also = ", or were not probed" if (d.unprobed or d.unprobeable) else ""
        head = (f"{head.rstrip()} The single-input probes explain {d.explained:+d} of the {d.racks_delta:+d} racks; the other {d.residual:+d} "
                f"are not explained by any one input (the inputs interact{also}).")
    return head


def _state_drivers_note(d) -> str | None:
    """Why a diff against a recorded state names no driver. A state keeps fingerprints of the earlier inputs, not the inputs, so a changed input
    cannot be located from it; the caller who needs the driver sends `before`. None when the inputs are verifiably unchanged (nothing to name:
    what moved is ours, in `model_drift`)."""
    if d.inputs == "unchanged":
        return None
    if d.inputs == "changed":
        note = "the earlier inputs were not stored, so the driver cannot be named; send `before` to get it"
        if d.evidence_digest_changed:
            note += " (the declared evidence classes also differ from the earlier record, which kept only a fingerprint of them)"
        return note
    return ("the earlier record carries no fingerprint of its inputs, so whether they moved cannot be told and no driver can be named; "
            "send `before` to get it")


def handle_diff(body: dict, tier: Tier) -> dict:
    after = body.get("after") or body.get("intake")
    if not isinstance(after, dict):
        raise ApiError(422, 'expected {"before": {...}, "after": {...}} or '
                            '{"previous_state": {...}, "after": {...}}')
    objective = _objective(body)
    prev = body.get("previous_state")
    from_state = isinstance(prev, dict)
    if from_state:
        try:
            state = EnvelopeState.from_record(prev)
        except StateError as exc:
            raise ApiError(422, f"previous_state is not a recorded envelope state: {exc}")
        d = diff_from_state(state, after, objective=objective, recorded=set(prev))
    else:
        before = body.get("before")
        if not isinstance(before, dict):
            raise ApiError(422, 'a diff needs either "before" or "previous_state"')
        d = envelope_diff(before, after, objective=objective,
                          attribute=bool(body.get("attribute", True)))

    payload = {
        "headline": _headline_with_residual(d),
        "material": d.material,
        "material_reasons": d.material_reasons,
        "not_compared": d.not_compared,
        "before": d.before.as_record(),
        "after": d.after.as_record(),
        "racks_delta": d.racks_delta,
        "weeks_delta": d.weeks_delta,
        **d.date_basis(),
        "capex_delta_eur": d.capex_delta,
        "binding_moved": d.binding_moved,
        "changed_inputs": d.changed_paths,
        # Additive. `changed_inputs` and `drivers` are empty when the earlier inputs were never stored (a recorded state keeps fingerprints of them, not
        # the inputs): that is "cannot be named", not "nothing moved", and `inputs` / `changed_inputs_known` / `drivers_note` say which. With `before`
        # the paths are compared and named; `evidence_changed_inputs` names the inputs whose declared evidence class moved (what `before` can see).
        "changed_inputs_known": not (from_state and d.inputs != "unchanged"),
        "evidence_changed_inputs": list(d.evidence_changes),
        "drivers_note": _state_drivers_note(d) if from_state else None,
        "drivers": [dr.__dict__ for dr in d.drivers],
        "explained_racks": d.explained,
        "unexplained_racks": d.residual,
        "inputs": d.inputs,
        "model_drift": d.drift,
        "model_drift_known": d.drift_known,
        "unprobed_inputs": d.unprobed,
        "unprobeable_inputs": d.unprobeable,
        "calibration": calibration_block_for_bindings([d.before.binding_id, d.after.binding_id]),
    }
    fmt = str(body.get("format") or "json").lower()
    if fmt in ("html", "md"):
        site = str((after.get("site") or {}).get("name") or body.get("site") or "Site")
        hall = str((after.get("hall") or {}).get("id") or body.get("hall") or "Hall")
        client = str((after.get("project") or {}).get("client") or body.get("client") or "Client")
        report = build_change_note_report(d, site=site, hall=hall, client=client,
                                          period=str(body.get("period") or ""))
        md = to_markdown(report)
        rendered = ({"format": "md", "title": report.title, "document": md} if fmt == "md"
                    else {"format": "html", "title": report.title,
                          "document": to_html(report, full_document=False),
                          "document_full": to_html(report, full_document=True)})
        rendered.update(payload)
        return rendered
    return payload


def handle_deck(body: dict, tier: Tier) -> dict:
    intake, results = _run(body.get("intake") or body)
    deck = build_deck_report(intake, results, objective=_objective(body))
    return {"format": "html", "title": deck.title, "slides": len(deck.slides),
            "document": deck_to_html(deck, full_document=False),
            "document_full": deck_to_html(deck, full_document=True),
            "calibration": calibration_block(results)}


def handle_proposal(body: dict, tier: Tier) -> dict:
    intake, results = _run(body.get("intake") or body)
    try:
        eng = engagement(str(body.get("engagement") or "density_screen"))
    except KeyError as exc:
        raise ApiError(422, str(exc), available=sorted(ENGAGEMENTS))
    report = build_proposal_report(
        intake, results, eng, objective=_objective(body),
        valid_days=_whole_number(body, "valid_days", 30, 1, 3650) or 30, contact=str(body.get("contact") or ""))
    out = _rendered(report, results, str(body.get("format") or "html").lower())
    out["engagement"] = {"id": eng.id, "name": eng.name, "price_eur": eng.price_eur,
                         "turnaround_days": eng.turnaround_days}
    out["calibration"] = calibration_block(results)
    return out


def _tender_scenario(body: dict, results, objective):
    """The scenario a specification or a bid comparison is built for: the one the request names, else the recommended one. A named scenario
    that is not one of the intake's is refused naming the field and the ids it has; it used to fall back silently to the recommended scenario,
    so a typo tendered (and ranked bids against) a different scenario than the one asked for."""
    from ..reporting.study import _pick_recommended
    named = body.get("scenario")
    if named in (None, ""):
        return _pick_recommended(results, objective)
    found = next((r for r in results if r.spec.id == named), None)
    if found is None:
        ids = [r.spec.id for r in results]
        raise ApiError(422, f"scenario {str(named)[:60]!r} is not one of this intake's scenarios; omit `scenario` for the recommended one",
                       field="scenario", allowed=ids)
    return found


def handle_spec(body: dict, tier: Tier) -> dict:
    from ..procurement import ProcurementError, build_spec, relief_steps
    from ..reporting.spec import build as build_spec_report
    intake, results = _run(body.get("intake") or body)
    objective = _objective(body)
    result = _tender_scenario(body, results, objective)

    if body.get("list"):
        return {"reliefs": [
            {"constraint_id": st.binding_id, "constraint": st.binding_name,
             "racks_unlocked": st.racks_unlocked, "cost_key": st.cost_key,
             "relief": st.relief_description}
            for st in relief_steps(result)], "calibration": calibration_block(results)}
    try:
        pkg = build_spec(intake, result, constraint_id=str(body.get("constraint") or ""))
    except ProcurementError as exc:
        raise ApiError(422, str(exc))

    report = build_spec_report(pkg, reference=str(body.get("reference") or ""),
                               return_by=str(body.get("return_by") or ""),
                               contact=str(body.get("contact") or ""),
                               claims=collect_claims(results))
    out = _rendered(report, results, str(body.get("format") or "html").lower())
    out["calibration"] = calibration_block(results)
    out["specification"] = {
        "constraint_id": pkg.constraint_id, "constraint": pkg.constraint_name,
        "relief": pkg.relief_title, "sized_for_racks": pkg.sized_for_racks,
        "requirements": len(pkg.requirements), "mandatory": len(pkg.mandatory()),
        # The basis the duties are quoted at, and every input that was assumed rather than supplied
        # (section 2A of the document), so a machine reader gets what the human reader gets.
        "site_conditions": [c.to_dict() for c in pkg.site_conditions],
        "assumed_inputs": [x.to_dict() for x in pkg.assumed_inputs],
    }
    out["response_template"] = {
        "specification": {"project": pkg.project, "hall": pkg.hall,
                          "constraint": pkg.constraint_id,
                          "sized_for_racks": pkg.sized_for_racks},
        "supplier": "", "received_on": "", "valid_until": "", "currency": "",     # a priced response names its currency (C-01: EUR)
        "values": {f.key: None for f in pkg.response_fields},
        "compliance": {q.id: "" for q in pkg.mandatory()},
    }
    return out


def handle_power_assess(body: dict, tier: Tier) -> dict:
    """The Power Readiness Case: current deployable capacity, the binding
    constraint, the priced headroom ladder, time to power, evidence strength and
    one deterministic next action, composed from the same solved scenario every
    other endpoint reads. No new physics — see gridforge/power/readiness.py."""
    from ..reporting.readiness import assess
    intake, results = _run(body.get("intake") or body)
    target = _whole_number(body, "target_racks", None, 0, 100_000)
    case = assess(intake, results, objective=_objective(body), target_racks=target)
    return redact(case, tier)


def handle_power_deploy_assess(body: dict, tier: Tier) -> dict:
    """The BTM Power Deployment Assessment: candidate grid/generation/BESS
    architectures compared against a real load profile under a real N/N+1/N+2/2N
    contingency test, each priced and dated where the request declared it, with
    one deterministic next action. No new physics — see
    gridforge/reporting/btm_assessment.py. This is a different input shape from
    every other engine endpoint (a load profile and a hybrid architecture, not a
    hall intake), so the request body is parsed by `deployment_request()` rather
    than through `_run()`/`load_document()`."""
    from ..reporting.btm_assessment import (DeploymentRequestError, assess_deployment,
                                            deployment_request)
    try:
        kwargs = deployment_request(body)
    except DeploymentRequestError as exc:
        raise ApiError(422, str(exc), **exc.extra)
    result = assess_deployment(**kwargs)
    result["calibration"] = btm_calibration_block()
    return redact(result, tier)


def _btm_spec_from_body(body: dict):
    """The BTM tender package for a deployment request. `architecture` names one of
    the candidate architectures the assessment compares; when it does, ONLY that
    architecture's units are tendered. With `require_rfq_ready`, the request is
    re-assessed here and refused unless that architecture is RFQ-ready — the engine,
    not the caller, decides whether an RFQ may be prepared."""
    from ..procurement.schema import ProcurementError
    from ..reporting.btm_assessment import (DeploymentRequestError, assess_deployment,
                                            candidate_architectures, deployment_request)
    from ..reporting.btm_spec import build_equipment_spec
    try:
        kwargs = deployment_request(body)
    except DeploymentRequestError as exc:
        raise ApiError(422, str(exc), **exc.extra)
    label = str(body.get("architecture") or "Declared architecture")
    generation, bess = kwargs["generation"], kwargs["bess"]
    chosen = next((c for c in candidate_architectures(generation, bess) if c.label == label),
                  None)
    if chosen is not None:
        generation, bess = chosen.generation, chosen.bess
    if body.get("require_rfq_ready"):
        if chosen is None:
            raise ApiError(422, f"architecture {label!r} is not one of the compared "
                                f"architectures — nothing to check RFQ readiness against")
        assessed = assess_deployment(**kwargs)
        row = next(a for a in assessed["architectures"] if a["label"] == label)
        if not row["rfq_ready"]:
            raise ApiError(409, f"'{label}' is not RFQ-ready; no RFQ was prepared",
                           blocking=row["blocking"],
                           capex_uncosted_units=row["capex_uncosted_units"],
                           readiness_gates=[g for g in row["readiness_gates"]
                                            if g["status"] in ("missing_data", "unknown")])
    project = str(body.get("project") or "Power Deployment Case")
    try:
        return build_equipment_spec(label, project=project, generation=generation, bess=bess)
    except ProcurementError as exc:
        raise ApiError(422, str(exc))


def _btm_response_template(spec) -> dict:
    """Same shape as the hall `response_template`: what `SupplierResponse.from_dict` reads."""
    return {
        "supplier": "", "received_on": "", "valid_until": "", "currency": "",     # a priced response names its currency (C-01: EUR)
        "values": {f.key: None for f in spec.response_fields},
        "compliance": {q.id: "" for q in spec.mandatory()},
    }


def handle_power_deploy_spec(body: dict, tier: Tier) -> dict:
    """A tender package for one architecture's generation and storage units —
    the dead end `gridforge_power_deploy_assess`'s "proceed to procurement"
    next action used to be. Same request shape as `/v1/power/deploy/assess`
    (a deployment request), plus `architecture` (one of the compared architecture
    labels, which selects the units tendered) and `project`. No new physics — see
    gridforge/reporting/btm_spec.py."""
    from ..reporting.btm_spec_report import build as build_spec_report
    spec = _btm_spec_from_body(body)
    summary = {
        "architecture": spec.architecture_label, "units": spec.units,
        "requirements": len(spec.requirements), "mandatory": len(spec.mandatory()),
    }
    fmt = str(body.get("format") or "html").lower()
    if fmt in ("html", "md"):
        report = build_spec_report(spec, reference=str(body.get("reference") or ""),
                                   return_by=str(body.get("return_by") or ""),
                                   contact=str(body.get("contact") or ""))
        extra = {"specification": summary, "response_template": _btm_response_template(spec), "calibration": btm_calibration_block()}
        if fmt == "md":
            return {"format": "md", "title": report.title, "document": to_markdown(report),
                    **extra}
        return {"format": "html", "title": report.title,
               "document": to_html(report, full_document=False),
               "document_full": to_html(report, full_document=True),
               "document_md": to_markdown(report), **extra}
    return {
        "specification": summary,
        "response_template": {f.key: None for f in spec.response_fields},
        "calibration": btm_calibration_block(),
    }


def handle_power_deploy_bids(body: dict, tier: Tier) -> dict:
    """Supplier responses to a BTM tender package, ranked by the SAME
    `procurement.rank_bids` the hall comparison uses. The package is rebuilt from the
    deployment request exactly as `/v1/power/deploy/spec` builds it, so a response is
    always judged against the requirements it was written for."""
    from ..procurement import ProcurementError, SupplierResponse, rank_bids
    raw = body.get("responses")
    if not isinstance(raw, list) or not raw:
        raise ApiError(422, 'expected a deployment request plus {"responses": [ ... ]}')
    spec = _btm_spec_from_body(body)
    try:
        responses = [SupplierResponse.from_dict(d, path=f"responses[{i}]") for i, d in enumerate(raw)]
        ranked = rank_bids(spec, responses)
    except ProcurementError as exc:
        raise ApiError(422, str(exc))
    best = next((a for a in ranked if not a.disqualified and a.compliant), None)
    return {
        "architecture": spec.architecture_label,
        "units": spec.units,
        "ranked": _ranked_rows(spec, ranked),
        "leading": best.supplier if best else None,
        "note": _BID_NOTE,
        "calibration": btm_calibration_block(),
    }


def _mcp_id_is_valid(rid) -> bool:
    """The ONE check of a JSON-RPC request id: a string, a number (an integer or a fraction: 1.5 is a number) or null. An object, an array or a
    boolean is not an id. A float that is not finite cannot be written back as JSON, so it is not one either. The valid path and the invalid-request
    path both ask this, so an id is echoed exactly or not at all (it used to be echoed unchecked when the request was valid and nulled, a float
    included, when it was not)."""
    if rid is None or isinstance(rid, str):
        return True
    if isinstance(rid, bool):
        return False
    return isinstance(rid, int) or (isinstance(rid, float) and math.isfinite(rid))


def _mcp_message_is_valid(message) -> bool:
    """The least JSON-RPC 2.0 asks of a request or notification: an object declaring `"jsonrpc": "2.0"` with a string method, and an `id`, when there
    is one, that is a string, a number or null. Anything else is an Invalid Request: a message that says it is another version (`"1.0"`) or none at all
    is not one this endpoint is entitled to read as 2.0, and an object or a list as an id could not be echoed as one."""
    return (isinstance(message, dict) and message.get("jsonrpc") == "2.0"
            and isinstance(message.get("method"), str) and bool(message["method"])
            and ("id" not in message or _mcp_id_is_valid(message["id"])))


def _invalid_rpc_request(message) -> dict:
    """-32600, answered whether or not the message had an id: a malformed message is an error to report, never a notification to ignore.
    The id is echoed exactly when it is one JSON-RPC allows (a string, a number or null), else null."""
    rid = message.get("id") if isinstance(message, dict) else None
    bad_id = not _mcp_id_is_valid(rid)
    if bad_id:
        rid = None
    if isinstance(message, dict) and message.get("jsonrpc") != "2.0":
        got = message.get("jsonrpc")
        shown = ("missing" if "jsonrpc" not in message else repr(got) if isinstance(got, str) and len(got) <= 20 else f"a {type(got).__name__}")
        what = f'invalid request: "jsonrpc" must be the string "2.0" (it is {shown})'
    elif bad_id and isinstance(message.get("method"), str) and message["method"]:
        what = f'invalid request: "id" must be a string, a number or null (it is {_json_type_name(message.get("id"))})'
    else:
        what = 'invalid request: expected a JSON-RPC object with a string "method"'
    return {"jsonrpc": "2.0", "id": rid, "error": {"code": -32600, "message": what}}


def _json_type_name(value) -> str:
    """The JSON name of a value's type, for a refusal ("an object", "an array", "a boolean")."""
    return ("a boolean" if isinstance(value, bool) else "an object" if isinstance(value, dict) else "an array" if isinstance(value, list)
            else "a number" if isinstance(value, (int, float)) else "a string" if isinstance(value, str) else "null" if value is None else type(value).__name__)


def handle_revoke(body: dict, tier: Tier) -> dict:
    """Kill a leaked key now, rather than at expiry.

    Keys expire on their own and a lapsed subscription needs nothing more — the
    webhook stops reissuing and the key dies inside the period the customer paid
    for. A LEAKED key is the case that cannot wait, and the only lever used to be
    an environment variable, which means a redeploy, which means the key kept
    working until a human did one.

    Verification is untouched: still offline, still no database and no network call
    per request. This writes to a local file the engine owns; `revoked_ids()` picks
    it up through an mtime check.
    """
    key_id = str(body.get("key_id") or "").strip()
    if not key_id:
        raise ApiError(422, "key_id is required")
    # Never "revoked" on a machine whose store would not survive a restart (a Fly machine with no volume): a write there succeeds, the
    # key is dead until the next restart, and the caller has been told it is gone. Ask the same question the operator tier reports.
    if not revocation_persistable():
        raise ApiError(503, "revocation is not persistable on this deployment",
                       fix="the revocation file must be on the mounted /data volume; check GET /v1/version (operator) revocation_persistable")
    stored = revoke(key_id)
    if not stored:
        # Never report a revocation that did not happen. A caller told "revoked"
        # stops looking for the leaked key.
        raise ApiError(503, "revocation is not persistable on this deployment",
                       fix="set GRIDFORGE_REVOKED_FILE to a writable path on a volume")
    try:
        count = len(revoked_ids())
    except Exception:
        count = None
    return {"revoked": key_id, "count": count}


def _record_cost(res, endpoint: str, started: tuple[float, float]) -> None:
    """Time one SUCCESSFUL charged call. `res` is the reservation the call took: None means nothing was billed
    (free tool, replay, operator key) and nothing is recorded. Never raises into the request."""
    if res is None:
        return
    try:
        wall, cpu = timer()
        METER.costs.record(endpoint, wall - started[0], cpu - started[1])
    except Exception:
        pass


ECONOMICS_BASIS = (
    "Calls, units and revenue come from the usage ledger for the UTC month, net of refunds (charges minus "
    "refunds), not from the timing file. revenue_cents_at_payg_price is units on payg-scope keys x the pay-as-you-go "
    "unit price; free_units are trial-scope (free allowance) units and earn nothing; subscription_units are "
    "units on subscription and operator keys and are NOT turned into revenue here because a subscription's price "
    "is per month, not per unit. "
    "Timings cover only the first, successful execution of a charged call, measured around the handler: not "
    "refused (401/402/503) or failed (refunded) calls, not idempotent replays (recomputed free), not free-tier "
    "calls, not request parsing, JSON encoding or the network. Wall time is per call; process CPU time is the "
    "whole process's (all threads), so under concurrent calls it over-attributes and is meaningful only as a "
    "total. Percentiles are the upper bound of the histogram bucket they fall in, capped at the slowest call "
    "seen: a ceiling, not an exact percentile. timed_calls can be lower than calls if the timing file was "
    "not durable or was set aside. "
    "NOT included in any figure: fixed infrastructure cost (the Fly machine and volume), Stripe processing "
    "fees, any model or LLM provider cost (the engine makes no model calls, so there is none to include), "
    "support and engineering time, taxes, minimum-invoice carry-forward, and invoices not yet paid."
)


def withhold_non_finite(payload):
    """(a copy of payload with every non-finite float replaced by None, the paths where that happened); (payload, []) when there is none.

    NaN and the infinities are not JSON: `Infinity` in a response breaks every strict parser downstream, and a client that coerces it to 0 has
    turned "unbounded" into "none". The loader refuses the inputs that can cause one; this is the defence behind it. The value becomes null (never
    zero, never a number made up) and its path is named, so the caller is told rather than left to find a hole. A tuple is read as a list."""
    paths: list[str] = []

    def clean(node, path):
        if isinstance(node, float):
            if math.isfinite(node):
                return node
            paths.append(path or "$")
            return None
        if isinstance(node, dict):
            return {k: clean(v, f"{path}.{k}" if path else str(k)) for k, v in node.items()}
        if isinstance(node, (list, tuple)):
            return [clean(v, f"{path}[{i}]") for i, v in enumerate(node)]
        return node

    out = clean(payload, "")
    return (out, paths) if paths else (payload, [])


def _warn_non_finite(payload, paths: list[str]):
    """The payload with a `warnings` entry per withheld figure. Top level of the answer, beside any warnings it already carries; in a JSON-RPC
    response (which has no room for one) inside its `result`. A list (an MCP batch) is handled element by element."""
    if isinstance(payload, list):
        return [_warn_non_finite(m, [p for p in paths if p.startswith(f"[{i}]")]) if isinstance(m, dict) else m for i, m in enumerate(payload)]
    if not isinstance(payload, dict):
        return payload
    notes = [f"non-finite figure withheld at {p}" for p in paths]
    if not notes:
        return payload
    target = payload["result"] if "jsonrpc" in payload and isinstance(payload.get("result"), dict) else payload
    existing = target.get("warnings")
    if isinstance(existing, list):
        target["warnings"] = existing + notes
    elif existing is None:
        target["warnings"] = notes
    else:
        target["non_finite_warnings"] = notes
    return payload


def _strict(obj):
    """Replace any non-finite float with None, recursively, so a report can never serialise to NaN/Infinity
    (which is not JSON and breaks every parser downstream)."""
    if isinstance(obj, float):
        return obj if math.isfinite(obj) else None
    if isinstance(obj, dict):
        return {k: _strict(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_strict(v) for v in obj]
    return obj


def economics_report(month: str) -> dict:
    """Operator-only unit economics for one UTC month: ledger-derived revenue and volume next to measured
    handler time. No figure here is estimated or assumed."""
    led = METER.ledger
    ledger_rows = led.economics(month)
    timings = METER.costs.month(month)
    price = PAYG.unit_price_cents
    endpoints: dict[str, dict] = {}
    totals = {"calls": 0, "units": 0, "payg_units": 0, "free_units": 0, "subscription_units": 0,
              "revenue_cents_at_payg_price": 0, "wall_ms_total": 0.0}
    for endpoint in sorted(set(ledger_rows) | set(timings)):
        by_scope = ledger_rows.get(endpoint, {})
        calls = sum(c for c, _ in by_scope.values())
        units = sum(u for _, u in by_scope.values())
        payg = by_scope.get("payg", (0, 0))[1]
        free = by_scope.get("trial", (0, 0))[1]
        sub = units - payg - free
        row = {"calls": calls, "units": units,
               "units_per_call": round(units / calls, 3) if calls else None,
               "payg_units": payg, "free_units": free, "subscription_units": sub,
               "revenue_cents_at_payg_price": payg * price}
        t = timings.get(endpoint)
        row.update(t if t else {"timed_calls": 0, "wall_ms_total": 0.0, "wall_ms_mean": None,
                                "wall_ms_p50": None, "wall_ms_p95": None, "wall_ms_max": None,
                                "process_cpu_ms_total": 0.0, "wall_ms_histogram": {}})
        # Only when every billed call was also timed: otherwise the numerator and denominator are different sets.
        row["wall_ms_per_unit"] = (round(row["wall_ms_total"] / units, 3)
                                   if units and t and t["timed_calls"] == calls else None)
        endpoints[endpoint] = row
        for k in ("calls", "units", "payg_units", "free_units", "subscription_units",
                  "revenue_cents_at_payg_price"):
            totals[k] += row[k]
        totals["wall_ms_total"] += row["wall_ms_total"]
    totals["wall_ms_total"] = round(totals["wall_ms_total"], 3)
    return {"month": month, "currency": PAYG.currency, "unit_price_cents": price,
            "endpoints": endpoints, "totals": totals,
            "durable": bool(led.available() and METER.costs.durable),
            "ledger_durable": led.available(), "timings_durable": METER.costs.durable,
            "timings_note": METER.costs.note,
            "bucket_bounds_ms": list(BUCKET_BOUNDS_MS),
            "basis": ECONOMICS_BASIS}


def admin_ledger_page(after_seq: int, limit: int) -> dict:
    """Operator-only read of the ledger, one page. `last_seq` is the seq of the last event IN THIS PAGE (or
    `after_seq` when there is none), so a consumer that stores it can never skip an event; `head_seq` is how
    far the ledger has got."""
    led = METER.ledger
    events = led.read_after(after_seq, limit)
    return {"events": events, "last_seq": events[-1]["seq"] if events else after_seq,
            "head_seq": led.last_seq, "durable": led.available(), "status": led.status()}


from ..procurement.evaluate import SCORE_BASIS  # noqa: E402


_BID_NOTE = ("Installation method and evidence quality carry 15 of the 100 points and "
             "are scored by an engineer, not by this endpoint. A ranking that claimed "
             "to have judged them would be inventing the part that needs judgement. "
             "A bid's own figures are held to the numeric 'shall' clauses they answer (a duty below the "
             "specified minimum, a price validity under 60 days): a bid that contradicts one is not compliant on it "
             "whatever code it declared, and `figure_checks` names the clause, the figure asked and the figure offered. "
             "A response that was not evaluated (`disqualified`) carries no rank, is never compliant and states no schedule effect. "
             + SCORE_BASIS)


def _ranked_rows(pkg, ranked) -> list[dict]:
    """The ranked-bid wire shape, shared by the hall (`/v1/bids`) and BTM
    (`/v1/power/deploy/bids`) comparisons so there is one ranking presentation."""
    from ..procurement.evaluate import schedule_impact
    rank = 0
    rows = []
    for a in ranked:
        # A response that was set aside has no rank: it was not compared, and a number there would read as its place in the comparison.
        if not a.disqualified:
            rank += 1
        rows.append({
        "rank": None if a.disqualified else rank, "supplier": a.supplier, "headline": a.headline(),
        "capex_eur": a.capex_eur, "weeks_to_energised": a.weeks_to_energised,
        "eur_per_rack": a.eur_per_rack, "compliant": a.compliant,
        "disqualified": a.disqualified, "score": round(a.total_score, 1),
        "scores": {k: round(v, 1) for k, v in a.scores.items()},
        "score_basis": a.score_basis,
        "mandatory_failed": a.mandatory_failed, "notes": a.notes,
        # Each numeric 'shall' the bid's own figure contradicts: the clause, the figure asked and the figure offered.
        "figure_checks": [c.to_dict() for c in a.contradictions],
        "schedule_impact": schedule_impact(pkg, a),
        # A bid with no install time is ranked on its LEAD time only and says so: weeks_to_energised is then not an energisation time.
        "install_weeks_missing": a.install_weeks_missing, "programme_basis": a.programme_basis,
        "needs_engineering_review": a.needs_engineering_review,
        })
    return rows


def handle_bids(body: dict, tier: Tier) -> dict:
    from ..procurement import ProcurementError, SupplierResponse, build_spec, rank_bids
    from ..procurement.ingest import cost_entries_from

    raw = body.get("responses")
    if not isinstance(raw, list) or not raw:
        raise ApiError(422, 'expected {"intake": {...}, "responses": [ ... ]}')
    intake, results = _run(body.get("intake") or {})
    objective = _objective(body)
    result = _tender_scenario(body, results, objective)
    try:
        pkg = build_spec(intake, result, constraint_id=str(body.get("constraint") or ""))
        responses = [SupplierResponse.from_dict(d, path=f"responses[{i}]") for i, d in enumerate(raw)]
        if body.get("evidence_only"):
            # Structured, validated quote lines for the site to persist for human review. Nothing is
            # ranked and nothing is accepted here: a line is evidence only after a person accepts it.
            from ..procurement.evidence import quote_lines
            return {
                "relief": pkg.relief_title, "constraint_id": pkg.constraint_id,
                "scope_quantity": pkg.scope_quantity, "scope_quantity_unit": pkg.scope_quantity_unit,
                "lines": [q.to_dict() for q in quote_lines(pkg, responses)],
                "calibration": calibration_block(results),
            }
        ranked = rank_bids(pkg, responses)
    except ProcurementError as exc:
        raise ApiError(422, str(exc))

    best = next((a for a in ranked if not a.disqualified and a.compliant), None)
    payload = {
        "relief": pkg.relief_title,
        "constraint_id": pkg.constraint_id,
        "sized_for_racks": pkg.sized_for_racks,
        "ranked": _ranked_rows(pkg, ranked),
        "leading": best.supplier if best else None,
        "note": _BID_NOTE,
        "calibration": calibration_block(results),
    }
    if body.get("ingest") and best is not None:
        winner = next(r for r in responses if r.supplier == best.supplier)
        try:
            payload["cost_library_entries"] = cost_entries_from(
                pkg, winner, basis=str(body.get("basis") or "budgetary_quote"),
                region=str(body.get("region") or ""))
        except ProcurementError as exc:
            payload["cost_library_entries"] = []
            payload["ingest_error"] = str(exc)
    return payload


#: MAX_PORTFOLIO_HALLS (the most halls one /v1/portfolio request may rank) is defined once, in metering.py, and imported above: the published
#: input schema, the estimator and the rate card read the same number.
from ..reporting.portfolio_guard import (declares_hall_ids as _declares_hall_ids, hall_key as _hall_key,  # noqa: E402
                                         identical_physics_warning as _identical_warning, is_repeat as _is_repeat_hall,
                                         physics_fingerprint as _fingerprint)


def handle_portfolio(body: dict, tier: Tier) -> dict:
    docs = body.get("intakes")
    if not isinstance(docs, list) or not docs:
        raise ApiError(422, "expected {\"intakes\": [ ... ]} with at least one intake")
    if len(docs) > MAX_PORTFOLIO_HALLS:
        raise ApiError(422, portfolio_cap_message(len(docs)), max_halls=MAX_PORTFOLIO_HALLS)
    objective = _objective(body)
    fmt = str(body.get("format") or "json").lower()
    if fmt not in ("json", "md", "html"):
        raise ApiError(422, f"unknown format {fmt!r}", allowed=["json", "md", "html"])
    entries = []
    seen: dict[tuple[str, str], int] = {}
    prints: dict[str, int] = {}
    portfolio_warnings_list: list[str] = []
    for i, d in enumerate(docs):
        intake, results = _run(d)
        # A hall is a physical thing: listing it twice cannot create capacity. Refuse a repeat by name rather than add it up silently. Two
        # entries are "the same hall" when they carry the same DECLARED site and hall ids, or are identical documents. Entries whose ids
        # were left to the library default (every sparse intake is SITE-1 / HALL-1) are not assumed to be one hall.
        key = _hall_key(intake.context.site.id, intake.context.hall.id)
        first = seen.get(key)
        if first is not None and _is_repeat_hall(d, docs[first]):
            raise ApiError(422, f"intakes[{i}] repeats site {key[0]!r} hall {key[1]!r} (already intakes[{first}]): a hall counts once, so its "
                                "capacity would be added twice. Remove the repeat, or give genuinely different halls different site.id and hall.id",
                           duplicate_of=first, index=i, site_id=key[0], hall_id=key[1])
        seen.setdefault(key, i)
        fp = _fingerprint(d)
        if fp is not None:
            if fp in prints:
                portfolio_warnings_list.append(_identical_warning(i, prints[fp]))
            else:
                prints[fp] = i
        entries.append(SiteEntry(intake=intake, results=results, objective=objective))
    out = {
        "objective": objective.value,
        "halls": portfolio_rows(entries, objective),
        "total_racks": sum(e.racks for e in entries),
        "total_racks_evidence": min(e.rack_class for e in entries).name,
        "calibration": calibration_block([r for e in entries for r in e.results]),
    }
    # Beside the sum of the rows: what it can and cannot be read as. total_racks stays the sum of every hall's own figure (an upper bound
    # while a connection is shared or a hall was not evaluated against every constraint); the comparable total adds only halls that are
    # rankable. All read from the per-hall results above -- nothing is solved again.
    out.update(portfolio_summary(entries, objective))
    portfolio_warnings_all = portfolio_warnings_list + portfolio_warnings(entries, objective)
    if portfolio_warnings_all:      # additive: present only when there is something to say, so a clean portfolio's shape is unchanged
        out["warnings"] = portfolio_warnings_all
    if fmt != "json":
        # The Portfolio Screen as it is delivered: the ranking document, rendered and gated like every other document, and one model
        # pack per hall, all from the SAME solve as the ranking above, so the document and the packs cannot disagree.
        client = body.get("client", "Portfolio")
        if not isinstance(client, str) or not client.strip() or len(client) > 120:
            raise ApiError(422, "client must be a non-empty string of at most 120 characters")
        report = build_portfolio(entries, client=client.strip(), objective=objective)
        out["document"] = _rendered(report, [r for e in entries for r in e.results], fmt)
        packs: dict[str, dict] = {}
        for e in entries:
            stem = f"{e.intake.context.site.id}_{e.intake.context.hall.id}".replace("/", "-")
            key, n = stem, 2
            while key in packs:                       # two halls with the same ids must not overwrite each other
                key, n = f"{stem}-{n}", n + 1
            packs[key] = model_pack(e.intake, e.results)
        out["model_packs"] = packs
    return out


#: Per-request context for handlers that need to know WHO is asking (only /v1/estimate does). Set by the
#: Handler before any handler runs, on the thread serving the request; handlers never see a key itself.
_CTX = threading.local()

_IDEM_REUSED = "this Idempotency-Key was already used with a different request body"
#: The longest Idempotency-Key header accepted, REST and MCP alike. The website ingests ledger events and rejects
#: an `idem` over 200 characters, so what is STORED is bounded too (see _ledger_idem): a header at the limit plus a
#: batch suffix, or anything longer, is stored as a digest.
MAX_IDEM_KEY_CHARS = 150
_IDEM_TOO_LONG = f"Idempotency-Key is longer than {MAX_IDEM_KEY_CHARS} characters"


def _ledger_idem(raw: str) -> str:
    """The idempotency key as it is written on a ledger event: itself when short, else `sha256:<hex>`.
    Deterministic, so a retry finds the same stored value (ledger replay keeps working)."""
    if len(raw.encode("utf-8", "replace")) <= MAX_IDEM_KEY_CHARS:
        return raw
    return "sha256:" + hashlib.sha256(raw.encode("utf-8", "replace")).hexdigest()
MAX_ESTIMATE_HALLS = 100_000
MAX_MCP_BATCH = 10
_PORTFOLIO = "/v1/portfolio"


def _units_basis(endpoint: str, units: int, halls: int | None) -> str:
    if endpoint == _PORTFOLIO:
        base = UNIT_COST[_PORTFOLIO]
        if halls is None:
            return (f"{base} unit per hall in the request, at most {MAX_PORTFOLIO_HALLS} halls per request; give hall_count (or body.intakes) for a total. "
                    f"Units are reserved when the call starts and refunded if it produces no answer.")
        return (f"{base} unit per hall x {halls} halls = {units} units. "
                f"Units are reserved when the call starts and refunded if it produces no answer.")
    if units == 0:
        return "free: never billed, and never counted against an allowance or a cap"
    return (f"fixed {units} unit{'s' if units != 1 else ''} per call, whatever the size of the intake. "
            f"Units are reserved when the call starts and refunded if it produces no answer.")


def handle_estimate(body: dict, tier: Tier) -> dict:
    """What a call would cost, before anyone spends anything. Public, free, never metered.

    The units come from the SAME `units_for()` the meter uses, so an estimate cannot drift from a bill.
    With a valid key the answer also says where that key stands, so an agent can decide to stop BEFORE the
    402 rather than after it."""
    endpoint = body.get("endpoint")
    if not isinstance(endpoint, str) or endpoint.rstrip("/") not in UNIT_COST:
        raise ApiError(422, "endpoint must be one of the engine routes that have a unit rate",
                       available=sorted(UNIT_COST))
    endpoint = endpoint.rstrip("/")
    req_body = body.get("body")
    if req_body is not None and not isinstance(req_body, dict):
        raise ApiError(422, "body, when given, must be the JSON object you intend to send")
    halls = None
    hall_count = body.get("hall_count")
    if hall_count is not None:
        if isinstance(hall_count, bool) or not isinstance(hall_count, int) or not (1 <= hall_count <= MAX_ESTIMATE_HALLS):
            raise ApiError(422, f"hall_count must be a whole number from 1 to {MAX_ESTIMATE_HALLS}")
    if endpoint == _PORTFOLIO:
        intakes = (req_body or {}).get("intakes")
        if isinstance(intakes, list):
            halls = max(1, len(intakes))
        elif hall_count is not None:
            halls = hall_count
        if halls is not None and halls > MAX_PORTFOLIO_HALLS:
            # A price for a request the engine would refuse is not an estimate: refuse it in the engine's own words, and say how many requests
            # the estate is (each is priced on its own by asking again with its own hall_count).
            raise ApiError(422, portfolio_cap_message(halls), max_halls=MAX_PORTFOLIO_HALLS,
                           requests_needed=-(-halls // MAX_PORTFOLIO_HALLS), units_per_hall=UNIT_COST[_PORTFOLIO])
        units = UNIT_COST[_PORTFOLIO] * (halls if halls is not None else 1)
    else:
        units = units_for(endpoint, req_body)
    price = PAYG.unit_price_cents
    out = {"endpoint": endpoint, "units": units, "unit_price_cents": price, "currency": PAYG.currency,
           "estimated_cents": units * price, "billable": units > 0, "free": units == 0,
           "basis": _units_basis(endpoint, units, halls),
           "note": ("estimated_cents is what pay-as-you-go would charge. A subscription's units come out "
                    "of its monthly allowance; the free allowance is never invoiced.")}
    plan = getattr(_CTX, "plan", None)
    supplied = getattr(_CTX, "supplied_key", "")
    if plan is not None:
        used = METER.current(plan.account).scope_units(plan.scope)
        cap = plan.monthly_quota or None
        remaining = (max(0, cap - used) if cap else None)
        beyond = max(0, units - remaining) if remaining is not None else 0
        out.update({
            "scope": plan.scope, "cap_units": cap, "used_units": used, "remaining_units": remaining,
            "fits": True if cap is None else used + units <= cap,
            # Cents this call would add that the key's own allowance does not cover. Zero for a call that
            # fits; for a free-allowance key the part beyond it (which would need pay-as-you-go).
            "would_cost_after_allowance": (units * price if plan.scope == "payg" else beyond * price)})
    elif supplied:
        out["key_error"] = refusal(supplied).get("error", "key not recognised")
    return out


ROUTES = {
    "/v1/qualify": (handle_qualify, Tier.PUBLIC),
    "/v1/estimate": (handle_estimate, Tier.PUBLIC),
    "/v1/screen": (handle_screen, Tier.CLIENT),
    "/v1/compare": (handle_compare, Tier.CLIENT),
    "/v1/study": (handle_study, Tier.CLIENT),
    "/v1/portfolio": (handle_portfolio, Tier.CLIENT),
    "/v1/proposal": (handle_proposal, Tier.CLIENT),
    "/v1/deck": (handle_deck, Tier.CLIENT),
    "/v1/diff": (handle_diff, Tier.CLIENT),
    "/v1/spec": (handle_spec, Tier.CLIENT),
    "/v1/bids": (handle_bids, Tier.CLIENT),
    "/v1/power/assess": (handle_power_assess, Tier.CLIENT),
    "/v1/power/deploy/assess": (handle_power_deploy_assess, Tier.CLIENT),
    "/v1/power/deploy/spec": (handle_power_deploy_spec, Tier.CLIENT),
    "/v1/power/deploy/bids": (handle_power_deploy_bids, Tier.CLIENT),
    "/v1/revoke": (handle_revoke, Tier.INTERNAL),
}

#: The `format` each route that renders a document honours, as (allowed values in the order its published schema lists them, the value used when
#: `format` is absent). The published enums are the source: a value outside them used to be answered as if it were the default (and billed), so
#: `format: "pdf"` on /v1/screen was a 200 JSON answer and a charge. /v1/deck has no schema (it is REST only) and always renders html.
ROUTE_FORMATS: dict[str, tuple[tuple[str, ...], str]] = {
    "/v1/screen": (("json", "md", "html"), "json"),
    "/v1/study": (("json", "md", "html", "csv"), "json"),
    "/v1/portfolio": (("json", "md", "html"), "json"),
    "/v1/diff": (("json", "md", "html"), "json"),
    "/v1/proposal": (("html", "md"), "html"),
    "/v1/spec": (("html", "md"), "html"),
    "/v1/deck": (("html",), "html"),
}


def validate_format(endpoint: str, body) -> None:
    """Refuse a `format` the route does not render, naming the allowed ones (422, the same shape /v1/portfolio always gave).

    Runs BEFORE the call is metered (REST: before `_charge`; MCP: before the tool is charged), so a request that can never be answered is
    refused for nothing, not billed and refunded. A route with no entry here, or a body that is not an object, is not looked at; absent, null
    and empty `format` are the route's default, as they always were; case is ignored, as it always was."""
    spec = ROUTE_FORMATS.get(endpoint)
    if spec is None or not isinstance(body, dict):
        return
    allowed, default = spec
    raw = body.get("format")
    fmt = str(raw or default).lower()
    if fmt not in allowed:
        raise ApiError(422, f"unknown format {fmt[:40]!r}", allowed=list(allowed))


def validate_request(endpoint: str, body) -> None:
    """What can be refused from the request alone, before it is metered: an unsupported `format` (`validate_format`) and a portfolio over
    MAX_PORTFOLIO_HALLS (the handler's own refusal, in the same words, which would otherwise come after `units_for` had reserved a unit per
    hall and a key short of that many units had been told it was over quota instead of told the cap)."""
    validate_format(endpoint, body)
    if endpoint == "/v1/portfolio" and isinstance(body, dict) and isinstance(body.get("intakes"), list) and len(body["intakes"]) > MAX_PORTFOLIO_HALLS:
        raise ApiError(422, portfolio_cap_message(len(body["intakes"])), max_halls=MAX_PORTFOLIO_HALLS)


#: Routes whose result depends on prices and can therefore take accepted cost evidence for that one request.
EVIDENCE_ROUTES = frozenset({"/v1/screen", "/v1/study", "/v1/compare", "/v1/diff", "/v1/deck", "/v1/spec"})
MAX_EVIDENCE_LINES = 200


#: The deepest a request body may nest. The deepest legitimate body (an intake with a supplier response inside a cost-evidence line) is under a
#: dozen levels; the parser accepts several thousand, and the engine copies documents recursively, so a body nested a few hundred deep failed with
#: a RecursionError (a 500 "engine error") on routes that copy it before validating it.
MAX_BODY_DEPTH = 64


def _nests_deeper_than(node, limit: int) -> bool:
    """Does a JSON-like value nest more than `limit` levels? Iterative, so a hostile value cannot make the check itself recurse."""
    stack = [(node, 1)]
    while stack:
        cur, depth = stack.pop()
        children = cur.values() if isinstance(cur, dict) else cur if isinstance(cur, list) else ()
        for child in children:
            if isinstance(child, (dict, list)):
                if depth + 1 > limit:
                    return True
                stack.append((child, depth + 1))
    return False


def _invoke(endpoint: str, handler, body, tier):
    """Run `handler` for `endpoint` inside the engine-wide concurrency cap (SOLVE_GATE) when the endpoint solves; see `_invoke_inner`.

    The ONE place a solve starts, for REST and MCP alike. When every slot is taken this raises ApiError 503 (with retry_after_seconds in its
    detail) at once: it never waits for a slot, so a flood is shed, not queued."""
    if endpoint not in SOLVING_ROUTES:
        return _invoke_inner(endpoint, handler, body, tier)
    caller, public = getattr(_CTX, "caller", ""), tier is Tier.PUBLIC
    if not SOLVE_GATE.enter(caller, public):
        busy = _busy_payload()
        raise ApiError(503, busy.pop("error"), **busy)
    try:
        return _invoke_inner(endpoint, handler, body, tier)
    finally:
        SOLVE_GATE.leave(caller, public)


def _invoke_inner(endpoint: str, handler, body, tier):
    """Call a handler, applying accepted cost evidence from the request when it carries any.

    The evidence applies to THIS call only (a request-scoped overlay over the library); an entry that is not accepted,
    has expired, is not in EUR, or is superseded by a newer one in the same request is ignored with a reason that is
    returned and printed. The answer says which evidence it used and, for a screen or study, what that changed."""
    validate_request(endpoint, body)           # already checked before the charge on both transports; this covers any other caller of `_invoke`
    if _nests_deeper_than(body, MAX_BODY_DEPTH):
        raise ApiError(422, f"the request nests more than {MAX_BODY_DEPTH} levels deep; no field of any route needs that")
    if not isinstance(body, dict) or "cost_evidence" not in body:
        return handler(body, tier)
    from ..costs import CostEntry, cost_overlay, set_evidence_effect
    ev = body["cost_evidence"]
    if endpoint not in EVIDENCE_ROUTES:
        raise ApiError(422, f"{endpoint} does not take cost_evidence", supported=sorted(EVIDENCE_ROUTES))
    if not isinstance(ev, list) or len(ev) > MAX_EVIDENCE_LINES:
        raise ApiError(422, f"cost_evidence must be a list of at most {MAX_EVIDENCE_LINES} accepted cost lines")
    entries = []
    for i, raw in enumerate(ev):
        try:
            entries.append(CostEntry(**raw))
        except (TypeError, ValueError) as exc:
            raise ApiError(422, f"cost_evidence[{i}] is not a valid cost line: {exc}")
    clean = {k: v for k, v in body.items() if k != "cost_evidence"}
    with cost_overlay(entries) as report:
        effect = None
        if endpoint in ("/v1/screen", "/v1/study", "/v1/compare"):
            from ..scenario.evidence import evidence_effect
            doc = clean.get("intake") or clean
            intake = load_document(doc)          # an invalid intake fails here exactly as the handler would
            effect = evidence_effect(intake.context, intake.scenarios, entries)
            set_evidence_effect(effect)
        out = handler(clean, tier)
    if isinstance(out, dict):
        out["cost_evidence"] = {**report.to_dict(), "effect": effect}
        out["provenance"] = provenance(VERSION)      # what produced this answer, so a caller can record it
    return out


GET_ROUTES = ("/health", "/v1/version", "/v1/platforms", "/v1/intake/template",
              "/v1/calibration", "/v1/calibration/residuals", "/v1/tools", "/v1/usage")


def public_endpoints() -> list[str]:
    """The routes a caller may be told exist: every POST and GET route except the operator-only ones (`Tier.INTERNAL`: /v1/revoke), which answer
    404 to everyone else precisely so they do not confirm they exist, and so are in no listing. The one list behind GET /v1/version `endpoints`."""
    return sorted(r for r, (_, tier) in ROUTES.items() if tier is not Tier.INTERNAL) + sorted(GET_ROUTES)


# --- Model Context Protocol --------------------------------------------------
# JSON-RPC 2.0 over one POST endpoint. Implemented here rather than pulled in as a
# dependency because the whole engine is standard-library-only and an agent-facing
# surface is the last place to start taking transitive packages on trust.

class RpcError(Exception):
    def __init__(self, code: int, message: str, data=None):
        super().__init__(message)
        self.code, self.message, self.data = code, message, data


def _mcp_call_tool(params: dict, tier: Tier, charge) -> dict:
    # Every tools/call after the first in one HTTP request is charged to the rate limiter on its own: the
    # limiter counts HTTP requests, and a batch of N free qualifies is N solves for one hit.
    limit = getattr(charge, "rate", None)
    if limit is not None and not limit():
        raise RpcError(-32005, "rate limit exceeded", {"status": 429, "limit_per_minute": RATE_LIMIT_PER_MINUTE})
    name = params.get("name")
    if not isinstance(name, str) or not name:
        got = "missing" if name is None else "empty" if name == "" else f"a {type(name).__name__}, not a string"
        raise RpcError(-32602, f"params.name is {got}: name the tool to call (a string)", {"available": sorted(TOOLS_BY_NAME)})
    tool = TOOLS_BY_NAME.get(name)
    if tool is None:
        raise RpcError(-32602, f"unknown tool {name!r}",
                       {"available": sorted(TOOLS_BY_NAME)})
    endpoint = tool["endpoint"]
    handler, required = ROUTES[endpoint]
    if required is Tier.CLIENT and tier is Tier.PUBLIC:
        raise RpcError(-32001, f"{name} requires an API key",
                       {"free_tool": "gridforge_qualify", "units": tool["units"]})
    args = params.get("arguments")
    if not isinstance(args, dict):
        raise RpcError(-32602, "arguments must be an object")
    try:
        validate_request(endpoint, args)       # before the idempotency lookup and the charge: nothing to refund
    except ApiError as exc:
        raise RpcError(-32602, exc.message, exc.extra)
    # Idempotency-Key, exactly as REST honours it: a retry after a timeout is neither charged twice nor handed a
    # different answer, and a key reused for another request is refused. `idem` is None when there is no key,
    # no valid API key to scope it to, or the tool is the estimator.
    idem = getattr(charge, "idem", lambda e, a: None)(endpoint, args)
    if idem is not None:
        cache_key, body_hash = idem
        hit = IDEMPOTENCY.get(cache_key)
        if hit is not None:
            if hit[1] != body_hash:
                raise RpcError(-32602, _IDEM_REUSED, {"status": 422})
            getattr(charge, "replayed", lambda: None)()
            return _mcp_content(name, hit[3])
    if endpoint in SOLVING_ROUTES and SOLVE_GATE.full(getattr(_CTX, "caller", ""), tier is Tier.PUBLIC):
        getattr(charge, "busy", lambda: None)()       # the HTTP response carries Retry-After too
        busy = _busy_payload()        # before any charge: nothing to refund
        raise RpcError(-32003, busy["error"], {"status": 503, **busy})
    denied = charge(endpoint, args)
    if denied:
        status = denied.get("status")
        raise RpcError(-32003 if status == 503 else -32602 if status == 422 else -32002, denied["error"], denied)
    # The reservation THIS call took (None for a free call or an idempotent replay). A failure refunds that
    # one and nothing else: in a batch the request's other calls were answered and stay charged.
    mine = getattr(charge, "current", lambda: None)()
    refund_one = getattr(charge, "refund", lambda res=None: None)

    def refund() -> None:
        if mine is not None:
            refund_one(mine)
    try:
        started = timer()
        result = _invoke(endpoint, handler, args, tier)
        _record_cost(mine, endpoint, started)
        if idem is not None:
            IDEMPOTENCY.put(idem[0], idem[1], 200, result)
        return _mcp_content(name, result)
    except ApiError as exc:
        refund()
        if exc.status == 503:         # the concurrency cap was taken between the look above and the start: still busy, not invalid
            getattr(charge, "busy", lambda: None)()
            raise RpcError(-32003, exc.message, {"status": 503, **exc.extra})
        raise RpcError(-32602, exc.message, exc.extra)
    except IntakeError as exc:
        refund()
        raise RpcError(-32602, str(exc))
    except (ValueError, TypeError, KeyError, ArithmeticError) as exc:
        refund()
        raise RpcError(-32602, f"invalid arguments: {exc.__class__.__name__}: {str(exc)[:160]}")
    except Exception:
        # Our fault, not the caller's: refund exactly this call's own reservation, log the detail on the
        # server under a request id, and tell the caller only that and the id. Never the exception text.
        refund()
        rid = getattr(charge, "request_id", "") or secrets.token_hex(6)
        _log_engine_error(rid)
        raise RpcError(-32603, "engine error", {"request_id": rid})


def _log_engine_error(request_id: str) -> None:
    import traceback
    print(f"gridforge: engine error request_id={request_id}", file=sys.stderr)
    traceback.print_exc()


def _mcp_content(name: str, result: dict) -> dict:
    # MCP wants content blocks. The structured payload is the real answer; the text
    # block is a one-line summary so a model that only reads text is not left with
    # a wall of JSON and no idea which number mattered.
    return {
        "content": [{"type": "text", "text": _mcp_summary(name, result)}],
        "structuredContent": result,
        "isError": False,
    }


def _mcp_summary(name: str, result: dict) -> str:
    try:
        if name == "gridforge_qualify":
            a, b = result["as_found"], result["after_relief"]
            # Follows the payload: an item is named only when the payload names one; with no date the sentence says so and why.
            no_date = str(b.get("sets_the_date_reason") or b.get("date_label") or "No date can be given.").rstrip(".") + ". "
            sets = f"{b['sets_the_date']} sets the date. " if b.get("sets_the_date") else no_date
            return (f"{a['racks']} racks as found, {b['racks']} after relief. "
                    f"Binds first on {a['binding_constraint']}. "
                    f"{sets}"
                    f"Calibration: {result['calibration']['state']}.")
        if name == "gridforge_portfolio":
            top = result["halls"][0]
            return (f"{len(result['halls'])} halls ranked; {top['site']}/{top['hall']} leads "
                    f"with {top['racks']} racks, binds on {top['binds_first']}.")
        if name == "gridforge_diff":
            return result["headline"]
        if name == "gridforge_proposal":
            e = result["engagement"]
            return f"{e['name']} proposal, EUR {e['price_eur']:,}, {e['turnaround_days']} days."
        if "scenarios" in result:
            def racks(x):
                a = x.get("after_ladder") or {}
                return a.get("racks") or x.get("racks_after_ladder") or 0
            best = max(result["scenarios"], key=racks)
            found = (best.get("as_found") or {})
            return (f"{len(result['scenarios'])} architectures compared; best is "
                    f"{best.get('name') or best.get('id')} at {racks(best)} racks "
                    f"({found.get('racks', '?')} as found, binds on "
                    f"{found.get('binding_name') or found.get('binding')}).")
    except Exception:
        pass
    return f"{name} completed. Read structuredContent; every figure carries an evidence class."


def handle_mcp(body: dict, tier: Tier, charge) -> dict | None:
    """One JSON-RPC request. Returns None for a notification (no id)."""
    rpc_id = body.get("id")
    method = body.get("method")
    # A notification is a message with NO `id` member (JSON-RPC 2.0 section 4.1). `"id": null` is a request, answered with id null: it used to be
    # taken for a notification, so the caller got a 202 and nothing else.
    notification = "id" not in body
    params = body.get("params") if isinstance(body.get("params"), dict) else {}

    def ok(result):
        return None if notification else {"jsonrpc": "2.0", "id": rpc_id, "result": result}

    try:
        if method == "initialize":
            return ok({
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {"tools": {"listChanged": False}},
                "serverInfo": {"name": "gridforge", "version": VERSION},
                "instructions": (
                    "Capacity and thermal envelope engine for AI data-center halls. It "
                    "answers one question: how much AI compute an EXISTING hall can carry, "
                    "which of thirteen electrical, thermal and physical constraints binds "
                    "first, and what each step of extra density costs.\n\n"
                    "gridforge_qualify is free and needs no API key — call it whenever a "
                    "user asks whether a data hall can take high-density or AI racks. Send "
                    "at least three of its seven figures (contracted MW, current site peak, "
                    "current IT load, busway ampacity, tap-off rating, plant supply "
                    "temperature, free rack positions); each one you omit is named in the "
                    "answer as an assumption, so ask the user for them rather than guessing.\n\n"
                    "Every numeric field carries an evidence class E0-E7 and a provenance "
                    "digest. Do not present an E0 or E1 figure as a property of a physical "
                    "asset: it is modelled, not measured. The calibration block on each "
                    "result states how far this engine has been reconciled against site "
                    "data; where it says uncalibrated, say so too."),
            })
        if method in ("notifications/initialized", "initialized"):
            return None
        if method == "ping":
            return ok({})
        if method == "tools/list":
            # Everything is listed whatever the caller holds. An agent that cannot
            # see a paid tool cannot tell its user the answer exists, which is worse
            # for us than for them.
            return ok({"tools": mcp_tools()})
        if method == "tools/call":
            if not isinstance(body.get("params"), dict):
                raise RpcError(-32602, 'tools/call needs params: an object with a string "name" (the tool to call) and an "arguments" object',
                               {"available": sorted(TOOLS_BY_NAME)})
            return ok(_mcp_call_tool(params, tier, charge))
        raise RpcError(-32601, f"method not found: {method}")
    except RpcError as exc:
        if notification:
            return None
        err = {"code": exc.code, "message": exc.message}
        if exc.data is not None:
            err["data"] = exc.data
        return {"jsonrpc": "2.0", "id": rpc_id, "error": err}


def _encode(payload) -> bytes:
    """A response body as strict JSON. `allow_nan=False`: a NaN or an infinity is never written (`Infinity` is not JSON). If one reaches here it
    is replaced by null where it stands and named in a top-level `warnings` entry ('non-finite figure withheld at <path>'): never a 500, never
    silent, never a zero. A body that fails for any other reason is the caller's exception, as before."""
    try:
        return json.dumps(payload, allow_nan=False).encode()
    except ValueError as exc:
        try:
            clean, paths = withhold_non_finite(payload)
        except RecursionError:             # a payload that refers to itself: not a non-finite figure, so the original error stands
            raise exc from None
        if not paths:
            raise
        print(f"gridforge: non-finite figure withheld at {', '.join(paths[:5])}", file=sys.stderr)
        return json.dumps(_warn_non_finite(clean, paths), allow_nan=False).encode()


class Handler(BaseHTTPRequestHandler):
    #: Seconds a connection may sit idle mid-request. Without it a client that announces a body and
    #: never sends it holds a thread for ever.
    timeout = 30
    server_version = f"gridforge/{VERSION}"
    limiter = _RateLimiter(RATE_LIMIT_PER_MINUTE)
    #: Bounds the cheap discovery GETs (see DISCOVERY_PATHS). Its rate follows ``limiter.per_minute``: off when that is off.
    discovery_limiter = _RateLimiter(max(DISCOVERY_FACTOR * RATE_LIMIT_PER_MINUTE, DISCOVERY_MIN_PER_MINUTE) if RATE_LIMIT_PER_MINUTE > 0 else 0)

    def _allowed_to_read(self, path: str) -> bool:
        """The GET rate limit. Discovery routes are counted on their own (generous) limiter, every other GET on the main one, so reading
        the platform library, the calibration record, an estimate or an operator route cannot be done at machine speed (nor an operator key
        guessed at it)."""
        if path in DISCOVERY_PATHS:
            main = self.limiter.per_minute
            self.discovery_limiter.per_minute = max(DISCOVERY_FACTOR * main, DISCOVERY_MIN_PER_MINUTE) if main > 0 else 0
            return self._within(self.discovery_limiter)
        return self._within(self.limiter)

    def log_message(self, fmt: str, *args) -> None:  # pragma: no cover - noise
        if os.environ.get("GRIDFORGE_ACCESS_LOG"):
            super().log_message(fmt, *args)

    # -- plumbing ----------------------------------------------------------
    def _cors(self) -> None:
        origins = _allowed_origins()
        origin = self.headers.get("Origin")
        allow = "*" if "*" in origins else (origin if origin in origins else "")
        allow_headers = "Content-Type, X-API-Key, Authorization, Idempotency-Key, X-GridForge-Project"
        if not allow and _public_cors_enabled() and urlparse(self.path).path.rstrip("/") in PUBLIC_CORS_PATHS:
            # A foreign origin on a keyless free route: readable, but it may not send a key from there.
            allow, allow_headers = "*", "Content-Type"
        if allow:
            self.send_header("Access-Control-Allow-Origin", allow)
        self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Headers", allow_headers)
        self.send_header("Access-Control-Expose-Headers",
                         "X-GridForge-Units, X-GridForge-Units-Month, X-GridForge-Units-Remaining, "
                         "X-GridForge-Charge-Cents, X-GridForge-Idempotent-Replay, Idempotent-Replay")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")      # HEAD is CORS-safelisted like GET and POST: not listed

    def _send(self, status: int, payload: dict) -> None:
        if isinstance(payload, dict) and "jsonrpc" not in payload:
            payload = {"schema_version": API_SCHEMA, **payload}
        data = _encode(payload)
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-GridForge-Schema", API_SCHEMA)
        if getattr(self, "_replayed", False):
            self.send_header("Idempotent-Replay", "true")
            self.send_header("X-GridForge-Idempotent-Replay", "true")
        if getattr(self, "_retry_after", None):
            self.send_header("Retry-After", str(self._retry_after))
        if getattr(self, "_allow", None):
            self.send_header("Allow", self._allow)
        self._usage_headers()
        self._cors()
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def _declares_json_or_nothing(self) -> bool:
        """True when the request declares application/json (or an application/*+json type, parameters such as charset ignored) or
        declares nothing. A missing header is allowed: a browser cannot send a body without one, so it is not the cross-site case,
        and non-browser clients that never set it have always worked. A DECLARED type that is not JSON is the case refused."""
        declared = (self.headers.get("Content-Type") or "").split(";", 1)[0].strip().lower()
        if not declared:
            return True
        return declared == "application/json" or (declared.startswith("application/") and declared.endswith("+json"))

    def _client_addr(self) -> str:
        """The address text the caller is identified by: see "Who a caller is" in the module docstring.

        The socket peer, unless a proxy of ours is declared (GRIDFORGE_TRUSTED_PROXY_HOPS, GRIDFORGE_TRUSTED_IP_HEADER, or Fly.io's own
        FLY_APP_NAME). A client-supplied X-Forwarded-For with no declared proxy is ignored: it used to be read with one hop by default, so a
        caller could send a different single entry on every request and never meet the limit."""
        env = os.environ
        peer = (self.client_address[0] if self.client_address else "") or ""
        on_fly = bool(env.get("FLY_APP_NAME"))
        try:
            raw_hops = env.get("GRIDFORGE_TRUSTED_PROXY_HOPS")
            hops = max(0, int(raw_hops)) if raw_hops not in (None, "") else (1 if on_fly else 0)
        except ValueError:
            hops = 1 if on_fly else 0
        named = (env.get("GRIDFORGE_TRUSTED_IP_HEADER") or "").strip().lower() or ("fly-client-ip" if on_fly else "")
        if named:
            entries = [p.strip() for p in (self.headers.get(named) or "").split(",") if p.strip()]
            n = max(hops, 1) if named == "x-forwarded-for" else 1
            if len(entries) >= n and _bucket(entries[-n]):
                return entries[-n]
        if hops:
            fwd = [p.strip() for p in (self.headers.get("X-Forwarded-For") or "").split(",") if p.strip()]
            if len(fwd) >= hops and _bucket(fwd[-hops]):
                return fwd[-hops]
        return peer

    def _client_key(self) -> str:
        """The caller's rate-limit identity: its address (IPv6: its /64), or "?" when no address can be read."""
        return _bucket(self._client_addr()) or "?"

    def _within(self, limiter: "_RateLimiter") -> bool:
        """Count this request against `limiter` on the caller's /64 AND, for IPv6, its /48. False when either bucket is full."""
        return limiter.allow(self._client_key(), _bucket_wide(self._client_addr()))

    def _supplied_key(self) -> str:
        auth = (self.headers.get("Authorization") or "").strip()
        if auth[:7].lower() == "bearer ":
            auth = auth[7:].strip()
        return self.headers.get("X-API-Key") or auth

    def _plan(self):
        return plan_for(self._supplied_key())

    def _is_operator(self) -> bool:
        """Us, not a customer.

        A separate secret from GRIDFORGE_API_KEYS on purpose: a paying customer's
        key must never be able to revoke anybody's credential, including their own
        competitor's. Unset means the operator surface does not exist at all.
        """
        admin = os.environ.get("GRIDFORGE_ADMIN_KEY") or ""
        supplied = self._supplied_key() or ""
        return bool(admin) and hmac.compare_digest(admin.encode(), supplied.encode("utf-8", "replace"))

    def _tier(self) -> Tier:
        if self._is_operator():
            return Tier.INTERNAL
        return Tier.CLIENT if self._plan() else Tier.PUBLIC

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        allow = self._allowed_methods(urlparse(self.path).path.rstrip("/") or "/")
        if allow:
            self.send_header("Allow", ", ".join(allow))
        self._cors()
        self.end_headers()

    # -- methods -----------------------------------------------------------
    @staticmethod
    def _allowed_methods(path: str) -> list[str] | None:
        """The methods a known route answers, for a 405's Allow header; None when the path is not a route a caller may know exists.
        Operator routes (/v1/revoke, /v1/admin/*) are None on purpose: they answer 404 to everyone else and never confirm they exist."""
        reads = path in ("/", "/health", "/v1/estimate") or path in GET_ROUTES
        posts = path == "/mcp" or (path in ROUTES and ROUTES[path][1] is not Tier.INTERNAL)
        if not (reads or posts):
            return None
        return (["GET", "HEAD"] if reads else []) + (["POST"] if posts else []) + ["OPTIONS"]

    def _method_not_allowed(self, path: str):
        """405 with an Allow header for a known route reached by a method it does not take; 404 for a path that is no route."""
        allow = self._allowed_methods(path)
        if allow is None:
            return self._send(404, {"error": "not found", "endpoints": public_endpoints() + ["/mcp"]})
        self._allow = ", ".join(allow)
        return self._send(405, {"error": f"{self.command} is not allowed on {path}", "allow": allow})

    def _other_method(self) -> None:
        """PUT, DELETE and PATCH: no route takes them. They used to get the standard library's HTML 501 page."""
        self._method_not_allowed(urlparse(self.path).path.rstrip("/") or "/")

    do_PUT = do_DELETE = do_PATCH = _other_method  # noqa: N815

    def do_HEAD(self) -> None:  # noqa: N802
        """HEAD answers a GET route exactly as GET does (same status, same headers, no body: `_send` leaves the body out), so a monitor that
        probes with HEAD is not told the service is down."""
        self.do_GET()

    def send_error(self, code, message=None, explain=None) -> None:
        """Every error the standard library raises on its own (a malformed request line, an over-long header, an unsupported method such as
        TRACE) as the engine's JSON, never its HTML page. Runs before any header is parsed on a bad request, so it reads nothing from them."""
        short = self.responses.get(code, ("error",))[0]
        data = json.dumps({"schema_version": API_SCHEMA, "error": message or short, "status": code}).encode()
        try:
            self.log_error("code %d, message %s", code, message)
            self.send_response(code, message)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Connection", "close")
            self.end_headers()
            if self.command != "HEAD" and code >= 200 and code not in (204, 205, 304):
                self.wfile.write(data)
        except (OSError, ValueError):       # the peer is gone: nothing to tell it
            pass

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/") or "/"
        _CTX.plan, _CTX.supplied_key = self._plan(), self._supplied_key()
        if not self._allowed_to_read(path):
            return self._send(429, {"error": "rate limit exceeded",
                                    "limit_per_minute": RATE_LIMIT_PER_MINUTE})
        if path == "/v1/admin/ledger":
            # Operator tier only, and 404 (not 401) to anyone else, like /v1/revoke: an operator surface does
            # not confirm it exists to a caller who cannot use it. Deliberately absent from every listing.
            if self._tier() is not Tier.INTERNAL:
                return self._send(404, {"error": "not found"})
            q = parse_qs(parsed.query)
            try:
                after = int((q.get("after_seq") or ["0"])[0])
                limit = int((q.get("limit") or ["1000"])[0])
                if after < 0 or not (1 <= limit <= 1000):
                    raise ValueError
            except ValueError:
                return self._send(400, {"error": "after_seq must be >= 0 and limit between 1 and 1000"})
            return self._send(200, admin_ledger_page(after, limit))
        if path == "/v1/admin/economics":
            # Operator tier only; 404 to everyone else and absent from every listing, like the ledger read.
            if self._tier() is not Tier.INTERNAL:
                return self._send(404, {"error": "not found"})
            month = (parse_qs(parsed.query).get("month") or [datetime.now(timezone.utc).strftime("%Y-%m")])[0]
            try:
                datetime.strptime(month, "%Y-%m")
                if len(month) != 7:
                    raise ValueError
            except ValueError:
                return self._send(400, {"error": "month must be YYYY-MM"})
            return self._send(200, _strict(economics_report(month)))
        if path == "/v1/estimate":
            q = parse_qs(parsed.query)
            req: dict = {"endpoint": (q.get("endpoint") or [""])[0]}
            if q.get("hall_count"):
                try:
                    req["hall_count"] = int(q["hall_count"][0])
                except ValueError:
                    return self._send(422, {"error": f"hall_count must be a whole number from 1 to {MAX_ESTIMATE_HALLS}"})
            try:
                return self._send(200, handle_estimate(req, Tier.PUBLIC))
            except ApiError as exc:
                return self._send(exc.status, {"error": exc.message, **exc.extra})
        if path in ("/health", "/"):
            return self._send(200, {"ok": True, "service": "gridforge", "version": VERSION})
        if path == "/v1/version":
            # Operator tier only: lets the website verify, with the admin key and no side effect, that
            # revocation can actually be persisted before it sells a key it could not later kill.
            extra = ({"revocation_persistable": revocation_persistable(), "ledger_status": METER.ledger.status()}
                     if self._tier() is Tier.INTERNAL else {})
            return self._send(200, {
                **extra,
                "version": VERSION,
                "provenance": provenance(VERSION),
                "auth_configured": _auth_configured(),
                "signed_keys": bool(os.environ.get("GRIDFORGE_KEY_SECRET")),
                "rate_limit_per_minute": RATE_LIMIT_PER_MINUTE,
                "schema": API_SCHEMA,
                "idempotency": (f"send an Idempotency-Key header (at most {MAX_IDEM_KEY_CHARS} characters) on a POST, "
                                f"or on an /mcp tools/call, to make a retry free and identical"),
                "idempotency_key_max_chars": MAX_IDEM_KEY_CHARS,
                "tier": self._tier().value,
                "endpoints": public_endpoints(),
                # Behaviour a route has that its path does not show. A site that depends on one reads it here and, from an engine that does
                # not list it (an older deployment), hides the feature instead of sending a field that engine would silently ignore.
                "capabilities": dict(CAPABILITIES),
                "unit_rates": dict(sorted(UNIT_COST.items())),
                "payg": payg_public(),
                "metering": {
                    "durable": METER.durable,
                    "ledger_durable": METER.ledger.available(),
                    "over_quota_status": 402,
                    "note": ("Units are published so a caller can predict a bill before "
                             "making the call. A meter whose rate is secret is a meter "
                             "nobody integrates against."),
                },
                "machine_interface": {"tools": "/v1/tools", "mcp": "/mcp",
                                      "protocolVersion": PROTOCOL_VERSION},
                "calibration": "/v1/calibration",
            })
        if path == "/v1/platforms":
            return self._send(200, {
                "platforms": [{"id": p.id, "name": p.name, "status": p.status,
                               "rack_kW": p.rack_kW.rounded(),
                               "gpus_per_rack": p.gpus_per_rack} for p in PLATFORMS.values()],
                "deliberately_absent": UNPUBLISHED_PLATFORMS,
                "note": ("Platforms whose rack power the manufacturer has not published are "
                         "absent by design. An invented number in a capacity study is how an "
                         "engineering reputation ends."),
            })
        if path == "/v1/intake/template":
            return self._send(200, blank_intake())
        if path == "/v1/calibration":
            # Public, and public precisely because the answer is currently "none".
            # An accuracy record that only becomes visible once it flatters us is a
            # marketing number; this one is a commitment.
            # The PUBLISHED ledger only: an observation a client supplied never reaches a public page, whatever it says. A ledger whose
            # hash chain is broken is not served as an empty or as a partial record; it is a 503 that says so.
            try:
                led = load_ledger(published_only=True)
            except LedgerIntegrityError:
                return self._send(503, {"error": "the calibration ledger failed its integrity check and is not being served",
                                        "state": "unavailable"})
            block = accuracy_block(calibration_keys(), led)
            block["ledger_sources"] = len(led.sources)
            block["policy"] = (
                "An observation must be E5 or above — site data, not another run of our "
                "own model — and client site data never enters the published ledger.")
            return self._send(200, block)
        if path == "/v1/calibration/residuals":
            # Public and read-only. Aggregate statistics over APPROVED observation records only (a draft or rejected
            # record changes nothing here, not even a count); no site id, hall id, record id, free text or measurement is
            # in the payload. With nothing approved it says "uncalibrated" and n_records 0. A store whose hash chain is
            # broken is a 503, never an empty or partial answer.
            try:
                recs = approved_observation_records()
            except LedgerIntegrityError:
                return self._send(503, {"error": "the calibration record store failed its integrity check and is not being served",
                                        "state": "unavailable"})
            return self._send(200, public_residual_report(recs))
        if path == "/v1/tools":
            return self._send(200, catalogue())
        if path == "/v1/usage":
            plan = self._plan()
            if plan is None:
                return self._send(401, dict(refusal(self._supplied_key()),
                                            hint="GET /v1/tools is free and needs no key"))
            return self._send(200, METER.statement(plan))
        return self._method_not_allowed(path)       # a POST route read with GET: 405 and Allow; a path that is no route: the 404 it always was

    # -- metering ----------------------------------------------------------
    def _project(self) -> str:
        """X-GridForge-Project: a label the CALLER chooses so their own invoice can be split by project. Short and
        boring on purpose: anything else is ignored, never rejected, so a bad label cannot cost an answer."""
        v = (self.headers.get("X-GridForge-Project") or "").strip()
        if 0 < len(v) <= 64 and all((c.isascii() and c.isalnum()) or c in "._:-" for c in v):
            return v
        return ""

    def _charge(self, endpoint: str, body: dict | None, idem: str = "", body_sha: str = ""):
        """Bill the call, or explain why it cannot be billed.

        Returns None when the call may proceed (and the units are already on the
        account), or a dict describing the refusal, with its HTTP `status` (402 over the
        cap, 503 when a payg/trial charge cannot be made durable, 422 for an Idempotency-Key
        reused with another body). Billing happens BEFORE the work: an agent in a loop can
        otherwise run a month's quota of solves while the first response is still being rendered.
        """
        # Per-call state. A call that takes no reservation (free, replayed, refused) must not inherit the previous
        # call's: in an MCP batch that is exactly how a failing free call used to refund a paid sibling.
        self._open_res = None
        plan = self._plan()
        if plan is None:
            # A paid route reached with no plan: the key was valid when the tier was decided and is not any more (revoked in between).
            # Serving it would be a free paid run, so refuse. The operator is the only caller with no plan that may use a paid route.
            if not self._is_operator() and ROUTES.get(endpoint, (None, Tier.PUBLIC))[1] is Tier.CLIENT:
                return {"status": 401, "error": "this key has been revoked or is no longer valid; nothing was run and nothing was charged"}
            return None
        units = units_for(endpoint, body)
        if units <= 0:
            return None
        res = METER.reserve_ex(plan.account, endpoint, units, plan.monthly_quota, scope=plan.scope,
                               key_id=plan.key_id, project=self._project(), idem=idem, body_sha=body_sha)
        if res.status == "unavailable":
            self._retry_after = 30
            return {"status": 503,
                    "error": "usage cannot be recorded right now; nothing was charged and no work was done",
                    "retryable": True, "units_required": units,
                    "fix": "retry in a few seconds. Metered keys are refused rather than served unrecorded; "
                           "if this persists the fault is on our side, not your key"}
        if res.status == "conflict":
            return {"status": 422, "error": res.reason}
        if res.status == "replay":
            self._replayed = True
            self._last_units = getattr(self, "_req_units", 0)
            self._last_usage = res.usage
            return None
        if res.status == "over":
            return dict(self._over_body(plan, units), status=402)
        self._open_res = res
        self._req_units = getattr(self, "_req_units", 0) + units
        self._last_units = self._req_units
        self._last_usage = res.usage
        return None

    @staticmethod
    def _over_body(plan, units: int) -> dict:
        u = METER.statement(plan)
        cap = u["monthly_quota"]
        now = datetime.now(timezone.utc)
        nxt = (now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
               .replace(year=now.year + (now.month == 12), month=now.month % 12 + 1))
        body = {"error": "monthly unit quota exhausted", "units_required": units, "units_used": u["units"],
                "monthly_quota": cap, "cap_units": cap, "month": u["month"],
                "unit_price_cents": PAYG.unit_price_cents, "resets_at": nxt.strftime("%Y-%m-%dT%H:%M:%SZ")}
        if plan.scope == "trial":
            body.update(plan="api_free", reason="free_allowance_exhausted",
                        fix=(f"the free allowance of {cap} units is used for {u['month']}; it renews at the start "
                             f"of next month (UTC). To keep going now, enable pay-as-you-go with a spending cap "
                             f"of your choosing on your API access page (no charge until you do; "
                             f"EUR {PAYG.unit_price_cents / 100:.2f} per unit), or pick a plan at /pricing"))
        elif plan.scope == "payg":
            body.update(plan="api_payg", reason="spending_cap_reached",
                        cap_eur=round(cap * PAYG.unit_price_cents / 100, 2) if cap else None,
                        fix=(f"your monthly spending cap of {cap} units "
                             f"(EUR {cap * PAYG.unit_price_cents / 100:,.2f}) is reached. Nothing beyond it is "
                             f"billed. Raise the cap on your API access page (a new cap issues a new key) or "
                             f"wait for the reset at the start of next month (UTC); a subscription at "
                             f"/pricing is cheaper per unit at sustained volume"))
        elif plan.scope in ("machine", "client") and plan.key_id:
            body.update(plan="subscription", reason="plan_quota_exhausted",
                        fix=("upgrade the plan on your account page, or wait for the "
                             "allowance to reset at the start of next month"))
        else:
            body.update(plan="operator_key", reason="plan_quota_exhausted",
                        fix=("upgrade the plan on your account page, or wait for the "
                             "allowance to reset at the start of next month"))
        return body

    def _refund(self, res=None) -> None:
        """Undo one charge: the call produced no answer. With no argument, this request's open reservation
        (REST has one call per request); an MCP call passes the reservation it took. Always exactly one
        reservation, refunded once."""
        res = res if res is not None else getattr(self, "_open_res", None)
        if res is None or getattr(res, "_refunded", False):
            return
        res._refunded = True
        METER.refund_reservation(res)
        if getattr(self, "_open_res", None) is res:
            self._open_res = None
        self._req_units = max(0, getattr(self, "_req_units", 0) - res.units)
        self._last_units = self._req_units
        self._last_usage = METER.current(res.account)

    def _usage_headers(self) -> None:
        units = getattr(self, "_last_units", None)
        usage = getattr(self, "_last_usage", None)
        if units is None or usage is None:
            return
        self.send_header("X-GridForge-Units", str(units))
        plan = self._plan()
        # Scope-specific: the free allowance and a pay-as-you-go cap are counted separately.
        month_units = usage.scope_units(plan.scope) if plan else usage.units
        self.send_header("X-GridForge-Units-Month", str(month_units))
        if plan and plan.monthly_quota:
            self.send_header("X-GridForge-Units-Remaining",
                             str(max(0, plan.monthly_quota - month_units)))
        if plan and plan.scope == "payg":
            # What THIS request adds to the invoice: net units (after any refund) x the unit price.
            self.send_header("X-GridForge-Charge-Cents", str(PAYG.charge_cents(units)))
        if plan and plan.expires:
            self.send_header("X-GridForge-Key-Expires", plan.expires)

    def do_POST(self) -> None:  # noqa: N802
        self._open_res, self._req_units, self._last_units, self._last_usage = None, 0, None, None
        _CTX.plan, _CTX.supplied_key = self._plan(), self._supplied_key()
        _CTX.caller = self._client_key()          # the solve gate's per-caller identity: the one the rate limiter uses
        try:
            self._do_post()
        finally:
            _CTX.plan, _CTX.supplied_key, _CTX.caller = None, "", ""

    def _do_post(self) -> None:
        path = urlparse(self.path).path.rstrip("/") or "/"
        if path not in ROUTES and path != "/mcp":
            return self._method_not_allowed(path)          # a GET route sent a POST: 405 and Allow; a path that is no route: 404

        if not self._within(self.limiter):
            return self._send(429, {"error": "rate limit exceeded",
                                    "limit_per_minute": RATE_LIMIT_PER_MINUTE})
        tier = self._tier()
        # The MCP transport is PUBLIC and the tools inside it are not.
        #
        # It was key-gated end to end, which closed the single best distribution
        # channel this product has: a stranger adding GridForge to their AI client
        # and getting a real answer about their own hall in thirty seconds. Every
        # paid tool still refuses without a key — _mcp_call_tool checks the tier per
        # tool — so the only thing the gate was protecting was the free tier from
        # being used.
        required = Tier.PUBLIC if path == "/mcp" else ROUTES[path][1]
        if required is Tier.INTERNAL and tier is not Tier.INTERNAL:
            # 404, not 401: an operator surface should not confirm it exists to a
            # caller who cannot use it.
            return self._send(404, {"error": "not found"})
        if required is Tier.CLIENT and tier is Tier.PUBLIC:
            if not _auth_configured():
                return self._send(503, {
                    "error": "paid endpoints are not configured on this deployment",
                    "fix": "set GRIDFORGE_API_KEYS, or GRIDFORGE_KEY_SECRET for "
                           "self-serve signed keys"})
            return self._send(401, dict(refusal(self._supplied_key()),
                                        public_endpoint="/v1/qualify",
                                        tool_schemas="/v1/tools"))

        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return self._send(400, {"error": "invalid Content-Length"})
        if length < 0:
            return self._send(400, {"error": "invalid Content-Length"})
        if length > MAX_BODY_BYTES:
            return self._send(413, {"error": "payload too large",
                                    "max_bytes": MAX_BODY_BYTES})
        if length and not self._declares_json_or_nothing():
            # Refused before the body is read, before any charge and before idempotency handling. A browser can send text/plain,
            # application/x-www-form-urlencoded and multipart/form-data cross-site WITHOUT a preflight, which is exactly the
            # request a page we do not control could aim at a public route; application/json always needs one, and the preflight
            # is answered by our CORS policy. The server speaks HTTP/1.0 (one request per connection), so not reading the body
            # leaves nothing behind to be parsed as the next request.
            return self._send(415, {"error": "unsupported media type",
                                    "fix": "send the body as JSON with 'Content-Type: application/json'",
                                    "received": (self.headers.get("Content-Type") or "")[:80]})
        raw = self.rfile.read(length) if length else b"{}"
        try:
            body = json.loads(raw or b"{}", parse_constant=_reject_constant, object_pairs_hook=_refuse_duplicate_keys)
        except RecursionError:
            # Python's parser gives up on nesting around ten thousand levels. Uncaught, this ended the request with no HTTP response at all
            # (the connection was closed) and a traceback in the log, and it is reachable without a key on the free public endpoints.
            return self._send(400, {"error": "invalid JSON: nested too deeply"})
        except (json.JSONDecodeError, ValueError, UnicodeDecodeError) as exc:
            return self._send(400, {"error": f"invalid JSON: {exc}"})

        if path == "/mcp":
            return self._serve_mcp(body, tier)

        if not isinstance(body, dict):
            return self._send(400, {"error": "expected a JSON object"})
        try:
            validate_request(path, body)       # a format the route cannot render, or a portfolio over the cap, is refused before anything is metered
        except ApiError as exc:
            return self._send(exc.status, {"error": exc.message, **exc.extra})

        idem = (self.headers.get("Idempotency-Key") or "").strip()
        idem_key = None
        body_hash = hashlib.sha256(raw).hexdigest()
        plan = self._plan()
        if idem and plan is not None and path != "/v1/estimate":
            if len(idem) > MAX_IDEM_KEY_CHARS:
                return self._send(400, {"error": _IDEM_TOO_LONG, "max_chars": MAX_IDEM_KEY_CHARS})
            idem_key = (plan.account, path, idem)
            hit = IDEMPOTENCY.get(idem_key)
            if hit is not None:
                if hit[1] != body_hash:
                    return self._send(422, {"error": "this Idempotency-Key was already used with a "
                                                     "different request body"})
                self._replayed = True
                self._last_units, self._last_usage = 0, METER.current(plan.account)
                return self._send(hit[2], hit[3])

        if path in SOLVING_ROUTES and SOLVE_GATE.full(self._client_key(), tier is Tier.PUBLIC):
            # Shed load before anything is charged: a refused request leaves no ledger event to refund. Not queued.
            self._retry_after = SOLVE_RETRY_AFTER_SECONDS
            return self._send(503, _busy_payload())
        denied = self._charge(path, body, idem=_ledger_idem(idem_key[2]) if idem_key else "",
                              body_sha=body_hash[:16])
        if denied:
            return self._send(denied.pop("status", 402), denied)

        handler = ROUTES[path][0]
        try:
            started = timer()
            result = _invoke(path, handler, body, tier)
            _record_cost(self._open_res, path, started)
            if idem_key is not None:
                IDEMPOTENCY.put(idem_key, body_hash, 200, result)
            return self._send(200, result)
        except ApiError as exc:
            self._refund()
            if exc.status == 503 and exc.extra.get("retry_after_seconds"):
                self._retry_after = exc.extra["retry_after_seconds"]
            return self._send(exc.status, {"error": exc.message, **exc.extra})
        except IntakeError as exc:
            self._refund()
            return self._send(422, {"error": str(exc)})
        except (ValueError, TypeError, KeyError, ArithmeticError) as exc:
            # Malformed input that got past the field checks. Reported as the caller's problem
            # (422, not billed) rather than a 500 that blames us and leaks an exception string.
            self._refund()
            return self._send(422, {"error": "the request could not be processed as given",
                                    "detail": f"{exc.__class__.__name__}: {str(exc)[:160]}"})
        except Exception:  # pragma: no cover - last resort
            self._refund()
            import traceback
            traceback.print_exc()
            return self._send(500, {"error": "engine error",
                                    "request_id": self.headers.get("X-Request-Id", "")})

    def _serve_mcp(self, body, tier: Tier) -> None:
        """JSON-RPC 2.0, single request or batch. Notifications get 202 and no body."""
        header = (self.headers.get("Idempotency-Key") or "").strip()
        position: list = [None]          # index in the batch of the message being handled; None for a single call

        def idem_for(endpoint: str, args: dict):
            """(response-cache key, full body hash) for this call, or None when no idempotency applies."""
            plan = self._plan()
            if not header or plan is None or endpoint == "/v1/estimate":
                return None
            if len(header) > MAX_IDEM_KEY_CHARS:
                raise RpcError(-32602, _IDEM_TOO_LONG, {"status": 400, "max_chars": MAX_IDEM_KEY_CHARS})
            idem = header if position[0] is None else f"{header}#{position[0]}"
            canon = json.dumps({"endpoint": endpoint, "arguments": args}, sort_keys=True, separators=(",", ":"))
            return (plan.account, endpoint, idem), hashlib.sha256(canon.encode()).hexdigest()

        def charge(endpoint, args):
            info = idem_for(endpoint, args)
            if info is None:
                return self._charge(endpoint, args)
            return self._charge(endpoint, args, idem=_ledger_idem(info[0][2]), body_sha=info[1][:16])

        charge.refund = self._refund

        def busy() -> None:
            self._retry_after = SOLVE_RETRY_AFTER_SECONDS
        charge.busy = busy
        charge.current = lambda: self._open_res        # the reservation the call just made, if any
        charge.idem = idem_for

        def replayed() -> None:
            self._replayed = True
            plan = self._plan()
            if getattr(self, "_last_units", None) is None and plan is not None:
                self._last_units, self._last_usage = 0, METER.current(plan.account)
        charge.replayed = replayed
        calls = [0]

        def rate() -> bool:
            calls[0] += 1
            return calls[0] == 1 or self._within(self.limiter)   # the first rode in on the HTTP hit
        charge.rate = rate
        rid = "".join(c for c in (self.headers.get("X-Request-Id") or "")[:64] if c.isascii() and (c.isalnum() or c in "._:-"))
        charge.request_id = rid or secrets.token_hex(6)

        def guarded(message: dict):
            """handle_mcp for ONE message that cannot raise: whatever goes wrong, this message gets a generic
            -32603 (no exception text), the reservation it holds is refunded, and the rest of a batch is still
            answered. State is reset per message so a refund can only ever touch this message's own charge."""
            self._open_res = None
            if not _mcp_message_is_valid(message):
                return _invalid_rpc_request(message)          # before handle_mcp: nothing is charged, nothing is silently dropped
            try:
                return handle_mcp(message, tier, charge)
            except Exception:
                self._refund()
                _log_engine_error(charge.request_id)
                if "id" not in message:
                    return None
                return {"jsonrpc": "2.0", "id": message.get("id"),
                        "error": {"code": -32603, "message": "engine error",
                                  "data": {"request_id": charge.request_id}}}
        if isinstance(body, list):
            if not body:
                return self._send(400, {"jsonrpc": "2.0", "id": None,
                                        "error": {"code": -32600, "message": "empty batch"}})
            if len(body) > MAX_MCP_BATCH:
                return self._send(400, {"jsonrpc": "2.0", "id": None,
                                        "error": {"code": -32600,
                                                  "message": f"batch too large: at most {MAX_MCP_BATCH} requests",
                                                  "data": {"max_batch": MAX_MCP_BATCH, "received": len(body)}}})
            out = []
            for i, m in enumerate(body):
                position[0] = i
                r = guarded(m)
                if r is not None:
                    out.append(r)
            if not out:
                self.send_response(202)
                self._cors()
                self.end_headers()
                return
            return self._send(200, out)
        if not isinstance(body, dict):
            return self._send(400, {"jsonrpc": "2.0", "id": None,
                                    "error": {"code": -32600, "message": "expected an object"}})
        if not _mcp_message_is_valid(body):
            return self._send(400, _invalid_rpc_request(body))
        result = guarded(body)
        if result is None:
            self.send_response(202)
            self._cors()
            self.end_headers()
            return
        return self._send(200, result)


def graceful_stop(httpd=None, meter=None) -> None:
    """Everything the engine controls on the way down: stop accepting, then write any refund that could not be
    written at the time. A refund owed to a customer must not be lost because the process was told to stop."""
    if httpd is not None:
        try:
            httpd.server_close()
        except Exception:
            pass
    (meter or METER).close()


def install_signal_handlers() -> None:
    """Fly stops a machine with SIGTERM, which by default kills the process with no chance to flush. Turn it
    into the same path as Ctrl-C so serve() reaches graceful_stop(). A hard kill (SIGKILL, OOM, power loss)
    cannot be handled by anything in-process; see Meter.close()."""
    import signal

    def _term(signum, frame):
        raise KeyboardInterrupt
    try:
        signal.signal(signal.SIGTERM, _term)
    except (ValueError, OSError):      # not the main thread
        pass


def serve(host: str = "0.0.0.0", port: int = 8080) -> None:  # pragma: no cover - entry point
    weak, refuse = check_secret_strength()
    for line in weak:
        print(f"gridforge: WARNING: {line}" + (" Refusing to start (GRIDFORGE_ENFORCE_SECRET_STRENGTH=1)." if refuse else ""), file=sys.stderr)
    if refuse:
        raise SystemExit(2)          # before anything is bound
    httpd = _listening_server(host, port)
    keys = _api_keys()
    print(f"gridforge {VERSION} listening on http://{host}:{port}")
    print(f"  public : POST /v1/qualify")
    print(f"  client : POST /v1/screen, /v1/study, /v1/portfolio "
          f"({'keys configured' if keys else 'DISABLED — set GRIDFORGE_API_KEYS'})")
    install_signal_handlers()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        graceful_stop(httpd)


#: The listening backlog. The default of 5 reset connections in a burst of a couple of dozen simultaneous connects before the engine could answer
#: any of them, which defeats shedding load with a 503 (a reset carries no Retry-After).
LISTEN_BACKLOG = 64


def _listening_server(host: str, port: int) -> ThreadingHTTPServer:
    """A ThreadingHTTPServer on host:port with the larger backlog. Built unbound so the backlog is set on the instance before it listens (the
    stdlib class is left as it is for anything else in the process)."""
    httpd = ThreadingHTTPServer((host, port), Handler, bind_and_activate=False)
    httpd.request_queue_size = LISTEN_BACKLOG
    try:
        httpd.server_bind()
        httpd.server_activate()
    except BaseException:
        httpd.server_close()
        raise
    return httpd


def make_server(host: str = "127.0.0.1", port: int = 0) -> ThreadingHTTPServer:
    """Used by the tests, and by anyone embedding the engine in their own process."""
    return _listening_server(host, port)
