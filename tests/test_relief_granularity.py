"""A relief buys the capacity it adds, priced on that capacity; how the customer happened to LIST the plant, and banks with no units, change nothing.

Defect (independent numerics audit, 2026-11-13, reproduced before the fix; each figure is the old engine's):

* the UPS relief added two modules to EVERY listed block, priced on the sum: the reference hall with the UPS under N and the same 6 x 1200 kW plant
  listed as 1, 2 or 6 blocks gave identical racks (0 -> 26) and capex 5,858,000 / 6,626,000 / 9,698,000 EUR; the CDU relief added one unit to every bank;
* a block or bank declared with ``units: 0`` still counted: a zero-unit UPS block on the Dublin hall repriced the UPS step on 4,800 kW instead of 2,400 and
  lifted the capex from 3,718,000 to 4,486,000 EUR for the same racks; an empty CDU bank doubled its step; a zero-unit transformer bank with a lead time of
  300 weeks moved ``weeks_to_full`` from 160 to 300.

The rule (power.constraints._ups_host, thermal.constraints._cdu_host): a UPS relief buys two modules in total and a CDU relief one further usable unit in
total (a matched pair under 2N), each put in ONE bank (the fewest that can host it), the one whose added capacity is largest; banks with units < 1 are
ignored wherever banks are counted, priced or dated. The expectations below are stated from that rule and from equality between listings, not read back.
"""
from __future__ import annotations

import copy
import itertools
import json
import random
from pathlib import Path

import pytest

from gridforge.constraints import EnvelopeContext
from gridforge.envelope import ladder
from gridforge.envelope.time_to_power import date_record, schedule
from gridforge.intake.loader import load_document
from gridforge.power.constraints import UPS_MODULES_PER_RELIEF, _ups_host, active_banks, transformer_capacity, ups_capacity
from gridforge.scenario.run import run_all
from gridforge.thermal.constraints import _cdu_host, cdu_capacity

INTAKE = Path(__file__).resolve().parent.parent / "examples" / "intake"
HALLS = ("reference_hall", "dublin_hall", "london_hall", "nordic_hall")


def _doc(name: str) -> dict:
    return json.loads((INTAKE / f"{name}.json").read_text())


def _fingerprint(doc: dict) -> list:
    """Every number and name a customer is shown that the plant's listing could move: racks as found and unlocked, the binding constraints, the
    capex total and relief, the date, and each step of the plan with its price, quantity and scope."""
    it = load_document(copy.deepcopy(doc))
    out = []
    for r in run_all(it.context, it.scenarios):
        t = schedule(r.ladder)
        out.append((
            r.spec.id, r.envelope.max_racks, r.envelope.binding.id, r.unlocked_racks, r.ladder.final.binding.id,
            r.economics.capex_total_eur.value, r.economics.capex_relief_eur.value, t.weeks_to_full, r.ladder.critical_path_weeks,
            tuple((s.binding_id, s.racks_before, s.racks_after, s.capex_eur.value if s.capex_eur is not None else None, s.quantity,
                   s.quantity_unit, s.scope) for s in r.ladder.taken_steps)))
    return out


def _ups_doc(doc: dict, units: int, parts: int, rating: float = 1200.0, redundancy: str = "N") -> dict:
    """The same UPS plant (units x rating, redundancy ``redundancy`` per block) listed as ``parts`` equal blocks."""
    d = copy.deepcopy(doc)
    per = units // parts
    assert per * parts == units
    d["ups"] = [{"id": f"UPS-{i + 1}", "unit_rating_kW": rating, "units": per, "redundancy": redundancy, "step_load_capability": 0.5}
                for i in range(parts)]
    return d


def _tx_doc(doc: dict, units: int, parts: int, lead: float = 160) -> dict:
    d = copy.deepcopy(doc)
    per = units // parts
    d["transformers"] = [{"id": f"TX-{i + 1}", "unit_rating_MVA": 5.0, "units": per, "redundancy": "N", "derating_factor": 0.9,
                          "replacement_lead_time_weeks": lead} for i in range(parts)]
    return d


def _cdu_doc(doc: dict, units: int, parts: int, redundancy: str = "N") -> dict:
    d = copy.deepcopy(doc)
    per = units // parts
    d["thermal"]["cdus"] = [{"id": f"CDU-{i + 1}", "rated_capacity_kW": 1350, "rated_approach_K": 5, "rated_flow_l_per_min": 2000, "units": per,
                             "redundancy": redundancy} for i in range(parts)]
    return d


# ============================================================================================================================
# the audit's own numbers
# ============================================================================================================================
class TestTheAuditCases:
    def test_the_same_ups_plant_listed_as_one_two_or_six_blocks_costs_the_same(self):
        base = _doc("reference_hall")
        base["scenarios"] = ["hybrid_dlc"]
        seen = {}
        for parts in (1, 2, 6):
            fp = _fingerprint(_ups_doc(base, 6, parts))
            seen[parts] = (fp[0][1], fp[0][3], fp[0][5])
        assert seen[1] == seen[2] == seen[6]
        assert seen[1] == (0, 26, 5_858_000.0)          # racks 0 -> 26; the 1-block figure the audit measured, which the old engine also gave

    def test_a_zero_unit_ups_block_does_not_reprice_the_step(self):
        base = _doc("dublin_hall")
        base["scenarios"] = ["hybrid_dlc"]
        empty = copy.deepcopy(base)
        empty["ups"].append(dict(base["ups"][0], id="UPS-EMPTY", units=0))
        a, b = _fingerprint(base)[0], _fingerprint(empty)[0]
        assert a == b
        assert a[3] == 22 and a[5] == 3_718_000.0
        ups_step = next(s for s in a[-1] if s[0] == "ups_capacity")
        assert ups_step[3:5] == (768_000.0, 2400.0)      # 2 modules x 1200 kW = 2,400 kW at 320 EUR/kW, not 4,800 kW

    def test_an_empty_cdu_bank_does_not_double_the_step(self):
        base = _cdu_doc(_doc("reference_hall"), 3, 1, "N+1")
        base["scenarios"] = ["hybrid_dlc"]
        empty = copy.deepcopy(base)
        empty["thermal"]["cdus"].append(dict(base["thermal"]["cdus"][0], id="CDU-EMPTY", units=0))
        a, b = _fingerprint(base)[0], _fingerprint(empty)[0]
        assert a == b
        cdu = [s for s in a[-1] if s[0] == "cdu_capacity"]
        assert cdu and all(s[5] == "unit" and s[4] == 1.0 for s in cdu)

    @pytest.mark.parametrize("hall", ("reference_hall", "dublin_hall", "nordic_hall"))
    def test_a_zero_unit_transformer_bank_does_not_set_the_date(self, hall):
        base = _doc(hall)
        base["scenarios"] = ["hybrid_dlc"]
        for lead in (None, 300, 500):
            d = copy.deepcopy(base)
            empty = {"id": "TX-EMPTY", "unit_rating_MVA": 5.0, "units": 0, "redundancy": "N"}
            if lead is not None:
                empty["replacement_lead_time_weeks"] = lead
            d["transformers"].append(empty)
            assert _fingerprint(d) == _fingerprint(base)
        it = load_document(copy.deepcopy(d))
        r = run_all(it.context, it.scenarios)[0]
        assert schedule(r.ladder).weeks_to_full == 160.0
        rec = date_record(r.ladder, document=d)
        assert rec["lead_time_source"] == "customer_supplied_unverified"        # the document's empty bank is skipped here too, not "not determined"


# ============================================================================================================================
# split and merge identical banks, on all four halls
# ============================================================================================================================
def _relief_on_plan(rows: list, binding_id: str) -> bool:
    return any(step[0] == binding_id for row in rows for step in row[-1])


@pytest.mark.parametrize("hall", HALLS)
class TestTheSamePhysicalPlantListedAsOneOrManyBanks:
    """Each plant is sized so that its relief is on the plan (the premise is asserted: a property that holds because the relief never fires proves
    nothing). London's own plan never needs a CDU or transformer step at any size tried, so for it only equality is asserted."""

    def test_ups(self, hall):
        base, on_plan = _doc(hall), False
        for units, splits in ((3, (1, 3)), (6, (1, 2, 3, 6))):
            ref = _fingerprint(_ups_doc(base, units, 1))
            on_plan = on_plan or _relief_on_plan(ref, "ups_capacity")
            for parts in splits[1:]:
                assert _fingerprint(_ups_doc(base, units, parts)) == ref, (hall, units, parts)
        assert on_plan

    def test_a_ups_block_under_n_plus_one_is_a_different_plant_when_split(self, hall):
        """The spare is per block: 12 modules under N+1 in one block is 11 usable, in two blocks it is 10. Only the listing of ONE plant is stable."""
        base = _doc(hall)
        assert _fingerprint(_ups_doc(base, 12, 1, redundancy="N+1")) == _fingerprint(_ups_doc(base, 12, 1, redundancy="N+1"))

    def test_transformers(self, hall):
        base = _doc(hall)
        ref = _fingerprint(_tx_doc(base, 2, 1))
        assert _fingerprint(_tx_doc(base, 2, 2)) == ref, hall
        assert hall == "london_hall" or _relief_on_plan(ref, "transformer_capacity")

    def test_cdus(self, hall):
        base, on_plan = _doc(hall), False
        for units, splits in ((2, (1, 2)), (3, (1, 3)), (6, (1, 2, 3, 6))):
            ref = _fingerprint(_cdu_doc(base, units, 1))
            on_plan = on_plan or _relief_on_plan(ref, "cdu_capacity")
            for parts in splits[1:]:
                assert _fingerprint(_cdu_doc(base, units, parts)) == ref, (hall, units, parts)
        assert hall == "london_hall" or on_plan

    def test_all_three_at_once(self, hall):
        base = _doc(hall)
        ref = _fingerprint(_cdu_doc(_tx_doc(_ups_doc(base, 3, 1), 2, 1), 2, 1))
        assert _fingerprint(_cdu_doc(_tx_doc(_ups_doc(base, 3, 3), 2, 2), 2, 2)) == ref, hall


@pytest.mark.parametrize("hall", HALLS)
class TestAnEmptyBankChangesNothing:
    def test_a_zero_unit_ups_block_transformer_bank_and_cdu_bank(self, hall):
        base = _cdu_doc(_doc(hall), 6, 1)
        base["ups"] = base.get("ups") or [{"id": "UPS-1", "unit_rating_kW": 1200, "units": 6, "redundancy": "N", "step_load_capability": 0.5}]
        ref = _fingerprint(base)
        for lead in (None, 300, 500):
            d = copy.deepcopy(base)
            tx = {"id": "TX-EMPTY", "unit_rating_MVA": 500.0, "units": 0, "redundancy": "N"}
            if lead is not None:
                tx["replacement_lead_time_weeks"] = lead
            d["transformers"].insert(0, tx)
            d["ups"].insert(0, {"id": "UPS-EMPTY", "unit_rating_kW": 19000, "units": 0, "redundancy": "2N", "step_load_capability": 0.5})
            d["thermal"]["cdus"].insert(0, {"id": "CDU-EMPTY", "rated_capacity_kW": 19000, "rated_approach_K": 5, "rated_flow_l_per_min": 99000,
                                            "units": 0, "redundancy": "N"})
            assert _fingerprint(d) == ref, (hall, lead)


# ============================================================================================================================
# the rule itself
# ============================================================================================================================
def _ctx(doc: dict) -> EnvelopeContext:
    return load_document(copy.deepcopy(doc)).context


class TestTheHostRule:
    def test_two_modules_in_total_go_into_one_block_whatever_the_listing_order(self):
        base = _doc("dublin_hall")
        blocks = [{"id": "U-A", "unit_rating_kW": 1800, "units": 4, "redundancy": "N", "step_load_capability": 0.5},
                  {"id": "U-B", "unit_rating_kW": 1200, "units": 5, "redundancy": "N", "step_load_capability": 0.5},
                  {"id": "U-C", "unit_rating_kW": 900, "units": 8, "redundancy": "N", "step_load_capability": 0.5}]
        results = set()
        for perm in itertools.permutations(blocks):
            d = copy.deepcopy(base)
            d["ups"] = list(perm)
            ctx = _ctx(d)
            relief = ups_capacity(ctx).relief
            after = relief.apply(ctx)
            before_units = {u.id: u.units for u in ctx.power.ups}
            added = {u.id: u.units - before_units[u.id] for u in after.power.ups}
            assert sum(added.values()) == UPS_MODULES_PER_RELIEF and max(added.values()) == 2
            results.add((tuple(sorted(added.items())), relief.capex_eur.value, relief.quantity, relief.scope))
        assert len(results) == 1
        (added, capex, quantity, scope), = results
        assert dict(added)["U-A"] == 2                           # the biggest module carries the most usable kW per rung
        assert quantity == 3600.0 and capex == 3600.0 * 320 and scope == "3,600 kW added"

    def test_the_step_says_the_rule(self):
        ctx = _ctx(_ups_doc(_doc("dublin_hall"), 6, 3))
        note = ups_capacity(ctx).relief.basis_note
        assert "2 modules in total" in note and "one block" in note and "listed as one block or as several is priced and dated the same" in note
        assert "ignored" in note
        cctx = _ctx(_cdu_doc(_doc("dublin_hall"), 6, 3))
        cctx.architecture = type(cctx.architecture).HYBRID_DLC
        cnote = cdu_capacity(cctx).relief.basis_note
        assert "in total" in cnote and "one bank" in cnote and "same CDUs listed as one bank or as several are priced the same" in cnote

    def test_redundancy_decides_which_block_gains_most(self):
        """Two modules under 2N make one usable, under N two: the N block gains more kW per rung even though its module is smaller."""
        d = _doc("dublin_hall")
        d["ups"] = [{"id": "U-2N", "unit_rating_kW": 1800, "units": 4, "redundancy": "2N", "step_load_capability": 0.5},
                    {"id": "U-N", "unit_rating_kW": 1200, "units": 4, "redundancy": "N", "step_load_capability": 0.5}]
        assert _ups_host(_ctx(d).power.ups).id == "U-N"
        d["ups"][1]["unit_rating_kW"] = 800
        assert _ups_host(_ctx(d).power.ups).id == "U-2N"          # 1 x 1800 kW now beats 2 x 800 kW

    def test_identical_blocks_choose_by_id_not_by_position(self):
        d = _ups_doc(_doc("dublin_hall"), 6, 3)
        for perm in itertools.permutations(d["ups"]):
            dd = copy.deepcopy(d)
            dd["ups"] = list(perm)
            assert _ups_host(_ctx(dd).power.ups).id == "UPS-1"

    def test_an_empty_block_is_never_the_host_and_is_not_touched(self):
        d = _ups_doc(_doc("dublin_hall"), 6, 1)
        d["ups"].insert(0, {"id": "AAA-EMPTY", "unit_rating_kW": 20000, "units": 0, "redundancy": "N", "step_load_capability": 0.5})
        ctx = _ctx(d)
        # Through the loader (one live block beside an empty one) the empty block is ignored with a named warning, so it never reaches the solver...
        assert [u.id for u in ctx.power.ups] == ["UPS-1"]
        assert [u.id for u in active_banks(ctx.power.ups)] == ["UPS-1"]
        assert _ups_host(ctx.power.ups).id == "UPS-1"
        after = ups_capacity(ctx).relief.apply(ctx)
        assert [(u.id, u.units) for u in after.power.ups] == [("UPS-1", 8)]
        # ...and the solver, handed an empty block directly (a programmatic context, a stored state), still never hosts it and never touches it.
        from gridforge.common import CUSTOMER, V
        empty = copy.deepcopy(ctx.power.ups[0])
        empty.id, empty.units, empty.unit_rating_kW = "AAA-EMPTY", 0, V(20000, "kW", "AAA-EMPTY module rating", CUSTOMER)
        ctx.power.ups.insert(0, empty)
        assert [u.id for u in active_banks(ctx.power.ups)] == ["UPS-1"]
        assert _ups_host(ctx.power.ups).id == "UPS-1"
        after = ups_capacity(ctx).relief.apply(ctx)
        assert [(u.id, u.units) for u in after.power.ups] == [("AAA-EMPTY", 0), ("UPS-1", 8)]

    def test_a_list_of_only_empty_banks_is_a_declaration_of_zero_capacity_not_an_unlimited_one(self):
        """Ignoring empty banks must never turn "the client declared nothing but empty banks" into "nothing limits the hall". When no bank has a
        unit the list is kept as declared: the constraint binds at zero (as test_adversarial_intake pins for a transformer bank of 0 units) and the
        relief buys the first modules of the block that gains most. An empty LIST is a different thing: undeclared."""
        d = _doc("dublin_hall")
        d["ups"] = [{"id": "U0", "unit_rating_kW": 1200, "units": 0, "redundancy": "N", "step_load_capability": 0.5},
                    {"id": "U1", "unit_rating_kW": 1800, "units": 0, "redundancy": "N", "step_load_capability": 0.5}]
        d["transformers"] = [{"id": "T0", "unit_rating_MVA": 5.0, "units": 0, "redundancy": "N"}]
        ctx = _ctx(d)
        assert [u.id for u in active_banks(ctx.power.ups)] == ["U0", "U1"]          # nothing live: both stand as declared
        assert ups_capacity(ctx).max_racks.value == 0 and transformer_capacity(ctx).max_racks.value == 0
        host = _ups_host(ctx.power.ups)
        assert host.id == "U1"                                                       # the larger module gains more kW per rung
        after = ups_capacity(ctx).relief.apply(ctx)
        assert {u.id: u.units for u in after.power.ups} == {"U0": 0, "U1": 2}
        assert ladder(ctx).unassessed_banks == ()                                     # declared, so assessed: the plan and its date are complete
        d["ups"], d["transformers"] = [], []
        assert ladder(_ctx(d)).unassessed_banks == ("transformers", "UPS")            # an empty LIST is undeclared, as for an omitted section

    def test_one_further_cdu_unit_in_total_in_the_bank_with_most_heat(self):
        d = _doc("dublin_hall")
        d["thermal"]["cdus"] = [
            {"id": "C-small", "rated_capacity_kW": 900, "rated_approach_K": 5, "rated_flow_l_per_min": 1500, "units": 3, "redundancy": "N+1"},
            {"id": "C-big", "rated_capacity_kW": 1800, "rated_approach_K": 5, "rated_flow_l_per_min": 2500, "units": 2, "redundancy": "N+1"}]
        for perm in itertools.permutations(d["thermal"]["cdus"]):
            dd = copy.deepcopy(d)
            dd["thermal"]["cdus"] = list(perm)
            ctx = _ctx(dd)
            assert _cdu_host(ctx).id == "C-big"
            relief = cdu_capacity(ctx).relief
            after = relief.apply(ctx)
            assert {c.id: c.units for c in after.thermal.cdus} == {"C-small": 3, "C-big": 3}
            assert relief.quantity == 1.0

    def test_under_2n_a_matched_pair_is_one_usable_unit(self):
        d = _doc("dublin_hall")
        d["thermal"]["cdus"] = [{"id": "C-2N", "rated_capacity_kW": 1350, "rated_approach_K": 5, "rated_flow_l_per_min": 2000, "units": 4,
                                 "redundancy": "2N"}]
        ctx = _ctx(d)
        relief = cdu_capacity(ctx).relief
        assert relief.quantity == 2.0
        assert {c.id: c.units for c in relief.apply(ctx).thermal.cdus} == {"C-2N": 6}

    def test_the_ladder_takes_the_same_rungs_whatever_the_listing_order(self):
        base = _ups_doc(_doc("nordic_hall"), 12, 4)
        ref = _fingerprint(base)
        rng = random.Random(7)
        for _ in range(8):
            d = copy.deepcopy(base)
            rng.shuffle(d["ups"])
            assert _fingerprint(d) == ref


# ============================================================================================================================
# banks equally slow: the listing order cannot choose which band or which source the date carries
# ============================================================================================================================
class TestEquallySlowTransformerBanks:
    def _doc_with(self, supplied_first: bool, both_supplied: bool = False) -> dict:
        d = _doc("dublin_hall")
        d["scenarios"] = ["hybrid_dlc"]
        a = {"id": "TX-A", "unit_rating_MVA": 5.0, "units": 1, "redundancy": "N", "derating_factor": 0.9, "replacement_lead_time_weeks": 160}
        b = {"id": "TX-B", "unit_rating_MVA": 5.0, "units": 1, "redundancy": "N", "derating_factor": 0.9}      # no lead time: the library's 160 weeks
        if both_supplied:
            b["replacement_lead_time_weeks"] = 160
        d["transformers"] = [a, b] if supplied_first else [b, a]
        return d

    def test_the_source_and_the_date_interval_do_not_depend_on_the_order(self):
        records = []
        for first in (True, False):
            d = self._doc_with(first)
            it = load_document(copy.deepcopy(d))
            r = run_all(it.context, it.scenarios)[0]
            rec = date_record(r.ladder, document=d)
            records.append((rec["lead_time_source"], rec["date_interval_weeks"], schedule(r.ladder).weeks_to_full))
        assert records[0] == records[1]
        assert records[0][0] == "library_placeholder"          # one of the two equally slow banks is the library's figure, so the date is not the customer's alone
        assert records[0][2] == 160.0

    def test_when_every_equally_slow_bank_is_supplied_the_date_is_the_customers(self):
        for first in (True, False):
            d = self._doc_with(first, both_supplied=True)
            it = load_document(copy.deepcopy(d))
            r = run_all(it.context, it.scenarios)[0]
            assert date_record(r.ladder, document=d)["lead_time_source"] == "customer_supplied_unverified"
