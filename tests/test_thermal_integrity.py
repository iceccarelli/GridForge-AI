"""Thermal input handling and constraint maths: declared inputs are read or said to be ignored, impossible inputs are refused, one
facility-water temperature feeds both constraints that need it, and a defaulted figure is a named gap.

Every expected number is worked by hand in the comment beside it (GB300 NVL72: 135 kW rack, 90% liquid = 121.5 kW liquid, 13.5 kW
residual air, 130 l/min per rack, ASHRAE W45 = 45 degC maximum inlet liquid temperature) and none is read back from the engine. The
shipped intakes are SYNTHETIC; nothing here is calibration.
"""
from __future__ import annotations

import copy
import dataclasses
import json
import math
import random
from pathlib import Path

import pytest

from gridforge.common import ASSUMED, V
from gridforge.constraints import EnvelopeContext
from gridforge.envelope.solver import ladder, solve
from gridforge.intake.loader import IntakeError, _scenario_set, load_document
from gridforge.intake.schema import FIELD_BY_PATH, INTAKE_FIELDS
from gridforge.scenario.run import run
from gridforge.thermal.library import PUE_BY_ARCHITECTURE
from gridforge.thermal.schema import Architecture

ROOT = Path(__file__).resolve().parents[1]
NAMES = ("reference_hall", "dublin_hall", "nordic_hall", "london_hall")
INTAKES = {n: json.loads((ROOT / "examples" / "intake" / f"{n}.json").read_text(encoding="utf-8")) for n in NAMES}
REF = INTAKES["reference_hall"]
ARCHS = (Architecture.RETAINED_AIR, Architecture.RDHX, Architecture.HYBRID_DLC, Architecture.FULL_DLC)
DELETE = object()


def doc(base: dict | None = None, **over) -> dict:
    """A deep copy of ``base`` (default: the reference hall) with dotted-path overrides; ``DELETE`` removes a key."""
    d = copy.deepcopy(REF if base is None else base)
    for path, val in over.items():
        cur = d
        parts = path.split(".")
        for p in parts[:-1]:
            cur = cur.setdefault(p, {})
        if val is DELETE:
            cur.pop(parts[-1], None)
        else:
            cur[parts[-1]] = val
    return d


CDU = {"id": "CDU-1", "rated_capacity_kW": 1350, "rated_approach_K": 5, "units": 3, "redundancy": "N+1"}


def ctx_for(intake, arch: Architecture) -> EnvelopeContext:
    c = intake.context.copy()
    c.architecture = arch
    c.pue = PUE_BY_ARCHITECTURE[arch]
    return c


def by_id(result) -> dict:
    return {c.id: c for c in result.constraints}


def scenario(intake, sid: str):
    return run(intake.context, _scenario_set([sid])[0])


# ============================================================================================================================
# T5  physically impossible TCS and approach figures are refused at load
# ============================================================================================================================
class TestTcsAndApproachBounds:
    def test_a_tcs_target_above_the_platform_maximum_inlet_is_refused_naming_both_numbers_and_w45(self):
        # GB300: max inlet liquid 45 degC (ASHRAE W45, an EQUIPMENT limit). 46 degC supply cannot be delivered to the rack.
        with pytest.raises(IntakeError) as e:
            load_document(doc(**{"thermal.tcs_target_supply_C": 46}))
        msg = str(e.value)
        assert "thermal.tcs_target_supply_C" in msg and "46" in msg and "45" in msg and "W45" in msg
        assert "equipment" in msg.lower()

    @pytest.mark.parametrize("tcs", [46, 50, 60, 80])
    def test_every_tcs_target_above_45_is_refused_for_the_nvl72_racks(self, tcs):
        with pytest.raises(IntakeError, match="W45"):
            load_document(doc(**{"thermal.tcs_target_supply_C": tcs}))

    @pytest.mark.parametrize("tcs", [27, 30, 32, 45])
    def test_a_tcs_target_up_to_and_including_the_maximum_inlet_is_accepted(self, tcs):
        assert load_document(doc(**{"thermal.tcs_target_supply_C": tcs})).context.thermal.tcs_target_supply_C.value == tcs

    def test_the_bound_is_the_chosen_platforms_own_maximum_inlet_not_a_constant(self):
        # generic_dlc_50 is rated to 40 degC inlet in the library: 41 is refused for it and accepted for GB300.
        load_document(doc(**{"thermal.tcs_target_supply_C": 41}))
        with pytest.raises(IntakeError, match="generic_dlc_50"):
            load_document(doc(**{"thermal.tcs_target_supply_C": 41, "compute.platform": "generic_dlc_50"}))

    def test_the_check_runs_when_the_platform_was_not_declared_too(self):
        d = doc(**{"thermal.tcs_target_supply_C": 46, "compute": DELETE})        # default platform (GB300) applies after resolution
        with pytest.raises(IntakeError, match="W45"):
            load_document(d)

    @pytest.mark.parametrize("approach", [0, 0.5, 0.999])
    def test_a_cdu_approach_below_one_kelvin_is_refused_with_a_plausibility_reason(self, approach):
        with pytest.raises(IntakeError) as e:
            load_document(doc(**{"thermal.cdu_approach_K": approach}))
        assert "thermal.cdu_approach_K" in str(e.value) and "1 K" in str(e.value) and "approach" in str(e.value)

    @pytest.mark.parametrize("approach", [0, 0.5])
    def test_a_rated_cdu_approach_below_one_kelvin_is_refused(self, approach):
        with pytest.raises(IntakeError) as e:
            load_document(doc(**{"thermal.cdus": [dict(CDU, rated_approach_K=approach)]}))
        assert "rated_approach_K" in str(e.value) and "1 K" in str(e.value)

    def test_one_kelvin_is_accepted_for_both(self):
        it = load_document(doc(**{"thermal.cdu_approach_K": 1, "thermal.cdus": [dict(CDU, rated_approach_K=1)]}))
        assert it.context.thermal.cdu_approach_K.value == 1 and it.context.thermal.cdus[0].rated_approach_K.value == 1

    def test_the_plausibility_table_has_thermal_entries_for_tcs_and_both_approaches(self):
        from gridforge.intake.loader import PLAUSIBLE_MAX
        for key in ("thermal.tcs_target_supply_C", "thermal.cdu_approach_K", "thermal.cdus.rated_approach_K"):
            assert key in PLAUSIBLE_MAX, key
        with pytest.raises(IntakeError, match="stray digit"):
            load_document(doc(**{"thermal.cdu_approach_K": 5000}))
        with pytest.raises(IntakeError, match="stray digit"):
            load_document(doc(**{"thermal.tcs_target_supply_C": 4000}))
        with pytest.raises(IntakeError, match="stray digit"):
            load_document(doc(**{"thermal.cdus": [dict(CDU, rated_approach_K=5000)]}))

    def test_the_library_defaults_still_load(self):
        # TCS 30 degC and a 5 K approach are the library figures: omitting both must not trip the new bounds.
        it = load_document(doc(**{"thermal.tcs_target_supply_C": DELETE, "thermal.cdu_approach_K": DELETE}))
        assert it.context.thermal.tcs_target_supply_C.value == 30 and it.context.thermal.cdu_approach_K.value == 5


# ============================================================================================================================
# T6a  a declared CDU flow is a limit; an undeclared one is not, and is a named gap
# ============================================================================================================================
def _hybrid(d):
    it = load_document(d)
    return it, by_id(solve(ctx_for(it, Architecture.HYBRID_DLC)))


class TestCduFlowLimit:
    @pytest.mark.parametrize("flow, racks", [
        (2000, 22),     # 2 usable (3 units N+1) x 2000 = 4000 l/min / 130 = 30.8 -> 30 racks of flow: not binding, heat gives 22
        (200, 3),       # 2 x 200 = 400 / 130 = 3.08 -> 3
        (20, 0),        # 2 x 20 = 40 / 130 = 0.31 -> 0
        (1, 0),         # the audit repro: 22 racks from a CDU that moves 1 l/min
    ])
    def test_a_declared_rated_flow_limits_the_cdu_bank(self, flow, racks):
        _it, c = _hybrid(doc(**{"thermal.cdus": [dict(CDU, rated_flow_l_per_min=flow)]}))
        assert c["cdu_capacity"].racks == racks
        if flow < 2000:
            assert "flow" in c["cdu_capacity"].basis.lower()

    def test_usable_units_are_counted_exactly_as_the_heat_limit_counts_them(self):
        # 3 units: N -> 3 x 1000 = 3000 / 130 = 23 (heat 3 x 1350 / 121.5 = 33 -> flow binds); N+1 -> 2 x 1000 / 130 = 15;
        # N+2 -> 1 x 1000 / 130 = 7; 2N -> 3 // 2 = 1 usable -> 7.
        for red, expect in (("N", 23), ("N+1", 15), ("N+2", 7), ("2N", 7)):
            _it, c = _hybrid(doc(**{"thermal.cdus": [dict(CDU, rated_flow_l_per_min=1000, redundancy=red)]}))
            assert c["cdu_capacity"].racks == expect, red

    def test_an_undeclared_flow_adds_no_limit_and_changes_nothing(self):
        _it, with_flow = _hybrid(doc(**{"thermal.cdus": [dict(CDU, rated_flow_l_per_min=100000)]}))
        it, without = _hybrid(doc(**{"thermal.cdus": [dict(CDU)]}))
        assert without["cdu_capacity"].racks == with_flow["cdu_capacity"].racks == 22        # 2 usable x 1350 kW / 121.5 kW
        assert "flow" not in without["cdu_capacity"].basis.lower()
        gap = next(g for g in it.report.gaps if g.path == "thermal.cdus.rated_flow_l_per_min")
        assert not gap.required and "no CDU flow limit" in gap.fallback_description

    def test_existing_fixtures_declaring_2000_l_per_min_do_not_move(self):
        # Every shipped declaration of a 2000 l/min CDU keeps its count: the flow limit (30 racks for 2 usable units) is above the heat limit (22).
        for n_units, red in ((3, "N+1"), (2, "N+1"), (3, "N")):
            with_flow = _hybrid(doc(**{"thermal.cdus": [dict(CDU, units=n_units, redundancy=red, rated_flow_l_per_min=2000)]}))[1]
            without = _hybrid(doc(**{"thermal.cdus": [dict(CDU, units=n_units, redundancy=red)]}))[1]
            assert with_flow["cdu_capacity"].racks == without["cdu_capacity"].racks, (n_units, red)

    def test_the_flow_limit_carries_the_weakest_evidence_of_its_inputs(self):
        # platform flow per rack is a library figure (E0), so a flow-limited count can be no better than E0.
        _it, c = _hybrid(doc(**{"thermal.cdus": [dict(CDU, rated_flow_l_per_min=200)]}))
        assert int(c["cdu_capacity"].max_racks.evidence) == 0

    def test_one_cdu_without_a_declared_flow_means_the_bank_flow_is_not_assessed(self):
        # Summing only the declared flows would UNDERSTATE the bank's flow and refuse racks it can carry: no limit, and the gap says why.
        two = [dict(CDU, id="A", units=2, rated_flow_l_per_min=1), dict(CDU, id="B", units=2)]
        it, c = _hybrid(doc(**{"thermal.cdus": two}))
        assert c["cdu_capacity"].racks == 22        # heat only: two banks of 2 units at N+1 = 2 usable x 1350 kW / 121.5 kW
        assert any(g.path == "thermal.cdus.rated_flow_l_per_min" for g in it.report.gaps)

    def test_a_declared_flow_is_not_a_gap(self):
        it, _c = _hybrid(doc(**{"thermal.cdus": [dict(CDU, rated_flow_l_per_min=2000)]}))
        assert "thermal.cdus.rated_flow_l_per_min" not in [g.path for g in it.report.gaps]
        assert "thermal.cdus.rated_flow_l_per_min" in it.report.supplied


# ============================================================================================================================
# T6c  an omitted CDU rated approach is a named OPTIONAL gap, outside the completeness ratio
# ============================================================================================================================
class TestOmittedRatedApproach:
    def test_omitted_it_is_5_k_with_a_named_optional_gap(self):
        no_approach = {k: v for k, v in CDU.items() if k != "rated_approach_K"}
        it = load_document(doc(**{"thermal.cdus": [no_approach]}))
        assert it.context.thermal.cdus[0].rated_approach_K.value == 5
        gap = next(g for g in it.report.gaps if g.path == "thermal.cdus.rated_approach_K")
        assert gap.required is False
        assert gap.fallback_description == "5 K assumed (library, E0)"
        assert gap.why_it_binds and gap.how_to_get_it

    def test_declared_it_is_no_gap_and_is_the_clients_figure(self):
        it = load_document(doc(**{"thermal.cdus": [dict(CDU, rated_approach_K=8)]}))
        assert "thermal.cdus.rated_approach_K" not in [g.path for g in it.report.gaps]
        assert it.context.thermal.cdus[0].rated_approach_K.value == 8

    def test_the_gap_does_not_move_completeness(self):
        no_approach = {k: v for k, v in CDU.items() if k != "rated_approach_K"}
        a = load_document(doc(**{"thermal.cdus": [no_approach]})).report.completeness
        b = load_document(doc(**{"thermal.cdus": [dict(CDU, rated_approach_K=5)]})).report.completeness
        assert a == b
        assert not FIELD_BY_PATH["thermal.cdus.rated_approach_K"].counts_toward_completeness
        assert not FIELD_BY_PATH["thermal.cdus.rated_approach_K"].required


# ============================================================================================================================
# T7  one facility-water temperature for the CDU derate and the TCS gate
# ============================================================================================================================
def _dlc_ctx(*, drybulb=15.0, dry_cooler_approach=10.0, cdu_rated=8.0, tcs_approach=5.0, arch=Architecture.FULL_DLC):
    it = load_document(doc(**{"site.design_drybulb_C": drybulb, "thermal.cdu_approach_K": tcs_approach,
                              "thermal.cdus": [dict(CDU, rated_approach_K=cdu_rated)]}))
    c = ctx_for(it, arch)
    c.thermal.plant.dry_cooler_approach_K = V(dry_cooler_approach, "K", "assumed dry cooler approach", ASSUMED)
    return c


class TestOneFacilityWaterTemperature:
    def test_the_audit_repro_full_dlc_derates_against_the_dry_cooler_water_not_the_legacy_plant(self):
        # Dry bulb 15 + dry-cooler approach 10 = 25 degC facility water. TCS target 30 -> 5 K available; CDU rated at 8 K approach:
        # ratio 5 / 8 = 0.625; 2 usable units x 1350 kW x 0.625 = 1687.5 kW / 121.5 kW per rack = 13.9 -> 13 racks.
        c = _dlc_ctx()
        r = by_id(solve(c))
        assert r["cdu_capacity"].racks == 13
        assert r["tcs_supply_achievable"].racks == math.inf           # 25 <= 30 - 5: the gate passes at exactly the limit
        assert "; 24 " not in r["cdu_capacity"].basis                  # the legacy 6 degC plant would have printed a 24 K approach
        assert " 5 [" in r["cdu_capacity"].basis or "; 5 " in r["cdu_capacity"].basis

    def test_the_two_constraints_read_the_same_temperature_through_the_public_helper(self):
        from gridforge.thermal.constraints import facility_water_supply
        c = _dlc_ctx()
        fws = facility_water_supply(c)
        assert fws.temperature.value == 25.0 and fws.source == "dry_coolers"
        assert "dry coolers" in fws.mechanism
        assert fws.temperature.unit == "degC"

    def test_the_cdu_derate_follows_the_dry_bulb_in_full_dlc(self):
        # FWS 20 (dry bulb 10): 10 K available >= rated 8 K -> full rating: 2 x 1350 / 121.5 = 22.2 -> 22.
        assert by_id(solve(_dlc_ctx(drybulb=10.0)))["cdu_capacity"].racks == 22
        # FWS 27 (dry bulb 17): 3 K available -> ratio 0.375: 2 x 1350 x 0.375 / 121.5 = 8.3 -> 8 (the TCS gate fails at 27 > 25).
        assert by_id(solve(_dlc_ctx(drybulb=17.0)))["cdu_capacity"].racks == 8

    def test_hybrid_and_the_other_architectures_still_read_the_legacy_plant_supply(self):
        from gridforge.thermal.constraints import facility_water_supply
        for arch in (Architecture.HYBRID_DLC, Architecture.RDHX, Architecture.RETAINED_AIR):
            c = _dlc_ctx(arch=arch)
            fws = facility_water_supply(c)
            assert fws.source == "existing_plant" and fws.temperature.value == c.thermal.plant.design_supply_C.value, arch
        # and a full-DLC context with no dry-cooler approach declared is the existing plant too
        c = _dlc_ctx()
        c.thermal.plant.dry_cooler_approach_K = None
        assert facility_water_supply(c).source == "existing_plant"

    def test_a_proposed_trim_chiller_gives_both_constraints_the_plant_supply_temperature(self):
        from gridforge.thermal.constraints import facility_water_supply
        c = _dlc_ctx(drybulb=34.0)                      # FWS 44: hopeless for dry coolers
        c.thermal.trim_chiller_installed = True
        fws = facility_water_supply(c)
        assert fws.source == "trim_chiller" and fws.temperature.value == c.thermal.plant.design_supply_C.value == 6.0
        r = by_id(solve(c))
        assert r["cdu_capacity"].racks == 22 and r["tcs_supply_achievable"].racks == math.inf

    def test_no_approach_available_defers_to_the_water_temperature_gate_instead_of_stalling_the_ladder(self):
        # Dry bulb 34 + 10 K = 44 degC water against a 30 degC TCS target: the CDU has no approach at all and the gate is already 0.
        # Two zero-rack constraints tie; the first in evaluation order is "binding", and adding CDU units cannot help it, so the plan
        # would stop at zero racks with the trim chiller (the only relief) never reached. The CDU row says so and the gate is binding.
        c = _dlc_ctx(drybulb=34.0)
        r = solve(c)
        rows = by_id(r)
        assert rows["tcs_supply_achievable"].racks == 0
        assert rows["cdu_capacity"].racks == math.inf
        assert "tcs_supply_achievable" in rows["cdu_capacity"].basis and "not assessed" in rows["cdu_capacity"].basis
        assert rows["cdu_capacity"].relief is not None           # the CDU kit's lead time is still read from this relief
        lad = ladder(c)
        assert lad.final.max_racks > 0 and any(s.binding_id == "tcs_supply_achievable" and s.taken for s in lad.steps)

    def test_a_cdu_with_no_approach_is_still_zero_when_the_gate_is_not_what_holds_the_hall(self):
        # Hybrid on a declared legacy plant at 31 degC (TCS 30): the existing, unchanged behaviour is a real zero.
        it = load_document(doc(**{"thermal.plant.design_supply_C": 31, "thermal.plant.design_return_C": 37,
                                  "thermal.cdus": [dict(CDU)]}))
        r = by_id(solve(ctx_for(it, Architecture.HYBRID_DLC)))
        assert r["cdu_capacity"].racks == 0

    def test_only_full_dlc_results_move_across_the_four_examples_and_four_architectures(self):
        before = json.loads((ROOT / "tests" / "golden_thermal_pre_integrity.json").read_text(encoding="utf-8"))
        moved: dict[str, list[str]] = {}
        for name in NAMES:
            intake = load_document(INTAKES[name])
            for sid in ("retained_air", "rdhx", "hybrid_dlc", "full_dlc", "full_dlc_btm"):
                res = scenario(intake, sid)
                snap = before[f"{name}/{sid}"]
                now = {c.id: c.racks for c in res.envelope.constraints}
                diffs = []
                for cid, was in snap["constraints"].items():
                    was_racks = math.inf if was["racks"] == "inf" else was["racks"]
                    if now[cid] != was_racks:
                        diffs.append(f"{cid}: {was_racks} -> {now[cid]}")
                steps = [[s.binding_id, s.racks_before, s.racks_after, s.taken] for s in res.ladder.steps]
                if sid in ("retained_air", "rdhx", "hybrid_dlc"):
                    assert not diffs, (name, sid, diffs)
                else:
                    # full DLC: the as-found CDU row may move (the water is the dry coolers', not the legacy plant's) and nothing else may.
                    assert all(d.startswith("cdu_capacity") for d in diffs), (name, sid, diffs)
                    moved[f"{name}/{sid}"] = diffs
                # and no answer moves: the as-found count, the plan and its racks are the ones recorded before the change
                assert res.envelope.max_racks == snap["as_found_racks"] and res.unlocked_racks == snap["unlocked"], (name, sid)
                assert steps == [s[:4] for s in snap["steps"]], (name, sid)
        # the four shipped halls all sit at dry bulb + 10 K above the 30 degC target, so the CDU row defers in every full-DLC scenario
        assert len(moved) == 8 and all(moved.values())


# ============================================================================================================================
# T6b  declared figures that nothing reads, and keys that are not inputs, are said to be ignored
# ============================================================================================================================
SCENARIO_IDS = ("retained_air", "rdhx", "hybrid_dlc", "full_dlc", "full_dlc_btm")


def _racks_by_scenario(d: dict) -> dict:
    it = load_document(d)
    return {sid: {c.id: c.racks for c in scenario(it, sid).envelope.constraints} for sid in SCENARIO_IDS}


def _example_doc(name: str, **over) -> dict:
    return doc(INTAKES[name], **over)


class TestIgnoredInputsAreWarnedAbout:
    def test_the_audit_repro_every_ignored_key_is_refused_and_named(self):
        """The audit found keys that were accepted and ignored with no word. The intake's own key allow-list (E2) now REFUSES each one
        and names it, which is stronger than the warning this test first asked for: a key the engine does not read changes nothing,
        and a study must not run on the library default in its place."""
        cases = [("thermal.plant", "max_hot_day_derate", 0.7), ("site", "water_available", False), ("thermal", "pump_redundancy", "N")]
        for block, key, value in cases:
            d = doc()
            cur = d
            for part in block.split("."):
                cur = cur[part]
            cur[key] = value
            with pytest.raises(IntakeError) as err:
                load_document(d)
            assert f"{block}.{key}" in str(err.value) and "not an input" in str(err.value), (block, key, str(err.value)[:160])
        d = doc()
        d["thermal"]["cdus"] = [{"id": "C", "rated_capacity_kW": 1350, "units": 3, "rated_flow_l_per_min": 5, "pump_redundancy": "N+1"}]
        with pytest.raises(IntakeError) as err:
            load_document(d)
        assert "pump_redundancy" in str(err.value) and "not an input" in str(err.value)

    def test_each_declared_figure_nothing_reads_has_its_own_named_warning(self):
        from gridforge.thermal.library import UNREAD_THERMAL_INPUTS
        w = load_document(doc()).report.warnings       # the reference hall declares all four
        for path in UNREAD_THERMAL_INPUTS:
            assert sum(1 for x in w if x.startswith(path + " was declared, but no constraint reads it")) == 1, path

    def test_a_figure_that_was_not_declared_draws_no_warning(self):
        from gridforge.thermal.library import UNREAD_THERMAL_INPUTS
        d = doc(**{p: DELETE for p in UNREAD_THERMAL_INPUTS})
        w = load_document(d).report.warnings
        assert not [x for x in w if any(x.startswith(p) for p in UNREAD_THERMAL_INPUTS)]

    def test_a_clean_thermal_section_draws_no_ignored_key_warning(self):
        assert not [x for x in load_document(doc()).report.warnings if "not an input this engine reads" in x]

    def test_an_unknown_site_or_hall_key_is_refused_whether_or_not_it_sounds_like_cooling(self):
        """The first version of this check warned only about cooling- or water-sounding keys and let the rest pass. With the key
        allow-list in force every unknown site or hall key is refused and named, so there is no key left to be silently ignored."""
        for key, value in (("site.latitude", 50.1), ("hall.cooling_loop", "x"), ("hall.tenant_notes", "x")):
            with pytest.raises(IntakeError) as err:
                load_document(doc(**{key: value}))
            assert key in str(err.value), key
    def test_the_table_of_unread_inputs_is_what_the_constraints_really_do(self):
        """Derived from behaviour, not from a reading of the code: across all four shipped intakes and all five scenarios, moving an unread figure
        from one value to a very different one moves no constraint, while moving each other thermal figure moves at least one."""
        from gridforge.thermal.library import UNREAD_THERMAL_INPUTS
        unread = {"thermal.plant.available_head_kPa": (100, 900), "thermal.plant.free_cooling_hours_per_year": (1000, 8000),
                  "thermal.plant.design_return_C": (40, 55), "site.design_wetbulb_C": (15, 30)}
        assert set(unread) == set(UNREAD_THERMAL_INPUTS)
        for path, (lo, hi) in unread.items():
            for name in NAMES:
                a = _racks_by_scenario(_example_doc(name, **{path: lo}))
                b = _racks_by_scenario(_example_doc(name, **{path: hi}))
                assert a == b, (path, name)

    @pytest.mark.parametrize("path, lo, hi, extra", [
        ("thermal.plant.chilled_water_capacity_kW", 3000, 12000, {}),
        ("thermal.plant.design_supply_C", 8, 28, {"thermal.plant.design_return_C": 40}),
        ("thermal.plant.pump_flow_capacity_l_per_min", 2000, 20000, {}),
        ("thermal.plant.existing_flow_l_per_min", 500, 1900, {"thermal.plant.pump_flow_capacity_l_per_min": 2000}),
        ("thermal.plant.existing_non_it_heat_kW", 100, 1000, {}),
        ("thermal.plant.dry_cooler_capacity_kW", 1000, 20000, {}),
        ("thermal.tcs_target_supply_C", 28, 35, {}),
        # plant water at 24 degC against a 30 degC target: a 3 K approach needs 27 degC or colder (passes), an 8 K approach 22 (fails)
        ("thermal.cdu_approach_K", 3, 8, {"thermal.plant.design_supply_C": 24, "thermal.plant.design_return_C": 30}),
        ("thermal.residual_air_capacity_kW_per_rack", 5, 30, {}),
        ("thermal.rdhx.capacity_kW_per_rack", 100, 200, {}),
        ("thermal.cdus", [dict(CDU, rated_capacity_kW=300)], [dict(CDU, rated_capacity_kW=3000)], {}),
        ("thermal.cdus", [dict(CDU, rated_flow_l_per_min=50)], [dict(CDU, rated_flow_l_per_min=5000)], {}),
        ("thermal.cdus", [dict(CDU, rated_approach_K=2)], [dict(CDU, rated_approach_K=20)], {"thermal.plant.design_supply_C": 24,
                                                                                            "thermal.plant.design_return_C": 30}),
    ])
    def test_every_other_thermal_figure_moves_at_least_one_constraint_somewhere(self, path, lo, hi, extra):
        moved = False
        for name in NAMES:
            a = _racks_by_scenario(_example_doc(name, **{path: lo}, **extra))
            b = _racks_by_scenario(_example_doc(name, **{path: hi}, **extra))
            moved = moved or a != b
        assert moved, path

    def test_the_known_keys_are_exactly_the_ones_the_loader_reads(self):
        import re
        from gridforge.thermal.library import KNOWN_THERMAL_KEYS
        src = (ROOT / "gridforge" / "intake" / "loader.py").read_text(encoding="utf-8")
        literals = set(re.findall(r'"(thermal\.[A-Za-z_.]+)"', src))
        assert literals
        for p in literals:                      # every thermal path the loader reads is a known key (else it would be reported as ignored)
            section, _, key = p.rpartition(".")
            assert section in KNOWN_THERMAL_KEYS and key in KNOWN_THERMAL_KEYS[section], p
        for section, keys in KNOWN_THERMAL_KEYS.items():      # and every known key is one the loader mentions (else it would be silently dropped)
            for key in keys:
                assert key in src, (section, key)


# ============================================================================================================================
# T6d  pumps that cannot move the existing hall's heat: a warning, never a number
# ============================================================================================================================
class TestPlantHeatBalanceWarning:
    def test_the_reference_hall_is_warned_with_its_own_numbers_and_the_field_that_fixes_it(self):
        # 9,000 l/min x 0.997 kg/l x 4.19 kJ/kg/K x 6 K / 60 = 3,760 kW, against 4,900 kW of existing IT load.
        w = [x for x in load_document(doc()).report.warnings if x.startswith("thermal.plant.pump_flow_capacity_l_per_min")]
        assert len(w) == 1
        for fragment in ("9,000 l/min", "3,760 kW", "4,900 kW", "6 K", "OVERSTATES", "thermal.plant.existing_flow_l_per_min", "TOTAL"):
            assert fragment in w[0], fragment

    def test_it_changes_no_number(self):
        it = load_document(doc())
        c = by_id(solve(ctx_for(it, Architecture.HYBRID_DLC)))
        assert c["hydraulic_flow"].racks == 69                               # 9,000 / 130, as before

    def test_declaring_the_existing_flow_removes_the_warning(self):
        w = load_document(doc(**{"thermal.plant.existing_flow_l_per_min": 3000})).report.warnings
        assert not [x for x in w if x.startswith("thermal.plant.pump_flow_capacity_l_per_min")]

    def test_pumps_that_can_carry_the_existing_hall_draw_no_warning(self):
        for name in ("dublin_hall", "nordic_hall"):      # 7,798 kW and 15,317 kW against 4,200 and 5,500 kW
            w = load_document(INTAKES[name]).report.warnings
            assert not [x for x in w if x.startswith("thermal.plant.pump_flow_capacity_l_per_min")], name

    def test_a_placeholder_pump_flow_is_not_compared_with_anything(self):
        # london_hall gives no pump flow: the 7,000 l/min is the library placeholder, already a named gap.
        w = load_document(INTAKES["london_hall"]).report.warnings
        assert not [x for x in w if x.startswith("thermal.plant.pump_flow_capacity_l_per_min")]


# ============================================================================================================================
# T9  defaults printed as facts become named optional gaps
# ============================================================================================================================
FIVE = {
    "thermal.plant.available_head_kPa": "250 kPa assumed (library, E0)",
    "thermal.plant.free_cooling_hours_per_year": "2,500 h assumed (library, E0)",
    "hall.containment": "cold aisle assumed (library, E0)",
    "hall.floor_type": "raised floor assumed (library, E0)",
    "hall.build_year": "2015 assumed (library, E0)",
}


class TestOptionalAssumedInputsAreNamedGaps:
    def test_each_omitted_input_is_a_named_optional_gap_with_the_assumed_value(self):
        it = load_document(doc(**{p: DELETE for p in FIVE}))
        by_path = {g.path: g for g in it.report.gaps}
        for path, text in FIVE.items():
            g = by_path[path]
            assert g.fallback_description == text and g.required is False and g.why_it_binds and g.how_to_get_it, path

    def test_supplied_they_are_no_gap_and_count_as_supplied(self):
        it = load_document(doc())                                  # the reference hall supplies all five
        for path in FIVE:
            assert path not in [g.path for g in it.report.gaps], path
            assert path in it.report.supplied, path

    def test_none_of_them_moves_completeness(self):
        for path in FIVE:
            assert not FIELD_BY_PATH[path].counts_toward_completeness and not FIELD_BY_PATH[path].required, path
        a = load_document(doc(**{p: DELETE for p in FIVE})).report.completeness
        b = load_document(doc()).report.completeness
        assert a == b

    def test_they_go_last_in_the_ledger_so_the_first_eight_do_not_move(self):
        thin = {**{p: DELETE for p in FIVE}, "grid.power_factor": DELETE, "lv.voltage_V": DELETE}
        full = [g.path for g in load_document(doc(**{k: v for k, v in thin.items() if k not in FIVE})).report.gaps]
        thin_gaps = [g.path for g in load_document(doc(**thin)).report.gaps]
        assert thin_gaps[:len(full)] == full and set(thin_gaps[len(full):]) == set(FIVE)
        assert thin_gaps[-len(FIVE):] == [p for p in thin_gaps if p in FIVE]

    def test_the_study_says_assumed_beside_an_assumed_hall_figure_and_only_then(self):
        from gridforge.reporting import to_markdown
        from gridforge.reporting.study import build as build_study
        from gridforge.scenario import run_all

        def rows(d):
            it = load_document(d)
            md = to_markdown(build_study(it.context, run_all(it.context, it.scenarios), client="x"))
            return {k: next(line for line in md.splitlines() if line.startswith(f"| {k} |")) for k in ("Built", "Floor", "Containment")}

        for line in rows(doc(**{p: DELETE for p in FIVE})).values():
            assert "assumed" in line and "E0" in line, line
        for line in rows(doc()).values():
            assert "assumed" not in line, line

    def test_the_specification_lists_the_assumed_head_and_free_cooling_hours(self):
        from gridforge.procurement.build import build_spec
        it = load_document(doc(**{p: DELETE for p in FIVE}))
        res = scenario(it, "hybrid_dlc")
        pkg = build_spec(it, res, constraint_id="plant_capacity")
        paths = [a.path for a in pkg.assumed_inputs]
        assert "thermal.plant.free_cooling_hours_per_year" in paths
        t22 = next(rq for rq in pkg.requirements if rq.id == "T-22")
        assert "(E0)" in t22.basis


# ============================================================================================================================
# T2-lite  the dedicated high-temperature loop is an unpriced component; declared dry coolers are a limit
# ============================================================================================================================
LOOP = "dedicated heat-rejection loop (dry coolers, pumps, pipework)"


class TestDedicatedLoopIsDisclosedNotPriced:
    @pytest.mark.parametrize("name", NAMES)
    def test_full_dlc_capex_is_a_lower_bound_naming_the_loop(self, name):
        before = json.loads((ROOT / "tests" / "golden_thermal_pre_integrity.json").read_text(encoding="utf-8"))
        for sid in ("full_dlc", "full_dlc_btm"):
            e = scenario(load_document(INTAKES[name]), sid).economics
            assert e.capex_complete is False
            rows = [u for u in e.unpriced if u["component"] == LOOP]
            assert len(rows) == 1 and rows[0]["key"] == "loop.ht_heat_rejection"
            assert any(LOOP in x and "LOWER BOUND" in x for x in e.limitations)
            assert round(e.capex_total_eur.value, 2) == before[f"{name}/{sid}"]["capex"]        # no price was invented: the number is the same

    @pytest.mark.parametrize("sid", ["retained_air", "rdhx", "hybrid_dlc"])
    def test_the_other_architectures_do_not_name_the_loop(self, sid):
        e = scenario(load_document(REF), sid).economics
        assert not [u for u in e.unpriced if u["component"] == LOOP]

    def test_a_hall_that_deploys_nothing_does_not_claim_a_loop(self):
        d = doc(**{"hall.positions_available": 0, "hall.rack_positions": 560})
        e = scenario(load_document(d), "full_dlc").economics
        assert not [u for u in e.unpriced if u["component"] == LOOP]

    def test_no_library_line_prices_the_loop(self):
        from gridforge.costs import library
        assert "loop.ht_heat_rejection" not in library().entries


def _full_dlc(extra=None, **over):
    it = load_document(doc(**over))
    c = ctx_for(it, Architecture.FULL_DLC)
    c.thermal.plant.dry_cooler_approach_K = V(10, "K", "assumed dry cooler approach", ASSUMED)
    if extra:
        extra(c)
    return it, c


def scenario_ctx(intake, sid: str) -> EnvelopeContext:
    """The context ``scenario.run`` solves for ``sid`` (architecture, PUE and the scenario's own overrides), without running the ladder."""
    spec = _scenario_set([sid])[0]
    c = intake.context.copy()
    c.architecture = spec.architecture
    c.pue = PUE_BY_ARCHITECTURE[spec.architecture]
    return spec.overrides(c) if spec.overrides is not None else c


class TestDeclaredDryCoolersAreAHeatRejectionLimit:
    def test_declared_capacity_over_the_liquid_load_per_rack_limits_full_dlc(self):
        # 1,215 kW / (135 kW x 0.90 = 121.5 kW per rack) = exactly 10 racks. Exactly on an integer: floors to 10, not 9.
        it, c = _full_dlc(**{"thermal.plant.dry_cooler_capacity_kW": 1215})
        assert it.context.thermal.plant.dry_cooler_capacity_kW.value == 1215
        r = by_id(solve(c))
        assert r["plant_capacity"].racks == 10
        assert "No derating" in r["plant_capacity"].basis and "dry-cooler" in r["plant_capacity"].basis
        assert "E0" in r["plant_capacity"].basis
        assert int(r["plant_capacity"].max_racks.evidence) == 0

    def test_no_derating_is_claimed_and_none_is_applied(self):
        # Doubling the design dry bulb changes nothing: the nameplate is not derated.
        _it, a = _full_dlc(**{"thermal.plant.dry_cooler_capacity_kW": 1215, "site.design_drybulb_C": 20})
        _it, b = _full_dlc(**{"thermal.plant.dry_cooler_capacity_kW": 1215, "site.design_drybulb_C": 40})
        assert by_id(solve(a))["plant_capacity"].racks == by_id(solve(b))["plant_capacity"].racks == 10
        assert any("derating" in n for n in by_id(solve(a))["plant_capacity"].notes)

    def test_undeclared_there_is_no_limit_and_the_note_says_so(self):
        _it, c = _full_dlc()
        r = by_id(solve(c))
        assert r["plant_capacity"].racks == 140                       # (6,800 - 4,900) kW / 13.5 kW residual air per rack, as before
        assert any("not declared" in n for n in r["plant_capacity"].notes)

    def test_declared_zero_means_none_installed_and_is_not_a_limit(self):
        _it, c = _full_dlc(**{"thermal.plant.dry_cooler_capacity_kW": 0})
        r = by_id(solve(c))
        assert r["plant_capacity"].racks == 140 and any("zero" in n for n in r["plant_capacity"].notes)

    def test_other_architectures_ignore_it(self):
        for arch in (Architecture.HYBRID_DLC, Architecture.RDHX, Architecture.RETAINED_AIR):
            it = load_document(doc(**{"thermal.plant.dry_cooler_capacity_kW": 1215}))
            with_cap = by_id(solve(ctx_for(it, arch)))["plant_capacity"].racks
            without = by_id(solve(ctx_for(load_document(doc()), arch)))["plant_capacity"].racks
            assert with_cap == without, arch

    def test_when_the_dry_coolers_are_the_lesser_limit_the_relief_is_more_of_them_and_it_is_unpriced(self):
        _it, c = _full_dlc(**{"thermal.plant.dry_cooler_capacity_kW": 1215})
        relief = by_id(solve(c))["plant_capacity"].relief
        assert relief.capex_eur is None and relief.lead_time_weeks is None
        after = relief.apply(c)
        assert after.thermal.plant.dry_cooler_capacity_kW.value == pytest.approx(1215 * 1.5)
        assert after.thermal.plant.chilled_water_capacity_kW.value == c.thermal.plant.chilled_water_capacity_kW.value

    def test_when_they_are_not_the_lesser_limit_the_relief_is_the_unchanged_plant_uprate(self):
        _it, c = _full_dlc(**{"thermal.plant.dry_cooler_capacity_kW": 1_000_000})
        relief = by_id(solve(c))["plant_capacity"].relief
        assert relief.cost_key == "plant.uprate" and relief.capex_eur is not None

    def test_a_declared_figure_through_the_whole_ladder_makes_the_capex_a_lower_bound(self):
        d = doc(**{"thermal.plant.dry_cooler_capacity_kW": 1215})
        res = scenario(load_document(d), "full_dlc")
        assert res.economics.capex_complete is False
        assert res.unlocked_racks <= 10 or any(s.binding_id == "plant_capacity" for s in res.ladder.steps)

    def test_the_declared_figure_is_recorded_with_its_class_and_asked_for(self):
        spec = FIELD_BY_PATH["thermal.plant.dry_cooler_capacity_kW"]
        assert not spec.required and not spec.counts_toward_completeness
        it = load_document(doc(**{"thermal.plant.dry_cooler_capacity_kW": {"value": 1215, "source": "dry-cooler schedule rev C"}}))
        assert it.context.thermal.plant.dry_cooler_capacity_kW.evidence == spec.supplied_evidence
        assert any(s.path == "thermal.plant.dry_cooler_capacity_kW" and s.source == "dry-cooler schedule rev C" for s in it.report.sourced)
        # undeclared: a plain absence, with nothing assumed in its place (no gap row, no change to anything)
        assert it.report.completeness == load_document(doc()).report.completeness
        assert "thermal.plant.dry_cooler_capacity_kW" not in [g.path for g in load_document(doc()).report.gaps]


# ============================================================================================================================
# Metamorphic properties over random thermal inputs (seeded: stdlib random, fixed seed, so a failure reproduces)
# ============================================================================================================================
SEED = 20261112
CASES = 40


def _random_thermal(rng: random.Random, name: str) -> dict:
    """A valid thermal section for one of the shipped halls: random plant, CDU schedule and temperatures, every optional limit absent."""
    supply = rng.uniform(4.0, 26.0)
    cdu = {"id": "CDU-R", "rated_capacity_kW": rng.uniform(800, 2300), "rated_approach_K": rng.uniform(3.0, 10.0),
           "units": rng.randint(2, 6), "redundancy": rng.choice(["N", "N+1", "N+2", "2N"])}
    return {
        "site.design_drybulb_C": rng.uniform(15.0, 38.0),
        "thermal.plant.chilled_water_capacity_kW": rng.uniform(3000, 15000),
        "thermal.plant.pump_flow_capacity_l_per_min": rng.uniform(2000, 30000),
        "thermal.plant.design_supply_C": supply,
        "thermal.plant.design_return_C": supply + rng.uniform(3.0, 12.0),
        "thermal.tcs_target_supply_C": rng.uniform(25.0, 42.0),
        "thermal.cdu_approach_K": rng.uniform(2.0, 8.0),
        "thermal.residual_air_capacity_kW_per_rack": rng.uniform(5.0, 25.0),
        "thermal.cdus": [cdu],
    }


def _racks(intake, sid: str, mutate=None) -> float:
    """What the THERMAL constraints alone permit (the minimum over the thermal domain; inf when none limits). The whole envelope is almost
    always held at zero by an electrical or air-removal gate on the shipped halls, which would make every monotonicity check vacuous."""
    c = scenario_ctx(intake, sid)
    if mutate is not None:
        c = mutate(c) or c
    return min(x.racks for x in solve(c).constraints if x.domain == "thermal")


@pytest.mark.parametrize("name", NAMES)
class TestMetamorphicProperties:
    """For random thermal inputs over the four shipped halls: a limit can only take racks away, never add them."""

    def _cases(self, name):
        rng = random.Random(f"{SEED}/{name}")
        for _ in range(CASES):
            over = _random_thermal(rng, name)
            yield rng, over, load_document(doc(INTAKES[name], **over))

    def test_more_rack_power_never_adds_racks(self, name):
        def scaled(k):
            def f(c):
                p = c.cluster.platform
                c.cluster.platform = dataclasses.replace(p, rack_kW=p.rack_kW * k, peak_rack_kW=p.peak_rack_kW * k)
            return f
        for _rng, over, it in self._cases(name):
            for sid in ("hybrid_dlc", "full_dlc"):
                lo, mid, hi = (_racks(it, sid, scaled(k)) for k in (0.8, 1.0, 1.25))
                assert hi <= mid <= lo, (name, sid, over, lo, mid, hi)

    def test_warmer_facility_water_never_adds_racks(self, name):
        def warmer(dT):
            def f(c):
                p = c.thermal.plant
                p.design_supply_C = V(p.design_supply_C.value + dT, "degC", "warmer supply", ASSUMED)
                p.design_return_C = V(p.design_return_C.value + dT, "degC", "warmer return", ASSUMED)
                c.site.design_drybulb_C = V(c.site.design_drybulb_C.value + dT, "degC", "hotter day", ASSUMED)
            return f
        for _rng, over, it in self._cases(name):
            for sid in ("hybrid_dlc", "full_dlc"):
                cool, mid, warm = (_racks(it, sid, warmer(d)) for d in (-3.0, 0.0, 4.0))
                assert warm <= mid <= cool, (name, sid, over, cool, mid, warm)

    def test_lower_declared_cdu_flow_never_adds_racks(self, name):
        for rng, over, it_ in self._cases(name):
            flow = rng.uniform(300, 5000)
            cdus = [dict(over["thermal.cdus"][0], rated_flow_l_per_min=flow * k) for k in (0.25, 0.5, 1.0)]
            racks = [_racks(load_document(doc(INTAKES[name], **{**over, "thermal.cdus": [c]})), sid)
                     for c in cdus for sid in ("hybrid_dlc", "full_dlc")]
            for sid_n in range(2):
                a, b, c_ = racks[sid_n], racks[2 + sid_n], racks[4 + sid_n]
                assert a <= b <= c_, (name, over, flow, racks)

    def test_declaring_a_limit_that_was_undeclared_never_adds_racks(self, name):
        for rng, over, it in self._cases(name):
            pump = over["thermal.plant.pump_flow_capacity_l_per_min"]
            cap = over["thermal.plant.chilled_water_capacity_kW"]
            declared = {
                "existing_flow": {"thermal.plant.existing_flow_l_per_min": rng.uniform(0, pump)},
                "existing_non_it": {"thermal.plant.existing_non_it_heat_kW": rng.uniform(0, cap)},
                "dry_coolers": {"thermal.plant.dry_cooler_capacity_kW": rng.uniform(500, 20000)},
                "cdu_flow": {"thermal.cdus": [dict(over["thermal.cdus"][0], rated_flow_l_per_min=rng.uniform(100, 6000))]},
            }
            for label, extra in declared.items():
                it2 = load_document(doc(INTAKES[name], **{**over, **extra}))
                for sid in ("hybrid_dlc", "full_dlc", "full_dlc_btm"):
                    assert _racks(it2, sid) <= _racks(it, sid), (name, label, sid, over, extra)

    def test_declaring_a_limit_never_adds_racks_after_the_ladder_either(self, name):
        for rng, over, it in list(self._cases(name))[:10]:
            extra = {"thermal.plant.dry_cooler_capacity_kW": rng.uniform(500, 20000)}
            it2 = load_document(doc(INTAKES[name], **{**over, **extra}))
            for sid in ("full_dlc",):
                assert scenario(it2, sid).unlocked_racks <= scenario(it, sid).unlocked_racks, (name, over, extra)

    def test_the_random_cases_are_not_vacuous(self, name):
        """Some cases must actually be limited by thermal constraints, or the monotonicity above proves nothing."""
        limited = 0
        for _rng, _over, it in self._cases(name):
            for sid in ("hybrid_dlc", "full_dlc"):
                if 0 < _racks(it, sid) < math.inf:
                    limited += 1
        assert limited >= 10, (name, limited)
