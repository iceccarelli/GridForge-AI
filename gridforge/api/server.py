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
    POST /v1/qualify                    seven fields -> binding constraint  (public)
    POST /v1/screen                     full intake -> screen payload       (key)
    POST /v1/study                      full intake -> model pack           (key)
    POST /v1/portfolio                  [intakes]  -> ranked halls          (key)
    POST /v1/proposal                   intake     -> priced proposal       (key)
    POST /v1/deck                       intake     -> walkthrough deck      (key)
    POST /v1/diff                       two intakes-> change note           (key)
    GET  /v1/calibration                how far the model is reconciled      (public)
    GET  /v1/tools                      machine-callable tool schemas        (public)
    GET  /v1/usage                      this key's metered usage             (key)
    POST /mcp                           Model Context Protocol, JSON-RPC 2.0 (key)

Auth: X-API-Key, or Authorization: Bearer <key>, against GRIDFORGE_API_KEYS
(comma separated, `key[:label[:monthly_units]]`). With no keys configured the paid
endpoints refuse rather than open — a misconfigured deployment must fail closed.

Metering: every paid call bills units (see /v1/version). Over quota returns 402,
not 429 — to a machine those mean buy more and try later respectively, and an
agent told to retry a call it can never afford will retry it forever.
"""
from __future__ import annotations

import json
import os
import threading
import time
from collections import defaultdict, deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

from ..calibration import accuracy_block, all_keys as calibration_keys, load_ledger
from ..compute.library import PLATFORMS, UNPUBLISHED_PLATFORMS
from ..intake.loader import IntakeError, blank_intake, load_document
from ..reporting import to_html, to_markdown
from ..reporting.gates import ReportMode, run_all_gates
from ..reporting.portfolio import SiteEntry, rank
from ..commercial import ENGAGEMENTS, engagement
from ..change import EnvelopeState, diff as envelope_diff, diff_from_state
from ..reporting.change_note import build as build_change_note_report
from ..reporting.deck import build as build_deck_report
from ..reporting.deck import to_html as deck_to_html
from ..reporting.proposal import build as build_proposal_report
from ..reporting.screen import build as build_screen_report
from ..reporting.study import build as build_study_report
from ..reporting.study import collect_claims
from ..reporting.study import Objective
from ..scenario import run_all
from ..scenario.knobs import SENSITIVITY_KNOBS
from ..serialize import csv_bundle, model_pack
from .metering import METER, UNIT_COST, key_plans, units_for
from .payloads import qualify_payload, screen_payload
from .tiers import Tier
from .tools import PROTOCOL_VERSION, TOOLS_BY_NAME, catalogue, mcp_tools

VERSION = "0.8.0"
MAX_BODY_BYTES = 512 * 1024
RATE_LIMIT_PER_MINUTE = int(os.environ.get("GRIDFORGE_RATE_LIMIT", "30"))


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


def qualify_to_intake(body: dict) -> dict:
    """Expand the short web form into a sparse intake document.

    Everything not asked becomes a library default and a recorded gap, which is
    exactly the list the prospect is shown at the end. The form is short because
    the gap list is the product, not because the model is."""
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
        cur[parts[-1]] = float(body[key])
    if body.get("firm_capacity_MVA") is not None:
        doc["grid"]["firm_capacity_MVA"] = float(body["firm_capacity_MVA"])
    elif doc.get("grid", {}).get("contracted_MW") is not None:
        # A connection is normally sized at or above the contracted figure; assume
        # parity rather than inventing headroom the site may not have.
        doc["grid"]["firm_capacity_MVA"] = float(doc["grid"]["contracted_MW"]) / 0.97
    return doc


class ApiError(Exception):
    def __init__(self, status: int, message: str, **extra):
        super().__init__(message)
        self.status = status
        self.message = message
        self.extra = extra


class _RateLimiter:
    def __init__(self, per_minute: int):
        self.per_minute = per_minute
        self._hits: dict[str, deque] = defaultdict(deque)
        self._lock = threading.Lock()

    def allow(self, key: str) -> bool:
        if self.per_minute <= 0:
            return True
        now = time.time()
        with self._lock:
            q = self._hits[key]
            while q and now - q[0] > 60:
                q.popleft()
            if len(q) >= self.per_minute:
                return False
            q.append(now)
            return True


def _api_keys() -> set[str]:
    """Parsed through the meter, so `sk_x`, `sk_x:acme` and `sk_x:acme:5000` all
    authenticate on `sk_x`. Plain keys configured before metering existed keep
    working unchanged, which is the only acceptable way to add billing to a
    running deployment."""
    return set(key_plans())


def _allowed_origins() -> list[str]:
    raw = os.environ.get("GRIDFORGE_ALLOWED_ORIGINS", "*")
    return [o.strip() for o in raw.split(",") if o.strip()]


def _run(doc: dict):
    intake = load_document(doc)
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
    missing = [k for k in QUALIFY_FIELDS if body.get(k) is None]
    if len(missing) > 4:
        raise ApiError(422, "too little to say anything useful",
                       required_at_least=list(QUALIFY_FIELDS)[:3], missing=missing)
    intake, results = _run(qualify_to_intake(body))
    return qualify_payload(intake, results, _objective(body))


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


def handle_screen(body: dict, tier: Tier) -> dict:
    intake, results = _run(body.get("intake") or body)
    fmt = str(body.get("format") or "json").lower()
    if fmt in ("html", "md"):
        report = build_screen_report(intake, results, objective=_objective(body))
        return _rendered(report, results, fmt)
    return screen_payload(intake, results, _objective(body), tier=tier)


def handle_study(body: dict, tier: Tier) -> dict:
    intake, results = _run(body.get("intake") or body)
    fmt = str(body.get("format") or "json").lower()
    if fmt == "csv":
        return {"format": "csv", "files": csv_bundle(intake, results)}
    if fmt in ("html", "md"):
        objective = _objective(body)
        from ..reporting.study import _pick_recommended
        from ..scenario import sensitivity
        rec = _pick_recommended(results, objective)
        sens = sensitivity(rec, SENSITIVITY_KNOBS)
        report = build_study_report(intake.context, results, sens,
                                    client=intake.client, objective=objective)
        return _rendered(report, results, fmt)
    return model_pack(intake, results)


def handle_diff(body: dict, tier: Tier) -> dict:
    after = body.get("after") or body.get("intake")
    if not isinstance(after, dict):
        raise ApiError(422, 'expected {"before": {...}, "after": {...}} or '
                            '{"previous_state": {...}, "after": {...}}')
    objective = _objective(body)
    prev = body.get("previous_state")
    if isinstance(prev, dict):
        try:
            d = diff_from_state(EnvelopeState(**prev), after, objective=objective)
        except TypeError as exc:
            raise ApiError(422, f"previous_state is not a recorded envelope state: {exc}")
    else:
        before = body.get("before")
        if not isinstance(before, dict):
            raise ApiError(422, 'a diff needs either "before" or "previous_state"')
        d = envelope_diff(before, after, objective=objective,
                          attribute=bool(body.get("attribute", True)))

    payload = {
        "headline": d.headline(),
        "material": d.material,
        "before": d.before.__dict__,
        "after": d.after.__dict__,
        "racks_delta": d.racks_delta,
        "weeks_delta": d.weeks_delta,
        "capex_delta_eur": d.capex_delta,
        "binding_moved": d.binding_moved,
        "changed_inputs": d.changed_paths,
        "drivers": [dr.__dict__ for dr in d.drivers],
        "explained_racks": d.explained,
        "unexplained_racks": d.residual,
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
            "document_full": deck_to_html(deck, full_document=True)}


def handle_proposal(body: dict, tier: Tier) -> dict:
    intake, results = _run(body.get("intake") or body)
    try:
        eng = engagement(str(body.get("engagement") or "density_screen"))
    except KeyError as exc:
        raise ApiError(422, str(exc), available=sorted(ENGAGEMENTS))
    report = build_proposal_report(
        intake, results, eng, objective=_objective(body),
        valid_days=int(body.get("valid_days") or 30), contact=str(body.get("contact") or ""))
    out = _rendered(report, results, str(body.get("format") or "html").lower())
    out["engagement"] = {"id": eng.id, "name": eng.name, "price_eur": eng.price_eur,
                         "turnaround_days": eng.turnaround_days}
    return out


def handle_portfolio(body: dict, tier: Tier) -> dict:
    docs = body.get("intakes")
    if not isinstance(docs, list) or not docs:
        raise ApiError(422, "expected {\"intakes\": [ ... ]} with at least one intake")
    entries = []
    for d in docs:
        intake, results = _run(d)
        entries.append(SiteEntry(intake=intake, results=results))
    objective = _objective(body)
    ordered = rank(entries, objective)
    return {
        "objective": objective.value,
        "halls": [{
            "rank": i,
            "site": e.intake.context.site.name,
            "hall": e.intake.context.hall.id,
            "metro": e.intake.context.site.metro,
            "racks": e.racks,
            "weeks_to_full": None if e.weeks == float("inf") else e.weeks,
            "capex_eur": e.capex,
            "capex_per_rack_eur": e.capex_per_rack,
            "binds_first": e.best.envelope.binding.name,
            "intake_completeness": round(e.intake.report.completeness, 3),
        } for i, e in enumerate(ordered, 1)],
        "total_racks": sum(e.racks for e in entries),
    }


ROUTES = {
    "/v1/qualify": (handle_qualify, Tier.PUBLIC),
    "/v1/screen": (handle_screen, Tier.CLIENT),
    "/v1/study": (handle_study, Tier.CLIENT),
    "/v1/portfolio": (handle_portfolio, Tier.CLIENT),
    "/v1/proposal": (handle_proposal, Tier.CLIENT),
    "/v1/deck": (handle_deck, Tier.CLIENT),
    "/v1/diff": (handle_diff, Tier.CLIENT),
}

GET_ROUTES = ("/health", "/v1/version", "/v1/platforms", "/v1/intake/template",
              "/v1/calibration", "/v1/tools", "/v1/usage")


# --- Model Context Protocol --------------------------------------------------
# JSON-RPC 2.0 over one POST endpoint. Implemented here rather than pulled in as a
# dependency because the whole engine is standard-library-only and an agent-facing
# surface is the last place to start taking transitive packages on trust.

class RpcError(Exception):
    def __init__(self, code: int, message: str, data=None):
        super().__init__(message)
        self.code, self.message, self.data = code, message, data


def _mcp_call_tool(params: dict, tier: Tier, charge) -> dict:
    name = params.get("name")
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
    denied = charge(endpoint, args)
    if denied:
        raise RpcError(-32002, denied["error"], denied)
    try:
        result = handler(args, tier)
    except ApiError as exc:
        raise RpcError(-32602, exc.message, exc.extra)
    except IntakeError as exc:
        raise RpcError(-32602, str(exc))
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
            return (f"{a['racks']} racks as found, {b['racks']} after relief. "
                    f"Binds first on {a['binding_constraint']}. "
                    f"{b['sets_the_date']} sets the date. "
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
    params = body.get("params") if isinstance(body.get("params"), dict) else {}

    def ok(result):
        return None if rpc_id is None else {"jsonrpc": "2.0", "id": rpc_id, "result": result}

    try:
        if method == "initialize":
            return ok({
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {"tools": {"listChanged": False}},
                "serverInfo": {"name": "gridforge", "version": VERSION},
                "instructions": (
                    "Capacity and thermal envelope engine for AI data-center halls. Every "
                    "numeric field carries an evidence class E0-E7 and a provenance digest. "
                    "Do not present an E0 or E1 figure as a property of a physical asset: "
                    "it is modelled. The calibration block on each result states how far "
                    "this engine has been reconciled against site data."),
            })
        if method in ("notifications/initialized", "initialized"):
            return None
        if method == "ping":
            return ok({})
        if method == "tools/list":
            return ok({"tools": mcp_tools()})
        if method == "tools/call":
            return ok(_mcp_call_tool(params, tier, charge))
        raise RpcError(-32601, f"method not found: {method}")
    except RpcError as exc:
        if rpc_id is None:
            return None
        err = {"code": exc.code, "message": exc.message}
        if exc.data is not None:
            err["data"] = exc.data
        return {"jsonrpc": "2.0", "id": rpc_id, "error": err}


class Handler(BaseHTTPRequestHandler):
    server_version = f"gridforge/{VERSION}"
    limiter = _RateLimiter(RATE_LIMIT_PER_MINUTE)

    def log_message(self, fmt: str, *args) -> None:  # pragma: no cover - noise
        if os.environ.get("GRIDFORGE_ACCESS_LOG"):
            super().log_message(fmt, *args)

    # -- plumbing ----------------------------------------------------------
    def _cors(self) -> None:
        origins = _allowed_origins()
        origin = self.headers.get("Origin")
        allow = "*" if "*" in origins else (origin if origin in origins else "")
        if allow:
            self.send_header("Access-Control-Allow-Origin", allow)
            self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-API-Key, Authorization")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")

    def _send(self, status: int, payload: dict) -> None:
        data = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self._usage_headers()
        self._cors()
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def _client_key(self) -> str:
        return (self.headers.get("X-Forwarded-For") or self.client_address[0] or "?").split(",")[0]

    def _supplied_key(self) -> str:
        return (self.headers.get("X-API-Key")
                or (self.headers.get("Authorization") or "").removeprefix("Bearer ").strip())

    def _tier(self) -> Tier:
        supplied = self._supplied_key()
        if supplied and supplied in _api_keys():
            return Tier.CLIENT
        return Tier.PUBLIC

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        path = urlparse(self.path).path.rstrip("/") or "/"
        if path in ("/health", "/"):
            return self._send(200, {"ok": True, "service": "gridforge", "version": VERSION})
        if path == "/v1/version":
            return self._send(200, {
                "version": VERSION,
                "auth_configured": bool(_api_keys()),
                "rate_limit_per_minute": RATE_LIMIT_PER_MINUTE,
                "tier": self._tier().value,
                "endpoints": sorted(ROUTES) + sorted(GET_ROUTES),
                "unit_rates": dict(sorted(UNIT_COST.items())),
                "metering": {
                    "durable": METER.durable,
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
            led = load_ledger()
            block = accuracy_block(calibration_keys(), led)
            block["ledger_sources"] = len(led.sources)
            block["policy"] = (
                "An observation must be E5 or above — site data, not another run of our "
                "own model — and client site data never enters the published ledger.")
            return self._send(200, block)
        if path == "/v1/tools":
            return self._send(200, catalogue())
        if path == "/v1/usage":
            if self._tier() is not Tier.CLIENT:
                return self._send(401, {"error": "an API key is required to read its usage"})
            return self._send(200, METER.statement(self._supplied_key()))
        return self._send(404, {"error": "not found",
                                "endpoints": sorted(ROUTES) + sorted(GET_ROUTES)})

    # -- metering ----------------------------------------------------------
    def _charge(self, endpoint: str, body: dict | None):
        """Bill the call, or explain why it cannot be billed.

        Returns None when the call may proceed (and the units are already on the
        account), or a dict describing the refusal. Billing happens BEFORE the
        work: an agent in a loop can otherwise run a month's quota of solves
        while the first response is still being rendered.
        """
        key = self._supplied_key()
        if self._tier() is not Tier.CLIENT or not key:
            return None
        units = units_for(endpoint, body)
        if units <= 0:
            return None
        if METER.would_exceed(key, units):
            u = METER.statement(key)
            return {"error": "monthly unit quota exhausted",
                    "units_required": units, "units_used": u["units"],
                    "monthly_quota": u["monthly_quota"], "month": u["month"],
                    "fix": "raise the quota on this key, or issue a second key"}
        self._last_usage = METER.record(key, endpoint, units)
        self._last_units = units
        return None

    def _usage_headers(self) -> None:
        units = getattr(self, "_last_units", None)
        usage = getattr(self, "_last_usage", None)
        if units is None or usage is None:
            return
        self.send_header("X-GridForge-Units", str(units))
        self.send_header("X-GridForge-Units-Month", str(usage.units))
        plan = key_plans().get(self._supplied_key())
        if plan and plan.monthly_quota:
            self.send_header("X-GridForge-Units-Remaining",
                             str(max(0, plan.monthly_quota - usage.units)))

    def do_POST(self) -> None:  # noqa: N802
        path = urlparse(self.path).path.rstrip("/") or "/"
        if path not in ROUTES and path != "/mcp":
            return self._send(404, {"error": "not found",
                                    "endpoints": sorted(ROUTES) + ["/mcp"]})

        if not self.limiter.allow(self._client_key()):
            return self._send(429, {"error": "rate limit exceeded",
                                    "limit_per_minute": RATE_LIMIT_PER_MINUTE})
        tier = self._tier()
        required = Tier.CLIENT if path == "/mcp" else ROUTES[path][1]
        if required is Tier.CLIENT and tier is Tier.PUBLIC:
            if not _api_keys():
                return self._send(503, {
                    "error": "paid endpoints are not configured on this deployment",
                    "fix": "set GRIDFORGE_API_KEYS to enable them"})
            return self._send(401, {"error": "an API key is required for this endpoint",
                                    "public_endpoint": "/v1/qualify",
                                    "tool_schemas": "/v1/tools"})

        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY_BYTES:
            return self._send(413, {"error": "payload too large",
                                    "max_bytes": MAX_BODY_BYTES})
        raw = self.rfile.read(length) if length else b"{}"
        try:
            body = json.loads(raw or b"{}")
        except json.JSONDecodeError as exc:
            return self._send(400, {"error": f"invalid JSON: {exc}"})

        if path == "/mcp":
            return self._serve_mcp(body, tier)

        if not isinstance(body, dict):
            return self._send(400, {"error": "expected a JSON object"})

        denied = self._charge(path, body)
        if denied:
            return self._send(402, denied)

        handler = ROUTES[path][0]
        try:
            return self._send(200, handler(body, tier))
        except ApiError as exc:
            return self._send(exc.status, {"error": exc.message, **exc.extra})
        except IntakeError as exc:
            return self._send(422, {"error": str(exc)})
        except Exception as exc:  # pragma: no cover - last resort
            return self._send(500, {"error": "engine error", "detail": str(exc)[:300]})

    def _serve_mcp(self, body, tier: Tier) -> None:
        """JSON-RPC 2.0, single request or batch. Notifications get 202 and no body."""
        charge = lambda endpoint, args: self._charge(endpoint, args)  # noqa: E731
        if isinstance(body, list):
            if not body:
                return self._send(400, {"jsonrpc": "2.0", "id": None,
                                        "error": {"code": -32600, "message": "empty batch"}})
            out = [r for r in (handle_mcp(m if isinstance(m, dict) else {}, tier, charge)
                               for m in body) if r is not None]
            if not out:
                self.send_response(202)
                self._cors()
                self.end_headers()
                return
            return self._send(200, out)
        if not isinstance(body, dict):
            return self._send(400, {"jsonrpc": "2.0", "id": None,
                                    "error": {"code": -32600, "message": "expected an object"}})
        try:
            result = handle_mcp(body, tier, charge)
        except Exception as exc:  # pragma: no cover - last resort
            return self._send(200, {"jsonrpc": "2.0", "id": body.get("id"),
                                    "error": {"code": -32603, "message": "engine error",
                                              "data": str(exc)[:300]}})
        if result is None:
            self.send_response(202)
            self._cors()
            self.end_headers()
            return
        return self._send(200, result)


def serve(host: str = "0.0.0.0", port: int = 8080) -> None:  # pragma: no cover - entry point
    httpd = ThreadingHTTPServer((host, port), Handler)
    keys = _api_keys()
    print(f"gridforge {VERSION} listening on http://{host}:{port}")
    print(f"  public : POST /v1/qualify")
    print(f"  client : POST /v1/screen, /v1/study, /v1/portfolio "
          f"({'keys configured' if keys else 'DISABLED — set GRIDFORGE_API_KEYS'})")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        httpd.shutdown()


def make_server(host: str = "127.0.0.1", port: int = 0) -> ThreadingHTTPServer:
    """Used by the tests, and by anyone embedding the engine in their own process."""
    return ThreadingHTTPServer((host, port), Handler)
