"""Navbar/Footer parity and dead-link checks for the site chrome.

Static checks only — no browser, no network — so they run in CI without a
build. The Playwright suite in tests/e2e covers rendered behaviour across
breakpoints; this file covers "does every link lib/nav.ts advertises
actually resolve to a route in app/", which a browser test would only catch
by clicking every single one.
"""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
NAV_TS = (ROOT / "lib" / "nav.ts").read_text()


def read(rel: str) -> str:
    return (ROOT / rel).read_text()


def _extract_hrefs(source: str) -> list[str]:
    return re.findall(r'href:\s*"([^"]+)"', source)


def _extract_hashes(source: str) -> set[str]:
    """hash-flagged entries only, i.e. `{ href: "#x", ..., hash: true }`."""
    hashes = set()
    for m in re.finditer(r'\{\s*href:\s*"(#[^"]+)"[^}]*hash:\s*true\s*\}', source):
        hashes.add(m.group(1))
    return hashes


def route_exists(href: str) -> bool:
    """Does a public route href resolve to a real app/ page?"""
    if href == "/":
        return (ROOT / "app" / "page.tsx").exists()
    path = href.lstrip("/")
    return (ROOT / "app" / path / "page.tsx").exists()


def test_every_nav_link_route_exists():
    hrefs = _extract_hrefs(NAV_TS)
    offenders = [h for h in hrefs if not h.startswith("#") and not route_exists(h)]
    assert not offenders, f"lib/nav.ts points at routes with no app/ page: {offenders}"


def test_every_hash_link_has_a_matching_section_id():
    home = read("components/HomeClient.tsx")
    hashes = _extract_hashes(NAV_TS)
    assert hashes, "expected at least one hash-anchored nav link"
    offenders = [h for h in hashes if f'id="{h.lstrip("#")}"' not in home]
    assert not offenders, f"hash links with no matching section id in HomeClient.tsx: {offenders}"


def test_primary_nav_is_restrained():
    # The header is brand -> product discovery -> technical trust -> purchase
    # -> account, not every route that happens to exist. Application/customer
    # surfaces (dashboard, account, watch, intake, deliverable, api-access,
    # workspace) must not appear in the primary nav.
    match = re.search(r"export const NAV_LINKS: NavLink\[\] = \[(.*?)\n\];", NAV_TS, re.S)
    assert match, "NAV_LINKS not found in lib/nav.ts"
    primary = match.group(1)
    for banned in ["/dashboard", "/account", "/watch", "/intake", "/deliverable", "/api-access", "/workspace"]:
        assert banned not in primary, f"{banned} does not belong in the primary commercial nav"
    assert len(_extract_hrefs(primary)) <= 6, "primary nav should stay short enough to scan in one glance"


def test_client_portal_uses_the_real_dashboard_route():
    match = re.search(r'CLIENT_PORTAL_LINK: NavLink = \{ href: "([^"]+)"', NAV_TS)
    assert match, "CLIENT_PORTAL_LINK not defined in lib/nav.ts"
    assert match.group(1) == "/dashboard"
    assert (ROOT / "app" / "dashboard" / "page.tsx").exists()
    # /dashboard checks its own Supabase session and renders a sign-in prompt
    # or the real engagement list — the chrome does not need its own auth
    # check to send anonymous and signed-in visitors to the right place.
    dashboard = read("app/dashboard/page.tsx")
    assert "getSupabase()" in dashboard
    assert '"anonymous"' in dashboard


def test_navbar_desktop_exposes_client_portal_and_free_check_and_paid_cta():
    navbar = read("components/Navbar.tsx")
    assert "CLIENT_PORTAL_LINK" in navbar
    assert "QUALIFY_LINK" in navbar
    assert "DENSITY_SCREEN_CTA" in navbar


def test_mobile_menu_closes_on_escape_and_has_no_dead_controls():
    navbar = read("components/Navbar.tsx")
    assert '"Escape"' in navbar, "the mobile drawer must be dismissable from the keyboard"
    assert 'aria-controls="mobile-nav"' in navbar
    assert 'id="mobile-nav"' in navbar
    assert 'href="#"' not in navbar, "no placeholder hrefs in the mobile menu"


def test_footer_groups_resolve_to_real_routes():
    match = re.search(r"export const FOOTER_GROUPS: FooterGroup\[\] = \[(.*)\];\s*$", NAV_TS, re.S)
    assert match, "FOOTER_GROUPS not found in lib/nav.ts"
    body = match.group(1)
    hrefs = set(_extract_hrefs(body))
    offenders = [h for h in hrefs if not h.startswith("#") and not route_exists(h)]
    assert not offenders, f"FOOTER_GROUPS points at routes with no app/ page: {offenders}"


def test_footer_does_not_invent_products():
    footer_groups = re.search(r"export const FOOTER_GROUPS.*", NAV_TS, re.S).group(0)
    products = read("lib/products.ts")
    # Every LADDER_PRODUCTS entry's name must appear verbatim in products.ts —
    # i.e. FOOTER_GROUPS is deriving names from the catalogue, not hand-typing
    # a second, driftable list of products.
    assert "LADDER_PRODUCTS.map(" in footer_groups
    assert "p.name" in footer_groups
    assert products  # the catalogue this derives from actually exists


def test_footer_socials_are_filtered_to_real_destinations():
    footer = read("components/Footer.tsx")
    # No hardcoded generic platform homepage — a social icon must resolve
    # through SITE.social (real accounts only) or SITE.repo (always real).
    assert '"https://www.linkedin.com/"' not in footer
    assert '"https://x.com/"' not in footer
    assert "SITE.social.linkedin" in footer
    assert "SITE.social.x" in footer
    assert ".filter((s) => s.href)" in footer


def test_footer_primary_cta_reads_the_price_from_the_catalogue():
    footer = read("components/Footer.tsx")
    assert "DENSITY_SCREEN_CTA" in footer, "the footer's paid CTA must read its price from lib/products.ts, never a literal"


def test_footer_secondary_cta_is_the_free_qualifier():
    footer = read("components/Footer.tsx")
    assert "QUALIFY_LINK" in footer


def test_section_nav_targets_all_exist_in_home_client():
    # SectionNav.tsx's go() silently no-ops when document.getElementById()
    # finds nothing — so a stale id here isn't a crash, it's a button that
    # visibly does nothing when clicked. Previously 7 of 11 entries pointed
    # at ids that had been removed from HomeClient.tsx in an earlier content
    # pass; this guards that class of drift going forward.
    section_nav = read("components/SectionNav.tsx")
    home = read("components/HomeClient.tsx")
    ids = re.findall(r'\{\s*id:\s*"([^"]+)"', section_nav)
    assert ids, "expected at least one entry in SectionNav's SECTIONS list"
    offenders = [i for i in ids if f'id="{i}"' not in home]
    assert not offenders, f"SectionNav targets with no matching section id in HomeClient.tsx: {offenders}"


def test_desktop_nav_groups_share_one_flex_container_with_a_gap():
    # justify-between on the outer nav row only guarantees space between
    # brand/links/CTA when there is leftover width — at exactly the content's
    # natural width it collapses to zero, and "Pricing" (last NAV_LINKS item)
    # butts directly against "Client portal" (first CTA item) with no visible
    # gap: "PricingClient portal", one fused word. Caught by rendering the
    # real page in a browser, not by reading the JSX. The fix is an explicit
    # gap on a wrapper that holds both groups, not relying on justify-between
    # leftover space between them.
    navbar = read("components/Navbar.tsx")
    m = re.search(
        r'<div className="hidden lg:flex items-center (gap-\d+)">(.*?)\n          </div>\n\n          <button',
        navbar, re.S,
    )
    assert m, "expected one wrapper div holding both the NAV_LINKS group and the CTA group"
    assert m.group(1) != "gap-0", "the wrapper must carry a real gap"
    inner = m.group(2)
    assert inner.count('className="flex items-center gap-') >= 2, (
        "NAV_LINKS and the CTA group must both be inside the gapped wrapper, not siblings of it"
    )
