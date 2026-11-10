"""`hall.occupied_positions`: how many rack positions are already occupied (optional).

Defect (independent harness oracle review): with `hall.rack_positions` omitted, the busway warning said "the 220 occupied positions ... would
draw 1,760 kW" although nobody gave 220: it was the library default total of 400 less the 180 free positions, stated as a fact about the client's
hall. And `rack_positions == positions_available` (nothing occupied by derivation) silenced the check entirely, with nothing asking the client to
confirm that nothing is occupied.

The field is optional and additive in the manner of `lv.existing_busway_load_kW` (tests/test_existing_load_input.py):
  * absent: every engineering number is what it was (proved here by comparing a run that declares the DERIVED count with one that declares none,
    and, for the shipped intakes, by the golden diff recorded in the commit message); only the warning and disclosure TEXT differs, and the
    field is named as an OPTIONAL gap outside the completeness ratio;
  * supplied: used for the busway-versus-existing-load check instead of the derived figure, read at E5 at most, and refused by name when it
    contradicts the total and the free positions.

Hand-worked on the reference hall (8 kW design density; busway 8 runs x 400 A at 400 V three-phase, derated 0.8, pf 0.97 -> 1,720 kW):
  occupied 380 (560 total less 180 free) x 8 kW = 3,040 kW > 1,720 kW: the warning fires. Occupied 200 x 8 kW = 1,600 kW < 1,720 kW: it does not.
  The library default total is 400: with 180 free the DERIVED occupied count would be 220 (x 8 = 1,760 kW > 1,720 kW) - the invented figure.
"""
from __future__ import annotations

import copy
import json
import os
import threading
import urllib.error
import urllib.request
from pathlib import Path

import pytest

from gridforge.api.server import Handler, handle_compare, handle_screen, handle_study, make_server
from gridforge.api.tiers import Tier
from gridforge.intake.loader import IntakeError, blank_intake, load_document
from gridforge.intake.schema import FIELD_BY_PATH, INTAKE_FIELDS
from gridforge.scenario import run_all

ROOT = Path(__file__).resolve().parents[1]
REFERENCE = json.loads((ROOT / "examples" / "intake" / "reference_hall.json").read_text(encoding="utf-8"))
PATH = "hall.occupied_positions"
KEY = "occupied-positions-test-key-0123456789abcdef"


def _doc(**hall) -> dict:
    d = copy.deepcopy(REFERENCE)
    d["lv"]["busway_ampacity_A"] = 400
    for k, v in hall.items():
        if v is None:
            d["hall"].pop(k, None)
        else:
            d["hall"][k] = v
    return d


def _busway(intake) -> list[str]:
    return [w for w in intake.report.warnings if w.startswith("Busway:")]


def _confirm_lines(intake) -> list[str]:
    return [w for w in intake.report.warnings if "confirm that nothing is occupied" in w]


# --- (a) absent: a derived count is never stated as a fact ---------------------------------------------------------------------
def test_without_the_total_the_default_total_is_named_as_an_assumption_not_a_count_of_the_hall():
    """The harness defect: 400 (library default) less 180 free = 220 was presented as '220 occupied positions'."""
    d = _doc(rack_positions=None, positions_available=180)
    (w,) = _busway(load_document(d))
    assert "the 220 occupied positions" not in w                       # fails on the engine before this change
    assert "neither hall.occupied_positions nor hall.rack_positions was supplied" in w
    assert "assumption (E0)" in w and "library default total of 400 positions" in w
    assert "not a count of anything in your hall" in w
    assert "1,760 kW" in w and "1,720 kW" in w                          # the arithmetic is unchanged: 220 x 8 kW against 8 x 215.05 kW


def test_with_the_total_given_the_derived_count_is_still_called_an_assumption():
    (w,) = _busway(load_document(_doc()))                                # 560 total, 180 free: 380 not free
    assert "hall.occupied_positions was not supplied, so the occupied count is an assumption (E0), not a fact" in w
    assert "560 in total less 180 free = 380 positions" in w and "3,040 kW" in w
    assert "the 380 occupied positions" not in w                       # fails on the engine before this change


def test_all_positions_free_and_no_occupied_figure_asks_the_client_to_confirm_that_nothing_is_occupied():
    d = _doc(positions_available=560)                                    # equals rack_positions: nothing occupied by derivation
    lines = _confirm_lines(load_document(d))
    assert len(lines) == 1                                               # one line, not one per scenario or per route
    assert "hall.positions_available equals hall.rack_positions (560)" in lines[0]
    assert "declare hall.occupied_positions as 0" in lines[0] and "(an assumption, E0)" in lines[0]


def test_the_confirmation_is_asked_for_a_free_total_that_was_defaulted_too():
    d = _doc(rack_positions=None, positions_available=450)              # total defaults to the 450 free: still nothing occupied, still unconfirmed
    (line,) = _confirm_lines(load_document(d))
    assert "hall.rack_positions was not supplied" in line and "450" in line


def test_a_declared_zero_is_the_confirmation_and_silences_the_line():
    for zero in (0, {"value": 0, "note": "fully vacant, per the tenancy schedule"}):
        intake = load_document(_doc(positions_available=560, occupied_positions=zero))
        assert not _confirm_lines(intake) and not _busway(intake)
        assert intake.context.hall.occupied_positions.value == 0


def test_a_hall_with_occupied_positions_by_derivation_is_not_asked_to_confirm_zero():
    assert not _confirm_lines(load_document(_doc()))                     # 560 total, 180 free


def test_the_field_is_an_optional_gap_outside_the_completeness_ratio_and_listed_last():
    intake = load_document(_doc())
    gap = next(g for g in intake.report.gaps if g.path == PATH)
    assert not gap.required and gap.unit == "positions" and gap.why_it_binds and gap.how_to_get_it
    assert "assumption, E0" in gap.fallback_description
    assert intake.report.gaps[-1].path == PATH                           # after every long-standing row (the deck slide shows the first eight)
    assert PATH not in [g.path for g in intake.report.required_gaps]
    assert not FIELD_BY_PATH[PATH].required and not FIELD_BY_PATH[PATH].counts_toward_completeness


def test_completeness_and_can_issue_are_what_they_were_for_every_example():
    counted = {f.path for f in INTAKE_FIELDS if f.counts_toward_completeness}
    assert PATH not in counted
    for name in ("dublin_hall", "london_hall", "nordic_hall", "reference_hall"):
        doc = json.loads((ROOT / "examples" / "intake" / f"{name}.json").read_text(encoding="utf-8"))
        absent = load_document(copy.deepcopy(doc)).report
        doc["hall"]["occupied_positions"] = doc["hall"]["rack_positions"] - doc["hall"]["positions_available"]    # consistent: the derived count
        supplied = load_document(doc).report
        assert absent.completeness == supplied.completeness              # supplying it moves nothing in the ratio
        assert absent.can_issue == supplied.can_issue
        expected = (len(counted) - len({g.path for g in absent.gaps if g.path in counted})) / len(counted)
        assert absent.completeness == expected


# --- (b) supplied: used instead of the derived figure, recorded at E5 -------------------------------------------------------------
def test_a_supplied_count_replaces_the_derived_one_in_the_busway_check():
    d = _doc(rack_positions=None, positions_available=180, occupied_positions=215)   # derived would be 220 (1,760 kW); declared 215 x 8 = 1,720 kW
    intake = load_document(d)
    assert intake.context.hall.occupied_positions.value == 215
    assert not _busway(intake)                                           # 1,720 kW is not above the 1,720.4 kW busway: the derived 220 would have fired
    d["hall"]["occupied_positions"] = 300                                # 300 x 8 = 2,400 kW
    (w,) = _busway(load_document(d))
    assert "the 300 occupied positions you declared (hall.occupied_positions, E5)" in w and "2,400 kW" in w
    assert "assumption" not in w.split("busway_ampacity_A")[0]            # nothing in the sentence about the count is an assumption
    assert "give hall.occupied_positions" not in w                       # it was given: no request for it


def test_supplied_without_the_total_does_not_invent_a_contradiction_with_the_default_total():
    intake = load_document(_doc(rack_positions=None, positions_available=180, occupied_positions=600))
    assert intake.context.hall.rack_positions == 780                     # the default total holds both figures: 600 + 180
    assert intake.context.hall.occupied_positions.value == 600


def test_supplied_is_read_as_customer_data_e5_and_never_higher():
    q = load_document(_doc(occupied_positions=300)).context.hall.occupied_positions
    assert q.evidence.short == "E5" and q.unit == "positions"
    capped = load_document(_doc(occupied_positions={"value": 300, "evidence": "E7"}))
    assert capped.context.hall.occupied_positions.evidence.short == "E5"
    assert any("capped at E5" in w and PATH in w for w in capped.report.warnings)
    lower = load_document(_doc(occupied_positions={"value": 300, "evidence": "E0", "note": "walked the floor once"}))
    assert lower.context.hall.occupied_positions.evidence.short == "E0"  # a client may declare lower; the engine never raises
    assert any(s.path == PATH and s.evidence == "E0" and s.note == "walked the floor once" for s in lower.report.sourced)


def test_the_annotated_object_form_is_accepted_like_the_other_integer_figures():
    intake = load_document(_doc(occupied_positions={"value": 300, "source": "tenancy schedule, March", "note": "racks installed"}))
    assert intake.context.hall.occupied_positions.value == 300
    assert PATH in intake.report.supplied and PATH not in [g.path for g in intake.report.gaps]
    assert any(s.path == PATH and s.source == "tenancy schedule, March" and s.evidence == "E5" for s in intake.report.sourced)


def test_a_supplied_count_less_than_the_positions_not_free_says_what_the_remainder_is():
    (w,) = [w for w in load_document(_doc(occupied_positions=300)).report.warnings if "neither free nor occupied" in w]
    assert "account for 480 of the 560 positions" in w and "the other 80" in w
    assert not [w for w in load_document(_doc(occupied_positions=380)).report.warnings if "neither free nor occupied" in w]


# --- validation: refused by field name ---------------------------------------------------------------------------------------------
@pytest.mark.parametrize("bad, why", [
    (-1, "cannot be negative"), (3.5, "whole number"), (True, "not a number"), ("300", "not a number"), ([1], "not a number"),
    (60_000, "above 50000"), ({"note": "x"}, "without a \"value\""), ({"value": "x"}, "not a number"),
])
def test_a_figure_that_is_not_a_count_is_refused_naming_the_field(bad, why):
    with pytest.raises(IntakeError, match=PATH.replace(".", r"\.")) as e:
        load_document(_doc(occupied_positions=bad))
    assert why in str(e.value)


def test_occupied_plus_free_beyond_the_total_is_refused_naming_all_three_fields():
    with pytest.raises(IntakeError) as e:
        load_document(_doc(occupied_positions=400))                      # 400 + 180 = 580 > 560
    msg = str(e.value)
    assert "hall.occupied_positions is 400" in msg and "hall.positions_available is 180" in msg and "hall.rack_positions (560)" in msg
    assert "cannot be both free and occupied" in msg
    load_document(_doc(occupied_positions=380))                          # 380 + 180 = 560: exactly the total is consistent


def test_null_and_empty_are_absent_not_zero():
    for blank in (None, []):
        d = _doc()
        d["hall"]["occupied_positions"] = blank
        intake = load_document(d)
        assert intake.context.hall.occupied_positions is None and intake.report.gaps[-1].path == PATH


# --- nothing it does not govern moves ------------------------------------------------------------------------------------------------
def _numbers(intake) -> dict:
    out = {}
    for r in run_all(intake.context, intake.scenarios):
        out[r.spec.id] = {
            "racks": r.envelope.max_racks, "binding": r.envelope.binding.id, "unlocked": r.unlocked_racks,
            "constraints": {c.id: (c.racks if c.racks != float("inf") else None, c.max_racks.evidence.short) for c in r.envelope.sorted_constraints()},
        }
    return out


@pytest.mark.parametrize("name", ["dublin_hall", "london_hall", "nordic_hall", "reference_hall"])
def test_declaring_the_derived_count_changes_no_rack_count_constraint_or_class(name):
    """The count feeds the busway-versus-existing-load WARNING and the report's tables, nothing the envelope solves: declaring exactly what the
    engine would have derived leaves every rack count, binding constraint and evidence class where it was."""
    doc = json.loads((ROOT / "examples" / "intake" / f"{name}.json").read_text(encoding="utf-8"))
    base = load_document(copy.deepcopy(doc))
    hall = doc["hall"]
    doc["hall"]["occupied_positions"] = hall["rack_positions"] - hall["positions_available"]
    assert _numbers(load_document(doc)) == _numbers(base)


def _strip(x):
    """A response without the parts this change is allowed to alter: the intake block (gaps, warnings, supplied list, the echoed document) and
    the provenance and request digests, which hash the engine's own source and the request text."""
    if isinstance(x, dict):
        return {k: _strip(v) for k, v in x.items() if k not in ("intake", "provenance", "caveats", "notes", "document", "files", "request_digest")}
    if isinstance(x, list):
        return [_strip(v) for v in x]
    return x


@pytest.mark.parametrize("route", [handle_screen, handle_study])
def test_the_screen_and_study_numbers_are_unchanged_by_declaring_the_derived_count(route):
    a = copy.deepcopy(REFERENCE)
    b = copy.deepcopy(REFERENCE)
    b["hall"]["occupied_positions"] = 380
    assert _strip(route(a, Tier.CLIENT)) == _strip(route(b, Tier.CLIENT))


def test_the_compare_numbers_are_unchanged_by_declaring_the_derived_count():
    a = handle_compare({"intake": copy.deepcopy(REFERENCE)}, Tier.CLIENT)
    d = copy.deepcopy(REFERENCE)
    d["hall"]["occupied_positions"] = 380
    b = handle_compare({"intake": d}, Tier.CLIENT)
    assert _strip(a) == _strip(b)


# --- where it is carried -----------------------------------------------------------------------------------------------------------------
def test_the_model_pack_records_the_value_and_its_class_only_when_supplied():
    absent = handle_study(copy.deepcopy(REFERENCE), Tier.CLIENT)["intake"]
    assert "occupied_positions" not in absent and PATH not in absent["supplied"]
    d = copy.deepcopy(REFERENCE)
    d["hall"]["occupied_positions"] = {"value": 300, "evidence": "E3"}
    got = handle_study(d, Tier.CLIENT)["intake"]
    assert got["occupied_positions"] == {"value": 300, "evidence": "E3"} and PATH in got["supplied"]
    assert PATH not in [g["path"] for g in got["gaps"]]


def test_the_study_table_shows_the_declared_count_with_its_class_and_nothing_when_absent():
    d = copy.deepcopy(REFERENCE)
    absent = handle_study({**d, "format": "md"}, Tier.CLIENT)["document"]
    d["hall"]["occupied_positions"] = 300
    got = handle_study({**d, "format": "md"}, Tier.CLIENT)["document"]
    assert "Positions occupied (declared)" not in absent
    assert "Positions occupied (declared)" in got


def test_the_blank_template_and_the_field_spec_name_it():
    assert blank_intake()["hall"]["occupied_positions"] is None
    spec = FIELD_BY_PATH[PATH]
    assert spec.label == "Rack positions occupied" and spec.unit == "positions" and not spec.required


def test_the_tools_description_of_an_intake_names_the_field_its_class_and_zero():
    from gridforge.api.tools import TOOLS
    screen = next(t for t in TOOLS if t["name"] == "gridforge_screen")
    text = screen["inputSchema"]["properties"]["intake"]["description"]
    assert "hall.occupied_positions" in text and "E5" in text and "Declare 0" in text and "optional gap" in text


# --- over HTTP ------------------------------------------------------------------------------------------------------------------------------
@pytest.fixture(scope="module")
def base():
    os.environ["GRIDFORGE_API_KEYS"] = KEY
    os.environ["GRIDFORGE_RATE_LIMIT"] = "0"
    Handler.limiter.per_minute = 0
    httpd = make_server("127.0.0.1", 0)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{httpd.server_address[1]}"
    httpd.shutdown()
    os.environ.pop("GRIDFORGE_API_KEYS", None)


def _post(base, path, body):
    req = urllib.request.Request(base + path, data=json.dumps(body).encode(), method="POST", headers={"Content-Type": "application/json", "X-API-Key": KEY})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


def test_over_http_a_contradiction_is_a_422_naming_the_field_and_a_valid_count_is_accepted(base):
    bad = copy.deepcopy(REFERENCE)
    bad["hall"]["occupied_positions"] = 400
    status, body = _post(base, "/v1/screen", bad)
    assert status == 422 and "hall.occupied_positions" in json.dumps(body)
    ok = copy.deepcopy(REFERENCE)
    ok["hall"]["occupied_positions"] = {"value": 300, "evidence": "E5", "note": "racks installed"}
    status, body = _post(base, "/v1/screen", ok)
    assert status == 200
    warnings = body["intake"]["warnings"]
    assert any("the 300 occupied positions you declared" in w for w in warnings)


def test_over_http_the_free_qualifier_never_states_a_derived_count_as_a_fact(base):
    status, body = _post(base, "/v1/qualify", json.loads((ROOT / "examples" / "api" / "qualify-request.json").read_text(encoding="utf-8")))
    assert status == 200
    text = " ".join(body["intake"]["warnings"])
    assert "the 220 occupied positions" not in text and "library default total of 400 positions" in text
    golden = json.loads((ROOT / "tests" / "golden_qualify_plain_002fa59.json").read_text(encoding="utf-8"))["cases"][0]
    assert golden["name"] == "reference_example" and body["intake"]["completeness"] == golden["response"]["intake"]["completeness"]
