"""Quantities are JSON numbers; contradictory grid figures are stated, never silently resolved; screen and compare agree.

Found by the independent gridforge-stress harness (its two strict-xfail cases, now fixed here):

  * a numeric string such as "14" for grid.firm_capacity_MVA was converted by float() while a boolean was refused, so the engine
    accepted whatever sent the text without checking what it was sending (a unit label, a locale comma, a thousands separator);
  * contracted_MW above what the firm connection can deliver (firm MVA x power factor) passed with no finding at all, although the
    model silently used the lesser of the two.
"""
from __future__ import annotations

import copy
import json
from pathlib import Path

import pytest

from gridforge.api.server import handle_compare, handle_screen
from gridforge.api.tiers import Tier
from gridforge.intake.loader import IntakeError, load_document
from gridforge.power.plausibility import intake_warnings, plausibility_findings

ROOT = Path(__file__).resolve().parents[1]
EXAMPLES = sorted((ROOT / "examples" / "intake").glob("*.json"))
BASE = json.loads((ROOT / "examples" / "intake" / "reference_hall.json").read_text())


def mutated(fn):
    doc = copy.deepcopy(BASE)
    fn(doc)
    return doc


# --- a quantity is a number: text is refused exactly as a boolean is ---------------------------------------------------------------


@pytest.mark.parametrize(
    ("setter", "field"),
    [
        (lambda d, v: d["grid"].__setitem__("firm_capacity_MVA", v), "grid.firm_capacity_MVA"),
        (lambda d, v: d["grid"].__setitem__("contracted_MW", v), "grid.contracted_MW"),
        (lambda d, v: d["grid"].__setitem__("power_factor", v), "grid.power_factor"),
        (lambda d, v: d["hall"].__setitem__("positions_available", v), "hall.positions_available"),
        (lambda d, v: d["hall"].__setitem__("build_year", v), "hall.build_year"),
        (lambda d, v: d["transformers"][0].__setitem__("units", v), "units"),
        (lambda d, v: d["btm_options"][0].__setitem__("lead_time_weeks", v), "lead_time_weeks"),
    ],
)
@pytest.mark.parametrize("text", ["14", "14.0", " 14 ", "1e2", "14 MVA", "14,5", "", "NaN", "Infinity"])
def test_a_numeric_string_is_refused_and_the_field_is_named(setter, field, text):
    with pytest.raises(IntakeError) as exc:
        load_document(mutated(lambda d: setter(d, text)))
    assert field in str(exc.value) and "not a string" in str(exc.value)


def test_a_quantity_given_as_value_and_note_is_held_to_the_same_rule():
    doc = mutated(lambda d: d["grid"].__setitem__("current_site_peak_MW", {"value": "7.4", "note": "metered"}))
    with pytest.raises(IntakeError, match="current_site_peak_MW"):
        load_document(doc)


@pytest.mark.parametrize("junk", [True, False, [14], {"v": 14}])
def test_other_non_numbers_are_still_refused_with_the_field_named(junk):
    with pytest.raises(IntakeError, match="grid.firm_capacity_MVA"):
        load_document(mutated(lambda d: d["grid"].__setitem__("firm_capacity_MVA", junk)))


def test_null_is_not_supplied_and_the_gap_is_disclosed_not_treated_as_a_value():
    """JSON null means "not given": the library default is used and the gap is reported. It is never read as 0 or as a measured number."""
    loaded = load_document(mutated(lambda d: d["grid"].__setitem__("firm_capacity_MVA", None)))
    assert "grid.firm_capacity_MVA" not in loaded.report.supplied
    assert any(g.path == "grid.firm_capacity_MVA" for g in loaded.report.gaps)


@pytest.mark.parametrize("path", EXAMPLES, ids=lambda p: p.stem)
def test_every_shipped_intake_still_loads(path):
    assert load_document(json.loads(path.read_text())).report.supplied


def test_integers_and_floats_are_both_numbers():
    load_document(mutated(lambda d: d["grid"].__setitem__("firm_capacity_MVA", 14)))
    load_document(mutated(lambda d: d["grid"].__setitem__("firm_capacity_MVA", 14.0)))


# --- contracted power above the firm connection is stated, and says what it is ---------------------------------------------------------


def _contracted(mw):
    return mutated(lambda d: d["grid"].__setitem__("contracted_MW", mw))


def test_contracted_above_the_firm_connection_is_a_finding_not_silence():
    found = plausibility_findings(load_document(_contracted(20)).context)
    assert len(found) == 1
    text = found[0]
    assert "contracted capacity (20.00 MW)" in text and "14.00 MVA x 0.97 = 13.58 MW" in text
    assert "uses the lesser, 13.58 MW" in text and "network operator" in text
    # an input discrepancy to confirm, not a claim that the site is impossible
    assert "No hall can run" not in text and "MW, MVA, kW" in text


@pytest.mark.parametrize("mw", [12.0, 13.58, 13.58 * (1 + 1e-9)])
def test_contracted_at_or_below_the_firm_connection_is_not_flagged(mw):
    assert plausibility_findings(load_document(_contracted(mw)).context) == []


@pytest.mark.parametrize("path", EXAMPLES, ids=lambda p: p.stem)
def test_no_shipped_intake_trips_the_contracted_finding(path):
    ctx = load_document(json.loads(path.read_text())).context
    assert not [w for w in plausibility_findings(ctx) if w.startswith("The contracted capacity")]


def test_the_comparison_carries_the_contracted_finding_exactly_once():
    out = handle_compare({"intake": _contracted(50)}, Tier.CLIENT)
    hits = [c for c in out["caveats"] if c.startswith("The contracted capacity")]
    assert len(hits) == 1 and "50.00 MW" in hits[0]
    clean = handle_compare({"intake": BASE}, Tier.CLIENT)
    assert out["caveats"] != clean["caveats"]


def test_the_contracted_finding_does_not_change_the_numbers():
    """It is a statement about the inputs. The model already used the lesser figure; stating it must not move any result."""
    flagged = handle_compare({"intake": _contracted(50)}, Tier.CLIENT)
    capped = handle_compare({"intake": _contracted(13.58)}, Tier.CLIENT)
    drop = {"caveats", "request_digest", "provenance", "intake_completeness", "grid_queue_context", "retail_price_context"}
    assert {k: v for k, v in flagged.items() if k not in drop} == {k: v for k, v in capped.items() if k not in drop}


# --- screen and compare say the same thing about the same intake -----------------------------------------------------------------------


@pytest.mark.parametrize(
    "fn",
    [
        lambda d: d["grid"].__setitem__("current_it_load_MW", 99),
        lambda d: d["grid"].__setitem__("contracted_MW", 20),
        lambda d: d["grid"].__setitem__("current_site_peak_MW", 40),
        lambda d: (d["grid"].__setitem__("contracted_MW", 20), d["grid"].__setitem__("current_it_load_MW", 99)),
    ],
    ids=["it-load-over-supply", "contracted-over-firm", "peak-over-supply", "both"],
)
def test_screen_and_compare_agree_on_every_material_finding(fn):
    doc = mutated(fn)
    screen = handle_screen({"intake": doc}, Tier.CLIENT)["intake"]["warnings"]
    compare = handle_compare({"intake": doc}, Tier.CLIENT)["caveats"]
    material = plausibility_findings(load_document(doc).context)
    assert material, "the case must actually raise a finding"
    for finding in material:
        assert screen.count(finding) == 1, "screen must carry the finding once, unchanged"
        assert compare.count(finding) == 1, "compare must carry the finding once, unchanged"


def test_an_intake_with_nothing_to_flag_has_no_plausibility_finding_in_either_response():
    ctx = load_document(BASE).context
    assert plausibility_findings(ctx) == []
    assert intake_warnings(load_document(BASE)) == list(load_document(BASE).report.warnings)


# --- a date that rests on a lead time the client did not give is never silent ------------------------------------------------------------


def _no_transformer_lead_time():
    return mutated(lambda d: d["transformers"][0].pop("replacement_lead_time_weeks"))


def test_removing_the_transformer_lead_time_is_disclosed_in_the_comparison_and_the_screen():
    doc = _no_transformer_lead_time()
    compare = handle_compare({"intake": doc}, Tier.CLIENT)
    said = [c for c in compare["caveats"] if "transformer replacement lead time was not supplied" in c]
    assert len(said) == 1 and "library placeholder" in said[0] and "not a manufacturer's quote" in said[0]
    assert compare["grade"] != "decision_grade"
    screen = handle_screen({"intake": doc}, Tier.CLIENT)["intake"]["warnings"]
    assert any("transformer replacement lead time was not supplied" in w for w in screen) or any(
        "replacement_lead_time_weeks" in str(g) for g in handle_screen({"intake": doc}, Tier.CLIENT)["intake"]["gaps"]
    )


def test_every_date_that_rests_on_the_placeholder_is_labelled_an_assumed_lead_time_not_a_date():
    compare = handle_compare({"intake": _no_transformer_lead_time()}, Tier.CLIENT)
    dated = [s for s in compare["scenarios"] if s["time_to_power"].get("weeks") is not None]
    assert dated, "the example must date at least one scenario for this to test anything"
    for s in dated:
        ttp = s["time_to_power"]
        assert ttp["date_basis"] in {"assumed", "mixed"} or ttp.get("date_evidence_class") == "E0", s["id"]
        assert "not a date" in ttp["date_label"], s["id"]
        assert ttp.get("date_evidence_class") in {"E0", None}, s["id"]


def test_supplying_the_lead_time_removes_the_disclosure_and_nothing_else_is_invented():
    given = handle_compare({"intake": BASE}, Tier.CLIENT)
    assert not [c for c in given["caveats"] if "transformer replacement lead time was not supplied" in c]


# --- a request cannot demand unbounded work through the size of an equipment list ------------------------------------------------------------
from gridforge.intake.loader import MAX_EQUIPMENT_ITEMS  # noqa: E402


@pytest.mark.parametrize(
    ("section", "make"),
    [
        ("transformers", lambda i, d: dict(d["transformers"][0], id=f"T{i}")),
        ("ups", lambda i, d: dict(d["ups"][0], id=f"U{i}")),
        ("btm_options", lambda i, d: dict(d["btm_options"][0], id=f"B{i}")),
    ],
)
def test_an_equipment_list_one_over_the_limit_is_refused_by_name_before_any_solving(section, make):
    doc = copy.deepcopy(BASE)
    doc[section] = [make(i, BASE) for i in range(MAX_EQUIPMENT_ITEMS + 1)]
    with pytest.raises(IntakeError) as exc:
        load_document(doc)
    assert section in str(exc.value) and str(MAX_EQUIPMENT_ITEMS + 1) in str(exc.value) and "per hall" in str(exc.value)


def test_an_equipment_list_at_the_limit_is_accepted_and_solved_in_bounded_time():
    import time

    doc = copy.deepcopy(BASE)
    doc["transformers"] = [dict(BASE["transformers"][0], id=f"T{i}") for i in range(MAX_EQUIPMENT_ITEMS)]
    started = time.monotonic()
    out = handle_compare({"intake": doc}, Tier.CLIENT)
    assert out["scenarios"] and time.monotonic() - started < 20


@pytest.mark.parametrize("section", ["transformers", "ups", "btm_options"])
@pytest.mark.parametrize("junk", ["abc", 7, {"id": "x"}, True])
def test_an_equipment_section_that_is_not_a_list_is_refused_naming_it(section, junk):
    doc = copy.deepcopy(BASE)
    doc[section] = junk
    with pytest.raises(IntakeError, match=section):
        load_document(doc)


@pytest.mark.parametrize("junk", [None, 7, "x", [1], True])
def test_an_equipment_element_that_is_not_an_object_is_refused_naming_its_position(junk):
    doc = copy.deepcopy(BASE)
    doc["btm_options"] = [BASE["btm_options"][0], junk]
    with pytest.raises(IntakeError, match=r"btm_options\[1\]"):
        load_document(doc)


def test_repeated_ids_in_a_long_list_are_found_in_linear_time():
    doc = copy.deepcopy(BASE)
    doc["ups"] = [dict(BASE["ups"][0], id=f"U{i % 99}") for i in range(MAX_EQUIPMENT_ITEMS)]
    with pytest.raises(IntakeError, match="twice"):
        load_document(doc)


def test_a_portfolio_beyond_the_hall_limit_is_refused_before_any_hall_is_solved():
    from gridforge.api.server import MAX_PORTFOLIO_HALLS, ApiError, handle_portfolio

    with pytest.raises(ApiError) as exc:
        handle_portfolio({"intakes": [BASE] * (MAX_PORTFOLIO_HALLS + 1)}, Tier.CLIENT)
    assert exc.value.status == 422 and str(MAX_PORTFOLIO_HALLS + 1) in exc.value.message
    assert exc.value.extra["max_halls"] == MAX_PORTFOLIO_HALLS


def test_a_portfolio_of_the_size_the_product_sells_is_unaffected():
    from gridforge.api.server import handle_portfolio

    out = handle_portfolio({"intakes": [BASE] * 15}, Tier.CLIENT)
    assert len(out["halls"]) == 15
