"""The example request shown on /developers is executed here, against the real handler, so a documented example cannot stop working unnoticed.

The page prints `public/reference/examples/qualify-request.json` (and serves the same file), and this test sends that exact body to the free public
route. If the engine's contract changes so the example is refused or loses its meaning, this fails before a visitor pastes a command that errors.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from gridforge.api.server import ApiError, handle_qualify
from gridforge.api.tiers import Tier

ROOT = Path(__file__).resolve().parents[1]
EXAMPLE = json.loads((ROOT / "public" / "reference" / "examples" / "qualify-request.json").read_text(encoding="utf-8"))


def test_the_documented_qualify_example_is_accepted_and_answers_the_question():
    out = handle_qualify(dict(EXAMPLE), Tier.PUBLIC)
    assert out["as_found"]["binding_constraint"], "the free route names the binding constraint"
    assert "calibration" in out and "notice" in out, "the answer carries its calibration state and notice"
    assert out["first_three_constraints"], "the first constraints are listed"


def test_the_free_route_carries_no_schedule_or_money():
    text = json.dumps(handle_qualify(dict(EXAMPLE), Tier.PUBLIC)).lower()
    for word in ("capex", "lead_time", "weeks", "eur"):
        assert word not in text, f"the free tier must not carry {word!r}"


@pytest.mark.parametrize("drop", sorted(EXAMPLE))
def test_each_documented_field_is_load_bearing_or_defaults_visibly(drop):
    body = {k: v for k, v in EXAMPLE.items() if k != drop}
    try:
        out = handle_qualify(body, Tier.PUBLIC)
    except ApiError as e:
        assert 400 <= e.status < 500, "a missing field is a clean refusal, never a server fault"
        return
    # Accepted without it: the answer must then say the field was assumed.
    assert "assum" in json.dumps(out).lower() or "default" in json.dumps(out).lower()


def test_the_page_prints_the_shared_file_and_types_no_copy_of_it():
    page = (ROOT / "app" / "developers" / "page.tsx").read_text(encoding="utf-8")
    assert "qualify-request.json" in page
    assert '"contracted_MW":12' not in page.replace(" ", "")
