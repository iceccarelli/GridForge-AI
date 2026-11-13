"""/v1/portfolio: a hall that is not ranked has no rank, and the request cap is published wherever the route is described.

The audit found (J4-2) an unrankable hall given `rank: 3` while its own note said "not ranked", and (J4-1) a 50-hall cap that is in no schema, no
tools.json and no doc: GET /v1/estimate?endpoint=/v1/portfolio&hall_count=200 answered "200 units" with no warning, and the plan copy sold a
"200-hall sweep" as one request.
"""
from __future__ import annotations

import copy
import json
from pathlib import Path

import pytest

from gridforge.api import server as S
from gridforge.api.metering import MAX_PORTFOLIO_HALLS, UNIT_COST, portfolio_cap_message
from gridforge.api.server import ApiError, handle_estimate, handle_portfolio, qualify_to_intake
from gridforge.api.tiers import Tier
from gridforge.api.tools import TOOLS_BY_NAME, rate_card
from gridforge.commercial import API_PLANS, ENGAGEMENTS
from payg_rig import INTAKE, rig  # noqa: F401

ROOT = Path(__file__).resolve().parent.parent


def example(name: str) -> dict:
    return json.loads((ROOT / "examples" / "intake" / f"{name}_hall.json").read_text())


REF, DUB = example("reference"), example("dublin")
QUALIFY = json.loads((ROOT / "examples" / "api" / "qualify-request.json").read_text())


def sparse() -> dict:
    """What the seven-figure qualifier builds: every required input, but no transformer or UPS schedule, so it cannot be ranked."""
    d = qualify_to_intake(QUALIFY)
    d["site"] = {"id": "SPARSE", "name": "Sparse Site"}
    d["hall"] = {**d.get("hall", {}), "id": "H1"}
    return d


def empty() -> dict:
    """A fully declared hall with no free position: rankable on its inputs and deploying nothing."""
    d = copy.deepcopy(REF)
    d["site"].update(id="EMPTY", name="Full Site")
    d["hall"].update(id="E1", positions_available=0)
    return d


def portfolio(docs, objective=None):
    body = {"intakes": docs}
    if objective:
        body["objective"] = objective
    return handle_portfolio(body, Tier.CLIENT)


# --- J4-2 -----------------------------------------------------------------------------------------------------------------------------
@pytest.mark.parametrize("objective", [None, "fastest", "min_cost"])
def test_a_hall_that_is_not_ranked_has_a_null_rank_and_the_ranked_halls_are_numbered_without_a_gap(objective):
    out = portfolio([sparse(), REF, empty(), DUB], objective)
    rows = out["halls"]
    ranked = [r for r in rows if r["rank"] is not None]
    assert [r["rank"] for r in ranked] == list(range(1, len(ranked) + 1)), "the ranks that exist are 1..k"
    assert {r["hall"] for r in ranked} == {REF["hall"]["id"], DUB["hall"]["id"]}
    for r in rows:
        says_not_ranked = "not ranked" in r["rank_note"]
        assert (r["rank"] is None) == says_not_ranked, (r["hall"], r["rank"], r["rank_note"])
    unranked = {r["hall"]: r for r in rows if r["rank"] is None}
    assert set(unranked) == {"H1", "E1"}
    assert unranked["H1"]["rankable"] is False and unranked["E1"]["racks"] == 0
    assert all(r["rank"] is not None for r in rows[:len(ranked)]), "an unranked hall is listed after every ranked one"


def test_every_row_still_says_where_it_sits_in_the_table():
    out = portfolio([sparse(), REF, empty(), DUB])
    assert [r["position"] for r in out["halls"]] == [1, 2, 3, 4]
    assert [r["position"] for r in out["incomparable_halls"]] == [r["position"] for r in out["halls"] if not r["rankable"]]
    assert all(r["rank"] is None for r in out["incomparable_halls"]), "an incomparable hall is not ranked"


def test_the_old_keys_are_still_first_and_in_order_and_position_is_added_after_them():
    row = portfolio([REF, DUB])["halls"][0]
    assert list(row)[0] == "rank" and list(row)[-1] == "position"
    assert row["rank"] == 1


def test_the_document_shows_no_place_for_a_hall_that_is_not_ranked():
    out = handle_portfolio({"intakes": [sparse(), REF, DUB], "format": "md"}, Tier.CLIENT)
    cells = [[c.strip() for c in ln.split("|")[1:-1]] for ln in out["document"]["document"].splitlines() if ln.startswith("|")]
    place = {c[1].split(" / ")[0]: c[0] for c in cells if len(c) >= 9 and " / " in c[1]}
    assert place["Sparse Site"] == "—", place
    assert sorted(v for k, v in place.items() if k != "Sparse Site") == ["1", "2"], place


# --- J4-1 -----------------------------------------------------------------------------------------------------------------------------
def test_the_published_input_schema_carries_the_cap_from_the_one_constant():
    intakes = TOOLS_BY_NAME["gridforge_portfolio"]["inputSchema"]["properties"]["intakes"]
    assert intakes["maxItems"] == MAX_PORTFOLIO_HALLS == S.MAX_PORTFOLIO_HALLS == 50
    assert intakes["minItems"] == 1
    assert str(MAX_PORTFOLIO_HALLS) in intakes["description"] and str(MAX_PORTFOLIO_HALLS) in TOOLS_BY_NAME["gridforge_portfolio"]["description"]
    assert "Bills one unit per hall" in TOOLS_BY_NAME["gridforge_portfolio"]["description"]


def test_the_rate_card_row_of_the_portfolio_says_it_and_no_other_row_does():
    rows = {r["endpoint"]: r for r in rate_card()}
    assert rows["/v1/portfolio"]["max_halls_per_request"] == MAX_PORTFOLIO_HALLS
    assert [e for e, r in rows.items() if "max_halls_per_request" in r] == ["/v1/portfolio"]
    assert rows["/v1/portfolio"]["units"] == UNIT_COST["/v1/portfolio"]


def test_the_estimator_refuses_over_the_cap_with_the_handlers_own_message():
    over = MAX_PORTFOLIO_HALLS + 150
    with pytest.raises(ApiError) as e:
        handle_estimate({"endpoint": "/v1/portfolio", "hall_count": over}, Tier.PUBLIC)
    assert e.value.status == 422 and e.value.message == portfolio_cap_message(over)
    assert e.value.extra["max_halls"] == MAX_PORTFOLIO_HALLS and e.value.extra["requests_needed"] == 4
    with pytest.raises(ApiError) as h:
        handle_portfolio({"intakes": [INTAKE] * over}, Tier.CLIENT)
    assert h.value.message == e.value.message and h.value.extra["max_halls"] == MAX_PORTFOLIO_HALLS


def test_the_estimator_refuses_a_body_over_the_cap_and_prices_one_at_the_cap():
    with pytest.raises(ApiError) as e:
        handle_estimate({"endpoint": "/v1/portfolio", "body": {"intakes": [INTAKE] * (MAX_PORTFOLIO_HALLS + 1)}}, Tier.PUBLIC)
    assert e.value.message == portfolio_cap_message(MAX_PORTFOLIO_HALLS + 1)
    at_cap = handle_estimate({"endpoint": "/v1/portfolio", "hall_count": MAX_PORTFOLIO_HALLS}, Tier.PUBLIC)
    assert at_cap["units"] == MAX_PORTFOLIO_HALLS * UNIT_COST["/v1/portfolio"] and str(MAX_PORTFOLIO_HALLS) in at_cap["basis"]
    no_count = handle_estimate({"endpoint": "/v1/portfolio"}, Tier.PUBLIC)
    assert str(MAX_PORTFOLIO_HALLS) in no_count["basis"], "even with no count, the basis says the cap"


def test_the_estimate_over_http_is_a_422_with_the_named_message(rig):  # noqa: F811
    status, out, _ = rig.get("/v1/estimate?endpoint=/v1/portfolio&hall_count=200")
    assert status == 422 and out["error"] == portfolio_cap_message(200) and out["requests_needed"] == 4


def test_a_portfolio_over_the_cap_is_refused_before_it_is_metered_not_told_it_is_over_quota(rig, monkeypatch):  # noqa: F811
    key = rig.key(scope="payg", quota=10)          # fewer units than the request has halls
    reserved = []
    real = rig.meter.reserve_ex
    monkeypatch.setattr(rig.meter, "reserve_ex", lambda *a, **k: (reserved.append(a), real(*a, **k))[1])
    status, out, _ = rig.post("/v1/portfolio", {"intakes": [INTAKE] * (MAX_PORTFOLIO_HALLS + 1)}, key=key)
    assert status == 422 and out["error"] == portfolio_cap_message(MAX_PORTFOLIO_HALLS + 1) and out["max_halls"] == MAX_PORTFOLIO_HALLS
    assert reserved == [] and rig.events() == []


def test_the_plan_copy_no_longer_sells_a_200_hall_sweep_as_one_request():
    copy_lines = [line for plan in API_PLANS.values() for line in plan.includes]
    assert not [line for line in copy_lines if "200-hall sweep" in line]
    portfolio_line = next(line for line in copy_lines if line.startswith("Portfolio endpoint"))
    assert f"up to {MAX_PORTFOLIO_HALLS} halls" in portfolio_line and "per hall" in portfolio_line


def test_the_api_cap_is_not_written_into_the_engagement_copy():
    """The Portfolio Screen ENGAGEMENT is sold for five to fifteen halls and the intake form takes two to fifteen: the API cap is a different thing
    and moves none of that."""
    eng = ENGAGEMENTS["portfolio_screen"]
    assert eng.price_eur == 60_000 and eng.price_eur_max == 140_000
    assert f"{MAX_PORTFOLIO_HALLS} halls" not in json.dumps(eng.__dict__, default=str)
