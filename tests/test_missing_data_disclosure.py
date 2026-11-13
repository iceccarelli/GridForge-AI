"""A value the client did not give is never silently invented, never zero, and never printed without saying so.

An independent review on 2026-11-03 removed the site's peak demand from the reference intake and found the engine substitutes a library
default (5 MW against the true 7.4) that raises the grid ceiling from 26 racks to 39. That is intended behaviour for a screening tool, but
only if the document that carries the number says, in the same place, that the input is missing, required, a default and an assumption.
These tests hold the disclosure, not the number: the number is not changed to look better or worse.
"""
from __future__ import annotations

import copy
import json
from pathlib import Path

import pytest

from gridforge.api.server import handle_screen
from gridforge.api.tiers import Tier

ROOT = Path(__file__).resolve().parents[1]
REFERENCE = json.loads((ROOT / "examples" / "intake" / "reference_hall.json").read_text(encoding="utf-8"))

REQUIRED_LOADS = [("grid", "current_site_peak_MW", "Current site peak demand"), ("grid", "current_it_load_MW", None)]


def _doc(d: dict) -> str:
    return handle_screen({"intake": d, "format": "md"}, Tier.CLIENT)["document"]


def test_a_missing_site_peak_is_disclosed_as_required_and_assumed():
    d = copy.deepcopy(REFERENCE)
    del d["grid"]["current_site_peak_MW"]
    doc = _doc(d)
    row = next(line for line in doc.splitlines() if line.startswith("| Current site peak demand"))
    assert "required" in row, "the input must be marked required"
    assert "(E0)" in row, "a default must carry the assumption class"
    # one input is missing, and the recommendation (buyer voice since 2026-11-13) says so in the singular: "1 required input is missing (...)"
    assert "1 required input is missing" in doc, "the document must say that required inputs are missing"


def test_the_default_is_a_range_not_a_point():
    d = copy.deepcopy(REFERENCE)
    del d["grid"]["current_site_peak_MW"]
    row = next(line for line in _doc(d).splitlines() if line.startswith("| Current site peak demand"))
    assert "[" in row and "–" in row, f"a default is shown with its range, not as a bare number: {row}"


def test_a_supplied_value_is_not_reported_as_missing():
    doc = _doc(copy.deepcopy(REFERENCE))
    assert "required inputs missing" not in doc.replace("0 required inputs missing", "")


@pytest.mark.parametrize("bad", [float("nan"), float("inf"), -1.0, True, "7.4"])
def test_unphysical_or_mistyped_load_values_are_refused_by_name_never_used(bad):
    """Refused with the engine's own IntakeError, which names the field and what was wrong. Not a crash, not a silent zero."""
    from gridforge.intake.loader import IntakeError

    d = copy.deepcopy(REFERENCE)
    d["grid"]["current_site_peak_MW"] = bad
    with pytest.raises(IntakeError) as e:
        _doc(d)
    assert "grid.current_site_peak_MW" in str(e.value)


def test_an_explicit_null_is_treated_as_missing_and_disclosed_not_as_zero():
    d = copy.deepcopy(REFERENCE)
    d["grid"]["current_site_peak_MW"] = None
    doc = _doc(d)
    row = next(line for line in doc.splitlines() if line.startswith("| Current site peak demand"))
    assert "required" in row and "(E0)" in row
