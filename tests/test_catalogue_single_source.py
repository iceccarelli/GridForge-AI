"""Every product in lib/products.ts, every field, against gridforge/commercial.py and the published tool catalogue.

tests/test_catalogue_parity.py compares the products somebody thought to list. This file starts from lib/products.ts and REFUSES a product it
cannot place, so a product added to the site with no engine counterpart (or an engine engagement nobody can buy) fails here. The outputs
(/openapi.json, /llms.txt, /pricing, JSON-LD) are checked against the same catalogue in tests/site/billing-catalogue.test.ts.

  SOLD_AS_ENGAGEMENT   the site product -> the engine engagement it IS (a one-off fee) or OPENS (a deposit against a scoped band)
  SOLD_AS_API_PLAN     the site product -> the engine API plan
  SITE_ONLY            sold on the site with no engine price, declared here on purpose, with the reason
"""
import json
import re
from pathlib import Path

import pytest

from gridforge.commercial import API_PLANS, ENGAGEMENTS, PAYG

ROOT = Path(__file__).resolve().parents[1]
PRODUCTS_TS = ROOT / "lib" / "products.ts"

SOLD_AS_ENGAGEMENT = {
    "density_screen": ("density_screen", "fee"),
    "procurement_spec": ("procurement_spec", "fee"),
    "envelope_study_deposit": ("envelope_study", "deposit"),
    "portfolio_screen_deposit": ("portfolio_screen", "deposit"),
}
SOLD_AS_API_PLAN = {"api_triage": "api_triage", "api_scale": "api_scale", "api_platform": "api_platform"}
#: Hall Watch is a quarterly subscription delivered by the site's own cron (app/api/cron/watches); the engine prices no such thing.
SITE_ONLY = {"hall_watch": ("month", 3)}


def _num(raw: str) -> int:
    return int(raw.replace("_", ""))


def ts_chunks() -> dict[str, str]:
    body = PRODUCTS_TS.read_text().split("export const PRODUCTS", 1)[1].split("export const API_PRODUCTS", 1)[0]
    return {m.group(1): m.group(2) for m in re.finditer(r"^  (\w+): \{(.*?)^  \},", body, re.S | re.M)}


def field(chunk: str, name: str, pattern: str = r"[\w_]+"):
    m = re.search(rf"\b{name}:\s*({pattern})", chunk)
    return None if m is None else m.group(1)


@pytest.fixture(scope="module")
def ts() -> dict[str, dict]:
    out = {}
    for pid, chunk in ts_chunks().items():
        rec = {
            "id": field(chunk, "id", r'"[^"]+"').strip('"'),
            "kind": field(chunk, "kind", r'"[^"]+"').strip('"'),
            "name": field(chunk, "name", r'"[^"]+"').strip('"'),
            "amountCents": _num(field(chunk, "amountCents")),
            "turnaroundDays": _num(field(chunk, "turnaroundDays")),
            "producesDeliverable": field(chunk, "producesDeliverable") == "true",
            "apiUnits": None,
            "recurring": None,
            "band": None,
            "creditsAgainst": None,
        }
        if (u := field(chunk, "apiUnits")) is not None:
            rec["apiUnits"] = _num(u)
        if (r := re.search(r'interval:\s*"(\w+)",\s*intervalCount:\s*(\d+)', chunk)):
            rec["recurring"] = (r.group(1), int(r.group(2)))
        if (b := re.search(r"opensBandCents:\s*\[([\d_]+),\s*([\d_]+)\]", chunk)):
            rec["band"] = (_num(b.group(1)), _num(b.group(2)))
        if (c := field(chunk, "creditsAgainst", r'"[^"]+"')) is not None:
            rec["creditsAgainst"] = c.strip('"')
        out[pid] = rec
    assert out, "could not parse lib/products.ts: the price list moved"
    return out


def test_every_field_parsed_for_every_product(ts):
    for pid, rec in ts.items():
        assert rec["id"] == pid and rec["kind"] == pid, f"{pid}: the webhook dispatches on kind, which must equal the id"
        assert rec["amountCents"] > 0 and rec["name"]


def test_every_site_product_is_placed_and_nothing_is_placed_twice(ts):
    placed = [*SOLD_AS_ENGAGEMENT, *SOLD_AS_API_PLAN, *SITE_ONLY]
    assert len(placed) == len(set(placed))
    assert set(ts) == set(placed), f"a product has no declared counterpart in gridforge/commercial.py (or the reverse): {set(ts) ^ set(placed)}"


def test_every_engine_price_is_sold_on_the_site():
    """The reverse direction: an engagement or plan the engine quotes that nobody can buy is a price list with a dead row."""
    assert {e for e, _ in SOLD_AS_ENGAGEMENT.values()} == set(ENGAGEMENTS)
    assert set(SOLD_AS_API_PLAN.values()) == set(API_PLANS)


@pytest.mark.parametrize("pid", sorted(SOLD_AS_ENGAGEMENT))
def test_engagement_product_agrees_on_id_name_amount_turnaround_and_deposit_semantics(ts, pid):
    eng_id, mode = SOLD_AS_ENGAGEMENT[pid]
    eng, prod = ENGAGEMENTS[eng_id], ts[pid]
    assert prod["recurring"] is None, f"{pid} is a one-off purchase, not a subscription"
    assert prod["apiUnits"] is None
    assert prod["turnaroundDays"] == eng.turnaround_days, (
        f"{pid}: the site promises {prod['turnaroundDays']} working days, the engine's proposal says {eng.turnaround_days}")
    if mode == "fee":
        assert prod["amountCents"] == eng.price_eur * 100
        assert prod["name"] == eng.name
        assert prod["band"] is None, "a fixed-fee product has no scoped band"
    else:
        assert eng.price_eur_max, f"{eng_id} is bought by deposit so the engine must quote a band"
        assert prod["band"] == (eng.price_eur * 100, eng.price_eur_max * 100)
        assert 0 < prod["amountCents"] < prod["band"][0], "a deposit is smaller than the engagement it opens"
        assert prod["name"].startswith(eng.name) and prod["name"].endswith("deposit"), f"{pid} must say it is a deposit: {prod['name']!r}"
        assert not prod["producesDeliverable"], "a deposit starts a scoping conversation, not the intake -> generate flow"


@pytest.mark.parametrize("pid", sorted(SOLD_AS_API_PLAN))
def test_api_product_agrees_on_id_amount_units_interval_and_has_no_delivery(ts, pid):
    plan, prod = API_PLANS[SOLD_AS_API_PLAN[pid]], ts[pid]
    assert plan.id == pid
    assert (prod["name"], prod["amountCents"], prod["apiUnits"]) == (plan.name, plan.price_eur_month * 100, plan.monthly_units)
    assert prod["recurring"] == ("month", 1), "an API plan is billed monthly in subscription mode"
    assert prod["turnaroundDays"] == 0, "a key is issued on payment: there is nothing to wait for"
    assert not prod["producesDeliverable"]


def test_the_site_only_product_is_declared_and_recurring_as_stated(ts):
    for pid, interval in SITE_ONLY.items():
        assert ts[pid]["recurring"] == interval
        assert pid not in ENGAGEMENTS and pid not in API_PLANS
        assert ts[pid]["apiUnits"] is None


def test_only_subscription_products_recur(ts):
    assert {p for p, r in ts.items() if r["recurring"]} == {*SOLD_AS_API_PLAN, *SITE_ONLY}


def test_credit_semantics_agree(ts):
    """density_screen credits against the Study: the engine says envelope_study, the site says the study's deposit product."""
    assert ENGAGEMENTS["density_screen"].credits_against == "envelope_study"
    assert ts["density_screen"]["creditsAgainst"] == "envelope_study_deposit"
    assert SOLD_AS_ENGAGEMENT["envelope_study_deposit"][0] == "envelope_study"
    for eng in ENGAGEMENTS.values():
        if eng.credits_against:
            assert eng.credits_against in ENGAGEMENTS
    credited = {p: r["creditsAgainst"] for p, r in ts.items() if r["creditsAgainst"]}
    assert all(target in ts for target in credited.values())


def test_the_published_tool_catalogue_carries_the_engines_own_units_tiers_and_unit_price():
    """public/reference/tools.json is what /openapi.json, /llms.txt and /pricing quote units from: it must equal what the engine serves."""
    from gridforge.api.metering import UNIT_COST
    from gridforge.api.tools import TOOLS

    published = json.loads((ROOT / "public" / "reference" / "tools.json").read_text())
    pub = {t["name"]: (t["endpoint"], t["tier"], t["units"]) for t in published["tools"]}
    assert pub == {t["name"]: (t["endpoint"], t["tier"], t["units"]) for t in TOOLS}
    assert all(UNIT_COST.get(ep, 1) == units for ep, _, units in pub.values())
    assert {r["endpoint"]: r["units"] for r in published["rate_card"]} == dict(UNIT_COST)
    assert published["payg"]["unit_price_cents"] == PAYG.unit_price_cents
