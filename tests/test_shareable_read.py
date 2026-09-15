"""The capacity read, on a link.

The qualifier produced a real engineering answer and then lost it when the tab
closed. That is not a cosmetic gap: the person who types seven numbers into a
capacity qualifier is an operations engineer, and the person who signs off a
five-figure study is a director. The distance between them is a link, and there
was not one.

Two things have to hold, and they pull against each other. The page must carry the
engineering — a shareable page that softened the caveats would be a brochure, and a
director who has read one brochure recognises the next. And it must never leak: a
token-addressed page holding somebody's site figures cannot be indexed, cannot be
guessable, and must never offer a link to a row that was not written.
"""
import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
PAGE = (ROOT / "app" / "q" / "[token]" / "page.tsx").read_text()
ROUTE = (ROOT / "app" / "api" / "qualify" / "route.ts").read_text()
LIB = (ROOT / "lib" / "qualify.ts").read_text()
QUALIFIER = (ROOT / "components" / "CapacityQualifier.tsx").read_text()
MIGRATION = (ROOT / "supabase" / "migrations" / "0008_qualification_token.sql").read_text()


# --- the link exists and is honest about when it does not ------------------

def test_the_qualifier_returns_a_share_link():
    assert "share:" in ROUTE
    assert "/q/${token}" in ROUTE


def test_no_link_is_offered_when_the_row_was_not_written():
    """A share link to a row that was never written is a 404 sent to somebody's
    director. The persist path therefore throws rather than swallowing, so the
    caller can tell the difference."""
    assert "share: stored ? " in ROUTE
    assert ": null" in ROUTE
    assert 'throw new Error("supabase not configured")' in ROUTE, (
        "an unconfigured Supabase used to be logged and ignored, which would hand "
        "out a link to nothing")
    assert ROUTE.count("throw new Error(detail)") == 1, (
        "a failed insert must also be visible to the caller")


def test_the_token_is_minted_before_the_engine_runs():
    """So a result that fails to persist still has an identity, and an unreachable
    engine still produces a row we can come back to."""
    i_token = ROUTE.index("newQualificationToken()")
    i_engine = ROUTE.index("await callEngine(input)")
    assert i_token < i_engine


def test_the_token_is_not_guessable():
    assert "crypto.getRandomValues" in LIB
    m = re.search(r"new Uint8Array\((\d+)\)", LIB)
    assert m and int(m.group(1)) >= 16, (
        "a short token on a page holding a customer's site figures is not a token")
    assert "base64url" in LIB


def test_the_migration_backfills_before_it_constrains():
    """A unique index added before the backfill refuses on the existing nulls, and
    the migration fails on exactly the deployments that already have data."""
    i_backfill = MIGRATION.index("update public.qualifications")
    i_notnull = MIGRATION.index("set not null")
    i_index = MIGRATION.index("create unique index")
    assert i_backfill < i_notnull < i_index


# --- the page carries the engineering --------------------------------------

def test_the_page_names_the_binding_constraint_and_links_to_its_reference():
    assert "binding_constraint" in PAGE
    assert "/constraints/${doc.slug}" in PAGE, (
        "the reader should be one click from the physics, not from a contact form")


def test_the_page_keeps_the_disclosure_the_paid_document_carries():
    """A shareable page that softened the caveats would be a brochure."""
    for phrase in ["not a bankable number", "not a design",
                   "not a measurement of this asset",
                   "has not yet been reconciled against any instrumented site"]:
        assert phrase in PAGE, f"the shared read drops {phrase!r}"


def test_the_page_states_what_is_behind_the_paid_engagement():
    for phrase in ["Capital cost", "programme duration", "full constraint\n          ladder",
                   "paid\n          engagement"]:
        flat = re.sub(r"\s+", " ", PAGE)
        assert re.sub(r"\s+", " ", phrase) in flat, f"missing: {phrase!r}"


def test_the_page_says_when_no_result_was_produced():
    """Nothing invented to fill the gap when the engine was unreachable."""
    assert 'q.status !== "scored"' in PAGE
    flat = re.sub(r"\s+", " ", PAGE)
    assert "Nothing was invented to fill the gap" in flat


# --- the benchmark, and its privacy floor ----------------------------------

def test_the_benchmark_has_the_same_privacy_floor_as_the_public_insights():
    insights = (ROOT / "app" / "api" / "insights" / "route.ts").read_text()
    m = re.search(r"MIN_HALLS\s*=\s*(\d+)", insights)
    assert m, "the public insights route no longer declares a floor"
    floor = int(m.group(1))
    m2 = re.search(r"BENCHMARK_MIN_HALLS\s*=\s*(\d+)", LIB)
    assert m2, "the benchmark declares no floor"
    assert int(m2.group(1)) == floor, (
        f"the shared page would publish a distribution at n={m2.group(1)} that the "
        f"public route withholds below n={floor}")


def test_the_benchmark_selects_nothing_identifying():
    """Two columns, neither of which can point at a hall."""
    m = re.search(r"qualifications\?select=([a-z_,]+)&binding_constraint", LIB)
    assert m, "could not read the benchmark query"
    cols = set(m.group(1).split(","))
    assert cols == {"binding_constraint", "racks_as_found"}, cols
    for forbidden in ("company", "email", "site_name", "hall_id", "metro"):
        assert forbidden not in cols


def test_the_benchmark_explains_its_own_floor_on_the_page():
    assert "BENCHMARK_MIN_HALLS" in PAGE
    assert "noise dressed as evidence" in PAGE


# --- the link is placed where it gets used ---------------------------------

def test_the_share_block_sits_under_the_headline_not_at_the_end():
    """The moment to forward something is the moment you have just read the thing
    worth forwarding."""
    i_headline = QUALIFIER.index("{headline}</p>")
    i_share = QUALIFIER.index("<ShareLink")
    between = QUALIFIER[i_headline:i_share]
    assert between.count("\n") < 3, "the share block drifted away from the headline"


def test_the_share_block_says_what_the_link_is_for():
    assert "Send this to whoever owns the capex" in QUALIFIER
    assert "Private to whoever holds the\n          link" in QUALIFIER or \
           "Private to whoever holds the link" in re.sub(r"\s+", " ", QUALIFIER)
