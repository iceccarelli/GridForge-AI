"""'Credits in full' states its conditions on every surface, engine documents included.

The website's one sentence (lib/credits-terms.ts SCREEN_CREDIT_SENTENCE) says what the code that honours the credit applies: once, for the same
email address after the buyer is confirmed, whole and only while deposit plus credit stay within the fee, never cash, nothing for a refunded or
disputed purchase. The delivered Density Screen and the proposal used to say 'This screen's fee credits in full against it' and 'Credits in full
against the envelope study' with none of that (found by the account-and-billing track, finished here).
"""
import re
from pathlib import Path

from gridforge.commercial import SCREEN_CREDIT_SENTENCE, engagement
from gridforge.intake.loader import load
from gridforge.reporting import to_markdown
from gridforge.reporting.proposal import build as build_proposal
from gridforge.reporting.screen import build as build_screen
from gridforge.scenario import run_all

ROOT = Path(__file__).resolve().parents[1]


def _ts_sentence() -> str:
    src = (ROOT / "lib" / "credits-terms.ts").read_text(encoding="utf-8")
    body = src.split("export const SCREEN_CREDIT_SENTENCE =", 1)[1].split(";", 1)[0]
    return "".join(re.findall(r'"((?:[^"\\]|\\.)*)"', body))


def test_the_engine_sentence_is_the_websites_sentence():
    assert SCREEN_CREDIT_SENTENCE == _ts_sentence()


def _solved():
    intake = load(ROOT / "examples" / "intake" / "reference_hall.json")
    return intake, run_all(intake.context, intake.scenarios)


def test_the_proposal_states_the_conditions_not_credits_in_full():
    intake, results = _solved()
    md = to_markdown(build_proposal(intake, results, engagement("density_screen")))
    assert SCREEN_CREDIT_SENTENCE in md
    assert "Credits in full against" not in md


def test_the_delivered_screen_states_the_conditions_not_credits_in_full():
    intake, results = _solved()
    md = to_markdown(build_screen(intake, results))
    assert SCREEN_CREDIT_SENTENCE in md
    assert "credits in full against it" not in md
