"""The public constraint reference — the most-read thing we publish.

It is also the most dangerous. A page that explains a constraint wrongly, or quotes
a number the engine no longer uses, is read by exactly the people whose judgement we
are asking for. Worse, it is read by them BEFORE they have any reason to trust us,
so there is no relationship to survive the error.

So: the catalogue must cover every constraint the engine evaluates and name none it
does not; every number on a page must come from the engine's own libraries; the
worked examples must be arithmetically correct; and nothing may read as a
measurement of anybody's asset.
"""
import json
import math
import re
import subprocess
import sys
from pathlib import Path

import pytest

from gridforge.calibration.keys import CONSTRAINT_IDS
from gridforge.compute.library import PLATFORMS, UNPUBLISHED_PLATFORMS
from gridforge.reference import platform_payload, reference_payload
from gridforge.reference.catalogue import (CONSTRAINT_DOCS, RELIEF_LEAD_TIMES,
                                           ReferenceError, constraint_doc)

ROOT = Path(__file__).resolve().parents[1]
REFERENCE = ROOT / "public" / "reference"


@pytest.fixture(scope="module")
def payload():
    return reference_payload()


# --- coverage, both directions ---------------------------------------------

def test_the_catalogue_covers_every_constraint_the_engine_evaluates():
    documented = {d.id for d in CONSTRAINT_DOCS}
    missing = sorted(set(CONSTRAINT_IDS) - documented)
    assert not missing, (
        f"constraints the engine evaluates with no public page: {missing}. A reader "
        f"who runs the qualifier will be told one of these binds and find nothing "
        f"written about it.")


def test_the_catalogue_names_no_constraint_the_engine_does_not_have():
    documented = {d.id for d in CONSTRAINT_DOCS}
    invented = sorted(documented - set(CONSTRAINT_IDS))
    assert not invented, f"published pages for constraints that do not exist: {invented}"


def test_every_constraint_has_a_relief_lead_time():
    """The schedule, not the capex, is what usually decides. A page that omits it has
    left out the number the reader came for."""
    for d in CONSTRAINT_DOCS:
        assert d.id in RELIEF_LEAD_TIMES, f"{d.id} publishes no relief lead time"
        lo, hi = RELIEF_LEAD_TIMES[d.id]
        assert 0 < lo < hi, f"{d.id}: implausible lead time range {lo}-{hi}"


def test_every_slug_is_unique_and_url_safe():
    slugs = [d.slug for d in CONSTRAINT_DOCS]
    assert len(set(slugs)) == len(slugs)
    for s in slugs:
        assert re.fullmatch(r"[a-z0-9-]+", s), f"{s} is not a clean slug"


def test_see_also_never_dangles():
    ids = {d.id for d in CONSTRAINT_DOCS}
    for d in CONSTRAINT_DOCS:
        for ref in d.see_also:
            assert ref in ids, f"{d.id} links to {ref}, which has no page"
        assert d.id not in d.see_also, f"{d.id} links to itself"


def test_lookup_accepts_an_id_or_a_slug_and_refuses_anything_else():
    assert constraint_doc("busway_ampacity").slug == "busway-ampacity"
    assert constraint_doc("busway-ampacity").id == "busway_ampacity"
    with pytest.raises(ReferenceError, match="One of"):
        constraint_doc("not_a_constraint")


# --- the numbers come from the engine --------------------------------------

def test_the_worked_examples_are_arithmetically_correct(payload):
    """Every example claims to be reproducible by hand. If one is not, the page has
    taught a sceptical engineer that we do not check our own arithmetic."""
    plat = PLATFORMS["gb300_nvl72"]
    rack_kW = plat.rack_kW.value
    by_id = {c["id"]: c for c in payload["constraints"]}

    amps = rack_kW * 1000 / (400 * math.sqrt(3) * 0.95)
    assert f"{amps:.0f} A" in by_id["rack_feed_tapoff"]["worked_example"]["answer"]

    run_kW = 400 * 0.8 * 400 * math.sqrt(3) * 0.95 / 1000
    assert f"{run_kW / rack_kW:.1f}" in by_id["busway_ampacity"]["worked_example"]["answer"]

    residual = plat.residual_air_kW().value
    assert f"{residual:.0f} kW" in by_id["plant_capacity"]["worked_example"]["answer"]

    loading = plat.rack_mass_kg.value / plat.rack_footprint_m2.value
    assert f"{loading:,.0f}" in by_id["floor_loading"]["worked_example"]["answer"]

    approach = plat.max_inlet_liquid_C.value - 6
    assert f"{approach:.0f} K" in by_id["cdu_capacity"]["worked_example"]["answer"]


def test_a_platform_change_moves_the_published_numbers(monkeypatch, payload):
    """The property that makes this defensible: the prose is authored, the numbers
    are not. If the platform library moves and a page does not, the page is a copy
    of the engine rather than a view of it.

    GPUPlatform is frozen, so the library entry is swapped rather than mutated —
    which is also how a real platform revision would arrive.
    """
    import dataclasses
    before = reference_payload()["constraints"]
    plat = PLATFORMS["gb300_nvl72"]
    monkeypatch.setitem(PLATFORMS, "gb300_nvl72",
                        dataclasses.replace(plat, rack_kW=plat.rack_kW * 2.0))
    after = reference_payload()["constraints"]
    changed = [a["id"] for a, b in zip(after, before)
               if a["worked_example"] != b["worked_example"]]
    assert len(changed) >= 4, (
        f"doubling rack power moved only {changed} — the pages are not reading the "
        f"platform library")


def test_every_priced_relief_publishes_its_evidence_class(payload):
    """Including — especially including — when it is a placeholder. A cost library
    of E0 defaults is the honest state of a young practice, and saying so is what
    makes the E5 lines credible when they arrive."""
    priced = [c for c in payload["constraints"] if c["cost_basis"]]
    assert len(priced) >= 6
    for c in priced:
        assert c["cost_basis"]["evidence"].startswith("E")
        assert c["cost_basis"]["note"]


# --- what may not be said --------------------------------------------------

BANNED = [
    r"\bwe have achieved\b", r"\bour customers have\b", r"\bproven\b",
    r"\bguaranteed\b", r"\bwill deliver\b", r"\bcertified\b",
    r"\bmeasured at \d", r"\bcase study\b",
]


def test_no_page_claims_a_track_record_we_do_not_have(payload):
    blob = json.dumps(payload).lower()
    for pattern in BANNED:
        m = re.search(pattern, blob)
        assert not m, f"the public reference claims {m.group(0)!r}"


def test_no_page_names_a_manufacturer(payload):
    """We take no margin on hardware, and the reference is not the place to start.
    NVIDIA and AMD appear only as platform makers in the platform library, which is
    a different document."""
    blob = json.dumps(payload).lower()
    for brand in ("vertiv", "schneider", "eaton", "abb", "siemens", "motivair",
                  "coolit", "jetcool", "submer", "legrand", "starline"):
        assert brand not in blob, f"the constraint reference names {brand}"


def test_the_notice_says_nothing_here_is_a_measurement(payload):
    notice = payload["notice"].lower()
    assert "is a measurement of any customer" in notice
    assert "modelled" in notice


# --- the platform library --------------------------------------------------

def test_the_platform_library_publishes_its_absences():
    lib = platform_payload()
    assert lib["deliberately_absent"] == UNPUBLISHED_PLATFORMS
    assert lib["deliberately_absent"], "the absences are the most credible thing on the page"
    assert "absent by design" in lib["notice"]
    for pid in lib["deliberately_absent"]:
        assert pid not in {p["id"] for p in lib["platforms"]}, (
            f"{pid} is listed as absent and also published")


def test_every_published_platform_carries_its_sources_or_says_it_is_generic():
    """An unsourced row that looks like the sourced ones beside it is the quietest
    way a library loses its authority."""
    for p in platform_payload()["platforms"]:
        assert p["sources"] or p["generic"], (
            f"{p['id']} is published with no source and is not marked generic")
        if p["generic"]:
            assert not p["sources"]
            assert "generic" in p["name"].lower()
        assert p["rack_kW"] > 0 and p["residual_air_kW"] > 0
        assert 0 < p["liquid_fraction"] < 1, (
            f"{p['id']}: a liquid fraction of 1.0 would mean no air load at all")


def test_the_floor_loading_figure_is_computed_not_quoted():
    for p in platform_payload()["platforms"]:
        expected = round(p["rack_mass_kg"] / p["rack_footprint_m2"])
        assert p["floor_loading_kg_per_m2"] == expected


# --- what is committed -----------------------------------------------------

def test_the_published_reference_matches_the_engine():
    """public/reference/constraints.json is what the website renders. If it has
    drifted, every page is quoting an engine that no longer exists."""
    published = json.loads((REFERENCE / "constraints.json").read_text())
    assert published["count"] == len(CONSTRAINT_DOCS)
    assert {c["id"] for c in published["constraints"]} == {d.id for d in CONSTRAINT_DOCS}
    live = reference_payload()
    assert published == live, (
        "public/reference/constraints.json is stale. Run scripts/build-reference.sh.")


def test_the_published_platform_library_matches_the_engine():
    published = json.loads((REFERENCE / "platforms.json").read_text())
    assert published == platform_payload(), (
        "public/reference/platforms.json is stale. Run scripts/build-reference.sh.")


def test_the_cli_emits_both_payloads(tmp_path):
    for which, expected in (("constraints", "constraints"), ("platforms", "platforms")):
        out = tmp_path / f"{which}.json"
        r = subprocess.run([sys.executable, "-m", "gridforge", "reference", which,
                            "-o", str(out)], cwd=ROOT, capture_output=True, text=True)
        assert r.returncode == 0, r.stderr
        assert "Traceback" not in r.stderr
        assert expected in json.loads(out.read_text())


# --- the site renders all of it --------------------------------------------

def test_the_site_has_a_page_for_every_constraint():
    """generateStaticParams builds from the same file, so this asserts the route
    exists and reads the reference rather than a hand-written list."""
    src = (ROOT / "app" / "constraints" / "[slug]" / "page.tsx").read_text()
    assert "generateStaticParams" in src
    assert "constraintReference()" in src
    index = (ROOT / "app" / "constraints" / "page.tsx").read_text()
    assert "constraintReference()" in index


def test_the_sitemap_is_generated_from_the_reference():
    src = (ROOT / "app" / "sitemap.ts").read_text()
    assert "constraintReference()" in src, (
        "constraint pages are listed by hand in the sitemap — a constraint added to "
        "the engine would never be indexed")
    assert "/platforms" in src


def test_the_structured_data_does_not_describe_a_different_company():
    src = (ROOT / "components" / "JsonLd.tsx").read_text().lower()
    for stale in ["dc distribution architecture", "physics-informed ems",
                  "dc microgrids"]:
        assert stale not in src, f"JSON-LD still tells search engines we do {stale!r}"
    assert "thirteen" in src or "constraints binds first" in src
