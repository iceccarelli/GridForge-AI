"""A schedule of only empty banks is zero capacity, not 'no limit' (review E3).

The loader ignores a bank declared with `units` below one ONLY when the same list also has a bank with at least one unit (a schedule with a
decommissioned bank left on it is a plausible document). A list of nothing but empty banks is a declaration of zero capacity and is kept as declared:
the constraint binds at zero racks. Dropping the empty banks first made `ups[0].units = 0` read as an undeclared UPS schedule, which is 'no limit', the
MOST favourable reading: the reference hall went from 0 racks (ups_capacity binds) to 26 / 28 / 62 racks with the warnings 'treated as no limit' and 'No
UPS schedule supplied'. (The solver half, `active_banks`, was already right: tests/test_relief_granularity.py pins it.)
"""
from __future__ import annotations

import copy
import json
from pathlib import Path

import pytest

from gridforge.api import server as S
from gridforge.intake.loader import load_document

ROOT = Path(__file__).resolve().parents[1]
REFERENCE = json.loads((ROOT / "examples" / "intake" / "reference_hall.json").read_text())
DUBLIN = json.loads((ROOT / "examples" / "intake" / "dublin_hall.json").read_text())
CDU = {"id": "CDU-A", "rated_capacity_kW": 1350, "units": 3, "redundancy": "N+1"}


def screen(doc: dict) -> dict:
    handler, tier = S.ROUTES["/v1/screen"]
    return S._invoke("/v1/screen", handler, {"intake": doc}, tier)


def by_scenario(out: dict) -> dict:
    return {s["id"]: s for s in out["scenarios"]}


def warnings_of(out: dict) -> list[str]:
    return out["intake"]["warnings"]


# ---------------------------------------------------------------------------------------------- an all-empty list binds at zero
def test_an_all_empty_ups_list_binds_at_zero_through_the_handler():
    d = copy.deepcopy(REFERENCE)
    d["ups"][0]["units"] = 0
    out = screen(d)
    for sid, sc in by_scenario(out).items():
        assert sc["as_found"]["racks"] == 0 and sc["as_found"]["binding"] == "ups_capacity", sid
    text = " | ".join(warnings_of(out))
    assert "ups: every bank declared 0 units" in text and "not as 'no limit'" in text
    assert "treated as no limit" not in text and "No UPS schedule supplied" not in text


def test_the_all_empty_ups_is_a_zero_the_plan_pays_for_not_a_limit_that_is_not_there():
    """The reference hall with `ups[0].units = 0`: 0 racks as found in every scenario with ups_capacity binding (what the engine answered before empty
    banks were ignored). The plan then BUYS UPS modules (taken, priced steps), where the 'no limit' reading of the same hall buys none: that difference is the
    whole of the defect. (26 / 28 / 62 racks after the ladder in the liquid scenarios are the same ceilings a hall with a UPS reaches: the zero is closable.)"""
    d = copy.deepcopy(REFERENCE)
    d["ups"][0]["units"] = 0
    out = screen(d)
    for sid, sc in by_scenario(out).items():
        assert (sc["as_found"]["racks"], sc["as_found"]["binding"]) == (0, "ups_capacity"), sid
    for sid in ("hybrid_dlc", "full_dlc", "full_dlc_btm"):
        sc = by_scenario(out)[sid]
        bought = [x for x in sc["ladder"] if x["constraint"] == "ups_capacity" and x["taken"]]
        assert bought and all(x["capex_eur"] is not None for x in bought), sid       # the declared zero capacity is bought up, and priced
    unlimited = copy.deepcopy(REFERENCE)
    unlimited["ups"] = []                                                           # the 'no limit' reading: no UPS step at all
    for sc in by_scenario(screen(unlimited)).values():
        assert not [x for x in sc["ladder"] if x["constraint"] == "ups_capacity"]


def test_an_all_empty_transformer_list_binds_at_zero_through_the_handler():
    d = copy.deepcopy(DUBLIN)
    d["transformers"][0]["units"] = 0
    out = screen(d)
    assert {sc["as_found"]["binding"] for sc in out["scenarios"]} == {"transformer_capacity"}
    assert all(sc["as_found"]["racks"] == 0 for sc in out["scenarios"])
    text = " | ".join(warnings_of(out))
    assert "transformers: every bank declared 0 units" in text and "No transformer schedule supplied" not in text


def test_an_all_empty_cdu_list_binds_at_zero_in_a_cdu_architecture():
    d = copy.deepcopy(DUBLIN)
    d["thermal"]["cdus"] = [{**CDU, "units": 0}]
    out = screen(d)
    hybrid = by_scenario(out)["hybrid_dlc"]
    assert hybrid["as_found"]["racks"] == 0 and hybrid["as_found"]["binding"] == "cdu_capacity"
    assert "thermal.cdus: every bank declared 0 units" in " | ".join(warnings_of(out))


def test_several_empty_banks_are_all_kept_when_none_has_a_unit():
    d = copy.deepcopy(DUBLIN)
    d["ups"] = [{"id": "U0", "unit_rating_kW": 1200, "units": 0, "redundancy": "N"}, {"id": "U1", "unit_rating_kW": 1800, "units": 0, "redundancy": "N"}]
    it = load_document(d)
    assert [(u.id, u.units) for u in it.context.power.ups] == [("U0", 0), ("U1", 0)]
    assert "ups" in it.report.supplied and it.report.can_issue
    assert any("every bank declared 0 units (ups[0] (U0), ups[1] (U1))" in w for w in it.report.warnings)


def test_an_empty_list_is_still_an_undeclared_schedule():
    """`ups: []` is the 'not supplied' reading (no limit, said so), unchanged: only a list of declared empty banks is zero capacity."""
    d = copy.deepcopy(DUBLIN)
    d["ups"] = []
    it = load_document(d)
    assert it.context.power.ups == [] and "ups" not in it.report.supplied
    assert "No UPS schedule supplied" in " | ".join(it.report.warnings)


# ---------------------------------------------------------------------------------------------- one live bank beside an empty one
def test_one_live_ups_block_beside_an_empty_one_ignores_the_empty_one_with_the_named_warning():
    d = copy.deepcopy(DUBLIN)
    d["ups"].append({"id": "UPS-EMPTY", "unit_rating_kW": 800, "units": 0, "redundancy": "N+1"})
    out = screen(d)
    assert any(w.startswith("ups[1] (UPS-EMPTY): units is 0, ignored") for w in warnings_of(out))
    assert not any("every bank declared 0 units" in w for w in warnings_of(out))
    plain = screen(copy.deepcopy(DUBLIN))
    assert {k: (v["as_found"]["racks"], v["after_ladder"]["racks"]) for k, v in by_scenario(out).items()} == \
           {k: (v["as_found"]["racks"], v["after_ladder"]["racks"]) for k, v in by_scenario(plain).items()}      # ignored: it changes no answer


def test_one_live_transformer_bank_beside_an_empty_one_ignores_the_empty_one_with_the_named_warning():
    d = copy.deepcopy(DUBLIN)
    d["transformers"].insert(0, {"id": "TX-OLD", "unit_rating_MVA": 5, "units": 0, "redundancy": "N+1", "replacement_lead_time_weeks": 300})
    it = load_document(d)
    assert [t.id for t in it.context.power.transformers] == ["TX-A/B"]
    assert any(w.startswith("transformers[0] (TX-OLD): units is 0, ignored") for w in it.report.warnings)


def test_one_live_cdu_bank_beside_an_empty_one_ignores_the_empty_one_with_the_named_warning():
    d = copy.deepcopy(DUBLIN)
    d["thermal"]["cdus"] = [{**CDU, "id": "CDU-GONE", "units": 0}, CDU]
    it = load_document(d)
    assert [c.id for c in it.context.thermal.cdus] == ["CDU-A"]
    assert any(w.startswith("thermal.cdus[0] (CDU-GONE): units is 0, ignored") for w in it.report.warnings)


@pytest.mark.parametrize("units", [-1, 1.5, "2"])
def test_a_units_figure_that_is_not_a_whole_number_of_zero_or_more_is_still_refused_in_a_list_of_empty_banks(units):
    from gridforge.intake.loader import IntakeError
    d = copy.deepcopy(DUBLIN)
    d["ups"] = [{"id": "U0", "unit_rating_kW": 1200, "units": 0, "redundancy": "N"}, {"id": "U1", "unit_rating_kW": 1800, "units": units, "redundancy": "N"}]
    with pytest.raises(IntakeError) as exc:
        load_document(d)
    assert "units" in str(exc.value)
