"""Time-to-Power scenario comparison: the same solved scenarios, side by side, with only the dates we can defend.

The comparison is not a second model, so its numbers must be the ones /v1/screen reports. These tests run the real
engine, the real HTTP server and the CLI; nothing here is a stubbed result.
"""
import copy
import json
import os
import subprocess
import sys
import threading
import urllib.error
import urllib.request
from pathlib import Path

import pytest

from gridforge.api.server import ApiError, Handler, _objective, handle_compare, handle_screen, make_server
from gridforge.api.tiers import Tier
from gridforge.api.tools import TOOLS_BY_NAME, _OBJECTIVE
from gridforge.intake.loader import load_document
from gridforge.api.compare_payload import SCHEMA, CompareError, compare_payload, request_digest, select
from gridforge.scenario.objective import Objective
from gridforge.scenario.run import run_all

EX = Path(__file__).resolve().parent.parent / "examples" / "intake"
DUBLIN = json.loads((EX / "dublin_hall.json").read_text())
LONDON = json.loads((EX / "london_hall.json").read_text())
KEY = "sk_compare_test"


def compare(doc, **kw):
    return handle_compare({"intake": doc, **kw}, Tier.CLIENT)


def row(out, sid):
    return next(r for r in out["scenarios"] if r["id"] == sid)


def test_the_comparison_reports_the_numbers_the_screen_reports():
    out = compare(DUBLIN)
    screen = handle_screen({"intake": DUBLIN}, Tier.CLIENT)
    assert out["schema"] == SCHEMA
    by = {s["id"]: s for s in screen["scenarios"]}
    for r in out["scenarios"]:
        s = by[r["id"]]
        assert r["as_found"]["racks"] == s["as_found"]["racks"]
        assert r["after_ladder"]["racks"] == s["after_ladder"]["racks"]
        assert r["economics"]["capex_total_eur"] == s["economics"]["capex_total_eur"]
        assert r["economics"]["capex_complete"] == s["economics"]["capex_complete"]


def test_a_dated_scenario_carries_its_band_and_evidence_class():
    out = compare(DUBLIN)
    r = row(out, "full_dlc")
    t = r["time_to_power"]
    assert t["status"] == "dated" and t["low"] <= t["weeks"] <= t["high"]
    assert t["evidence"].startswith("E") and t["sets_the_date"]
    assert all(lt["lead_time_weeks"] and lt["lead_time_weeks"]["evidence"] for lt in t["lead_times"])


def test_a_scenario_with_nothing_deployable_has_no_date_and_says_why():
    r = row(compare(DUBLIN), "retained_air")
    t = r["time_to_power"]
    assert r["after_ladder"]["racks"] == 0
    assert t["status"] == "no_deployable_racks" and t["weeks"] is None and "nothing to date" in t["reason"]


def test_a_missing_lead_time_is_not_zero_weeks():
    """The older serialiser reads a missing lead time as 0 weeks. The comparison must give NO date instead."""
    intake = load_document(DUBLIN)
    results = run_all(intake.context, intake.scenarios)
    res = next(r for r in results if r.spec.id == "full_dlc")
    taken = res.ladder.taken_steps
    assert taken, "the example must take at least one relief for this test to mean anything"
    broken = copy.deepcopy(res)
    broken.ladder.taken_steps[0].lead_time_weeks = None
    other = next(r for r in results if r.spec.id == "hybrid_dlc")
    out = compare_payload(DUBLIN, [other, broken], objective=Objective.FASTEST_TO_POWER, baseline=None)
    r = row(out, "full_dlc")
    assert r["time_to_power"]["status"] == "lead_time_missing"
    assert r["time_to_power"]["weeks"] is None and "No defensible date" in r["time_to_power"]["reason"]
    assert any(m.startswith("lead time:") for m in r["missing_inputs"])
    assert "full_dlc" not in out["ranking"]["order"]
    assert any(e["id"] == "full_dlc" for e in out["ranking"]["excluded"])
    assert r["vs_baseline"]["weeks_delta"] is None and r["vs_baseline"]["weeks_delta_unknown_reason"]


def test_nothing_is_ranked_on_a_figure_it_does_not_have():
    out = compare(DUBLIN, objective="min_cost")
    assert out["ranking"]["order"] == [] or all(
        row(out, i)["economics"]["capex_complete"] for i in out["ranking"]["order"])
    for e in out["ranking"]["excluded"]:
        assert e["reason"]
    if not out["ranking"]["order"]:
        assert out["ranking"]["leader"] is None and "Nothing can be ranked" in out["ranking"]["note"]


def test_an_all_assumption_comparison_is_labelled_indicative():
    out = compare(DUBLIN, objective="fastest")
    assert out["grade"] == "indicative"
    assert any("indicative" in c for c in out["caveats"])
    assert any("Grid reinforcement is not dated" in c for c in out["caveats"])


def test_level_scenarios_do_not_get_a_leader():
    out = compare(DUBLIN, scenarios=["hybrid_dlc", "full_dlc"], objective="max_compute")
    rk = out["ranking"]
    if rk["tie"]:
        assert rk["leader"] is None
    else:
        assert rk["leader"] == rk["order"][0]


def test_every_scenario_says_how_it_differs_from_the_baseline():
    out = compare(DUBLIN, baseline="full_dlc")
    assert out["baseline"] == "full_dlc" and row(out, "full_dlc")["vs_baseline"] is None
    d = row(out, "full_dlc_btm")["vs_baseline"]
    assert d["racks_delta"] == row(out, "full_dlc_btm")["after_ladder"]["racks"] - row(out, "full_dlc")["after_ladder"]["racks"]
    assert d["why"]


def test_the_same_request_gives_the_same_answer_and_a_changed_input_a_traceable_change():
    a, b = compare(DUBLIN), compare(DUBLIN)
    assert json.dumps(a, sort_keys=True) == json.dumps(b, sort_keys=True)
    changed = copy.deepcopy(DUBLIN)
    for path in (("grid", "contracted_MW"), ("site", "contracted_MW")):
        d = changed
        for k in path[:-1]:
            d = d.get(k, {}) if isinstance(d, dict) else {}
        if isinstance(d, dict) and path[-1] in d:
            d[path[-1]] = d[path[-1]] * 0.5
            break
    else:
        pytest.skip("no contracted_MW key found in the example intake")
    c = compare(changed)
    assert c["request_digest"] != a["request_digest"]
    assert [r["after_ladder"]["racks"] for r in c["scenarios"]] != [r["after_ladder"]["racks"] for r in a["scenarios"]] \
        or [r["time_to_power"]["weeks"] for r in c["scenarios"]] != [r["time_to_power"]["weeks"] for r in a["scenarios"]]


def test_the_digest_names_the_question_not_the_answer():
    assert request_digest(DUBLIN, ["a", "b"], Objective.MAX_COMPUTE, "a") != \
        request_digest(DUBLIN, ["a", "b"], Objective.FASTEST_TO_POWER, "a")
    assert request_digest(DUBLIN, ["a", "b"], Objective.MAX_COMPUTE, "a") != \
        request_digest(DUBLIN, ["a", "b"], Objective.MAX_COMPUTE, "b")
    out = compare(DUBLIN)
    assert out["provenance"]["digest"] and out["provenance"]["code_sha256"]


@pytest.mark.parametrize("body,fragment", [
    ({"scenarios": ["nope", "rdhx"]}, "unknown scenario"),
    ({"scenarios": ["rdhx"]}, "at least two"),
    ({"scenarios": ["rdhx", "rdhx"]}, "twice"),
    ({"baseline": "zz"}, "not one of the compared"),
    ({"objective": "cheapest"}, "unknown objective"),
    ({"scenarios": "rdhx"}, "list of scenario ids"),
])
def test_unsupported_requests_fail_explicitly(body, fragment):
    with pytest.raises(ApiError) as e:
        compare(DUBLIN, **body)
    assert e.value.status == 422 and fragment in e.value.message


def test_a_btm_comparison_without_btm_options_is_refused_not_silently_grid_only():
    doc = copy.deepcopy(LONDON)
    doc.pop("btm_options", None)
    intake = load_document(doc)
    if intake.context.power.options:
        pytest.skip("the london example declares supply options")
    with pytest.raises(ApiError) as e:
        compare(doc, scenarios=["full_dlc", "full_dlc_btm"])
    assert e.value.status == 422 and "behind-the-meter" in e.value.message
    ok = compare(doc)
    assert "full_dlc_btm" not in [r["id"] for r in ok["scenarios"]]
    assert any("full_dlc_btm is not compared" in c for c in ok["caveats"])


def test_a_bare_intake_is_not_guessed_at():
    with pytest.raises(ApiError) as e:
        handle_compare(DUBLIN, Tier.CLIENT)
    assert e.value.status == 422


def test_every_objective_the_tools_advertise_is_one_the_engine_accepts():
    """The advertised enum once listed names the engine rejected (min_capex_per_rack, fastest_to_power)."""
    for name in _OBJECTIVE["enum"]:
        assert _objective({"objective": name}).value == name


@pytest.fixture(scope="module")
def server():
    os.environ["GRIDFORGE_API_KEYS"] = f"{KEY}:compareacct:50"
    os.environ["GRIDFORGE_RATE_LIMIT"] = "0"
    Handler.limiter.per_minute = 0
    httpd = make_server("127.0.0.1", 0)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{httpd.server_address[1]}"
    httpd.shutdown()
    os.environ.pop("GRIDFORGE_API_KEYS", None)


def post(base, path, body, key=None):
    req = urllib.request.Request(f"{base}{path}", data=json.dumps(body).encode(), method="POST")
    req.add_header("Content-Type", "application/json")
    if key:
        req.add_header("X-API-Key", key)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def test_http_requires_a_key_and_returns_the_same_answer_as_the_handler(server):
    status, _ = post(server, "/v1/compare", {"intake": DUBLIN})
    assert status in (401, 402)
    status, body = post(server, "/v1/compare", {"intake": DUBLIN, "objective": "fastest"}, KEY)
    assert status == 200 and body["schema_version"] == "gridforge/api/1"
    direct = compare(DUBLIN, objective="fastest")
    for k in ("scenarios", "ranking", "grade", "request_digest", "baseline"):
        assert body[k] == direct[k], k


def test_http_unsupported_request_is_a_422_that_names_the_fix_and_is_not_billed(server):
    status, body = post(server, "/v1/compare", {"intake": DUBLIN, "scenarios": ["nope", "rdhx"]}, KEY)
    assert status == 422 and body["available"]


def test_the_mcp_tool_is_registered_and_described(server):
    t = TOOLS_BY_NAME["gridforge_compare"]
    assert t["endpoint"] == "/v1/compare" and t["units"] == 1
    assert "intake" in t["inputSchema"]["required"]


def test_the_cli_calls_the_same_handler_and_writes_the_same_answer(tmp_path):
    p = subprocess.run([sys.executable, "-m", "gridforge", "compare", str(EX / "dublin_hall.json"),
                        "-o", str(tmp_path), "--objective", "fastest"], capture_output=True, text=True)
    assert p.returncode == 0, p.stderr
    written = json.loads((tmp_path / "ttp_compare.json").read_text())
    direct = compare(DUBLIN, objective="fastest")
    for k in ("scenarios", "ranking", "grade", "request_digest"):
        assert written[k] == direct[k], k
    assert "digest" in p.stdout and "no date" in p.stdout


def test_the_cli_refuses_what_the_api_refuses(tmp_path):
    p = subprocess.run([sys.executable, "-m", "gridforge", "compare", str(EX / "dublin_hall.json"),
                        "-o", str(tmp_path), "--scenarios", "rdhx"], capture_output=True, text=True)
    assert p.returncode == 2 and "at least two" in p.stderr


def test_a_baseline_that_deploys_nothing_gives_no_capex_delta_from_nothing():
    """retained_air deploys 0 racks at EUR 0: a priced scenario is not 'EUR x more' than that."""
    out = compare(DUBLIN)
    base = row(out, out["baseline"])
    assert base["after_ladder"]["racks"] == 0
    for r in out["scenarios"]:
        if r["id"] == out["baseline"]:
            continue
        d = r["vs_baseline"]
        assert d["capex_delta_eur"] is None
        assert "no racks" in d["capex_delta_unknown_reason"]


def test_a_scenario_without_a_date_is_never_graded_above_indicative():
    out = compare(DUBLIN)
    assert row(out, "retained_air")["grade"] == "undated"
    intake = load_document(DUBLIN)
    results = run_all(intake.context, intake.scenarios)
    res = next(r for r in results if r.spec.id == "full_dlc")
    broken = copy.deepcopy(res)
    broken.ladder.taken_steps[0].lead_time_weeks = None
    other = next(r for r in results if r.spec.id == "hybrid_dlc")
    p = compare_payload(DUBLIN, [other, broken], objective=Objective.MAX_COMPUTE, baseline=None)
    assert row(p, "full_dlc")["grade"] == "undated"
    assert p["grade"] == "indicative"           # one relief with no lead time keeps the whole comparison indicative


def test_a_fastest_ranking_says_when_the_capacities_differ():
    out = compare(DUBLIN, objective="fastest")
    rk = out["ranking"]
    assert len({rk["racks"][i] for i in rk["order"]}) > 1
    assert "different numbers of racks" in rk["note"] and "not more capacity" in rk["note"]
    assert "different numbers of racks" not in (compare(DUBLIN, objective="max_compute")["ranking"]["note"] or "")


def test_an_empty_scenario_list_is_refused_not_read_as_all():
    with pytest.raises(ApiError) as e:
        compare(DUBLIN, scenarios=[])
    assert e.value.status == 422 and "empty list" in e.value.message


def test_the_cli_reproduces_the_request_file_the_site_offers(tmp_path):
    request = {"intake": DUBLIN, "objective": "fastest", "scenarios": ["hybrid_dlc", "full_dlc"]}
    f = tmp_path / "request.json"
    f.write_text(json.dumps(request))
    p = subprocess.run([sys.executable, "-m", "gridforge", "compare", str(f), "-o", str(tmp_path / "o")],
                       capture_output=True, text=True)
    assert p.returncode == 0, p.stderr
    written = json.loads((tmp_path / "o" / "ttp_compare.json").read_text())
    direct = handle_compare(request, Tier.CLIENT)
    assert written["request_digest"] == direct["request_digest"]
    assert [r["id"] for r in written["scenarios"]] == ["hybrid_dlc", "full_dlc"] and written["objective"] == "fastest"


# --- accepted supplier quotations priced into the comparison ------------------------------------------------------

QUOTE = {"key": "transformer.replacement", "label": "transformer (synthetic quotation)", "unit": "EUR/MVA",
         "value": 100_000.0, "basis": "budgetary_quote", "supplier": "SYNTHETIC-SUPPLIER-A", "quoted_on": "2026-10-01",
         "valid_until": "2099-12-31", "evidence_id": "ev-a", "reviewer": "Test Reviewer", "reviewed_on": "2026-10-05",
         "status": "accepted"}


def invoke(body):
    from gridforge.api.server import _invoke
    return _invoke("/v1/compare", handle_compare, body, Tier.CLIENT)


def test_an_accepted_quotation_prices_its_line_and_the_answer_says_so():
    plain = compare(DUBLIN)
    priced = invoke({"intake": DUBLIN, "cost_evidence": [QUOTE]})
    assert [u["evidence_id"] for u in priced["cost_evidence"]["used"]] == ["ev-a"]
    assert priced["cost_evidence"]["ignored"] == []
    assert priced["evidence_applied"] == [{"evidence_id": "ev-a", "key": "transformer.replacement", "unit": "EUR/MVA",
                                           "value": 100_000.0, "basis": "budgetary_quote", "quoted_on": "2026-10-01",
                                           "synthetic": False}]
    s = row(priced, "full_dlc")
    assert "budgetary_quote" in s["economics"]["cost_basis_mix"]
    assert s["economics"]["capex_total_eur"]["value"] != row(plain, "full_dlc")["economics"]["capex_total_eur"]["value"]
    assert any("accepted supplier quotations" in c and "transformer.replacement" in c for c in priced["caveats"])
    # the physics did not move: racks, limits and dates are identical, only cost and its basis changed
    for a, b in zip(plain["scenarios"], priced["scenarios"]):
        assert (a["after_ladder"]["racks"], a["time_to_power"]["weeks"]) == (b["after_ladder"]["racks"], b["time_to_power"]["weeks"])
    assert priced["cost_evidence"]["effect"]["scenarios"]


def test_the_applied_evidence_is_part_of_the_questions_identity_and_an_ignored_line_is_not():
    plain = compare(DUBLIN)
    priced = invoke({"intake": DUBLIN, "cost_evidence": [QUOTE]})
    assert priced["request_digest"] != plain["request_digest"]
    assert invoke({"intake": DUBLIN, "cost_evidence": [QUOTE]})["request_digest"] == priced["request_digest"]
    unreviewed = invoke({"intake": DUBLIN, "cost_evidence": [{**QUOTE, "status": "validated"}]})
    assert unreviewed["cost_evidence"]["used"] == []
    assert unreviewed["cost_evidence"]["ignored"][0]["reason"].startswith("status is validated")
    assert unreviewed["request_digest"] == plain["request_digest"]        # nothing was applied, so the question is the same
    assert unreviewed["evidence_applied"] == []
    assert row(unreviewed, "full_dlc")["economics"]["capex_total_eur"] == row(plain, "full_dlc")["economics"]["capex_total_eur"]


def test_without_evidence_the_response_is_exactly_what_it_was():
    out = compare(DUBLIN)
    assert "cost_evidence" not in out and out["evidence_applied"] == []


def test_a_synthetic_quotation_is_named_and_makes_the_comparison_not_decision_grade():
    out = invoke({"intake": DUBLIN, "cost_evidence": [{**QUOTE, "synthetic": True}]})
    assert any("SYNTHETIC" in c and "not decision-grade" in c for c in out["caveats"])
    assert out["evidence_applied"][0]["synthetic"] is True


def test_http_compare_takes_cost_evidence_and_refuses_a_bad_line(server):
    status, body = post(server, "/v1/compare", {"intake": DUBLIN, "cost_evidence": [QUOTE]}, KEY)
    assert status == 200 and [u["evidence_id"] for u in body["cost_evidence"]["used"]] == ["ev-a"]
    assert body["request_digest"] == invoke({"intake": DUBLIN, "cost_evidence": [QUOTE]})["request_digest"]
    status, body = post(server, "/v1/compare", {"intake": DUBLIN, "cost_evidence": [{"key": "x"}]}, KEY)
    assert status == 422 and "not a valid cost line" in body["error"]
    status, body = post(server, "/v1/compare", {"intake": DUBLIN, "cost_evidence": {"not": "a list"}}, KEY)
    assert status == 422


def test_the_cli_applies_the_same_evidence_the_same_way(tmp_path):
    ev = tmp_path / "evidence.json"
    ev.write_text(json.dumps([QUOTE]))
    p = subprocess.run([sys.executable, "-m", "gridforge", "compare", str(EX / "dublin_hall.json"), "-o", str(tmp_path / "o"),
                        "--cost-evidence", str(ev)], capture_output=True, text=True)
    assert p.returncode == 0, p.stderr
    assert "1 accepted line(s) used, 0 ignored" in p.stdout
    written = json.loads((tmp_path / "o" / "ttp_compare.json").read_text())
    direct = invoke({"intake": DUBLIN, "cost_evidence": [QUOTE]})
    assert written["request_digest"] == direct["request_digest"] and written["scenarios"] == direct["scenarios"]
    # a request file that carries its own cost_evidence reproduces too
    req = tmp_path / "request.json"
    req.write_text(json.dumps({"intake": DUBLIN, "cost_evidence": [QUOTE]}))
    p = subprocess.run([sys.executable, "-m", "gridforge", "compare", str(req), "-o", str(tmp_path / "o2")], capture_output=True, text=True)
    assert p.returncode == 0, p.stderr
    assert json.loads((tmp_path / "o2" / "ttp_compare.json").read_text())["request_digest"] == direct["request_digest"]
    bad = tmp_path / "bad.json"
    bad.write_text("{nope")
    p = subprocess.run([sys.executable, "-m", "gridforge", "compare", str(EX / "dublin_hall.json"), "-o", str(tmp_path / "o3"),
                        "--cost-evidence", str(bad)], capture_output=True, text=True)
    assert p.returncode == 2 and "unusable" in p.stderr
