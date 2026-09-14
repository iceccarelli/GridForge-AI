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

Auth: X-API-Key, or Authorization: Bearer <key>, against GRIDFORGE_API_KEYS
(comma separated). With no keys configured the paid endpoints refuse rather than
open — a misconfigured deployment must fail closed.
"""
from __future__ import annotations

import json
import os
import threading
import time
from collections import defaultdict, deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

from ..compute.library import PLATFORMS, UNPUBLISHED_PLATFORMS
from ..intake.loader import IntakeError, blank_intake, load_document
from ..reporting import to_html, to_markdown
from ..reporting.gates import ReportMode, run_all_gates
from ..reporting.portfolio import SiteEntry, rank
from ..commercial import ENGAGEMENTS, engagement
from ..reporting.deck import build as build_deck_report
from ..reporting.deck import to_html as deck_to_html
from ..reporting.proposal import build as build_proposal_report
from ..reporting.screen import build as build_screen_report
from ..reporting.study import build as build_study_report
from ..reporting.study import collect_claims
from ..reporting.study import Objective
from ..scenario import run_all
from ..scenario.knobs import SENSITIVITY_KNOBS
from ..serialize import model_pack
from .payloads import qualify_payload, screen_payload
from .tiers import Tier

VERSION = "0.5.0"
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
    raw = os.environ.get("GRIDFORGE_API_KEYS", "")
    return {k.strip() for k in raw.split(",") if k.strip()}


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
}


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
        self._cors()
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def _client_key(self) -> str:
        return (self.headers.get("X-Forwarded-For") or self.client_address[0] or "?").split(",")[0]

    def _tier(self) -> Tier:
        supplied = (self.headers.get("X-API-Key")
                    or (self.headers.get("Authorization") or "").removeprefix("Bearer ").strip())
        keys = _api_keys()
        if supplied and supplied in keys:
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
                "endpoints": sorted(ROUTES) + ["/v1/platforms", "/v1/intake/template"],
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
        return self._send(404, {"error": "not found", "endpoints": sorted(ROUTES)})

    def do_POST(self) -> None:  # noqa: N802
        path = urlparse(self.path).path.rstrip("/") or "/"
        route = ROUTES.get(path)
        if route is None:
            return self._send(404, {"error": "not found", "endpoints": sorted(ROUTES)})
        handler, required = route

        if not self.limiter.allow(self._client_key()):
            return self._send(429, {"error": "rate limit exceeded",
                                    "limit_per_minute": RATE_LIMIT_PER_MINUTE})
        tier = self._tier()
        if required is Tier.CLIENT and tier is Tier.PUBLIC:
            if not _api_keys():
                return self._send(503, {
                    "error": "paid endpoints are not configured on this deployment",
                    "fix": "set GRIDFORGE_API_KEYS to enable them"})
            return self._send(401, {"error": "an API key is required for this endpoint",
                                    "public_endpoint": "/v1/qualify"})

        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY_BYTES:
            return self._send(413, {"error": "payload too large",
                                    "max_bytes": MAX_BODY_BYTES})
        raw = self.rfile.read(length) if length else b"{}"
        try:
            body = json.loads(raw or b"{}")
        except json.JSONDecodeError as exc:
            return self._send(400, {"error": f"invalid JSON: {exc}"})
        if not isinstance(body, dict):
            return self._send(400, {"error": "expected a JSON object"})

        try:
            return self._send(200, handler(body, tier))
        except ApiError as exc:
            return self._send(exc.status, {"error": exc.message, **exc.extra})
        except IntakeError as exc:
            return self._send(422, {"error": str(exc)})
        except Exception as exc:  # pragma: no cover - last resort
            return self._send(500, {"error": "engine error", "detail": str(exc)[:300]})


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
