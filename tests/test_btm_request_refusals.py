"""Refusals of a BTM or tender request name the field and the values allowed (audit J3-4).

`redundancy: "3N"` answered {"error": "the request could not be processed as given", "detail": "ValueError: '3N' is not a valid Redundancy"}: the
catch-all of the HTTP layer, with no field and no list of what is accepted. `n+1` was refused too, for case.
"""
from __future__ import annotations

import copy
import json
import os
import threading
import urllib.error
import urllib.request

import pytest

from gridforge.api import server as S
from gridforge.api.tiers import Tier
from gridforge.reporting.btm_assessment import DeploymentRequestError, deployment_request

KEY = "k-test-redundancy"

BODY = {
    "load_profile": {"csv": "timestamp,kW\n2026-01-01T00:00:00,30000\n2026-01-01T00:15:00,30000\n2026-01-01T00:30:00,30000\n"},
    "grid_firm_MW": 10.0, "target_MW": 35.0, "ride_through_hours": 3.0, "redundancy": "N+1",
    "generation": [{"id": "GEN-A", "kind": "gas_engine", "nameplate_MW": 20.0, "capex_eur": 16000000, "lead_time_weeks": 44, "fuel_type": "natural gas"}],
    "bess": [{"id": "BESS-1", "power_MW": 8.0, "energy_MWh": 32.0, "capex_eur": 7200000, "lead_time_weeks": 30}],
}


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


def post(base, path, body):
    req = urllib.request.Request(base + path, data=json.dumps(body).encode(), method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("X-API-Key", KEY)
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read())


def with_redundancy(value):
    body = copy.deepcopy(BODY)
    body["redundancy"] = value
    return body


@pytest.mark.parametrize("value, expected", [
    ("n+1", "N+1"), (" N+1 ", "N+1"), ("N + 1", "N+1"), ("n+2", "N+2"), ("2n", "2N"), ("n", "N"), ("\tN+2\n", "N+2")])
def test_case_and_whitespace_are_normalised(value, expected):
    assert deployment_request(with_redundancy(value))["redundancy"].value == expected


def test_an_absent_or_null_redundancy_is_the_default_scheme():
    absent = copy.deepcopy(BODY)
    del absent["redundancy"]
    assert deployment_request(absent)["redundancy"].value == "N"
    assert deployment_request(with_redundancy(None))["redundancy"].value == "N"


@pytest.mark.parametrize("value", ["3N", "N+3", "", 2, ["N"], {"n": 1}, True])
def test_an_unknown_redundancy_is_a_422_naming_the_field_and_what_is_allowed(base, value):
    status, out = post(base, "/v1/power/deploy/assess", with_redundancy(value))
    assert status == 422, out
    assert out["field"] == "redundancy" and out["allowed"] == ["N", "N+1", "N+2", "2N"], out
    assert "redundancy" in out["error"] and "ValueError" not in json.dumps(out) and "detail" not in out
    assert out["error"] != "the request could not be processed as given"


def test_the_spec_route_refuses_the_same_way(base):
    status, out = post(base, "/v1/power/deploy/spec", {**with_redundancy("3N"), "architecture": "GRID + BESS + GENERATION"})
    assert status == 422 and out["field"] == "redundancy" and out["allowed"] == ["N", "N+1", "N+2", "2N"], out


def test_a_normalised_redundancy_is_accepted_end_to_end(base):
    status, out = post(base, "/v1/power/deploy/assess", with_redundancy("n+1"))
    assert status == 200 and out["capacity"]["redundancy"] == "N+1"


def test_an_unknown_objective_names_the_field_too():
    body = {**BODY, "objective": "cheap"}
    with pytest.raises(DeploymentRequestError) as exc:
        deployment_request(body)
    assert exc.value.extra["field"] == "objective" and "max_compute" in exc.value.extra["allowed"]


# --- the scenario a tender is built for ----------------------------------------------------------------------------------------

def test_an_unknown_scenario_is_refused_naming_the_field_and_the_ids_it_has_not_ignored():
    """Old: the unknown id fell back silently to the recommended scenario, so a typo tendered, and ranked bids against, a different scenario."""
    intake = json.load(open(os.path.join(os.path.dirname(__file__), "..", "examples", "intake", "reference_hall.json")))
    for handler, extra in ((S.handle_spec, {"list": True}), (S.handle_bids, {"responses": [{}]})):
        with pytest.raises(S.ApiError) as exc:
            handler({"intake": intake, "scenario": "no_such_scenario", **extra}, Tier.CLIENT)
        assert exc.value.status == 422 and exc.value.extra["field"] == "scenario" and exc.value.extra["allowed"], handler.__name__
    # a real id, and an omitted one, still work
    ids = S.handle_spec.__globals__["_run"](intake)[1]
    named = S.handle_spec({"intake": intake, "scenario": ids[0].spec.id, "list": True}, Tier.CLIENT)
    assert "reliefs" in named
