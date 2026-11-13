"""The published API contract is what the engine does.

What an outside engineer or an agent can read about the engine (GET /v1/tools, public/reference/tools.json, /openapi.json, /developers) is
checked here against the engine itself, in process and over a real socket:

  * POST /v1/qualify: every key the handler reads from the body is a property of the published input schema, every property is read, a
    valid example of each is accepted, and what the schema says `assumed_fields` does is what it does;
  * the 503 / 429 / 402 answers: which carry a Retry-After header, what each body holds;
  * the MCP error codes: each one is produced by the situation the document names, and no other code exists;
  * the browser (CORS) policy the document states;
  * schema_version in the body and X-GridForge-Schema in the header;
  * every request example the OpenAPI document carries is accepted by the real server, and the top-level keys the document names for a
    route are keys that route returns for its example.

lib/openapi-honesty.json and lib/openapi-examples.json hold the facts and examples the TypeScript document is generated from; this file is
the python half of tests/site/openapi-examples.test.ts and tests/site/openapi-contract.test.ts.
"""
from __future__ import annotations

import json
import os
import re
import threading
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from types import SimpleNamespace

import pytest
from openapi_example_support import EXAMPLES, resolve

from gridforge.api import server as S
from gridforge.api.tiers import Tier
from gridforge.api.tools import QUALIFY_FIGURES, TOOLS, TOOLS_BY_NAME
from gridforge.compute.library import PLATFORMS

ROOT = Path(__file__).resolve().parents[1]
HONESTY = json.loads((ROOT / "lib" / "openapi-honesty.json").read_text())
PUBLISHED = json.loads((ROOT / "public" / "reference" / "tools.json").read_text())
QUALIFY_TOOL = TOOLS_BY_NAME["gridforge_qualify"]
QUALIFY_SCHEMA = QUALIFY_TOOL["inputSchema"]
PROPS = QUALIFY_SCHEMA["properties"]
HALL = json.loads((ROOT / "public" / "reference" / "examples" / "qualify-request.json").read_text())
KEY = "sk_published_contract"

#: A valid value for every documented qualify property: the one place the test needs to know what each means.
VALID = {
    **HALL,
    "firm_capacity_MVA": 13,
    "platform": "gb200_nvl72",
    "objective": "min_cost",
    "assumed_fields": ["tapoff_max_A"],
    "client": "Synthetic Operator",
    "reference": "REF-1",
    "site_name": "Synthetic Campus",
    "metro": "Dublin",
    "country": "IE",
    "hall_id": "HALL-9",
}


# --- a real server, and a way to talk to it -----------------------------------------------------------------------------------
@pytest.fixture(scope="module")
def base():
    previous = (S.Handler.limiter.per_minute, os.environ.get("GRIDFORGE_API_KEYS"))
    os.environ["GRIDFORGE_API_KEYS"] = KEY
    S.Handler.limiter.per_minute = 0
    httpd = S.make_server("127.0.0.1", 0)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{httpd.server_address[1]}"
    httpd.shutdown()
    S.Handler.limiter.per_minute = previous[0]
    if previous[1] is None:
        os.environ.pop("GRIDFORGE_API_KEYS", None)
    else:
        os.environ["GRIDFORGE_API_KEYS"] = previous[1]


def call(base, path, body=None, *, key=None, method=None, headers=None, raw=None):
    """(status, response headers lower-cased, parsed JSON or None)."""
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    req = urllib.request.Request(base + path, data=data, method=method or ("POST" if data is not None else "GET"))
    if data is not None:
        req.add_header("Content-Type", "application/json")
    if key:
        req.add_header("X-API-Key", key)
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            status, hdrs, payload = r.status, r.headers, r.read()
    except urllib.error.HTTPError as e:
        status, hdrs, payload = e.code, e.headers, e.read()
    parsed = json.loads(payload) if payload else None
    return status, {k.lower(): v for k, v in hdrs.items()}, parsed


def rpc(base, message, **kw):
    return call(base, "/mcp", message, **kw)


def tools_call(name, arguments, rid=1):
    return {"jsonrpc": "2.0", "id": rid, "method": "tools/call", "params": {"name": name, "arguments": arguments}}


# =================================================================================================================================
# S3-4  POST /v1/qualify: the published schema is what the handler parses
# =================================================================================================================================
class RecordingBody(dict):
    """A request body that remembers every key the code asked it for. Enumerating it is recorded too, because an enumeration would read keys
    this record cannot name."""

    def __init__(self, *a, **k):
        super().__init__(*a, **k)
        self.read: set[str] = set()
        self.enumerated = False

    def get(self, key, default=None):
        self.read.add(key)
        return super().get(key, default)

    def __getitem__(self, key):
        self.read.add(key)
        return super().__getitem__(key)

    def __contains__(self, key):
        self.read.add(key)
        return super().__contains__(key)

    def __iter__(self):
        self.enumerated = True
        return super().__iter__()

    def keys(self):
        self.enumerated = True
        return super().keys()

    def items(self):
        self.enumerated = True
        return super().items()


def keys_the_handler_reads(body: dict) -> set[str]:
    rec = RecordingBody(body)
    S.handle_qualify(rec, Tier.PUBLIC)
    assert not rec.enumerated, "the handler enumerates its body, so the keys it reads cannot be listed by recording"
    return rec.read


def test_the_documented_figures_are_the_engines_own_seven_in_the_order_it_asks_them():
    assert list(QUALIFY_FIGURES) == list(S.QUALIFY_FIELDS)
    assert set(QUALIFY_SCHEMA["required"]) <= set(S.QUALIFY_FIELDS)
    assert PROPS["assumed_fields"]["items"]["enum"] == list(S.QUALIFY_FIELDS)
    assert PROPS["assumed_fields"]["maxItems"] == len(S.QUALIFY_FIELDS)
    assert PROPS["assumed_fields"]["uniqueItems"] is True


def test_the_example_request_gives_a_value_for_every_documented_property_and_no_other():
    assert set(VALID) == set(PROPS)


def test_every_key_the_handler_reads_from_the_body_is_a_published_property_and_every_property_is_read():
    read_all = keys_the_handler_reads(VALID)
    assert read_all == set(PROPS), {"read_but_undocumented": sorted(read_all - set(PROPS)), "documented_but_never_read": sorted(set(PROPS) - read_all)}
    # and a thin request, which takes other branches, reads nothing outside the schema either
    assert keys_the_handler_reads({k: HALL[k] for k in QUALIFY_SCHEMA["required"]}) <= set(PROPS)


def test_the_only_other_body_key_the_route_reads_is_cost_evidence_and_the_route_refuses_it():
    """_invoke (the one place a solve starts) looks for `cost_evidence`; qualify takes none, so it is refused rather than ignored."""
    rec = RecordingBody(VALID)
    S._invoke("/v1/qualify", S.handle_qualify, rec, Tier.PUBLIC)
    assert rec.read - set(PROPS) == {"cost_evidence"}
    with pytest.raises(S.ApiError) as e:
        S._invoke("/v1/qualify", S.handle_qualify, {**HALL, "cost_evidence": []}, Tier.PUBLIC)
    assert e.value.status == 422 and "does not take cost_evidence" in e.value.message
    assert "cost_evidence" not in PROPS


@pytest.mark.parametrize("prop", sorted(PROPS))
def test_each_documented_property_with_a_valid_example_is_accepted_over_http(base, prop):
    body = {k: HALL[k] for k in QUALIFY_SCHEMA["required"]}
    body[prop] = VALID[prop]
    if prop == "assumed_fields":
        assert set(VALID[prop]) <= set(body), "a figure can be declared assumed only if it is sent"
    status, _, out = call(base, "/v1/qualify", body)
    assert status == 200, out
    assert out["as_found"]["binding_constraint"]


def test_the_engine_does_not_refuse_a_key_the_schema_does_not_list_it_ignores_it(base):
    """The published schema says additionalProperties:false. That is the contract for what to send; the engine does not enforce it, and the
    documents say so. An unlisted key changes nothing in the answer."""
    assert QUALIFY_SCHEMA["additionalProperties"] is False
    assert "does not validate a request against this schema" in QUALIFY_SCHEMA["description"]
    plain = call(base, "/v1/qualify", dict(HALL))[2]
    for extra in ({"evidence": "E7"}, {"tapoff_max_A_evidence": "E7"}, {"no_such_key": 1}, {"declared_evidence": {"tapoff_max_A": "E7"}}):
        status, _, out = call(base, "/v1/qualify", {**HALL, **extra})
        assert status == 200 and out == plain, extra


@pytest.mark.parametrize("platform", sorted(PLATFORMS))
def test_every_platform_in_the_enum_is_accepted_and_is_the_one_assessed(base, platform):
    assert PROPS["platform"]["enum"] == list(PLATFORMS)
    status, _, out = call(base, "/v1/qualify", {**HALL, "platform": platform})
    assert status == 200 and out["platform"]["id"] == platform


def test_the_platform_default_is_the_one_used_and_an_unknown_platform_is_refused(base):
    status, _, out = call(base, "/v1/qualify", dict(HALL))
    assert out["platform"]["id"] == PROPS["platform"]["default"]
    status, _, out = call(base, "/v1/qualify", {**HALL, "platform": "vr200_nvl144"})
    assert status == 422 and "unknown platform" in out["error"]


@pytest.mark.parametrize("objective", PROPS["objective"]["enum"])
def test_every_objective_in_the_enum_is_accepted(base, objective):
    assert call(base, "/v1/qualify", {**HALL, "objective": objective})[0] == 200


def test_any_three_of_the_seven_figures_are_enough_and_two_are_not_as_the_schema_says(base):
    figures = list(S.QUALIFY_FIELDS)
    required = set(QUALIFY_SCHEMA["required"])
    for chosen in (figures[:3], figures[-3:], [f for f in figures if f not in required][:3]):
        status, _, out = call(base, "/v1/qualify", {k: HALL[k] for k in chosen})
        assert status == 200, (chosen, out)
    status, _, out = call(base, "/v1/qualify", {k: HALL[k] for k in figures[:2]})
    assert status == 422 and "too little" in out["error"]
    # so `required` is the minimum the contract asks for, not the minimum the engine enforces; the description says exactly that
    assert "more than four of the seven figures are missing" in QUALIFY_SCHEMA["description"]
    assert call(base, "/v1/qualify", {k: v for k, v in HALL.items() if k not in required})[0] == 200


@pytest.mark.parametrize("figure", list(S.QUALIFY_FIELDS))
def test_a_figure_left_out_is_listed_under_intake_gaps(base, figure):
    status, _, out = call(base, "/v1/qualify", {k: v for k, v in HALL.items() if k != figure})
    assert status == 200
    assert S.QUALIFY_FIELDS[figure] in [g["path"] for g in out["intake"]["gaps"]]


def test_assumed_fields_does_what_its_description_says(base):
    plain = call(base, "/v1/qualify", dict(HALL))[2]
    declared = call(base, "/v1/qualify", {**HALL, "assumed_fields": ["tapoff_max_A", "contracted_MW"]})[2]
    # E5 -> E0 in the result's basis
    assert "tap-offs rated 63 A (E5)" in plain["as_found"]["basis"]
    assert "tap-offs rated 63 A (E0)" in declared["as_found"]["basis"]
    # inputs_declared_assumed: path, input, unit, value, evidence "E0", note; in the order the qualifier asks
    rows = declared["inputs_declared_assumed"]
    assert [r["path"] for r in rows] == ["grid.contracted_MW", "lv.tapoff_max_A"]
    for r in rows:
        assert set(r) == {"path", "input", "unit", "value", "evidence", "note"} and r["evidence"] == "E0"
    # intake.assumed_count says how many; completeness and required_inputs_missing still count them as supplied
    assert declared["intake"]["assumed_count"] == 2 and "assumed_count_note" in declared["intake"]
    assert declared["intake"]["completeness"] == plain["intake"]["completeness"]
    assert declared["intake"]["required_inputs_missing"] == plain["intake"]["required_inputs_missing"]
    # the label changes and the racks and the binding constraint do not
    assert declared["as_found"]["racks"] == plain["as_found"]["racks"]
    assert declared["after_relief"]["racks"] == plain["after_relief"]["racks"]
    assert declared["as_found"]["binding_constraint"] == plain["as_found"]["binding_constraint"]
    # omitted, null and [] are the plain request
    for plain_form in ({}, {"assumed_fields": None}, {"assumed_fields": []}):
        assert call(base, "/v1/qualify", {**HALL, **plain_form})[2] == plain
    # and the capability flag the description names is on
    assert S.CAPABILITIES["qualify_assumed_fields"] is True
    assert "capabilities.qualify_assumed_fields" in PROPS["assumed_fields"]["description"]


@pytest.mark.parametrize("bad,why", [
    (["no_such_figure"], "not one of the seven"),
    (["tapoff_max_A", "tapoff_max_A"], "a repeat"),
    ("tapoff_max_A", "not a list"),
    ({"tapoff_max_A": True}, "not a list"),
    ([["tapoff_max_A"]], "not a name"),
    (["firm_capacity_MVA"], "a figure that cannot be declared"),
    (list(S.QUALIFY_FIELDS) + ["contracted_MW"], "more entries than figures"),
])
def test_what_the_schema_says_assumed_fields_refuses_it_refuses_with_422_and_the_allowed_names(base, bad, why):
    status, _, out = call(base, "/v1/qualify", {**HALL, "assumed_fields": bad})
    assert status == 422, (why, out)
    assert out.get("allowed") == list(S.QUALIFY_FIELDS) or "repeats" in out["error"] or "lists" in out["error"]


def test_a_figure_that_is_not_sent_cannot_be_declared_assumed(base):
    status, _, out = call(base, "/v1/qualify", {**{k: v for k, v in HALL.items() if k != "plant_supply_C"}, "assumed_fields": ["plant_supply_C"]})
    assert status == 422 and "does not give" in out["error"]


def test_the_schema_describes_the_derived_firm_capacity_as_a_separate_assumed_list():
    """A firm capacity the qualifier derives from contracted_MW is reported under inputs_derived_assumed (class E0, with a required gap row),
    apart from inputs_declared_assumed, which holds only what the caller declared. The property and the tool's `returns` say so;
    tests/test_published_additive_keys.py checks the behaviour against any engine that has it."""
    description = PROPS["firm_capacity_MVA"]["description"]
    assert "inputs_derived_assumed" in description and "separate from inputs_declared_assumed" in description
    assert "grid.firm_capacity_MVA" in description and "cannot be named in assumed_fields" in description
    assert "inputs_derived_assumed" in QUALIFY_TOOL["returns"] and "inputs_declared_assumed" in QUALIFY_TOOL["returns"]


def test_published_tools_json_carries_the_same_qualify_schema_as_the_engine():
    published = next(t for t in PUBLISHED["tools"] if t["name"] == "gridforge_qualify")
    assert published["inputSchema"] == QUALIFY_SCHEMA


# =================================================================================================================================
# S3-5  retries and errors
# =================================================================================================================================
def keyed_intake_body():
    return {"intake": json.loads((ROOT / "examples" / "intake" / "reference_hall.json").read_text())}


def units_used(base) -> int:
    return call(base, "/v1/usage", key=KEY)[2]["units"]


def test_the_constants_the_documents_state_are_the_engines():
    c = HONESTY["engine_constants"]
    assert c["solve_shed_retry_after_seconds"] == S.SOLVE_RETRY_AFTER_SECONDS
    assert set(HONESTY["solving_routes"]) == set(S.SOLVING_ROUTES)


def test_a_shed_503_names_retry_after_and_retry_after_seconds_and_charges_nothing(base, monkeypatch):
    gate = S._SolveGate(1, 0)
    assert gate.enter("", False)                      # every slot taken
    monkeypatch.setattr(S, "SOLVE_GATE", gate)
    before = units_used(base)
    busy = next(c for c in HONESTY["service_unavailable"] if c["cause"] == "busy")
    for path, body, key in (("/v1/screen", keyed_intake_body(), KEY), ("/v1/qualify", dict(HALL), None)):
        status, headers, out = call(base, path, body, key=key)
        assert status == 503, (path, out)
        assert headers["retry-after"] == str(HONESTY["engine_constants"]["solve_shed_retry_after_seconds"])
        assert set(out) == set(busy["body_fields"]) | {"schema_version"}
        assert out["retryable"] is True and out["retry_after_seconds"] == S.SOLVE_RETRY_AFTER_SECONDS
        assert "nothing was charged" in out["error"]
        assert "x-gridforge-units" not in headers
    monkeypatch.undo()
    assert units_used(base) == before


def test_a_503_for_usage_that_cannot_be_recorded_has_retry_after_30_retryable_and_no_retry_after_seconds(base, monkeypatch):
    monkeypatch.setattr(S.METER, "reserve_ex", lambda *a, **k: SimpleNamespace(status="unavailable"))
    cause = next(c for c in HONESTY["service_unavailable"] if c["cause"] == "usage_not_recorded")
    status, headers, out = call(base, "/v1/screen", keyed_intake_body(), key=KEY)
    assert status == 503
    assert headers["retry-after"] == str(HONESTY["engine_constants"]["ledger_unavailable_retry_after_seconds"])
    assert set(out) == set(cause["body_fields"]) | {"schema_version"}
    assert out["retryable"] is True and "retry_after_seconds" not in out
    assert "nothing was charged" in out["error"]


def test_a_503_for_a_deployment_with_no_keys_has_no_retry_after_and_is_not_retryable(base, monkeypatch):
    monkeypatch.delenv("GRIDFORGE_API_KEYS", raising=False)
    monkeypatch.delenv("GRIDFORGE_KEY_SECRET", raising=False)
    cause = next(c for c in HONESTY["service_unavailable"] if c["cause"] == "paid_endpoints_not_configured")
    status, headers, out = call(base, "/v1/screen", keyed_intake_body())
    assert status == 503
    assert "retry-after" not in headers
    assert set(out) == set(cause["body_fields"]) | {"schema_version"}
    assert "retryable" not in out


def test_the_three_503_causes_the_documents_name_are_the_ones_in_the_source():
    causes = {c["cause"] for c in HONESTY["service_unavailable"]}
    assert causes == {"busy", "usage_not_recorded", "paid_endpoints_not_configured"}
    src = (ROOT / "gridforge" / "api" / "server.py").read_text()
    for text in ("the engine is busy; nothing was run and nothing was charged", "usage cannot be recorded right now; nothing was charged and no work was done",
                 "paid endpoints are not configured on this deployment"):
        assert text in src
    # every other 503 is on a route the contract names separately: the operator-only revoke, and the two calibration reads (integrity check)
    others = set(re.findall(r"(?:_send|ApiError)\(503, (?:\{\s*)?(?:\"error\": )?(f?\"[^\"]*\")", src))
    assert {o.strip('"') for o in others} >= {
        "the calibration ledger failed its integrity check and is not being served",
        "the calibration record store failed its integrity check and is not being served",
        "revocation is not persistable on this deployment",
    }


def test_a_429_carries_limit_per_minute_and_no_retry_after_header(base, monkeypatch):
    monkeypatch.setattr(S.Handler, "limiter", S._RateLimiter(2))
    seen = [call(base, "/v1/qualify", dict(HALL)) for _ in range(3)]
    assert [s for s, _, _ in seen] == [200, 200, 429]
    status, headers, out = seen[2]
    assert "retry-after" not in headers
    assert out["limit_per_minute"] == S.RATE_LIMIT_PER_MINUTE and out["error"] == "rate limit exceeded"


def test_a_402_is_not_a_429_has_no_retry_after_and_names_the_reset(base, monkeypatch):
    label = f"cap-{uuid.uuid4().hex[:8]}"
    capped = f"sk_capped_{uuid.uuid4().hex[:8]}"
    monkeypatch.setenv("GRIDFORGE_API_KEYS", f"{KEY},{capped}:{label}:1")
    assert call(base, "/v1/screen", keyed_intake_body(), key=capped)[0] == 200
    status, headers, out = call(base, "/v1/screen", keyed_intake_body(), key=capped)
    assert status == 402 and status != 429
    assert "retry-after" not in headers
    assert out["reason"] == "plan_quota_exhausted" and out["units_required"] == 1 and "resets_at" in out and "unit_price_cents" in out and "plan" in out


# --- the MCP codes --------------------------------------------------------------------------------------------------------------
DOCUMENTED_CODES = [e["code"] for e in HONESTY["mcp_errors"]]


def test_no_mcp_error_code_exists_in_the_source_that_the_documents_leave_out():
    src = (ROOT / "gridforge" / "api" / "server.py").read_text()
    in_source = {int(c) for c in re.findall(r"-32\d{3}", src)}
    assert in_source == set(DOCUMENTED_CODES), {"in_source_only": sorted(in_source - set(DOCUMENTED_CODES)), "documented_only": sorted(set(DOCUMENTED_CODES) - in_source)}
    assert len(DOCUMENTED_CODES) == len(set(DOCUMENTED_CODES))


def error_code(response) -> int:
    return response["error"]["code"]


def test_32600_invalid_request(base):
    status, _, out = rpc(base, {"jsonrpc": "2.0", "id": 1})
    assert status == 400 and error_code(out) == -32600
    status, _, out = rpc(base, [])
    assert status == 400 and error_code(out) == -32600                                   # empty batch
    too_many = [{"jsonrpc": "2.0", "id": i, "method": "ping"} for i in range(HONESTY["engine_constants"]["max_mcp_batch"] + 1)]
    status, _, out = rpc(base, too_many)
    assert status == 400 and error_code(out) == -32600
    status, _, out = rpc(base, [{"jsonrpc": "2.0", "id": 1, "method": "ping"}, 5])         # one bad message inside a batch: 200, its own slot
    assert status == 200 and "result" in out[0] and error_code(out[1]) == -32600


def test_there_is_no_32700_a_body_that_is_not_json_is_a_plain_400(base):
    status, _, out = call(base, "/mcp", raw=b"{not json")
    assert status == 400 and "jsonrpc" not in out and out["error"].startswith("invalid JSON")


def test_32601_method_not_found(base):
    status, _, out = rpc(base, {"jsonrpc": "2.0", "id": 1, "method": "resources/list"})
    assert status == 200 and error_code(out) == -32601


def test_32602_invalid_params(base):
    status, _, out = rpc(base, tools_call("gridforge_nope", {}))
    assert status == 200 and error_code(out) == -32602 and "gridforge_qualify" in out["error"]["data"]["available"]
    assert error_code(rpc(base, {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "gridforge_qualify", "arguments": [1]}})[2]) == -32602
    refused = rpc(base, tools_call("gridforge_qualify", {**HALL, "objective": "vibes"}))[2]
    assert error_code(refused) == -32602 and refused["error"]["data"]["allowed"]       # the REST 422, with its fields in data
    reuse = {"Idempotency-Key": f"pc-{uuid.uuid4().hex}"}
    assert "result" in rpc(base, tools_call("gridforge_qualify", HALL), key=KEY, headers=reuse)[2]
    other = rpc(base, tools_call("gridforge_qualify", {**HALL, "contracted_MW": 13}), key=KEY, headers=reuse)[2]
    assert error_code(other) == -32602 and other["error"]["data"]["status"] == 422
    toolong = rpc(base, tools_call("gridforge_qualify", HALL), key=KEY, headers={"Idempotency-Key": "k" * (S.MAX_IDEM_KEY_CHARS + 1)})[2]
    assert error_code(toolong) == -32602 and toolong["error"]["data"]["status"] == 400


def test_32001_a_metered_tool_without_a_key(base):
    status, _, out = rpc(base, tools_call("gridforge_screen", keyed_intake_body()))
    assert status == 200 and error_code(out) == -32001 and out["error"]["data"]["free_tool"] == "gridforge_qualify"


def test_32002_the_meter_refuses_a_call_over_the_cap(base, monkeypatch):
    label = f"cap-{uuid.uuid4().hex[:8]}"
    capped = f"sk_capped_{uuid.uuid4().hex[:8]}"
    monkeypatch.setenv("GRIDFORGE_API_KEYS", f"{KEY},{capped}:{label}:1")
    assert "result" in rpc(base, tools_call("gridforge_screen", keyed_intake_body()), key=capped)[2]
    status, _, out = rpc(base, tools_call("gridforge_screen", keyed_intake_body()), key=capped)
    assert status == 200 and error_code(out) == -32002
    assert out["error"]["data"]["status"] == 402 and out["error"]["data"]["reason"] == "plan_quota_exhausted"


def test_32003_busy_carries_retry_after_and_the_retry_fields(base, monkeypatch):
    gate = S._SolveGate(1, 0)
    assert gate.enter("", False)
    monkeypatch.setattr(S, "SOLVE_GATE", gate)
    status, headers, out = rpc(base, tools_call("gridforge_qualify", HALL))
    assert status == 200 and error_code(out) == -32003
    assert out["error"]["data"]["status"] == 503 and out["error"]["data"]["retryable"] is True
    assert out["error"]["data"]["retry_after_seconds"] == S.SOLVE_RETRY_AFTER_SECONDS
    assert headers["retry-after"] == str(S.SOLVE_RETRY_AFTER_SECONDS)


def test_32003_usage_that_cannot_be_recorded_carries_retry_after_30(base, monkeypatch):
    monkeypatch.setattr(S.METER, "reserve_ex", lambda *a, **k: SimpleNamespace(status="unavailable"))
    status, headers, out = rpc(base, tools_call("gridforge_screen", keyed_intake_body()), key=KEY)
    assert status == 200 and error_code(out) == -32003 and out["error"]["data"]["status"] == 503
    assert headers["retry-after"] == str(HONESTY["engine_constants"]["ledger_unavailable_retry_after_seconds"])


def test_32005_only_the_second_and_later_calls_of_one_http_request_meet_the_mcp_rate_limit(base, monkeypatch):
    monkeypatch.setattr(S.Handler, "limiter", S._RateLimiter(1))
    status, headers, out = rpc(base, [tools_call("gridforge_qualify", HALL, 1), tools_call("gridforge_qualify", HALL, 2)])
    assert status == 200
    assert "result" in out[0] and error_code(out[1]) == -32005
    assert out[1]["error"]["data"] == {"status": 429, "limit_per_minute": S.RATE_LIMIT_PER_MINUTE}
    # a second HTTP request is refused at the HTTP level, with a plain 429 body, not a JSON-RPC error
    status, headers, out = rpc(base, tools_call("gridforge_qualify", HALL, 3))
    assert status == 429 and "jsonrpc" not in out and out["limit_per_minute"] == S.RATE_LIMIT_PER_MINUTE


def test_32603_an_engine_error_returns_a_request_id_and_no_exception_text(base, monkeypatch):
    def boom(body, tier):
        raise RuntimeError("SECRET-DETAIL-THAT-MUST-NOT-LEAK")

    monkeypatch.setitem(S.ROUTES, "/v1/qualify", (boom, Tier.PUBLIC))
    status, _, out = rpc(base, tools_call("gridforge_qualify", HALL), headers={"X-Request-Id": "pc-req-1"})
    assert status == 200 and error_code(out) == -32603
    assert out["error"]["message"] == "engine error" and out["error"]["data"] == {"request_id": "pc-req-1"}
    assert "SECRET-DETAIL" not in json.dumps(out)


def test_a_notification_gets_202_and_no_body(base):
    status, _, out = rpc(base, {"jsonrpc": "2.0", "method": "notifications/initialized"})
    assert status == 202 and out is None


# =================================================================================================================================
# the browser policy
# =================================================================================================================================
def header_list(value: str | None) -> list[str]:
    return [x.strip() for x in (value or "").split(",") if x.strip()]


@pytest.fixture
def default_cors(monkeypatch):
    monkeypatch.delenv("GRIDFORGE_ALLOWED_ORIGINS", raising=False)
    monkeypatch.delenv("GRIDFORGE_PUBLIC_CORS", raising=False)


def test_the_cors_defaults_the_documents_state_are_the_engines():
    cors = HONESTY["cors"]
    assert cors["default_allowed_origins"] == list(S.DEFAULT_ALLOWED_ORIGINS)
    assert set(cors["public_paths"]) == set(S.PUBLIC_CORS_PATHS)


def test_an_allowed_origin_is_echoed_on_every_route_with_the_full_header_list(base, default_cors):
    cors = HONESTY["cors"]
    for origin in cors["default_allowed_origins"]:
        for method, path in (("OPTIONS", "/v1/screen"), ("OPTIONS", "/v1/qualify"), ("GET", "/v1/tools"), ("GET", "/v1/usage")):
            status, h, _ = call(base, path, method=method, headers={"Origin": origin}, key=KEY if path == "/v1/usage" else None)
            assert status in (200, 204), (method, path)
            assert h["access-control-allow-origin"] == origin and h["vary"] == "Origin"
            assert header_list(h["access-control-allow-headers"]) == cors["allow_headers_allowed_origin"]
            assert header_list(h["access-control-allow-methods"]) == cors["allow_methods"]
            assert header_list(h["access-control-expose-headers"]) == cors["expose_headers"]
            assert "access-control-allow-credentials" not in h


def test_a_preflight_is_answered_204(base, default_cors):
    status, h, body = call(base, "/v1/screen", method="OPTIONS", headers={"Origin": "https://timetopower.ai", "Access-Control-Request-Method": "POST"})
    assert status == 204 and body is None


def test_any_other_origin_may_read_only_the_public_routes_and_cannot_send_a_key(base, default_cors):
    cors = HONESTY["cors"]
    foreign = {"Origin": "https://example.com"}
    for path in cors["public_paths"]:
        status, h, _ = call(base, path, method="OPTIONS", headers=foreign)
        assert status == 204
        assert h["access-control-allow-origin"] == "*", path
        assert header_list(h["access-control-allow-headers"]) == cors["allow_headers_public_path"]
    status, h, _ = call(base, "/v1/qualify", dict(HALL), headers=foreign)
    assert status == 200 and h["access-control-allow-origin"] == "*"
    for path, method in (("/v1/screen", "OPTIONS"), ("/v1/tools", "GET"), ("/v1/usage", "GET"), ("/v1/platforms", "GET")):
        status, h, _ = call(base, path, method=method, headers=foreign, key=KEY if path == "/v1/usage" else None)
        assert "access-control-allow-origin" not in h, path


def test_an_operator_can_change_the_origin_list_and_turn_the_wildcard_off(base, monkeypatch):
    monkeypatch.setenv("GRIDFORGE_ALLOWED_ORIGINS", "https://preview.example")
    h = call(base, "/v1/screen", method="OPTIONS", headers={"Origin": "https://preview.example"})[1]
    assert h["access-control-allow-origin"] == "https://preview.example"
    assert "access-control-allow-origin" not in call(base, "/v1/screen", method="OPTIONS", headers={"Origin": "https://timetopower.ai"})[1]
    monkeypatch.setenv("GRIDFORGE_PUBLIC_CORS", "0")
    assert "access-control-allow-origin" not in call(base, "/v1/qualify", method="OPTIONS", headers={"Origin": "https://example.com"})[1]


# =================================================================================================================================
# S3-6  schema_version: the fact, and only the fact
# =================================================================================================================================
def test_the_schema_version_the_documents_state_is_the_one_the_engine_sends():
    v = HONESTY["schema_version"]
    assert v["value"] == S.API_SCHEMA == "gridforge/api/1"
    assert v["body_field"] == "schema_version" and v["header"] == "X-GridForge-Schema"


def test_every_json_response_carries_the_version_in_the_body_and_the_header_and_a_jsonrpc_body_the_header_only(base):
    v = HONESTY["schema_version"]
    responses = [
        call(base, "/v1/qualify", dict(HALL)),                                    # 200
        call(base, "/v1/qualify", {"contracted_MW": 1}),                          # 422
        call(base, "/v1/screen", keyed_intake_body()),                            # 401
        call(base, "/v1/nothing", {}),                                            # 404
        call(base, "/health"), call(base, "/v1/tools"), call(base, "/v1/version"),
        call(base, "/v1/qualify", raw=b"{not json"),                              # 400
    ]
    for status, headers, body in responses:
        assert headers[v["header"].lower()] == v["value"], status
        assert body[v["body_field"]] == v["value"], status
    for status, headers, body in (rpc(base, {"jsonrpc": "2.0", "id": 1, "method": "ping"}), rpc(base, [{"jsonrpc": "2.0", "id": 1, "method": "ping"}])):
        assert status == 200 and headers[v["header"].lower()] == v["value"]
        assert v["body_field"] not in (body if isinstance(body, dict) else body[0])


# =================================================================================================================================
# S3-7  the request examples and the response keys
# =================================================================================================================================
EXAMPLE_ITEMS = [(path, name, resolve(e["value"])) for path, named in EXAMPLES["requests"].items() for name, e in named.items()]
POST_PATHS = sorted({t["endpoint"] for t in TOOLS} | {"/v1/deck", "/mcp"})


def test_every_post_operation_has_a_request_example_and_every_engine_response_names_its_keys():
    assert sorted(EXAMPLES["requests"]) == POST_PATHS
    assert sorted(HONESTY["responses"]) == sorted({t["endpoint"] for t in TOOLS} | {"/v1/deck"})
    for path, named in EXAMPLES["requests"].items():
        assert named and all(e["summary"] for e in named.values()), path


def test_every_example_is_built_from_a_file_that_ships_or_a_named_base_and_nothing_is_retyped():
    shipped = {"examples/intake/dublin_hall.json", "examples/intake/reference_hall.json",
               "public/reference/examples/qualify-request.json", "public/reference/response_template.json"}
    seen: set[str] = set()

    def walk(node):
        if isinstance(node, dict):
            if "$from" in node:
                seen.add(node["$from"])
            for v in node.values():
                walk(v)
        elif isinstance(node, list):
            for v in node:
                walk(v)

    walk(EXAMPLES["requests"])
    assert {s for s in seen if not s.startswith("#bases/")} <= shipped
    assert {s[len("#bases/"):] for s in seen if s.startswith("#bases/")} <= set(EXAMPLES["bases"])
    for f in shipped:
        assert (ROOT / f).is_file(), f


@pytest.mark.parametrize("path,name,body", EXAMPLE_ITEMS, ids=[f"{p}:{n}" for p, n, _ in EXAMPLE_ITEMS])
def test_every_request_example_is_accepted_and_the_keys_the_document_names_are_returned(base, path, name, body):
    if path == "/mcp":
        status, _, out = rpc(base, body, key=KEY)
        assert status == 200 and "error" not in out, out
        if body["method"] == "tools/list":
            assert sorted(t["name"] for t in out["result"]["tools"]) == sorted(t["name"] for t in TOOLS)
        else:
            assert out["result"]["isError"] is False and out["result"]["structuredContent"]["as_found"]
        return
    free = path in ("/v1/qualify", "/v1/estimate")
    status, _, out = call(base, path, body, key=None if free else KEY)
    assert status == 200, out
    documented = HONESTY["responses"][path]["top_level"]
    missing = [k for k in documented if k not in out]
    assert not missing, f"{path} ({name}) does not return {missing}; it returns {sorted(out)}"
    assert out["schema_version"] == HONESTY["schema_version"]["value"]
    if name == "figures_declared_assumed":
        assert [r["path"] for r in out["inputs_declared_assumed"]] == ["grid.contracted_MW", "lv.tapoff_max_A"]


def test_the_documented_keys_are_also_what_the_handlers_return_in_process():
    """No HTTP, no key, no tier plumbing: the handler on the example body, for every route that has a documented response."""
    handlers = {p: h for p, (h, _) in S.ROUTES.items()}
    for path, name, body in EXAMPLE_ITEMS:
        if path == "/mcp":
            continue
        tier = Tier.PUBLIC if path in ("/v1/qualify", "/v1/estimate") else Tier.CLIENT
        out = S._invoke(path, handlers[path], body, tier)
        for k in HONESTY["responses"][path]["top_level"]:
            assert k in out, f"{path} ({name}) does not return {k}"


def test_the_hall_bid_example_is_ranked_not_disqualified(base):
    body = resolve(EXAMPLES["requests"]["/v1/bids"]["one_response"]["value"])
    out = call(base, "/v1/bids", body, key=KEY)[2]
    assert out["leading"] == "Synthetic Supplier A" and not out["ranked"][0]["disqualified"]


def test_the_btm_bid_example_is_ranked_not_disqualified(base):
    body = resolve(EXAMPLES["requests"]["/v1/power/deploy/bids"]["one_response"]["value"])
    out = call(base, "/v1/power/deploy/bids", body, key=KEY)[2]
    assert out["leading"] == "Synthetic Supplier A" and not out["ranked"][0]["disqualified"]


def test_the_btm_bid_example_answers_every_mandatory_requirement_of_its_own_tender():
    body = resolve(EXAMPLES["requests"]["/v1/power/deploy/bids"]["one_response"]["value"])
    pkg = S._btm_spec_from_body(body)
    assert sorted(body["responses"][0]["compliance"]) == sorted(q.id for q in pkg.mandatory())


def test_the_conditional_shapes_the_documents_name_are_the_shapes_the_engine_returns():
    ref = json.loads((ROOT / "examples" / "intake" / "reference_hall.json").read_text())
    dub = json.loads((ROOT / "examples" / "intake" / "dublin_hall.json").read_text())
    lon = json.loads((ROOT / "examples" / "intake" / "london_hall.json").read_text())

    def run(path, body, tier=Tier.CLIENT):
        return S._invoke(path, S.ROUTES[path][0], body, tier)

    assert set(run("/v1/study", {"intake": ref, "format": "csv"})) == {"format", "files", "calibration"}
    assert {"format", "title", "document"} <= set(run("/v1/study", {"intake": ref, "format": "md"})) and "document_full" not in run("/v1/study", {"intake": ref, "format": "md"})
    assert {"document", "model_packs"} <= set(run("/v1/portfolio", {"intakes": [dub, lon], "format": "md"}))
    assert set(run("/v1/spec", {"intake": ref, "list": True})) == {"reliefs", "calibration"}
    assert "document_full" not in run("/v1/spec", {"intake": ref, "constraint": "busway_ampacity", "format": "md"})
    assert "document_full" not in run("/v1/proposal", {"intake": ref, "format": "md"})
    assert set(run("/v1/screen", {"intake": ref, "format": "md"})) == {"format", "title", "document"}


# =================================================================================================================================
# S-DOC  what each tool says about its own evidence boundary
# =================================================================================================================================
def test_every_tool_publishes_an_evidence_boundary_of_one_sentence_and_tools_json_carries_it():
    published = {t["name"]: t for t in PUBLISHED["tools"]}
    for t in TOOLS:
        text = t["evidence_boundary"]
        assert text and text == published[t["name"]]["evidence_boundary"], t["name"]
        assert "\n" not in text and text.endswith(".") and len(text) <= 360, t["name"]
        assert not re.search(r"[.!?]\s+[A-Z]", text), f"{t['name']}: more than one sentence"


def test_no_published_text_calls_a_metered_route_free():
    metered = [t["endpoint"] for t in TOOLS if t["units"] > 0]
    blob = json.dumps(PUBLISHED["tools"]).lower()
    for endpoint in metered:
        assert f"free {endpoint}" not in blob, f"a published text calls {endpoint} free, and it needs a key"


def test_the_tool_row_carries_the_unit_weight_the_meter_uses():
    from gridforge.api.metering import UNIT_COST
    for t in TOOLS:
        assert t["units"] == UNIT_COST[t["endpoint"]]



def test_the_published_portfolio_example_is_the_clean_case_two_comparable_halls_on_separate_connections():
    """The example ranked Dublin against London, and London declares no UPS schedule, so the published answer had a hall that is not comparable,
    a bare total above the comparable one and a warning: not the case a reader should learn the shape from (review R4)."""
    body = resolve(EXAMPLES["requests"]["/v1/portfolio"]["two_halls"]["value"])
    out = S._invoke("/v1/portfolio", S.ROUTES["/v1/portfolio"][0], body, Tier.CLIENT)
    assert len(out["halls"]) == 2 and all(h["rankable"] for h in out["halls"]), [(h["hall"], h.get("required_gaps")) for h in out["halls"]]
    assert out["incomparable_halls"] == [] and "warnings" not in out
    assert out["comparable_total_racks"] == out["total_racks"] == out["total_racks_upper_bound"]
