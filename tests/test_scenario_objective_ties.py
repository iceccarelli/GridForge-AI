"""The recommendation is a function of the SET of scenarios, never of the order they were listed in; a tie that decides it says so.

Defect (independent numerics audit, 2026-11-13, reproduced through ``handle_screen``): on the London example ``[full_dlc, full_dlc_btm]`` and
``[full_dlc_btm, full_dlc]`` both come to 6 racks and 1,860,000 EUR, and ``recommended`` flipped with the listing for all three objectives, because
the first of the tied scenarios in the caller's own order won. A tie is now broken on the simpler option (no behind-the-meter equipment), then on
the scenario id, and the recommendation says that a tie decided it.
"""
from __future__ import annotations

import copy
import itertools
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from gridforge.api.server import handle_screen
from gridforge.api.tiers import Tier
from gridforge.intake.loader import load_document
from gridforge.scenario.objective import (OBJECTIVE_RATIONALE, Objective, pick_recommended, pick_with_reason,
                                          recommendation_rationale)
from gridforge.scenario.run import run_all
from gridforge.thermal.schema import Architecture

INTAKE = Path(__file__).resolve().parent.parent / "examples" / "intake"
HALLS = ("reference_hall", "dublin_hall", "london_hall", "nordic_hall")
OBJECTIVES = tuple(Objective)


def _doc(name: str) -> dict:
    return json.loads((INTAKE / f"{name}.json").read_text())


def _results(doc: dict):
    it = load_document(copy.deepcopy(doc))
    return run_all(it.context, it.scenarios)


def _stub(sid: str, racks: int, capex: float = 1_000_000.0, *, btm: str = "none", weeks: float | None = 40.0, complete: bool = True,
          arch: str | None = None):
    """A scenario result reduced to what the selection reads. ``btm``: "none" (no options), "offered" (options kept, none installed), "installed"."""
    options = [] if btm == "none" else [SimpleNamespace(installed=(btm == "installed"))]
    return SimpleNamespace(
        spec=SimpleNamespace(id=sid) if arch is None else SimpleNamespace(id=sid, architecture=Architecture(arch)), unlocked_racks=racks,
        economics=SimpleNamespace(capex_complete=complete, capex_total_eur=SimpleNamespace(value=capex)),
        ladder=SimpleNamespace(final_context=SimpleNamespace(power=SimpleNamespace(options=options)), weeks=weeks),
        context=SimpleNamespace(power=SimpleNamespace(options=options)))


@pytest.fixture
def dated(monkeypatch):
    import gridforge.envelope.time_to_power as ttp
    monkeypatch.setattr(ttp, "schedule", lambda ladder: SimpleNamespace(weeks_to_full=ladder.weeks))


@pytest.mark.parametrize("hall", HALLS)
@pytest.mark.parametrize("objective", OBJECTIVES)
def test_every_listing_order_of_the_scenarios_recommends_the_same_one(hall, objective):
    results = _results(_doc(hall))
    reference = pick_with_reason(results, objective)
    for perm in itertools.permutations(results):
        got = pick_with_reason(list(perm), objective)
        assert got.result is reference.result, (hall, objective, [r.spec.id for r in perm])
        assert (got.tied_with, got.decided_by, got.note) == (reference.tied_with, reference.decided_by, reference.note)
        assert pick_recommended(list(perm), objective) is reference.result


@pytest.mark.parametrize("hall", HALLS)
@pytest.mark.parametrize("objective", OBJECTIVES)
def test_every_subset_in_either_order_recommends_the_same_one(hall, objective):
    results = _results(_doc(hall))
    for size in (2, 3):
        for subset in itertools.combinations(results, size):
            a = pick_recommended(list(subset), objective)
            b = pick_recommended(list(reversed(subset)), objective)
            assert a is b, (hall, objective, [r.spec.id for r in subset])


@pytest.mark.parametrize("objective", ("max_compute", "min_cost", "fastest"))
def test_the_audit_case_through_screen_london_two_scenarios_both_orders(objective):
    picks = {}
    for order in (["full_dlc", "full_dlc_btm"], ["full_dlc_btm", "full_dlc"]):
        d = _doc("london_hall")
        d["scenarios"] = order
        out = handle_screen({"intake": d, "objective": objective}, Tier.CLIENT)
        racks_capex = {s["id"]: (s["after_ladder"]["racks"], s["economics"]["capex_total_eur"]["value"]) for s in out["scenarios"]}
        assert racks_capex["full_dlc"] == racks_capex["full_dlc_btm"] == (6, 1860000.0)      # the premise: an exact tie
        picks[tuple(order)] = out["recommended"]
    assert set(picks.values()) == {"full_dlc"}


class TestTheTieIsBrokenOnTheSimplerOptionThenTheId:
    def test_less_behind_the_meter_equipment_wins_a_tie(self, dated):
        for objective in OBJECTIVES:
            for order in itertools.permutations([_stub("a_installed", 10, btm="installed"), _stub("b_offered", 10, btm="offered"),
                                                 _stub("c_none", 10, btm="none")]):
                rec = pick_with_reason(list(order), objective)
                assert rec.result.spec.id == "c_none", (objective, [r.spec.id for r in order])
                assert rec.decided_by == "behind_the_meter" and rec.tied_with == ("a_installed", "b_offered")

    def test_offered_but_unused_beats_installed(self, dated):
        rec = pick_with_reason([_stub("a", 10, btm="installed"), _stub("b", 10, btm="offered")], Objective.MAX_COMPUTE)
        assert rec.result.spec.id == "b" and rec.decided_by == "behind_the_meter"

    def test_with_nothing_to_separate_them_the_scenario_id_decides_in_either_order(self, dated):
        for objective in OBJECTIVES:
            for order in itertools.permutations([_stub("zeta", 10), _stub("alpha", 10), _stub("mid", 10)]):
                rec = pick_with_reason(list(order), objective)
                assert rec.result.spec.id == "alpha" and rec.decided_by == "scenario_id" and rec.tied_with == ("mid", "zeta")

    def test_the_simpler_architecture_beats_the_id_when_nothing_else_separates_them(self, dated):
        """Hybrid DLC sorts after full DLC by id, but it is the simpler thing to build: a default study lists the architectures simplest first, and a
        tie must keep opening with the same one whatever order the caller listed them in."""
        cands = [_stub("hybrid_dlc", 10, arch="hybrid_dlc"), _stub("full_dlc", 10, arch="full_dlc"), _stub("rdhx", 10, arch="rdhx"),
                 _stub("retained_air", 10, arch="retained_air")]
        for objective in OBJECTIVES:
            for order in itertools.permutations(cands):
                rec = pick_with_reason(list(order), objective)
                assert rec.result.spec.id == "retained_air" and rec.decided_by == "architecture"
        two = [_stub("hybrid_dlc", 10, arch="hybrid_dlc"), _stub("full_dlc", 10, arch="full_dlc")]
        for order in (two, two[::-1]):
            rec = pick_with_reason(order, Objective.FASTEST_TO_POWER)
            assert rec.result.spec.id == "hybrid_dlc"
            assert rec.note == ("Tied with full_dlc on fastest, and none of them differs in behind-the-meter equipment; chose hybrid_dlc, "
                                "the simplest cooling architecture of them. The objective could not separate them.")

    def test_behind_the_meter_equipment_still_comes_before_the_architecture(self, dated):
        plain_full = _stub("full_dlc", 10, arch="full_dlc", btm="none")
        btm_hybrid = _stub("hybrid_dlc", 10, arch="hybrid_dlc", btm="installed")
        for order in ([plain_full, btm_hybrid], [btm_hybrid, plain_full]):
            rec = pick_with_reason(order, Objective.MAX_COMPUTE)
            assert rec.result is plain_full and rec.decided_by == "behind_the_meter"

    def test_the_objective_still_decides_when_it_can(self, dated):
        """A tie-break never overrides the objective: more racks, lower cost per rack and an earlier date still win, whatever the equipment."""
        more = _stub("more_btm", 12, btm="installed")
        few = _stub("fewer_none", 10, btm="none")
        assert pick_with_reason([few, more], Objective.MAX_COMPUTE).result is more
        assert pick_with_reason([more, few], Objective.MAX_COMPUTE).result is more
        cheap = _stub("cheap_btm", 10, capex=900_000.0, btm="installed")
        dear = _stub("dear_none", 10, capex=1_000_000.0, btm="none")
        assert pick_with_reason([dear, cheap], Objective.MIN_COST_PER_RACK).result is cheap
        assert pick_with_reason([dear, cheap], Objective.MAX_COMPUTE).result is cheap          # racks level, then the lower capex
        quick = _stub("quick_btm", 10, btm="installed", weeks=30.0)
        slow = _stub("slow_none", 10, btm="none", weeks=44.0)
        assert pick_with_reason([slow, quick], Objective.FASTEST_TO_POWER).result is quick

    def test_a_difference_that_is_only_float_noise_is_a_tie(self, dated):
        a = _stub("a_btm", 10, capex=1_864_166.67, btm="installed")
        b = _stub("b_none", 10, capex=1_864_166.67 * (1 + 4e-16), btm="none")
        for order in ([a, b], [b, a]):
            assert pick_with_reason(order, Objective.MAX_COMPUTE).result is b
        c = _stub("c_none", 10, capex=1_864_166.67 * (1 + 1e-6), btm="none")           # a millionth apart is a difference: the cheaper one wins
        assert pick_with_reason([c, a], Objective.MAX_COMPUTE).result is a
        d = _stub("d_none", 10, btm="none", weeks=40.0 * (1 + 4e-16))
        e = _stub("e_btm", 10, btm="installed", weeks=40.0)
        assert pick_with_reason([e, d], Objective.FASTEST_TO_POWER).result is d

    def test_an_incomplete_capex_still_never_beats_a_complete_one_for_min_cost(self, dated):
        cheap_incomplete = _stub("a", 10, capex=100.0, complete=False)
        complete = _stub("b", 10, capex=900_000.0, complete=True)
        assert pick_with_reason([cheap_incomplete, complete], Objective.MIN_COST_PER_RACK).result is complete

    def test_nothing_dated_means_no_winner_on_capacity_and_the_simpler_option_opens(self, dated):
        cands = [_stub("big", 900, btm="installed", weeks=None), _stub("small", 10, btm="none", weeks=None),
                 _stub("mid", 400, btm="offered", weeks=None)]
        for order in itertools.permutations(cands):
            rec = pick_with_reason(list(order), Objective.FASTEST_TO_POWER)
            assert rec.result.spec.id == "small" and rec.decided_by == "behind_the_meter"

    def test_nothing_deployable_is_still_a_deterministic_choice(self, dated):
        cands = [_stub("b", 0, capex=0.0, complete=False), _stub("a", 0, capex=0.0, complete=False)]
        for order in (cands, cands[::-1]):
            assert pick_with_reason(order, Objective.MAX_COMPUTE).result.spec.id == "a"

    def test_a_single_scenario_is_no_tie_and_an_empty_list_is_refused(self, dated):
        rec = pick_with_reason([_stub("only", 3)], Objective.MAX_COMPUTE)
        assert rec.note == "" and rec.tied_with == () and rec.decided_by == ""
        with pytest.raises(ValueError):
            pick_recommended([], Objective.MAX_COMPUTE)


class TestAMeaningfulTieSaysSo:
    def test_london_audit_case_names_the_tie(self):
        d = _doc("london_hall")
        d["scenarios"] = ["full_dlc_btm", "full_dlc"]
        results = _results(d)
        for objective in OBJECTIVES:
            rec = pick_with_reason(results, objective)
            assert rec.result.spec.id == "full_dlc" and rec.tied_with == ("full_dlc_btm",)
            # the London intake declares no behind-the-meter option at all, so neither scenario has equipment to differ in: the id decides, and
            # the sentence says exactly that rather than claiming a difference in equipment that is not there
            assert rec.decided_by == "scenario_id"
            assert rec.note == (f"Tied with full_dlc_btm on {objective.value}, and none of them differs in behind-the-meter equipment or "
                                f"architecture; chose full_dlc, the first by scenario id. The objective could not separate them.")
            text = recommendation_rationale(results, objective)
            assert text.startswith(OBJECTIVE_RATIONALE[objective]) and rec.note in text

    def test_an_offered_but_unneeded_behind_the_meter_option_loses_the_tie_and_the_text_says_why(self):
        """The hall has a battery of no firm worth (PV): the behind-the-meter scenario keeps it on offer, buys none, and ties with the plain one."""
        d = _doc("london_hall")
        d["btm_options"] = [{"id": "PV-1", "kind": "pv", "capacity_MW": 2.0, "capex_eur_per_kW": 900, "lead_time_weeks": 40, "firm": False}]
        d["scenarios"] = ["full_dlc_btm", "full_dlc"]
        results = _results(d)
        rec = pick_with_reason(results, Objective.MAX_COMPUTE)
        assert rec.result.spec.id == "full_dlc" and rec.decided_by == "behind_the_meter"
        assert rec.note == ("Tied with full_dlc_btm on max_compute; chose the one without behind-the-meter equipment (full_dlc). "
                            "The objective could not separate them.")

    def test_no_tie_no_sentence(self):
        results = _results(_doc("dublin_hall"))
        rec = pick_with_reason(results, Objective.MAX_COMPUTE)
        assert rec.result.spec.id == "full_dlc_btm" and rec.note == "" and rec.tied_with == ()
        assert recommendation_rationale(results, Objective.MAX_COMPUTE) == OBJECTIVE_RATIONALE[Objective.MAX_COMPUTE]
