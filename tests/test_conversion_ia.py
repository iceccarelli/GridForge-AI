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
    # The footer no longer dumps NAV_LINKS into one column — it groups
    # commercial destinations (product, how-it-works, customer, company)
    # under lib/nav.ts's FOOTER_GROUPS, still one shared source.
    assert "FOOTER_GROUPS.map(" in footer


def test_workspace_is_reachable_but_not_in_primary_nav():
    # Workspace is an application/customer surface, not ordinary public
    # navigation — it stays reachable (the dashboard/portal surfaces link to
    # it) and noindexed, but it no longer competes with the five-item
    # commercial header for a visitor's attention.
    nav = read("lib/nav.ts")
    assert '"/workspace"' not in nav, "Workspace must not overload the primary commercial nav"


def test_workspace_stays_noindex_but_reachable():
    page = read("app/workspace/page.tsx")
    assert "index: false" in page, "Workspace's own robots meta must still say noindex"
    robots = read("app/robots.ts")
    assert '"/workspace"' in robots, "robots.txt should back up the page-level noindex"
    # Workspace is deliberately out of the primary nav (see
    # test_workspace_is_reachable_but_not_in_primary_nav) but noindex must
    # not mean unlinked — it stays reachable from ScopingAgent's "open full
    # workspace" affordance, present on every page.
    assert 'href="/workspace"' in read(
        "components/ScopingAgent.tsx"
    ), "Workspace must still be linked from somewhere a real visitor reaches"


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


def test_homepage_has_real_typographic_hierarchy_not_one_uniform_scale():
    # Every one of the homepage's ~10 sections used .section-title at
    # identical weight — no scale variation anywhere on the page. This
    # doesn't assert exact pixel values (a future redesign is free to
    # change those), only that the page keeps using more than one register:
    # the free qualifier (the actual lead-gen mechanism) reads louder than
    # the page's default, and the trust/support material (About, FAQ) reads
    # quieter — not all ten sections stated at the same volume again.
    css = read("app/globals.css")
    assert ".section-title-hero" in css
    assert ".section-title-quiet" in css

    home = read("components/HomeClient.tsx")
    assert 'id="qualify"' in home
    qualify_section = home.split('id="qualify"', 1)[1].split("</section>", 1)[0]
    assert "section-title-hero" in qualify_section, (
        "the free qualifier is the homepage's real conversion moment and should read louder than the page default"
    )

    for section_id in ["about", "faq"]:
        section = home.split(f'id="{section_id}"', 1)[1].split("</section>", 1)[0]
        assert "section-title-quiet" in section, (
            f"#{section_id} is trust/support material and should read quieter than the page default"
        )
