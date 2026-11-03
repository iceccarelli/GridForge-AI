"""Defects the independent laboratory reported against this repository, pinned from the company side.

  #110  seven numeric intake fields accepted {value, source, note, evidence} and dropped the source and note (six the lab found, plus
        economics.discount_rate, which its sample did not include);
  #112  /v1/portfolio added the same hall up twice.
(#107, the supplied transformer lead time's range, is pinned in tests/test_engine_review_fixes.py.)
"""
import copy
import json
from pathlib import Path

import pytest

from gridforge.api.server import ApiError, handle_portfolio, handle_screen
from gridforge.api.tiers import Tier

ROOT = Path(__file__).resolve().parent.parent
REF = json.loads((ROOT / "examples" / "intake" / "reference_hall.json").read_text())
LONDON = json.loads((ROOT / "examples" / "intake" / "london_hall.json").read_text())

ANNOTATED = [
    ("hall", "build_year", 2012), ("hall", "rack_positions", 400), ("hall", "positions_available", 180),
    ("lv", "phases", 3), ("lv", "busway_runs", 8), ("economics", "horizon_years", 10), ("economics", "discount_rate", 0.08),
]


def with_value(section, key, value):
    d = copy.deepcopy(REF)
    d.setdefault(section, {})[key] = value
    return d


def screen_md(doc):
    return handle_screen({"intake": doc, "format": "md"}, Tier.CLIENT)["document"]


@pytest.mark.parametrize("section,key,value", ANNOTATED)
def test_an_annotated_figure_shows_its_source_and_note(section, key, value):
    md = screen_md(with_value(section, key, {"value": value, "source": "SRC-MARK", "note": "NOTE-MARK"}))
    assert "SRC-MARK" in md and "NOTE-MARK" in md


@pytest.mark.parametrize("section,key,value", ANNOTATED)
def test_annotating_a_figure_changes_no_number(section, key, value):
    bare = screen_md(with_value(section, key, value))
    annotated = screen_md(with_value(section, key, {"value": value, "source": "S", "note": "N"}))
    # the only difference is the provenance table and its mention; every rack count and date line is identical
    keep = lambda md: [l for l in md.splitlines() if "racks" in l or "weeks" in l]
    assert keep(bare) == keep(annotated)


@pytest.mark.parametrize("section,key,value", ANNOTATED)
def test_a_declared_evidence_above_E5_is_capped_with_a_warning_not_silently_ignored(section, key, value):
    from gridforge.intake.loader import load_document
    intake = load_document(with_value(section, key, {"value": value, "source": "S", "evidence": "E7"}))
    assert any(f"{section}.{key}" in w and "capped at E5" in w for w in intake.report.warnings)
    src = next(s for s in intake.report.sourced if s.path == f"{section}.{key}")
    assert src.evidence == "E5"


@pytest.mark.parametrize("section,key,value", ANNOTATED)
def test_a_malformed_annotation_is_refused_by_field_name(section, key, value):
    from gridforge.intake.loader import IntakeError, load_document
    for bad in ({"value": value, "source": ["x"]}, {"value": value, "note": 3}, {"value": value, "evidence": "Q9"}, {"source": "S"}):
        with pytest.raises(IntakeError, match=f"{section}.{key}|{key}"):
            load_document(with_value(section, key, bad))


# ---- #112 ----------------------------------------------------------------------------------------------------------------------------

def test_the_same_hall_listed_twice_is_refused_not_doubled():
    with pytest.raises(ApiError) as e:
        handle_portfolio({"intakes": [REF, REF]}, Tier.CLIENT)
    assert e.value.status == 422 and "counts once" in str(e.value)


def test_a_repeat_that_differs_only_in_a_note_is_still_the_same_hall():
    noted = copy.deepcopy(REF)
    noted["project"] = {**noted["project"], "note": "exported twice"}
    with pytest.raises(ApiError):
        handle_portfolio({"intakes": [REF, noted]}, Tier.CLIENT)


def test_distinct_halls_still_add_up_and_in_any_order():
    a = handle_portfolio({"intakes": [REF, LONDON]}, Tier.CLIENT)
    b = handle_portfolio({"intakes": [LONDON, REF]}, Tier.CLIENT)
    assert a["total_racks"] == b["total_racks"] == sum(h["racks"] for h in a["halls"])
    assert len(a["halls"]) == 2


def test_sparse_intakes_that_name_no_ids_are_not_assumed_to_be_one_hall():
    s1 = {"grid": {"contracted_MW": 12, "current_site_peak_MW": 7, "current_it_load_MW": 5}, "lv": {"busway_ampacity_A": 400, "tapoff_max_A": 63},
          "hall": {"positions_available": 100}, "thermal": {"plant": {"design_supply_C": 6}}}
    s2 = copy.deepcopy(s1)
    s2["grid"]["contracted_MW"] = 30
    assert len(handle_portfolio({"intakes": [s1, s2]}, Tier.CLIENT)["halls"]) == 2
    with pytest.raises(ApiError):                                  # but the identical document twice is the same hall
        handle_portfolio({"intakes": [s1, s1]}, Tier.CLIENT)


def test_the_rendered_form_refuses_a_repeat_too():
    with pytest.raises(ApiError):
        handle_portfolio({"intakes": [REF, REF], "format": "md"}, Tier.CLIENT)
