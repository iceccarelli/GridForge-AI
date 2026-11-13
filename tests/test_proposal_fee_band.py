"""A proposal must quote the fee the way the catalogue does.

Found by the second-pass customer-journey audit (J1/J2-1): `/v1/proposal` printed the FLOOR of a quoted band as a fixed fee ("Fee | EUR 22,000,
fixed" and "Fixed fee. We do not bill hours") for the Envelope Study and the Portfolio Screen, whose catalogue price is a band agreed in writing
(EUR 22,000 to 45,000; EUR 60,000 to 140,000). A buyer reading the proposal would anchor on the floor. The band is the quoted price; the
proposal now states all of it and does not call it fixed.
"""
from pathlib import Path

import pytest

from gridforge.commercial import ENGAGEMENTS, engagement
from gridforge.intake.loader import load
from gridforge.reporting import to_markdown
from gridforge.reporting.proposal import build as build_proposal
from gridforge.scenario import run_all

ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture(scope="module")
def solved():
    intake = load(ROOT / "examples" / "intake" / "reference_hall.json")
    return intake, run_all(intake.context, intake.scenarios)


def _md(solved, eng_id):
    intake, results = solved
    return to_markdown(build_proposal(intake, results, engagement(eng_id)))


BANDED = [e for e in ENGAGEMENTS.values() if e.price_eur_max and e.price_eur_max > e.price_eur]
FIXED = [e for e in ENGAGEMENTS.values() if not (e.price_eur_max and e.price_eur_max > e.price_eur)]


def test_the_catalogue_has_both_kinds_or_this_proves_nothing():
    assert BANDED and FIXED


@pytest.mark.parametrize("eng", BANDED, ids=lambda e: e.id)
def test_a_banded_engagement_prints_its_whole_band_and_is_not_called_fixed(solved, eng):
    md = _md(solved, eng.id)
    assert f"EUR {eng.price_eur:,} to {eng.price_eur_max:,}" in md
    assert f"EUR {eng.price_eur:,}, fixed" not in md
    assert "Fixed fee" not in md and "We do not bill hours" not in md
    assert "agreed in writing" in md
    # the headline figure carries the band too, not the floor alone
    fee_line = next(line for line in md.splitlines() if line.startswith("**Fee:**"))
    assert f"{eng.price_eur:,}" in fee_line and f"{eng.price_eur_max:,}" in fee_line, fee_line


@pytest.mark.parametrize("eng", FIXED, ids=lambda e: e.id)
def test_a_fixed_engagement_still_prints_one_fixed_fee(solved, eng):
    md = _md(solved, eng.id)
    assert f"EUR {eng.price_eur:,}, fixed" in md
    assert "Fixed fee. We do not bill hours" in md
    assert " to " not in md.split(f"EUR {eng.price_eur:,}", 1)[1][:12]
