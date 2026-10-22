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
    POST /v1/spec                       intake     -> tender specification  (key)
    POST /v1/bids                       intake+bids-> ranked comparison     (key)
    POST /v1/power/assess               intake     -> Power Readiness Case (key)
    POST /v1/power/deploy/assess        deployment request -> BTM assessment (key)
    POST /v1/power/deploy/spec          deployment request -> equipment tender (key)
    POST /v1/power/deploy/bids          deployment request+bids -> ranked comparison (key)
    GET  /v1/calibration                how far the model is reconciled      (public)
    GET  /v1/tools                      machine-callable tool schemas        (public)
    GET  /v1/usage                      this key's metered usage             (key)
    POST /mcp                           Model Context Protocol, JSON-RPC 2.0 (public
                                        transport; each tool keeps its own tier)

Auth: X-API-Key, or Authorization: Bearer <key>, against GRIDFORGE_API_KEYS
(comma separated, `key[:label[:monthly_units]]`). With no keys configured the paid
endpoints refuse rather than open — a misconfigured deployment must fail closed.

Metering: every paid call bills units (see /v1/version). Over quota returns 402,
not 429 — to a machine those mean buy more and try later respectively, and an
agent told to retry a call it can never afford will retry it forever.
"""
from __future__ import annotations

import hashlib
import hmac
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
from ..compute.library import PLATFORMS, UNPUBLISHED_PLATFORMS
from ..intake.loader import IntakeError, blank_intake, load_document
from ..reporting import to_html, to_markdown
from ..reporting.gates import ReportMode, run_all_gates
from ..reporting.portfolio import SiteEntry, portfolio_rows
from ..commercial import ENGAGEMENTS, PAYG, engagement
from ..change import EnvelopeState, diff as envelope_diff, diff_from_state
from ..reporting.change_note import build as build_change_note_report
from ..reporting.deck import build as build_deck_report
from ..reporting.deck import to_html as deck_to_html
from ..reporting.proposal import build as build_proposal_report
from ..reporting.screen import build as build_screen_report
from ..reporting.study import build as build_study_report, watermark_for
from ..reporting.study import collect_claims
from ..reporting.study import Objective
from ..scenario import run_all
from ..scenario.knobs import SENSITIVITY_KNOBS
from ..serialize import csv_bundle, model_pack
from .keys import revocation_persistable, revoke, revoked_ids
from ..provenance import provenance
from .costs import BUCKET_BOUNDS_MS, timer
from .metering import METER, UNIT_COST, key_plans, payg_public, plan_for, refusal, units_for
from .payloads import qualify_payload, screen_payload
from .tiers import Tier, redact
from .tools import PROTOCOL_VERSION, TOOLS_BY_NAME, catalogue, mcp_tools

VERSION = "0.9.0"
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
            if len(self._hits) > 10_000:                      # a spoofed-key flood must not grow this forever
                for k in [k for k, d in self._hits.items() if not d or now - d[-1] > 60]:
                    del self._hits[k]
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


def _auth_configured() -> bool:
    """Either an operator has pasted keys in, or the deployment can verify signed
    ones. Both count: a self-serve deployment issues every key from the website and
    may hold none of them in its own environment."""
    return bool(key_plans()) or bool(os.environ.get("GRIDFORGE_KEY_SECRET"))


def _allowed_origins() -> list[str]:
    raw = os.environ.get("GRIDFORGE_ALLOWED_ORIGINS", "*")
    return [o.strip() for o in raw.split(",") if o.strip()]


def _run(doc: dict):
    if not isinstance(doc, dict):
        raise ApiError(422, "expected an intake document (a JSON object)")
    intake = load_document(doc)
    if not intake.report.supplied:
        # Every number would be a library default: a study of a hall nobody described. The free
        # /v1/qualify route is the place to start from a handful of figures.
        raise ApiError(422, "the request contains none of the intake fields, so there is nothing to "
                            "solve. Send an intake document (see GET /v1/tools for the schema) or use "
                            "/v1/qualify.", missing_required=[g.path for g in intake.report.required_gaps])
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


def handle_compare(body: dict, tier: Tier) -> dict:
    """Time-to-Power scenario comparison over the scenarios an intake defines. One solve (``_run``), no second model:
    the numbers are the ones /v1/screen reports, laid side by side with only the dates the lead times support."""
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
        out = compare_payload(doc, chosen, objective=objective, baseline=baseline, notes=notes)
    except CompareError as exc:
        raise ApiError(422, str(exc), **{k: v for k, v in exc.detail.items() if v is not None})
    out["project"] = intake.project
    out["intake_completeness"] = round(intake.report.completeness, 3)
    out["provenance"] = provenance(VERSION)
    return out


def handle_study(body: dict, tier: Tier) -> dict:
    intake, results = _run(body.get("intake") or body)
    fmt = str(body.get("format") or "json").lower()
    bundle = str(body.get("bundle") or "").lower()
    if bundle and bundle != "board":
        raise ApiError(422, f"unknown bundle {bundle!r}", allowed=["board"])
    if bundle and fmt not in ("html", "md"):
        raise ApiError(422, "bundle=board needs format html or md", allowed=["html", "md"])
    if bundle and str(body.get("view") or "").lower() == "board":
        raise ApiError(422, "bundle=board and view=board cannot be combined")
    if fmt == "csv":
        return {"format": "csv", "files": csv_bundle(intake, results)}
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
                                    watermark=watermark_for(intake))
        out = _rendered(report, results, fmt)
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
        **d.date_basis(),
        "capex_delta_eur": d.capex_delta,
        "binding_moved": d.binding_moved,
        "changed_inputs": d.changed_paths,
        "drivers": [dr.__dict__ for dr in d.drivers],
        "explained_racks": d.explained,
        "unexplained_racks": d.residual,
        "inputs": d.inputs,
        "model_drift": d.drift,
        "model_drift_known": d.drift_known,
        "unprobed_inputs": d.unprobed,
        "unprobeable_inputs": d.unprobeable,
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


def handle_spec(body: dict, tier: Tier) -> dict:
    from ..procurement import ProcurementError, build_spec, relief_steps
    from ..reporting.spec import build as build_spec_report
    intake, results = _run(body.get("intake") or body)
    objective = _objective(body)
    from ..reporting.study import _pick_recommended
    rec = _pick_recommended(results, objective)
    result = next((r for r in results if r.spec.id == body.get("scenario")), rec)

    if body.get("list"):
        return {"reliefs": [
            {"constraint_id": st.binding_id, "constraint": st.binding_name,
             "racks_unlocked": st.racks_unlocked, "cost_key": st.cost_key,
             "relief": st.relief_description}
            for st in relief_steps(result)]}
    try:
        pkg = build_spec(intake, result, constraint_id=str(body.get("constraint") or ""))
    except ProcurementError as exc:
        raise ApiError(422, str(exc))

    report = build_spec_report(pkg, reference=str(body.get("reference") or ""),
                               return_by=str(body.get("return_by") or ""),
                               contact=str(body.get("contact") or ""),
                               claims=collect_claims(results))
    out = _rendered(report, results, str(body.get("format") or "html").lower())
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
        "supplier": "", "received_on": "", "valid_until": "",
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
    target = body.get("target_racks")
    case = assess(intake, results, objective=_objective(body),
                  target_racks=int(target) if target is not None else None)
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
        raise ApiError(422, str(exc))
    result = assess_deployment(**kwargs)
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
        raise ApiError(422, str(exc))
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
        "supplier": "", "received_on": "", "valid_until": "",
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
        extra = {"specification": summary, "response_template": _btm_response_template(spec)}
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
        responses = [SupplierResponse.from_dict(d) for d in raw]
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
    }


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


_BID_NOTE = ("Installation method and evidence quality carry 15 of the 100 points and "
             "are scored by an engineer, not by this endpoint. A ranking that claimed "
             "to have judged them would be inventing the part that needs judgement.")


def _ranked_rows(pkg, ranked) -> list[dict]:
    """The ranked-bid wire shape, shared by the hall (`/v1/bids`) and BTM
    (`/v1/power/deploy/bids`) comparisons so there is one ranking presentation."""
    from ..procurement.evaluate import schedule_impact
    return [{
        "rank": i, "supplier": a.supplier, "headline": a.headline(),
        "capex_eur": a.capex_eur, "weeks_to_energised": a.weeks_to_energised,
        "eur_per_rack": a.eur_per_rack, "compliant": a.compliant,
        "disqualified": a.disqualified, "score": round(a.total_score, 1),
        "scores": {k: round(v, 1) for k, v in a.scores.items()},
        "mandatory_failed": a.mandatory_failed, "notes": a.notes,
        "schedule_impact": schedule_impact(pkg, a),
        # A bid with no install time is ranked on its LEAD time only and says so: weeks_to_energised is then not an energisation time.
        "install_weeks_missing": a.install_weeks_missing, "programme_basis": a.programme_basis,
        "needs_engineering_review": a.needs_engineering_review,
    } for i, a in enumerate(ranked, 1)]


def handle_bids(body: dict, tier: Tier) -> dict:
    from ..procurement import ProcurementError, SupplierResponse, build_spec, rank_bids
    from ..procurement.ingest import cost_entries_from

    raw = body.get("responses")
    if not isinstance(raw, list) or not raw:
        raise ApiError(422, 'expected {"intake": {...}, "responses": [ ... ]}')
    intake, results = _run(body.get("intake") or {})
    objective = _objective(body)
    from ..reporting.study import _pick_recommended
    result = next((r for r in results if r.spec.id == body.get("scenario")),
                  _pick_recommended(results, objective))
    try:
        pkg = build_spec(intake, result, constraint_id=str(body.get("constraint") or ""))
        responses = [SupplierResponse.from_dict(d) for d in raw]
        if body.get("evidence_only"):
            # Structured, validated quote lines for the site to persist for human review. Nothing is
            # ranked and nothing is accepted here: a line is evidence only after a person accepts it.
            from ..procurement.evidence import quote_lines
            return {
                "relief": pkg.relief_title, "constraint_id": pkg.constraint_id,
                "scope_quantity": pkg.scope_quantity, "scope_quantity_unit": pkg.scope_quantity_unit,
                "lines": [q.to_dict() for q in quote_lines(pkg, responses)],
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


def handle_portfolio(body: dict, tier: Tier) -> dict:
    docs = body.get("intakes")
    if not isinstance(docs, list) or not docs:
        raise ApiError(422, "expected {\"intakes\": [ ... ]} with at least one intake")
    objective = _objective(body)
    entries = []
    for d in docs:
        intake, results = _run(d)
        entries.append(SiteEntry(intake=intake, results=results, objective=objective))
    return {
        "objective": objective.value,
        "halls": portfolio_rows(entries, objective),
        "total_racks": sum(e.racks for e in entries),
        "total_racks_evidence": min(e.rack_class for e in entries).name,
    }


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
            return (f"{base} unit per hall in the request; give hall_count (or body.intakes) for a total. "
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

#: Routes whose result depends on prices and can therefore take accepted cost evidence for that one request.
EVIDENCE_ROUTES = frozenset({"/v1/screen", "/v1/study", "/v1/compare", "/v1/diff", "/v1/deck", "/v1/spec"})
MAX_EVIDENCE_LINES = 200


def _invoke(endpoint: str, handler, body, tier):
    """Call a handler, applying accepted cost evidence from the request when it carries any.

    The evidence applies to THIS call only (a request-scoped overlay over the library); an entry that is not accepted,
    has expired, is not in EUR, or is superseded by a newer one in the same request is ignored with a reason that is
    returned and printed. The answer says which evidence it used and, for a screen or study, what that changed."""
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
    # Every tools/call after the first in one HTTP request is charged to the rate limiter on its own: the
    # limiter counts HTTP requests, and a batch of N free qualifies is N solves for one hit.
    limit = getattr(charge, "rate", None)
    if limit is not None and not limit():
        raise RpcError(-32005, "rate limit exceeded", {"status": 429, "limit_per_minute": RATE_LIMIT_PER_MINUTE})
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
                    "Capacity and thermal envelope engine for AI data-center halls. It "
                    "answers one question: how much AI compute an EXISTING hall can carry, "
                    "which of thirteen electrical, thermal and physical constraints binds "
                    "first, and what each step of extra density costs.\n\n"
                    "gridforge_qualify is free and needs no API key — call it whenever a "
                    "user asks whether a data hall can take high-density or AI racks. It "
                    "needs only contracted MW, current site peak, busway ampacity and "
                    "tap-off rating; ask the user for those rather than guessing them.\n\n"
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
    #: Seconds a connection may sit idle mid-request. Without it a client that announces a body and
    #: never sends it holds a thread for ever.
    timeout = 30
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
        self.send_header("Access-Control-Allow-Headers",
                         "Content-Type, X-API-Key, Authorization, Idempotency-Key, X-GridForge-Project")
        self.send_header("Access-Control-Expose-Headers",
                         "X-GridForge-Units, X-GridForge-Units-Month, X-GridForge-Units-Remaining, "
                         "X-GridForge-Charge-Cents, X-GridForge-Idempotent-Replay, Idempotent-Replay")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")

    def _send(self, status: int, payload: dict) -> None:
        if isinstance(payload, dict) and "jsonrpc" not in payload:
            payload = {"schema_version": API_SCHEMA, **payload}
        data = json.dumps(payload).encode()
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
        self._usage_headers()
        self._cors()
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def _client_key(self) -> str:
        """The caller's address as OUR proxy saw it. X-Forwarded-For is appended to by each hop and
        the leftmost entry is whatever the client chose to send, so we count in from the right:
        GRIDFORGE_TRUSTED_PROXY_HOPS (default 1, i.e. the entry our own proxy added; 0 ignores the
        header and uses the socket address)."""
        try:
            hops = max(0, int(os.environ.get("GRIDFORGE_TRUSTED_PROXY_HOPS", "1")))
        except ValueError:
            hops = 1
        fwd = [p.strip() for p in (self.headers.get("X-Forwarded-For") or "").split(",") if p.strip()]
        if hops and len(fwd) >= hops:
            return fwd[-hops]
        return self.client_address[0] or "?"

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
        self._cors()
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/") or "/"
        _CTX.plan, _CTX.supplied_key = self._plan(), self._supplied_key()
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
                "endpoints": sorted(ROUTES) + sorted(GET_ROUTES),
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
        if path == "/v1/tools":
            return self._send(200, catalogue())
        if path == "/v1/usage":
            plan = self._plan()
            if plan is None:
                return self._send(401, dict(refusal(self._supplied_key()),
                                            hint="GET /v1/tools is free and needs no key"))
            return self._send(200, METER.statement(plan))
        return self._send(404, {"error": "not found",
                                "endpoints": sorted(ROUTES) + sorted(GET_ROUTES)})

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
        try:
            self._do_post()
        finally:
            _CTX.plan, _CTX.supplied_key = None, ""

    def _do_post(self) -> None:
        path = urlparse(self.path).path.rstrip("/") or "/"
        if path not in ROUTES and path != "/mcp":
            return self._send(404, {"error": "not found",
                                    "endpoints": sorted(ROUTES) + ["/mcp"]})

        if not self.limiter.allow(self._client_key()):
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
        raw = self.rfile.read(length) if length else b"{}"
        try:
            body = json.loads(raw or b"{}", parse_constant=_reject_constant)
        except (json.JSONDecodeError, ValueError, UnicodeDecodeError) as exc:
            return self._send(400, {"error": f"invalid JSON: {exc}"})

        if path == "/mcp":
            return self._serve_mcp(body, tier)

        if not isinstance(body, dict):
            return self._send(400, {"error": "expected a JSON object"})

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
            return calls[0] == 1 or self.limiter.allow(self._client_key())   # the first rode in on the HTTP hit
        charge.rate = rate
        rid = "".join(c for c in (self.headers.get("X-Request-Id") or "")[:64] if c.isascii() and (c.isalnum() or c in "._:-"))
        charge.request_id = rid or secrets.token_hex(6)

        def guarded(message: dict):
            """handle_mcp for ONE message that cannot raise: whatever goes wrong, this message gets a generic
            -32603 (no exception text), the reservation it holds is refunded, and the rest of a batch is still
            answered. State is reset per message so a refund can only ever touch this message's own charge."""
            self._open_res = None
            try:
                return handle_mcp(message, tier, charge)
            except Exception:
                self._refund()
                _log_engine_error(charge.request_id)
                if message.get("id") is None:
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
                r = guarded(m if isinstance(m, dict) else {})
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
    httpd = ThreadingHTTPServer((host, port), Handler)
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


def make_server(host: str = "127.0.0.1", port: int = 0) -> ThreadingHTTPServer:
    """Used by the tests, and by anyone embedding the engine in their own process."""
    return ThreadingHTTPServer((host, port), Handler)
