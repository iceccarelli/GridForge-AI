"""One question, asked of the whole stack: can everything we price actually be bought,
built and delivered?

Each of these has already failed in production at least once:

  * The Procurement Specification shipped priced, documented, and absent from the
    engagement ladder — because the ladder was a hand-written array in a component
    and nobody edited it.
  * That same product, once bought, would have generated a Density Screen, because
    the intake route branched inline on the kind.
  * commercial.py claimed for fourteen patches that a parity test existed. It did not.

The pattern is always the same: a fact stated in two places, and only one of them
updated. So this file asserts the JOINS rather than the parts — every catalogue
entry reaches a surface, every deliverable reaches an endpoint, every endpoint the
site calls exists on the engine, and every engagement the engine quotes can be paid
for.
"""
import json
import re
from pathlib import Path

import pytest

from gridforge.api.server import ROUTES
from gridforge.api.tools import TOOLS_BY_NAME
from gridforge.api.metering import UNIT_COST
from gridforge.commercial import API_PLANS, ENGAGEMENTS

ROOT = Path(__file__).resolve().parents[1]
PRODUCTS_TS = (ROOT / "lib" / "products.ts").read_text()
LADDER_TSX = (ROOT / "components" / "EngagementLadder.tsx").read_text()


def products() -> dict[str, dict]:
    body = PRODUCTS_TS.split("export const PRODUCTS", 1)[1]
    body = body.split("export const PRODUCT_BY_KIND", 1)[0]
    out: dict[str, dict] = {}
    for m in re.finditer(r"^  (\w+): \{(.*?)^  \},", body, re.S | re.M):
        pid, chunk = m.group(1), m.group(2)
        rec: dict = {"id": pid, "raw": chunk}
        for field, pattern in [
            ("name", r'name:\s*"([^"]+)"'),
            ("kind", r'kind:\s*"([^"]+)"'),
            ("surface", r'surface:\s*"([^"]+)"'),
            ("endpoint", r'endpoint:\s*"([^"]+)"'),
        ]:
            mm = re.search(pattern, chunk)
            if mm:
                rec[field] = mm.group(1)
        rec["producesDeliverable"] = "producesDeliverable: true" in chunk
        mm = re.search(r"ladderOrder:\s*(\d+)", chunk)
        if mm:
            rec["ladderOrder"] = int(mm.group(1))
        out[pid] = rec
    return out


@pytest.fixture(scope="module")
def cat():
    p = products()
    assert len(p) >= 7, f"only parsed {len(p)} products — the catalogue moved"
    return p


# --- every product reaches a surface ---------------------------------------

def test_every_product_declares_where_it_is_sold(cat):
    """No default. Something unsellable has to be declared unsellable on purpose."""
    missing = [pid for pid, p in cat.items() if not p.get("surface")]
    assert not missing, f"products with no surface: {missing}"
    allowed = {"ladder", "developers", "upsell", "hidden"}
    bad = {pid: p["surface"] for pid, p in cat.items() if p["surface"] not in allowed}
    assert not bad, bad


def test_every_ladder_product_has_a_position(cat):
    for pid, p in cat.items():
        if p["surface"] == "ladder":
            assert "ladderOrder" in p, f"{pid} is on the ladder with no position"
    orders = [p["ladderOrder"] for p in cat.values() if p["surface"] == "ladder"]
    assert len(set(orders)) == len(orders), f"two products share a ladder position: {orders}"


def test_the_ladder_is_derived_and_not_hand_written():
    """A literal array of ids in the component is the exact mechanism that left a
    priced, documented product impossible to buy."""
    assert "LADDER_PRODUCTS" in LADDER_TSX
    assert "const ORDER" not in LADDER_TSX, (
        "the engagement ladder is hand-written again — a product added to the "
        "catalogue will silently never appear for sale")


def test_the_procurement_specification_is_purchasable(cat):
    """The specific regression. It shipped priced, documented and unbuyable."""
    p = cat["procurement_spec"]
    assert p["surface"] == "ladder"
    assert p["producesDeliverable"]
    assert p["endpoint"] == "spec"


# --- every deliverable reaches an endpoint ---------------------------------

def test_every_purchased_deliverable_has_a_generation_path(cat):
    """A product that produces a deliverable and names no endpoint means a client
    pays and nothing can be generated."""
    for pid, p in cat.items():
        if p["producesDeliverable"]:
            assert p.get("endpoint"), f"{pid} produces a deliverable with no endpoint"


def test_every_endpoint_named_by_the_site_exists_on_the_engine(cat):
    named = {p["endpoint"] for p in cat.values() if p.get("endpoint")}
    for e in named:
        assert f"/v1/{e}" in ROUTES, (
            f"the site would call /v1/{e}, which the engine does not serve")


def test_the_intake_route_reads_the_catalogue_rather_than_branching():
    src = (ROOT / "app" / "api" / "intake" / "[token]" / "route.ts").read_text()
    assert "deliverableEndpoint(row.kind)" in src
    assert 'kind === "envelope_study_deposit" ? "study" : "screen"' not in src, (
        "the generation path is an inline conditional again — this is how an "
        "EUR 18,000 specification purchase produced a Density Screen")


def test_an_unmapped_kind_fails_loudly_rather_than_generating_the_wrong_document():
    src = (ROOT / "app" / "api" / "intake" / "[token]" / "route.ts").read_text()
    assert "No generation path is configured" in src


# --- engine and site agree on what exists ----------------------------------

def test_every_engagement_the_engine_quotes_can_be_paid_for(cat):
    """A proposal that quotes an engagement with no checkout route is a proposal
    that ends in an email asking how to pay."""
    by_kind = {p.get("kind", p["id"]) for p in cat.values()}
    for eid in ENGAGEMENTS:
        assert eid in by_kind or f"{eid}_deposit" in by_kind, (
            f"the engine quotes {eid} and the site sells no way to buy it")


def test_every_api_plan_is_on_the_developers_surface(cat):
    for pid in API_PLANS:
        assert cat[pid]["surface"] == "developers", (
            f"{pid} is an API plan but is sold as {cat[pid]['surface']}")


def test_every_paid_route_is_metered(cat):
    """An endpoint with no unit rate bills nothing and cannot be sold."""
    for path in ROUTES:
        assert path in UNIT_COST, f"{path} is routable but has no published unit rate"


def test_every_tool_points_at_a_real_route():
    for name, t in TOOLS_BY_NAME.items():
        assert t["endpoint"] in ROUTES, f"{name} advertises {t['endpoint']}, which does not exist"


def test_every_paid_route_is_reachable_by_a_machine():
    """A capability only the website can use is a feature; one an agent can call is
    a product. Anything paid should be in the tool catalogue or deliberately not."""
    advertised = {t["endpoint"] for t in TOOLS_BY_NAME.values()}
    # /v1/deck is the one deliberate omission: the walkthrough is a human session
    # artefact and an agent calling it in a loop has misunderstood what it is for.
    deliberate = {"/v1/deck"}
    missing = {p for p in ROUTES if p not in advertised} - deliberate
    assert not missing, f"paid routes no agent can discover: {sorted(missing)}"


# --- the published worked example matches the product ----------------------

REFERENCE = ROOT / "public" / "reference"


def test_the_worked_example_covers_every_document_we_sell():
    """A prospect is told they can read the deliverable before paying. That claim
    has to hold for each document, not just the study."""
    for name in ["envelope_study.md", "proposal.md", "specification.md",
                 "walkthrough.html", "response_template.json"]:
        assert (REFERENCE / name).exists(), f"public/reference/{name} is missing"


def test_the_published_tool_catalogue_matches_the_engine():
    published = json.loads((REFERENCE / "tools.json").read_text())
    assert {t["name"] for t in published["tools"]} == set(TOOLS_BY_NAME), (
        "public/reference/tools.json is stale — an integrator would read a schema "
        "the server no longer validates against. Run scripts/build-reference.sh.")
    for t in published["tools"]:
        assert t["units"] == UNIT_COST[t["endpoint"]], (
            f"{t['name']}: published rate {t['units']}, actual {UNIT_COST[t['endpoint']]}")


# --- documentation is not allowed to claim things that are not there -------

def test_the_readme_names_every_product_and_every_package(cat):
    """The first file anyone opens. It once described this repository as a
    marketing site for a behind-the-meter EMS practice, four patches after it had
    stopped being that."""
    readme = (ROOT / "README.md").read_text()
    for pid, p in cat.items():
        if p["surface"] == "hidden":
            continue
        # A deposit is a payment mechanism, not a product a reader needs named;
        # the engagement it opens is what must appear.
        name = p["name"].split(" — deposit")[0]
        assert name in readme, f"README does not mention {name}"
    packages = [d.name for d in (ROOT / "gridforge").iterdir()
                if d.is_dir() and not d.name.startswith(("_", "."))
                and (d / "__init__.py").exists()]
    missing = [d for d in packages if f"{d}/" not in readme]
    assert not missing, f"README's architecture map omits: {missing}"


def test_the_readme_does_not_describe_a_different_company():
    readme = (ROOT / "README.md").read_text().lower()
    for stale in ["lead-generation site", "physics-informed energy management",
                  "interactive (sample-data) dashboard"]:
        assert stale not in readme, f"README still says {stale!r}"


def test_the_commercial_spine_lists_what_is_actually_purchasable(cat):
    """The strategy document and the price list are allowed to disagree about the
    future. They are not allowed to disagree about the present."""
    spine = (ROOT / "docs" / "00_COMMERCIAL_SPINE.md").read_text()
    for pid, p in cat.items():
        if p["surface"] == "hidden":
            continue
        name = p["name"].split(" — deposit")[0]
        assert name in spine, f"the commercial spine does not mention {name}"


#: Everything allowed to sit in the repository root, and why it is there.
#: A root file is the first thing a stranger reads and the easiest place for a
#: stray to hide, so the list is explicit rather than a pattern.
ROOT_FILES = {
    ".dockerignore": "docker build context",
    ".env.example": "the environment, documented",
    ".eslintrc.json": "lint config",
    ".gitignore": "",
    "Dockerfile": "the engine image",
    "Makefile": "",
    "README.md": "",
    "fly.toml": "engine deployment",
    "next.config.ts": "",
    "package.json": "",
    "package-lock.json": "",
    "postcss.config.mjs": "",
    "pyproject.toml": "the engine package",
    "render.yaml": "alternate deployment",
    "tailwind.config.ts": "",
    "tsconfig.json": "",
    "vercel.json": "site deployment and the weekly cron",
}


def _tracked() -> list[str]:
    import subprocess
    return subprocess.run(["git", "ls-files"], cwd=ROOT, capture_output=True,
                          text=True, check=True).stdout.split()


def test_nothing_foreign_is_committed_at_the_repository_root():
    """Two things landed on public main this way: a patch file, and a build tool
    belonging to an entirely different project.

    Neither was caught, because nothing was looking. Every test asked whether what
    we had was correct; none asked whether something we did not put there had
    arrived. And .gitignore is no defence — a GitHub web upload commits directly,
    and an ignore rule only stops an UNTRACKED file being added.

    The root is the first thing a stranger reads. Adding a file here should be a
    decision, so the list is explicit: add yours to ROOT_FILES with a reason.
    """
    at_root = sorted(f for f in _tracked() if "/" not in f)
    unexpected = [f for f in at_root if f not in ROOT_FILES]
    assert not unexpected, (
        f"files at the repository root that nothing declares: {unexpected}. "
        f"A patch belongs in inbox/ — see inbox/README.md. Anything belonging to "
        f"another project belongs in that project's history, not this one.")


def test_the_root_allowlist_has_no_dead_entries():
    """An allowlist that outlives the files it names stops being a description of
    the repository and starts being a wish."""
    tracked = set(_tracked())
    dead = sorted(f for f in ROOT_FILES if f not in tracked)
    assert not dead, f"ROOT_FILES names files that are not tracked: {dead}"


def test_no_patch_is_committed_anywhere():
    """A patch is an instruction, not a source file. scripts/apply-inbox.sh removes
    each one in the same commit that applies it, so one surviving here means a patch
    was applied some other way and the repository is accumulating them again."""
    left = [f for f in _tracked() if f.endswith(".patch")]
    assert not left, (
        f"patch files committed to the repository: {left}. Apply them with "
        f"scripts/apply-inbox.sh, which removes each one in the commit that "
        f"applies it.")


def test_the_inbox_exists_and_is_empty_of_patches():
    """Tracked so an upload has somewhere to land; empty so nothing accumulates."""
    inbox = ROOT / "inbox"
    assert (inbox / "README.md").exists(), "inbox/README.md is the upload instructions"
    assert not list(inbox.glob("*.patch")), (
        "a patch is still sitting in inbox/. Run scripts/apply-inbox.sh.")


def test_the_apply_script_removes_the_patch_it_applied():
    src = (ROOT / "scripts" / "apply-inbox.sh").read_text()
    assert "git rm -q --cached" in src
    assert "commit -q --amend" in src, (
        "the patch must be removed in the SAME commit that applies it, or the "
        "history records a file that was never meant to be part of the project")
    assert "git reset -q --hard" in src, "a failing patch must roll back"


def test_the_runbook_documents_every_command_the_cli_offers():
    """The runbook is what the founder works from. A command it does not mention is
    one that does not get used; a command it mentions that does not exist is worse."""
    import argparse
    from gridforge import cli
    runbook = (ROOT / "docs" / "07_DELIVERY_RUNBOOK.md").read_text()
    parser_src = (ROOT / "gridforge" / "cli.py").read_text()
    commands = set(re.findall(r'sub\.add_parser\("([a-z]+)"', parser_src))
    assert len(commands) > 8, commands
    undocumented = sorted(c for c in commands
                          if f"gridforge {c}" not in runbook and f"`{c}`" not in runbook)
    assert not undocumented, f"CLI commands absent from the runbook: {undocumented}"
