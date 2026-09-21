"""Nav single-source-of-truth, canonical coverage and the money-path CTA —
static checks, in the same style as test_one_company.py, so a future edit
that reintroduces drift (a hand-typed link in Footer, a page that loses its
canonical, a price typed outside the catalogue) fails CI instead of shipping.
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(rel: str) -> str:
    return (ROOT / rel).read_text()


def test_navbar_and_footer_import_the_same_nav_config():
    navbar = read("components/Navbar.tsx")
    footer = read("components/Footer.tsx")
    assert 'from "@/lib/nav"' in navbar, "Navbar must source its links from lib/nav.ts"
    assert 'from "@/lib/nav"' in footer, "Footer must source its links from lib/nav.ts"
    assert "NAV_LINKS.map(" in navbar
    assert "NAV_LINKS.map(" in footer


def test_workspace_is_in_the_shared_nav():
    nav = read("lib/nav.ts")
    assert '"/workspace"' in nav, "Workspace must be reachable from the shared nav config"


def test_workspace_stays_noindex_but_reachable():
    page = read("app/workspace/page.tsx")
    assert "index: false" in page, "Workspace's own robots meta must still say noindex"
    robots = read("app/robots.ts")
    assert '"/workspace"' in robots, "robots.txt should back up the page-level noindex"
    # Reachability is covered by test_navbar_and_footer_import_the_same_nav_config
    # plus test_workspace_is_in_the_shared_nav — noindex must not mean unlinked.


CANONICAL_PAGES = [
    "app/page.tsx",
    "app/qualify/page.tsx",
    "app/pricing/page.tsx",
    "app/reference/page.tsx",
    "app/developers/page.tsx",
    "app/intelligence/page.tsx",
    "app/platforms/page.tsx",
    "app/constraints/page.tsx",
]


def test_every_public_indexable_route_has_a_canonical():
    offenders = [p for p in CANONICAL_PAGES if "alternates: { canonical:" not in read(p)]
    assert not offenders, f"missing alternates.canonical: {offenders}"


def test_every_canonical_page_sets_matching_og_url():
    offenders = [p for p in CANONICAL_PAGES if "url:" not in read(p)]
    assert not offenders, f"missing openGraph.url alongside canonical: {offenders}"


def test_home_and_intelligence_are_server_components_so_metadata_can_attach():
    # "use client" pages cannot export `metadata` (Next.js requirement) — these
    # two routes used to be 100% client components with no metadata export at
    # all, so /intelligence silently inherited the home page's title. Both are
    # now thin server wrappers (app/workspace/page.tsx's pattern) around a
    # client component that holds the actual page content.
    for page, client_import in [
        ("app/page.tsx", "HomeClient"),
        ("app/intelligence/page.tsx", "IntelligenceClient"),
    ]:
        src = read(page)
        assert '"use client"' not in src.splitlines()[0], f"{page} must be a server component"
        assert client_import in src


def test_navbar_primary_cta_reads_the_price_from_the_catalogue():
    navbar = read("components/Navbar.tsx")
    assert "DENSITY_SCREEN_CTA" in navbar, "the header's primary CTA must read its price from lib/ui.ts/lib/products.ts, never a literal"


def test_contact_email_is_on_the_domain_of_record():
    site = read("lib/site.ts")
    assert 'email: "power@timetopower.ai"' in site
    assert "gridforge.ai" not in read("app/legal/privacy/page.tsx")
    assert "gridforge.ai" not in read("app/legal/security/page.tsx")
