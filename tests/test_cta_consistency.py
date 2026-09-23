"""One vocabulary for the CTA system (AGENT_DIRECTIVE v7's "CTA SYSTEM" rule):
a visitor should recognize the same action anywhere on the site, not meet a
different phrase for "run the free qualifier" on every page. Browser-verified
against the production build separately; this file is the fast static guard
against the phrase count creeping back up.
"""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

FILES_WITH_FREE_CTA_LINKS = [
    "components/HomeClient.tsx",
    "components/Navbar.tsx",
    "components/Footer.tsx",
    "components/StickyMobileCTA.tsx",
    "components/ScopingAgent.tsx",
    "app/developers/page.tsx",
    "app/platforms/page.tsx",
    "app/constraints/page.tsx",
    "app/constraints/[slug]/page.tsx",
    "app/reference/page.tsx",
    "app/dashboard/page.tsx",
]

# Phrases that used to compete with the canonical QUALIFY_LINK.label ("Run
# free capacity check") for the same action, one per page, before this test
# existed. A regex substring match, not a whole-word one, so a rephrasing
# that reintroduces the drift still fails even if not verbatim.
DRIFTED_FREE_CTA_PHRASES = [
    "Run the free qualifier",
    "Or run the free qualifier",
    "Run the qualifier",
    "Run your hall",
    "Find out <ArrowRight",
    "Find the binding constraint",
]


def read(rel: str) -> str:
    return (ROOT / rel).read_text()


def test_no_drifted_free_cta_phrases_remain():
    offenders = []
    for rel in FILES_WITH_FREE_CTA_LINKS:
        src = read(rel)
        for phrase in DRIFTED_FREE_CTA_PHRASES:
            if phrase in src:
                offenders.append(f"{rel}: {phrase!r}")
    assert not offenders, "drifted free-CTA phrasing reappeared:\n  " + "\n  ".join(offenders)


def test_free_cta_surfaces_import_the_canonical_label():
    offenders = [
        rel for rel in FILES_WITH_FREE_CTA_LINKS if 'QUALIFY_LINK' not in read(rel)
    ]
    assert not offenders, f"these files link to /qualify without reading QUALIFY_LINK from lib/nav.ts: {offenders}"


def test_developers_code_blocks_cannot_force_page_overflow():
    # The two curl examples on /developers sit in a `grid` row; a grid item's
    # default min-width is `auto`, so an unwrapped <pre> forces the grid
    # track wider than the viewport even though the <pre> itself carries
    # overflow-x-auto. min-w-0 on the grid item is what actually contains it
    # — this regression shipped a 139px horizontal overflow at 390px wide,
    # caught by rendering the real page in a browser, not by reading the JSX.
    src = read("app/developers/page.tsx")
    m = re.search(r'<section className="mt-6 grid gap-4 lg:grid-cols-2">(.*?)</section>', src, re.S)
    assert m, "the two-column code-sample section moved or was restructured — re-check it by hand"
    body = m.group(1)
    grid_item_divs = re.findall(r'<div className="([^"]*)">', body)
    assert len(grid_item_divs) >= 2, "expected two grid-item <div>s wrapping the code samples"
    offenders = [cls for cls in grid_item_divs if "min-w-0" not in cls]
    assert not offenders, f"grid items holding a <pre> must carry min-w-0 or the page overflows horizontally: {offenders}"
