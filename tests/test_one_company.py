"""One domain, one company, one price list.

The site was two businesses wearing one skin.

The practice this repository began as sold behind-the-meter power: hybrid
microgrids, high-voltage DC distribution, containerised blocks to 120 MW+, a Power
Audit at EUR 25k-45k. The practice it became tells the owner of an existing hall
what stops their already-contracted megawatts becoming compute, for EUR 4,500.

Both were live. /pricing rendered both fee structures, one above the other.
/infrastructure sold "megawatts in months". And every canonical URL — JSON-LD,
robots, sitemap, llms.txt, the citation endpoint — pointed at a Vercel preview
domain while every email and Stripe link pointed at the real one.

None of that is a design opinion. Under the capital rule the company owns no energy
assets and funds no physical deployment, so a page offering them is a claim that
cannot be met; and a price nowhere in the engine's catalogue is a price the parity
test cannot see.
"""
import re
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]


def tracked(suffixes=(".ts", ".tsx")) -> list[Path]:
    out = subprocess.run(["git", "ls-files"], cwd=ROOT, capture_output=True,
                         text=True, check=True).stdout.split()
    return [ROOT / f for f in out if f.endswith(suffixes)]


# --- one domain ------------------------------------------------------------

REGISTRY = ROOT / "lib" / "site.ts"


def test_the_site_url_has_exactly_one_definition():
    src = REGISTRY.read_text()
    assert "export const SITE_URL" in src
    assert "NEXT_PUBLIC_SITE_URL" in src, "a preview deployment must be able to override it"
    assert '"https://timetopower.ai"' in src, "the production domain is the default"


def test_no_file_hardcodes_a_site_url_except_the_registry():
    """Six files hardcoded a preview domain and seven hardcoded the real one. Search
    engines were told the canonical home was the preview URL, which splits authority
    away from the domain that actually serves the site."""
    offenders = []
    for f in tracked():
        if f == REGISTRY:
            continue
        text = f.read_text()
        for m in re.finditer(r'https?://(?!\S*@)(timetopower\.ai|[\w-]+\.vercel\.app)', text):
            offenders.append(f"{f.relative_to(ROOT)}: {m.group(0)}")
    assert not offenders, (
        "hardcoded site URLs — use SITE_URL / siteUrl() from lib/site.ts:\n  "
        + "\n  ".join(offenders))


def test_the_public_surfaces_all_read_the_registry():
    for rel in ["app/layout.tsx", "components/JsonLd.tsx", "app/robots.ts",
                "app/sitemap.ts", "app/llms.txt/route.ts", "app/api/cite/route.ts"]:
        src = (ROOT / rel).read_text()
        assert "SITE_URL" in src or "siteUrl" in src, f"{rel} does not read the registry"


def test_the_citation_points_at_the_domain_that_serves_the_site():
    """We ask people to cite us. Citing a preview URL is worse than not being cited."""
    src = (ROOT / "app" / "api" / "cite" / "route.ts").read_text()
    assert "vercel.app" not in src
    assert 'siteUrl("/constraints")' in src


# --- one price list --------------------------------------------------------

def test_no_price_lives_outside_the_catalogue():
    """A euro figure on a page is a price, and a price the engine has never heard of
    cannot be parity-tested against what a proposal quotes."""
    allowed = {ROOT / "lib" / "products.ts", ROOT / "lib" / "commerce.ts"}
    offenders = []
    for f in tracked():
        if f in allowed or "/legal/" in str(f):
            continue
        text = f.read_text()
        for m in re.finditer(r"€\s?\d[\d,.]*\s?[kKmM]?", text):
            line = text[: m.start()].count("\n") + 1
            offenders.append(f"{f.relative_to(ROOT)}:{line} {m.group(0)}")
    assert not offenders, (
        "prices outside lib/products.ts:\n  " + "\n  ".join(offenders))


def test_no_price_hides_from_the_guard_by_being_written_in_cents():
    """The euro guard above looks for the € sign. A price written as `priceCents:
    199900` and rendered through a formatter carries no € anywhere in its file, so
    it is invisible to it — which is how a third fee structure could appear on the
    site without anything failing.

    lib/subscriptions.ts carried the GridForge Intelligence tiers this way — 49900,
    199900, 499900 — and was therefore the second price list the "one price list"
    rule exists to prevent, sitting in plain sight and invisible to every check.

    The question it raised was whether a recurring software subscription belongs in
    a catalogue of engine engagements. The file itself answers it: lib/products.ts
    already prices hall_watch, which recurs, and api_triage / api_scale /
    api_platform, which are metered software subscriptions involving no engineering
    hours at all. Intelligence is the same shape as those. Its prices now live
    there and lib/subscriptions.ts holds only the sales copy, so there is no
    exception left to declare — which is the point. The remaining entries set no
    price; they read amounts back out of Stripe or record what was charged.
    """
    declared = {
        ROOT / "lib" / "products.ts": "the catalogue — the one place a price is set",
        ROOT / "lib" / "commerce.ts": "the deposit rule",
        ROOT / "lib" / "admin.ts": "reads amounts back out of Stripe, sets none",
        ROOT / "lib" / "deliverables.ts": "records what was charged, sets nothing",
    }
    offenders = []
    for f in tracked():
        if f in declared or "/legal/" in str(f):
            continue
        for m in re.finditer(r"[Pp]rice[A-Za-z]*\s*:\s*(\d{4,})", f.read_text()):
            line = f.read_text()[: m.start()].count("\n") + 1
            offenders.append(f"{f.relative_to(ROOT)}:{line} {m.group(0)}")
    assert not offenders, (
        "prices written in cents outside the declared files:\n  "
        + "\n  ".join(offenders)
        + "\n\nAdd it to lib/products.ts, or declare it in this test with the "
          "reason it lives elsewhere.")


def test_the_second_price_list_is_gone():
    src = REGISTRY.read_text()
    assert "export const PACKAGES" not in src, (
        "PACKAGES was a second fee structure rendered above the real ladder")
    pricing = (ROOT / "app" / "pricing" / "page.tsx").read_text()
    code = "\n".join(l for l in pricing.split("\n")
                     if not l.lstrip().startswith(("//", "*", "{/*")))
    assert "PACKAGES" not in code, "still renders the second price list"
    assert "EngagementLadder" in pricing, "the catalogue must still be rendered"


def test_the_services_list_matches_what_can_be_bought():
    """SERVICES advertised hybrid microgrids, HVDC distribution and an EMS. A
    services list describing a different company is a claim, not an aspiration."""
    src = REGISTRY.read_text()
    m = re.search(r"export const SERVICES\s*=\s*\[(.*?)\n\];", src, re.S)
    assert m, "SERVICES not found"
    block = m.group(1)
    for gone in ["Hybrid Behind-the-Meter Microgrid", "High-Voltage DC Distribution",
                 "Physics-Informed EMS", "Power Audit", "Commissioning & EMS Tuning"]:
        assert gone not in block, f"SERVICES still offers {gone!r}"
    for real in ["Density Screen", "Envelope Study", "Procurement Specification",
                 "Hall Watch"]:
        assert real in block, f"SERVICES omits {real!r}"


# --- nothing we do not own or build ----------------------------------------

BANNED_OFFERS = [
    "POWER_BLOCKS",
    "CONFIG_VARIANTS",
    "Megawatts in months",
    "Power blocks you can deploy",
    "Stand up a megawatt",
]


def test_no_page_offers_plant_we_do_not_build_own_or_fund():
    """The capital rule: no owned energy assets, no owned hardware, no speculative
    installation. Physical deployment is customer-funded. A page offering
    containerised megawatts with lead times is fictitious capacity in the clothes of
    a product sheet."""
    offenders = []
    for f in tracked():
        if f.name.startswith("test_"):
            continue
        # A comment recording WHY an offer was removed is not an offer. Strip
        # every comment form before looking, rather than asking prose to be
        # written so a regex can cope with it.
        text = f.read_text()
        stripped = re.sub(r"\{/\*.*?\*/\}", "", text, flags=re.S)
        stripped = re.sub(r"/\*.*?\*/", "", stripped, flags=re.S)
        stripped = re.sub(r"^\s*//.*$", "", stripped, flags=re.M)
        for phrase in BANNED_OFFERS:
            if phrase in stripped:
                offenders.append(f"{f.relative_to(ROOT)}: {phrase}")
    assert not offenders, "offers we cannot meet:\n  " + "\n  ".join(offenders)


def test_the_infrastructure_page_is_gone():
    assert not (ROOT / "app" / "infrastructure").exists(), (
        "a whole page sold behind-the-meter power blocks by the megawatt")
    nav = (ROOT / "components" / "Navbar.tsx").read_text()
    assert "/infrastructure" not in nav
    assert "/infrastructure" not in (ROOT / "app" / "sitemap.ts").read_text()


def test_market_statistics_are_still_labelled_as_the_market_not_as_us():
    """Removing our own invented capacity does not mean removing sourced figures
    about the market the buyer lives in. Those stay, with their sources."""
    src = REGISTRY.read_text()
    m = re.search(r"export const MARKET_STATS\s*=\s*\[(.*?)\n\];", src, re.S)
    assert m, "MARKET_STATS was removed — that went too far"
    assert m.group(1).count("source:") >= 3, "every market figure carries its source"
