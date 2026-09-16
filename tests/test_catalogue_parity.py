"""One price list, two languages.

gridforge/commercial.py prices the proposals the engine generates. lib/products.ts
prices the checkout page. They are written in different languages by different
halves of the system and there is no shared runtime between them, so the only thing
stopping them drifting is this file.

A proposal that quotes a different number from the checkout page is worse than no
proposal: it is the moment a buyer stops believing the rest of the document. The
commercial.py docstring has claimed this test existed since patch 0001. It did not.
"""
import re
from pathlib import Path

import pytest

from gridforge.commercial import API_PLANS, ENGAGEMENTS

ROOT = Path(__file__).resolve().parents[1]
PRODUCTS_TS = ROOT / "lib" / "products.ts"


def ts_products() -> dict[str, dict]:
    """Parse the product table out of the TypeScript.

    A real parser would be overkill and a JSON export would be one more thing to
    keep in sync. The fields we care about are simple literals; if the file is
    restructured so this cannot read it, the test fails loudly, which is the
    correct outcome for a change that moves the price list.
    """
    src = PRODUCTS_TS.read_text()
    body = src.split("export const PRODUCTS", 1)[1]
    body = body.split("export const API_PRODUCTS", 1)[0]
    out: dict[str, dict] = {}
    for m in re.finditer(r"^  (\w+): \{(.*?)^  \},", body, re.S | re.M):
        pid, chunk = m.group(1), m.group(2)
        rec: dict = {"id": pid}
        name = re.search(r'name:\s*"([^"]+)"', chunk)
        amount = re.search(r"amountCents:\s*([\d_]+)", chunk)
        units = re.search(r"apiUnits:\s*([\d_]+)", chunk)
        band = re.search(r"opensBandCents:\s*\[([\d_]+),\s*([\d_]+)\]", chunk)
        if band:
            rec["band"] = (int(band.group(1).replace("_", "")),
                           int(band.group(2).replace("_", "")))
        recurring = re.search(r'interval:\s*"(\w+)",\s*intervalCount:\s*(\d+)', chunk)
        if name:
            rec["name"] = name.group(1)
        if amount:
            rec["amountCents"] = int(amount.group(1).replace("_", ""))
        if units:
            rec["apiUnits"] = int(units.group(1).replace("_", ""))
        if recurring:
            rec["recurring"] = (recurring.group(1), int(recurring.group(2)))
        out[pid] = rec
    return out


@pytest.fixture(scope="module")
def ts():
    p = ts_products()
    assert p, "could not parse lib/products.ts — the price list moved"
    return p


def test_every_api_plan_is_purchasable(ts):
    for plan_id, plan in API_PLANS.items():
        assert plan_id in ts, (
            f"{plan_id} is quoted by the engine but cannot be bought on the site")
        prod = ts[plan_id]
        assert prod["amountCents"] == plan.price_eur_month * 100, (
            f"{plan_id}: engine says EUR {plan.price_eur_month}/mo, "
            f"checkout says EUR {prod['amountCents'] / 100:.0f}")
        assert prod["apiUnits"] == plan.monthly_units, (
            f"{plan_id}: engine sells {plan.monthly_units} units, "
            f"checkout sells {prod['apiUnits']}")
        assert prod["name"] == plan.name
        assert prod.get("recurring") == ("month", 1), (
            f"{plan_id} is a monthly plan and must check out in subscription mode")


def test_every_engagement_sold_on_the_site_agrees_with_the_engine(ts):
    """Not only the two that were checked by hand. A new engagement added to one
    side and not the other is exactly the drift this file exists to catch."""
    for pid, prod in ts.items():
        if prod.get("apiUnits") is not None or pid.endswith("_deposit"):
            continue
        if pid not in ENGAGEMENTS:
            continue
        assert prod["amountCents"] == ENGAGEMENTS[pid].price_eur * 100, (
            f"{pid}: engine EUR {ENGAGEMENTS[pid].price_eur}, "
            f"checkout EUR {prod['amountCents'] / 100:.0f}")
        assert prod["name"] == ENGAGEMENTS[pid].name


def test_the_density_screen_price_agrees(ts):
    """The one engagement bought directly on the site, rather than by deposit."""
    assert ts["density_screen"]["amountCents"] == ENGAGEMENTS["density_screen"].price_eur * 100


def test_the_band_a_deposit_opens_comes_from_the_engine(ts):
    """The upper half of every quoted range used to be typed into a component —
    "Deposit against EUR 22k-45k" — so nothing could check it. It is now a figure
    the engine owns."""
    pairs = {"envelope_study_deposit": "envelope_study",
             "portfolio_screen_deposit": "portfolio_screen"}
    for deposit_id, engagement_id in pairs.items():
        band = ts[deposit_id].get("band")
        assert band, f"{deposit_id} quotes no band"
        eng = ENGAGEMENTS[engagement_id]
        assert eng.price_eur_max, f"{engagement_id} has no upper band in the engine"
        assert band == (eng.price_eur * 100, eng.price_eur_max * 100), (
            f"{deposit_id}: site says {band}, engine says "
            f"{(eng.price_eur * 100, eng.price_eur_max * 100)}")
        assert eng.price_eur_max > eng.price_eur


def test_deposits_are_smaller_than_the_engagements_they_open(ts):
    assert ts["envelope_study_deposit"]["amountCents"] < \
        ENGAGEMENTS["envelope_study"].price_eur * 100
    assert ts["portfolio_screen_deposit"]["amountCents"] < \
        ENGAGEMENTS["portfolio_screen"].price_eur * 100


def test_api_access_never_looks_like_a_substitute_for_the_study():
    """Price cannot protect the engagement business — the screening-mode disclosure
    on every response does that. What price can do is keep the API from *reading*
    as a substitute: a month of it must stay clearly under the flagship study, or a
    buyer comparing the two is comparing an opinion with a signature against a JSON
    endpoint and finding them similarly priced."""
    study = ENGAGEMENTS["envelope_study"].price_eur
    for plan in API_PLANS.values():
        assert plan.price_eur_month < study / 2, (
            f"{plan.id} at EUR {plan.price_eur_month}/mo is within reach of the "
            f"EUR {study} study, which carries a named signatory and an indemnity")


def test_the_cheapest_plan_is_a_credible_first_purchase():
    """A first API purchase has to be a decision somebody can take without a
    procurement cycle. Above roughly a thousand euros a month it stops being one."""
    cheapest = min(API_PLANS.values(), key=lambda p: p.price_eur_month)
    assert cheapest.price_eur_month <= 1_000
    assert cheapest.monthly_units >= 500, (
        "an allowance too small to screen a portfolio is not a product, it is a trial")


def test_larger_plans_cost_less_per_unit():
    ordered = sorted(API_PLANS.values(), key=lambda p: p.monthly_units)
    rates = [p.eur_per_unit for p in ordered]
    assert rates == sorted(rates, reverse=True), (
        f"volume must get cheaper per unit, not dearer: {rates}")


def test_the_api_scope_names_what_it_is_not():
    from gridforge.commercial import API_SCOPE_OUT
    joined = " ".join(API_SCOPE_OUT).lower()
    assert "no issued engineering opinion" in joined
    assert "indemnity" in joined


# --- GridForge Intelligence ---------------------------------------------------

def intelligence_plans() -> dict[str, dict]:
    """The Intelligence tiers, parsed out of lib/products.ts.

    They were in lib/subscriptions.ts as bare `priceCents`, next to the copy that
    described them, where nothing could compare them to anything.
    """
    import re
    src = PRODUCTS_TS.read_text()
    assert "INTELLIGENCE_PLANS" in src, (
        "the Intelligence price list left lib/products.ts — it is the only file "
        "allowed to set a euro figure")
    body = src.split("export const INTELLIGENCE_PLANS", 1)[1]
    body = body.split("export const INTELLIGENCE_PLAN_IDS", 1)[0]
    out: dict[str, dict] = {}
    for m in re.finditer(r"^  (\w+): \{(.*?)^  \},", body, re.S | re.M):
        pid, chunk = m.group(1), m.group(2)
        price = re.search(r"priceCents:\s*([\d_]+)", chunk)
        name = re.search(r'name:\s*"([^"]+)"', chunk)
        assert price and name, f"could not read {pid}"
        out[pid] = {"priceCents": int(price.group(1).replace("_", "")),
                    "name": name.group(1)}
    return out


def test_no_intelligence_price_is_set_outside_the_catalogue():
    """lib/subscriptions.ts is presentation now. A price that reappears next to the
    copy describing it is the second price list coming back."""
    src = (ROOT / "lib" / "subscriptions.ts").read_text()
    import re
    stray = re.findall(r"[Pp]rice[A-Za-z]*\s*:\s*\d{3,}", src)
    assert not stray, f"a price was typed back into lib/subscriptions.ts: {stray}"
    assert "INTELLIGENCE_PLANS" in src, "it must read the catalogue, not restate it"


def test_every_intelligence_tier_is_priced_and_ordered():
    plans = intelligence_plans()
    assert set(plans) == {"developer", "team", "enterprise"}, plans
    prices = [plans[p]["priceCents"] for p in ("developer", "team", "enterprise")]
    assert prices == sorted(prices), f"the tiers are not in ascending order: {prices}"
    assert all(p > 0 for p in prices)


def test_intelligence_never_looks_like_a_substitute_for_the_study():
    """The same rule already applied to the API plans, and for the same reason: a
    monthly subscription that reads as comparable in price to the flagship study is
    a buyer comparing a JSON feed with an engineering opinion that carries a named
    signatory and an indemnity, and finding them similarly priced."""
    study = ENGAGEMENTS["envelope_study"].price_eur
    for pid, plan in intelligence_plans().items():
        month = plan["priceCents"] / 100
        assert month < study / 2, (
            f"{pid} at EUR {month:.0f}/mo is within reach of the EUR {study} study")


def test_the_cheapest_intelligence_tier_is_a_credible_first_purchase():
    """Same threshold as the cheapest API plan: above roughly a thousand a month it
    stops being a decision somebody can take without a procurement cycle."""
    cheapest = min(p["priceCents"] for p in intelligence_plans().values()) / 100
    assert cheapest <= 1000, (
        f"the entry tier is EUR {cheapest:.0f}/mo, which needs a procurement cycle")

