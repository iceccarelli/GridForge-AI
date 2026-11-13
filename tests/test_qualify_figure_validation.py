"""/v1/qualify checks every figure BY THE NAME THE CALLER SENT IT UNDER, and states one rule for how many figures it needs.

The audits found: contracted_MW=-5, 12000, 1e9 and 4851 (inside its own 5000 cap) were refused as 'firm connection capacity
(grid.firm_capacity_MVA) is ...', a field the caller never sent; a 400-digit integer was 'OverflowError: int too large to convert to float'
(a 422 that said nothing about the figure); and three surfaces disagreed about what the route requires (the published schema said four figures,
the 422 listed three, the code needs any three of seven), with an explicit null silently using a library default.
"""
from __future__ import annotations

import json
import os
import threading
import urllib.error
import urllib.request

import pytest

from gridforge.api import server as S
from gridforge.api.server import ApiError, Handler, handle_qualify, make_server
from gridforge.api.tiers import Tier
from gridforge.api.tools import TOOLS_BY_NAME
from gridforge.intake.loader import PLAUSIBLE_MAX

HALL = {"contracted_MW": 12, "current_site_peak_MW": 7.4, "current_it_load_MW": 4.9,
        "busway_ampacity_A": 400, "tapoff_max_A": 63, "plant_supply_C": 6, "positions_available": 180}


@pytest.fixture(scope="module")
def base():
    mp = pytest.MonkeyPatch()
    mp.setenv("GRIDFORGE_RATE_LIMIT", "0")
    mp.setattr(Handler.limiter, "per_minute", 0)
    httpd = make_server("127.0.0.1", 0)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{httpd.server_address[1]}"
    httpd.shutdown()
    mp.undo()


def post(base, body, path="/v1/qualify"):
    raw = body if isinstance(body, bytes) else json.dumps(body).encode()
    req = urllib.request.Request(base + path, data=raw, method="POST", headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


def refusal(body):
    with pytest.raises(ApiError) as e:
        handle_qualify(dict(body), Tier.PUBLIC)
    assert e.value.status == 422
    return e.value


# --- J1-7 / N12: a refusal names the figure the caller sent ---------------------------------------------------------------------------
@pytest.mark.parametrize("value", [-5, 12000, 1e9])
def test_a_contract_the_loader_would_refuse_is_refused_by_its_own_name(value):
    msg = refusal({**HALL, "contracted_MW": value}).message
    assert msg.startswith("contracted_MW is "), msg
    assert "firm" not in msg and "grid." not in msg, "a field the caller never sent must not be named"


def test_a_contract_inside_its_cap_whose_derived_connection_is_not_says_what_was_derived():
    err = refusal({**HALL, "contracted_MW": 4851})
    assert err.message == ("contracted_MW=4851 implies a firm capacity of 5001.03 MVA, above the 5000 MVA the engine accepts; "
                           "send a smaller contracted_MW")
    assert err.extra["field"] == "contracted_MW"


def test_the_derived_ceiling_comes_from_the_loaders_constant_not_a_retyped_number(monkeypatch):
    monkeypatch.setitem(PLAUSIBLE_MAX, "grid.firm_capacity_MVA", 100.0)
    err = refusal({**HALL, "contracted_MW": 98})          # 98 / 0.97 = 101.03: over the (patched) bound, under contracted_MW's own
    assert "implies a firm capacity of 101.03 MVA, above the 100 MVA" in err.message
    assert handle_qualify({**HALL, "contracted_MW": 96}, Tier.PUBLIC)["as_found"]["racks"] >= 0


def test_a_declared_assumed_contract_gets_the_same_derived_refusal():
    err = refusal({**HALL, "contracted_MW": 4851, "assumed_fields": ["contracted_MW"]})
    assert err.message.startswith("contracted_MW=4851 implies a firm capacity of 5001.03 MVA")


def test_a_firm_capacity_the_caller_gives_is_not_derived_and_so_not_refused_for_being_derived():
    out = handle_qualify({**HALL, "contracted_MW": 4900, "firm_capacity_MVA": 4950}, Tier.PUBLIC)
    assert "inputs_derived_assumed" not in out


@pytest.mark.parametrize("name", list(S.QUALIFY_FIGURE_PATHS))
def test_every_figure_is_held_to_the_loaders_own_ceiling_under_its_own_name(name):
    ceiling = PLAUSIBLE_MAX[S.QUALIFY_FIGURE_PATHS[name]]
    over = ceiling + 1 if name == "positions_available" else ceiling * 1.01
    msg = refusal({**HALL, name: over}).message
    assert msg.startswith(f"{name} is "), msg
    assert f"above {ceiling:g}" in msg
    assert not [path for path in S.QUALIFY_FIGURE_PATHS.values() if path in msg], "the intake path the figure becomes is not the caller's name for it"


@pytest.mark.parametrize("name", [n for n in S.QUALIFY_FIELDS if n != "contracted_MW"])
def test_a_figure_exactly_at_its_ceiling_is_still_accepted(name):
    ceiling = PLAUSIBLE_MAX[S.QUALIFY_FIGURE_PATHS[name]]
    assert handle_qualify({**HALL, name: ceiling}, Tier.PUBLIC)["as_found"]


def test_inputs_that_were_accepted_before_are_still_accepted():
    for ok in ({"contracted_MW": 0}, {"plant_supply_C": -5}, {"positions_available": 0}, {"positions_available": 180.0}):
        assert handle_qualify({**HALL, **ok}, Tier.PUBLIC)["as_found"], ok


# --- review E7: a floor is applied by the caller's own name too ------------------------------------------------------------------------
@pytest.mark.parametrize("value", [-5.01, -6, -30, -273.16, -1e9])
def test_a_plant_supply_below_the_floor_is_refused_by_its_own_name_with_a_field(value):
    """plant_supply_C = -6 was answered 'plant chilled-water supply temperature (thermal.plant.design_supply_C) is -6 degC...': the intake path the
    caller never sent, and no `field` key, where the ceilings (and positions) name the figure and carry `field`."""
    err = refusal({**HALL, "plant_supply_C": value})
    assert err.message.startswith(f"plant_supply_C is {value:g} degC, below -5 degC, the lowest this tool will model"), err.message
    assert "thermal.plant" not in err.message and "design_supply_C" not in err.message
    assert err.extra["field"] == "plant_supply_C" and err.extra["limit"] == -5
    assert "chilled-water plant does not supply colder than about -5 degC" in err.message          # the loader's own reason travels with it


def test_the_floor_message_is_in_the_style_of_the_ceiling_message():
    ceiling = refusal({**HALL, "plant_supply_C": 41}).message
    floor = refusal({**HALL, "plant_supply_C": -6}).message
    assert ceiling.startswith("plant_supply_C is 41 degC, above 40 degC, the most this tool will model for one hall.")
    assert floor.startswith("plant_supply_C is -6 degC, below -5 degC, the lowest this tool will model for one hall.")


def test_the_floor_is_inclusive_and_the_http_answer_carries_the_field(base):
    assert handle_qualify({**HALL, "plant_supply_C": -5}, Tier.PUBLIC)["as_found"]
    status, out = post(base, {**HALL, "plant_supply_C": -6})
    assert status == 422 and out["field"] == "plant_supply_C" and out["limit"] == -5 and out["error"].startswith("plant_supply_C is -6 degC")


def test_the_floor_is_the_loaders_own_so_the_two_cannot_disagree():
    from gridforge.intake.loader import PLAUSIBLE_MIN, plausible_floor
    assert plausible_floor("thermal.plant.design_supply_C", "degC")[0] == PLAUSIBLE_MIN["thermal.plant.design_supply_C"] == -5
    assert plausible_floor("grid.contracted_MW", "MW") == (None, "")                      # a figure with no floor has none
    assert plausible_floor("anything.else", "degC")[0] == -273.15                          # a temperature is never below absolute zero


@pytest.mark.parametrize("name", list(S.QUALIFY_FIGURE_PATHS))
def test_a_400_digit_integer_is_a_named_422_not_an_overflow(base, name):
    huge = int("9" * 400)
    status, out = post(base, json.dumps({**HALL, name: huge}).encode())
    assert status == 422, out
    assert out["error"] == f"{name} is too large to be a number this tool can model", out
    assert "Overflow" not in json.dumps(out) and "could not be processed" not in json.dumps(out)


def test_a_number_that_parses_to_infinity_is_a_named_422():
    raw = json.dumps(HALL).replace('"contracted_MW": 12', '"contracted_MW": 1e999').encode()
    assert b"1e999" in raw
    body = json.loads(raw)
    assert body["contracted_MW"] == float("inf")
    assert "contracted_MW must be a finite number" in refusal(body).message


@pytest.mark.parametrize("bad", [2.5, -1])
def test_positions_must_be_a_whole_number_named_as_the_caller_sent_it(bad):
    msg = refusal({**HALL, "positions_available": bad}).message
    assert msg.startswith("positions_available is ") and "whole number" in msg and "hall." not in msg


# --- J1-8: one rule, stated one way -------------------------------------------------------------------------------------------------------
def test_the_published_schema_requires_no_single_figure_and_states_the_rule():
    schema = TOOLS_BY_NAME["gridforge_qualify"]["inputSchema"]
    assert "required" not in schema, "no one figure is required: any three of the seven are enough"
    assert "send at least three of these seven figures; each one you omit is an assumption named in the answer" in schema["description"].lower()
    assert "more than four" not in schema["description"] and "four marked required" not in schema["description"]


def test_the_engine_accepts_any_three_of_the_seven_and_refuses_two(base):
    figures = list(S.QUALIFY_FIELDS)
    for chosen in (figures[:3], figures[-3:], figures[2:5]):
        assert post(base, {k: HALL[k] for k in chosen})[0] == 200, chosen
    status, out = post(base, {k: HALL[k] for k in figures[:2]})
    assert status == 422


def test_the_422_lists_all_seven_figures_and_the_count():
    err = refusal({k: HALL[k] for k in list(HALL)[:2]})
    assert "at least 3 of the 7" in err.message and "this request has 2" in err.message
    assert err.extra["required_at_least"] == list(S.QUALIFY_FIELDS) and len(err.extra["required_at_least"]) == 7
    assert err.extra["minimum_figures"] == S.QUALIFY_MIN_FIGURES == 3 and err.extra["figures_sent"] == 2
    assert err.extra["missing"] == list(S.QUALIFY_FIELDS)[2:]


def test_an_explicit_null_is_not_supplied_in_the_count_and_the_422_says_so():
    body = {"contracted_MW": None, "current_site_peak_MW": 7.4, "current_it_load_MW": 4.9}
    err = refusal(body)
    assert err.extra["figures_sent"] == 2 and "contracted_MW" in err.extra["missing"]
    assert "a figure sent as null is not sent: contracted_MW" in err.message


def test_an_explicit_null_is_answered_as_a_named_assumption_not_silently():
    out = handle_qualify({**HALL, "contracted_MW": None, "plant_supply_C": None, "positions_available": None}, Tier.PUBLIC)
    rows = {r["field"]: r for r in out["figures_not_supplied"]}
    assert set(rows) == {"contracted_MW", "plant_supply_C", "positions_available"}
    assert all(r["sent"] == "null" for r in rows.values())
    assert rows["contracted_MW"]["path"] == "grid.contracted_MW" and "(E0)" in rows["contracted_MW"]["assumed"]
    # and the same assumption is in the gap list the engine always gave
    assert "grid.contracted_MW" in [g["path"] for g in out["intake"]["gaps"]]


def test_a_figure_left_out_is_listed_as_absent_and_a_complete_request_lists_none():
    out = handle_qualify({k: v for k, v in HALL.items() if k != "tapoff_max_A"}, Tier.PUBLIC)
    assert [(r["field"], r["sent"]) for r in out["figures_not_supplied"]] == [("tapoff_max_A", "absent")]
    assert handle_qualify(dict(HALL), Tier.PUBLIC)["figures_not_supplied"] == []


def test_a_null_is_the_same_answer_as_leaving_the_figure_out_apart_from_saying_so():
    omitted = handle_qualify({k: v for k, v in HALL.items() if k != "contracted_MW"}, Tier.PUBLIC)
    nulled = handle_qualify({**HALL, "contracted_MW": None}, Tier.PUBLIC)
    for out in (omitted, nulled):
        out.pop("figures_not_supplied")
    assert omitted == nulled


def test_the_mcp_instructions_state_the_same_rule():
    from gridforge.api.server import handle_mcp
    out = handle_mcp({"jsonrpc": "2.0", "id": 1, "method": "initialize"}, Tier.PUBLIC, lambda *a, **k: None)
    text = out["result"]["instructions"]
    assert "at least three of its seven figures" in text and "It needs only" not in text
