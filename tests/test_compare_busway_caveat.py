"""/v1/compare tells its reader whether the load already on the busway was subtracted.

Defect (independent harness, RC d23bc81): the comparison gave the same busway-bound rack count at 10, 50, ... occupied positions with no statement that
existing load is not subtracted (the screen's basis text already says it). The comparison now carries a caveat. No number changes: the test proves
the payload with the caveat is the payload without it plus exactly that one line.
"""
from __future__ import annotations

import copy
import json
from pathlib import Path

import pytest

from gridforge.api import compare_payload as cp
from gridforge.api.server import handle_compare
from gridforge.api.tiers import Tier

ROOT = Path(__file__).resolve().parents[1]
HALLS = ["dublin", "london", "nordic", "reference"]

NOT_SUBTRACTED = ("Existing load on the busway is not subtracted unless declared (lv.existing_busway_load_kW); busway-bound rack counts do not "
                  "fall as the hall fills.")


def _doc(name):
    return json.loads((ROOT / "examples" / "intake" / f"{name}_hall.json").read_text(encoding="utf-8"))


@pytest.mark.parametrize("hall", HALLS)
def test_the_caveat_is_present_when_the_load_is_not_declared(hall):
    out = handle_compare({"intake": _doc(hall)}, Tier.CLIENT)
    assert NOT_SUBTRACTED in out["caveats"]
    assert out["caveats"].count(NOT_SUBTRACTED) == 1


@pytest.mark.parametrize("hall", HALLS)
def test_only_the_caveat_text_is_added_no_number_moves(hall, monkeypatch):
    with_text = handle_compare({"intake": _doc(hall)}, Tier.CLIENT)
    monkeypatch.setattr(cp, "busway_caveat", lambda results: None)
    without = handle_compare({"intake": _doc(hall)}, Tier.CLIENT)
    assert [c for c in with_text["caveats"] if c not in without["caveats"]] == [NOT_SUBTRACTED]
    stripped = dict(with_text, caveats=[c for c in with_text["caveats"] if c != NOT_SUBTRACTED])
    assert stripped == without                       # scenarios, ranking, grade, request_digest: all identical


def test_declared_the_sentence_states_the_figure_is_subtracted():
    d = _doc("reference")
    d["lv"]["existing_busway_load_kW"] = 500
    out = handle_compare({"intake": d}, Tier.CLIENT)
    assert NOT_SUBTRACTED not in out["caveats"]
    assert any("500 kW" in c and "lv.existing_busway_load_kW as declared" in c and "is subtracted" in c for c in out["caveats"])


def test_busway_bound_racks_do_not_move_with_occupancy_and_the_comparison_says_so():
    """What the harness oracle checks: undeclared, the busway-bound count is the same whatever the occupancy; the caveat is why."""
    def busway_racks(occupied_free):
        d = _doc("reference")
        d["hall"]["positions_available"] = occupied_free
        from gridforge.intake.loader import load_document
        from gridforge.power.constraints import busway_ampacity
        out = handle_compare({"intake": d}, Tier.CLIENT)
        return busway_ampacity(load_document(d).context).racks, out["caveats"]
    (a, ca), (b, cb) = busway_racks(500), busway_racks(60)
    assert a == b and NOT_SUBTRACTED in ca and NOT_SUBTRACTED in cb
