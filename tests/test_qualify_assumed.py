"""POST /v1/qualify: figures a caller declares ASSUMED (class E0) are reported as assumptions, never as customer data.

The website's /qualify can start from a reference template (synthetic input values nobody measured). A template's numbers sent as plain
figures would be classed E5, customer data, in the result's own basis and evidence. `assumed_fields` is the least new surface that fixes
that: a list of the qualify fields the caller declares assumed. Its only effect is to LOWER a figure to E0; no spelling of it can raise a
class, and a request without it is answered exactly as it was before the parameter existed.
"""
from __future__ import annotations

import json
import os
import threading
import urllib.error
import urllib.request
from pathlib import Path

import pytest

from gridforge.api import server as S
from gridforge.api.server import (
    CAPABILITIES,
    QUALIFY_ASSUMED_CLASS,
    QUALIFY_FIELDS,
    ApiError,
    Handler,
    handle_qualify,
    make_server,
    qualify_assumed_fields,
    qualify_to_intake,
)
from gridforge.api.tiers import Tier
from gridforge.intake.loader import load_document

ROOT = Path(__file__).resolve().parent.parent
HALL = {
    "contracted_MW": 12, "current_site_peak_MW": 7.4, "current_it_load_MW": 4.9,
    "busway_ampacity_A": 400, "tapoff_max_A": 63, "plant_supply_C": 6, "positions_available": 180,
}


@pytest.fixture(scope="module")
def base():
    os.environ["GRIDFORGE_RATE_LIMIT"] = "0"
    Handler.limiter.per_minute = 0
    httpd = make_server("127.0.0.1", 0)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{httpd.server_address[1]}"
    httpd.shutdown()


def post_raw(base, body, path="/v1/qualify"):
    req = urllib.request.Request(base + path, data=json.dumps(body).encode(), method="POST", headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def post(base, body):
    status, raw = post_raw(base, body)
    return status, json.loads(raw)


# --- a plain request is answered exactly as before ---------------------------------------------------------------------------------
GOLDEN = json.loads((Path(__file__).parent / "golden_qualify_plain_002fa59.json").read_text())["cases"]


@pytest.mark.parametrize("case", GOLDEN, ids=[c["name"] for c in GOLDEN])
def test_a_plain_request_is_answered_identically_to_the_engine_before_assumed_fields_existed(case):
    """The golden answers were produced by the engine at commit 002fa59, before this parameter existed."""
    now = json.loads(json.dumps(handle_qualify(dict(case["request"]), Tier.PUBLIC)))
    assert now == case["response"]
    assert "inputs_declared_assumed" not in now


def test_an_absent_null_or_empty_assumed_fields_is_byte_identical_over_http(base):
    plain = post_raw(base, dict(HALL))
    assert plain[0] == 200
    assert post_raw(base, {**HALL, "assumed_fields": None}) == plain
    assert post_raw(base, {**HALL, "assumed_fields": []}) == plain


def test_a_plain_request_still_classes_every_figure_as_the_caller_s_own_data():
    basis = handle_qualify(dict(HALL), Tier.PUBLIC)["as_found"]["basis"]
    assert "installed tap-offs rated 63 A (E5)" in basis
    assert "(E0) per rack" in basis          # the platform's library current is an assumption either way


# --- an annotated request is accepted and labelled E0 ------------------------------------------------------------------------------
def test_a_declared_figure_is_reported_as_an_assumption_in_the_result_s_own_basis_and_evidence(base):
    status, out = post(base, {**HALL, "assumed_fields": ["tapoff_max_A"]})
    assert status == 200
    assert "installed tap-offs rated 63 A (E0)" in out["as_found"]["basis"]
    assert "(E5)" not in out["as_found"]["basis"]
    assert out["as_found"]["it_load_kW"]["evidence"] == "E0_ASSUMPTION"
    assert out["inputs_declared_assumed"] == [{
        "path": "lv.tapoff_max_A", "input": "Installed tap-off rating", "unit": "A", "value": 63.0,
        "evidence": "E0", "note": S.QUALIFY_ASSUMED_NOTE,
    }]


def test_a_figure_not_declared_stays_customer_data_beside_one_that_is(base):
    # only the contracted figure is a template's; the tap-off rating is the caller's own
    status, out = post(base, {**HALL, "assumed_fields": ["contracted_MW"]})
    assert status == 200
    assert "installed tap-offs rated 63 A (E5)" in out["as_found"]["basis"]
    assert [r["path"] for r in out["inputs_declared_assumed"]] == ["grid.contracted_MW"]


def test_all_seven_may_be_declared_and_the_list_is_in_the_order_the_qualifier_asks(base):
    status, out = post(base, {**HALL, "assumed_fields": list(reversed(list(QUALIFY_FIELDS)))})
    assert status == 200
    assert [r["path"] for r in out["inputs_declared_assumed"]] == list(QUALIFY_FIELDS.values())
    assert {r["evidence"] for r in out["inputs_declared_assumed"]} == {"E0"}


def test_declaring_a_figure_changes_its_label_and_nothing_else_about_the_arithmetic(base):
    plain = post(base, dict(HALL))[1]
    marked = post(base, {**HALL, "assumed_fields": list(QUALIFY_FIELDS)})[1]
    for key in ("racks",):
        assert marked["as_found"][key] == plain["as_found"][key]
    assert marked["after_relief"]["racks"] == plain["after_relief"]["racks"]
    assert marked["as_found"]["binding_constraint"] == plain["as_found"]["binding_constraint"]


def test_the_connection_capacity_derived_from_an_assumed_contract_is_assumed_too():
    """With no firm_capacity_MVA given the qualifier derives one from the contracted figure. Derived from an assumed number it is an assumed
    number: arithmetic must not turn a template's value into customer data."""
    plain = load_document(qualify_to_intake(dict(HALL)))
    assert plain.report.sourced == []                                   # nothing annotated: classed as supplied customer data
    marked = load_document(qualify_to_intake({**HALL, "assumed_fields": ["contracted_MW"]}))
    firm = [s for s in marked.report.sourced if s.path == "grid.firm_capacity_MVA"]
    assert [(s.evidence, s.note) for s in firm] == [(QUALIFY_ASSUMED_CLASS, S.QUALIFY_ASSUMED_NOTE)]
    # a caller that gives the firm capacity itself keeps it as theirs
    own = load_document(qualify_to_intake({**HALL, "firm_capacity_MVA": 13, "assumed_fields": ["contracted_MW"]}))
    assert not [s for s in own.report.sourced if s.path == "grid.firm_capacity_MVA"]


def test_a_declared_request_is_deterministic(base):
    body = {**HALL, "assumed_fields": ["busway_ampacity_A", "tapoff_max_A"]}
    assert post_raw(base, body) == post_raw(base, body)


# --- hostile values are refused, naming the field ----------------------------------------------------------------------------------
HOSTILE = [
    ("a string, not a list", "tapoff_max_A", "assumed_fields must be a list"),
    ("an object", {"tapoff_max_A": True}, "assumed_fields must be a list"),
    ("a number", 7, "assumed_fields must be a list"),
    ("a bool", True, "assumed_fields must be a list"),
    ("a non-text entry", [7], "assumed_fields[0] must be a field name"),
    ("a nested entry", [["tapoff_max_A"]], "assumed_fields[0] must be a field name"),
    ("an object entry", [{"value": 63, "evidence": "E5"}], "assumed_fields[0] must be a field name"),
    ("an unknown field", ["tapoff_max_A", "no_such_field"], "assumed_fields[1]"),
    ("an evidence class in place of a field", ["E5"], "assumed_fields[0]"),
    ("a case variant of a field", ["Tapoff_max_A"], "assumed_fields[0]"),
    ("a padded field", [" tapoff_max_A"], "assumed_fields[0]"),
    ("a path instead of a field name", ["lv.tapoff_max_A"], "assumed_fields[0]"),
    ("a field the engine derives, not one it is given", ["firm_capacity_MVA"], "assumed_fields[0]"),
    ("a repeated field", ["tapoff_max_A", "tapoff_max_A"], "assumed_fields[1] repeats tapoff_max_A"),
    ("a field the request does not give", ["plant_supply_C"], "assumed_fields[0] names plant_supply_C, which the request does not give"),
    ("more entries than there are fields", ["tapoff_max_A"] * 8, "assumed_fields lists 8 entries"),
    ("a very long list", ["tapoff_max_A"] * 5000, "assumed_fields lists 5000 entries"),
]


@pytest.mark.parametrize("label,value,message", HOSTILE, ids=[h[0] for h in HOSTILE])
def test_a_hostile_assumed_fields_is_refused_with_a_422_that_names_it(base, label, value, message):
    body = {k: v for k, v in HALL.items() if k != "plant_supply_C"} if "does not give" in message else dict(HALL)
    status, out = post(base, {**body, "assumed_fields": value})
    assert status == 422, out
    assert message in out["error"]
    assert "inputs_declared_assumed" not in out and "as_found" not in out


def test_a_refusal_names_the_fields_that_are_allowed(base):
    status, out = post(base, {**HALL, "assumed_fields": ["nope"]})
    assert status == 422 and out["allowed"] == list(QUALIFY_FIELDS)


def test_a_very_long_name_is_not_echoed_whole(base):
    status, out = post(base, {**HALL, "assumed_fields": ["x" * 100_000]})
    assert status == 422 and len(out["error"]) < 200


@pytest.mark.parametrize("field", list(QUALIFY_FIELDS))
@pytest.mark.parametrize("value", [{"value": 63, "evidence": "E5"}, {"value": 63, "evidence": "E0"}, "63", True, [63]])
def test_a_figure_cannot_carry_its_own_annotation_on_this_route(base, field, value):
    """The loader's annotated form is NOT accepted per figure here. A declaration is the list only, and the list can only say E0."""
    status, out = post(base, {**HALL, field: value})
    assert status == 422
    assert field in out["error"] and "must be a number" in out["error"]


def test_no_spelling_of_the_request_can_raise_a_class(base):
    plain = post(base, dict(HALL))[1]["as_found"]["basis"]
    for extra in (
        {"evidence": "E5"}, {"evidence": "E7"}, {"assumed_class": "E5"}, {"tapoff_max_A_evidence": "E7"},
        {"declared_evidence": {"tapoff_max_A": "E5"}}, {"assumed_fields_class": "E5"},
    ):
        status, out = post(base, {**HALL, **extra})
        assert status == 200
        assert out["as_found"]["basis"] == plain               # unknown keys are not a way to say anything about a figure
        status, out = post(base, {**HALL, **extra, "assumed_fields": ["tapoff_max_A"]})
        assert status == 200
        assert "installed tap-offs rated 63 A (E0)" in out["as_found"]["basis"]
        assert {r["evidence"] for r in out["inputs_declared_assumed"]} == {"E0"}


def test_the_only_class_this_route_can_declare_is_the_lowest():
    from gridforge.validation import EvidenceClass
    assert QUALIFY_ASSUMED_CLASS == "E0"
    assert EvidenceClass.E0_ASSUMPTION.short == "E0"
    assert min(EvidenceClass) is EvidenceClass.E0_ASSUMPTION


def test_assumed_fields_helper_returns_the_qualifier_s_own_order_and_no_duplicates():
    assert qualify_assumed_fields({**HALL, "assumed_fields": ["tapoff_max_A", "contracted_MW"]}) == ["contracted_MW", "tapoff_max_A"]
    assert qualify_assumed_fields(dict(HALL)) == []
    with pytest.raises(ApiError) as e:
        qualify_assumed_fields({**HALL, "assumed_fields": "contracted_MW"})
    assert e.value.status == 422


# --- the capability a site can detect ----------------------------------------------------------------------------------------------
def test_version_advertises_the_capability_and_every_flag_is_a_boolean(base):
    with urllib.request.urlopen(base + "/v1/version", timeout=30) as r:
        v = json.loads(r.read())
    assert v["capabilities"]["qualify_assumed_fields"] is True
    assert all(isinstance(x, bool) for x in v["capabilities"].values())
    assert v["capabilities"] == CAPABILITIES


def test_the_advertised_capability_is_one_the_engine_really_has(base):
    """A flag is a claim. This is the behaviour it claims, end to end over HTTP: if this fails, the flag must go."""
    status, out = post(base, {**HALL, "assumed_fields": ["contracted_MW"]})
    assert status == 200 and out["inputs_declared_assumed"][0]["evidence"] == "E0"


def test_the_unchanged_endpoint_list_still_lists_qualify(base):
    with urllib.request.urlopen(base + "/v1/version", timeout=30) as r:
        v = json.loads(r.read())
    assert "/v1/qualify" in v["endpoints"]
    assert (ROOT / "lib" / "engine-deployed.json").exists()


# --- the loader bug this exposed ---------------------------------------------------------------------------------------------------
@pytest.mark.parametrize("path,section,key,value", [
    ("hall.positions_available", "hall", "positions_available", 180),
    ("lv.busway_runs", "lv", "busway_runs", 6),
])
def test_an_integer_figure_declared_assumed_is_recorded_assumed_not_as_customer_data(path, section, key, value):
    """E0 is 0, so `declared or <field class>` treated a figure declared ASSUMED as if nothing had been declared and the report's source list
    said E5 (customer data) for it: a class above the one declared. The recorded class must be the declared one."""
    doc = qualify_to_intake(dict(HALL))
    doc.setdefault(section, {})[key] = {"value": value, "evidence": "E0", "note": "a template value"}
    recorded = [s for s in load_document(doc).report.sourced if s.path == path]
    assert [(s.evidence, s.note) for s in recorded] == [("E0", "a template value")]


# --- the figure-level class, not only the headline's --------------------------------------------------------------------------------
def test_the_class_is_proved_per_figure_not_by_the_headline_evidence(base):
    """as_found.it_load_kW.evidence is E0_ASSUMPTION for a PLAIN request too (the library's per-rack current is an assumption), so it proves nothing
    about a declared figure. What does: the loaded quantity's class, the basis text beside the figure, and the loader's own record."""
    plain = post(base, dict(HALL))[1]
    declared = post(base, {**HALL, "assumed_fields": list(QUALIFY_FIELDS)})[1]
    assert plain["as_found"]["it_load_kW"]["evidence"] == declared["as_found"]["it_load_kW"]["evidence"] == "E0_ASSUMPTION"
    assert "63 A (E5)" in plain["as_found"]["basis"] and "63 A (E0)" in declared["as_found"]["basis"]
    assert "inputs_declared_assumed" not in plain and len(declared["inputs_declared_assumed"]) == 7
    from gridforge.validation import EvidenceClass
    p, d = load_document(qualify_to_intake(dict(HALL))), load_document(qualify_to_intake({**HALL, "assumed_fields": list(QUALIFY_FIELDS)}))
    assert [s.path for s in p.report.sourced] == []
    assert sorted(s.path for s in d.report.sourced if s.evidence == "E0") == sorted([*QUALIFY_FIELDS.values(), "grid.firm_capacity_MVA"])
    for q in ("tapoff_max_A", "busway_ampacity_A"):
        assert getattr(p.context.power.lv, q).evidence is EvidenceClass.E5_CUSTOMER_DATA
        assert getattr(d.context.power.lv, q).evidence is EvidenceClass.E0_ASSUMPTION
    assert p.context.power.grid.contracted_MW.evidence is EvidenceClass.E5_CUSTOMER_DATA
    assert d.context.power.grid.contracted_MW.evidence is EvidenceClass.E0_ASSUMPTION


def test_a_declared_request_says_how_many_supplied_figures_are_assumptions(base):
    """completeness and required_inputs_missing count a declared figure as supplied; assumed_count says so. Absent from a plain request."""
    plain = post(base, dict(HALL))[1]["intake"]
    declared = post(base, {**HALL, "assumed_fields": list(QUALIFY_FIELDS)})[1]["intake"]
    assert "assumed_count" not in plain and "assumed_count_note" not in plain
    assert declared["assumed_count"] == 7 and "count figures declared assumed as supplied" in declared["assumed_count_note"]
    assert declared["completeness"] == plain["completeness"] and declared["required_inputs_missing"] == plain["required_inputs_missing"]
    some = post(base, {**HALL, "assumed_fields": ["tapoff_max_A", "contracted_MW"]})[1]["intake"]
    assert some["assumed_count"] == 2


# --- positions above the default rack total, declared assumed or annotated ----------------------------------------------------------
@pytest.mark.parametrize("positions", [401, 500, 1200])
def test_positions_above_the_default_rack_total_are_accepted_declared_assumed_exactly_as_plain(base, positions):
    """hall.rack_positions defaults to max(400, declared positions). The default read the declared number only from a plain figure, so the annotated
    form {value, evidence, note} (which is what assumed_fields sends) was read as 0 and refused with 'more than hall.rack_positions (400)'."""
    body = {**HALL, "positions_available": positions}
    s1, plain = post(base, body)
    s2, declared = post(base, {**body, "assumed_fields": ["positions_available"]})
    assert (s1, s2) == (200, 200), (plain, declared)
    for k in ("racks",):
        assert declared["as_found"][k] == plain["as_found"][k]
    assert declared["after_relief"]["racks"] == plain["after_relief"]["racks"]
    assert declared["as_found"]["basis"] == plain["as_found"]["basis"]


def test_an_annotated_positions_figure_in_an_intake_document_is_read_like_the_plain_number():
    doc = qualify_to_intake(dict(HALL))
    doc["hall"]["positions_available"] = {"value": 500, "note": "from the tenancy schedule"}
    annotated = load_document(doc)
    doc["hall"]["positions_available"] = 500
    plain = load_document(doc)
    assert annotated.context.hall.positions_available == plain.context.hall.positions_available == 500
    assert annotated.context.hall.rack_positions == plain.context.hall.rack_positions == 500
