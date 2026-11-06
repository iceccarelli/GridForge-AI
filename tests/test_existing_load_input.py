"""`lv.existing_busway_load_kW`: the load already on the busway (optional).

The busway constraint reads `busway_ampacity_A` as the INSTALLED total and, until this input existed, ignored what is already drawing from
it ("the figure is the INSTALLED busway total as declared; existing load and occupied positions are not subtracted"). The field is
optional and additive in the manner of `thermal.plant.existing_non_it_heat_kW` (tests/test_existing_non_it_heat.py): absent, nothing moves
(proved against a golden taken from base b649b3e7 for the four shipped intakes); present, it is subtracted and never below zero, the
basis says so with the numbers, and a figure that cannot be true of the busway is refused naming both numbers.

Hand-worked on the reference hall (GB300, 135 kW per rack; busway 8 runs x 400 A at 400 V three-phase, derated to 0.8, power factor 0.97):
  per run  = sqrt(3) x 400 V x 400 A x 0.8 x 0.97 = 215.05 kW,  hall = 8 x 215.05 = 1,720.4 kW  ->  1,720.4 / 135 = 12.74  ->  12 racks.
The expected numbers are written from those raw figures, not read back from the engine.
"""
from __future__ import annotations

import copy
import json
import math
from pathlib import Path

import pytest

from examples.reference_site import build_context
from gridforge.cli import main as cli_main
from gridforge.common import CUSTOMER, V
from gridforge.intake.loader import IntakeError, blank_intake, load, load_document
from gridforge.intake.schema import FIELD_BY_PATH, INTAKE_FIELDS
from gridforge.power.constraints import busway_ampacity
from gridforge.scenario import run_all

ROOT = Path(__file__).resolve().parents[1]
PATH = "lv.existing_busway_load_kW"
REFERENCE = json.loads((ROOT / "examples" / "intake" / "reference_hall.json").read_text(encoding="utf-8"))
GOLDEN = json.loads((ROOT / "tests" / "golden_busway_b649b3e.json").read_text(encoding="utf-8"))

PER_RUN_KW = math.sqrt(3.0) * 400.0 * 400.0 * 0.8 * 0.97 / 1000.0      # 215.05
RUNS = 8
HALL_KW = PER_RUN_KW * RUNS                                           # 1,720.4
RACK_KW = 135.0


def _ctx(existing=None, topology=None):
    ctx = build_context()
    ctx.power.lv.busway_ampacity_A = V(400, "A", "busway", CUSTOMER)
    ctx.power.lv.busway_runs = RUNS
    ctx.power.lv.busway_utilisation_limit = V(0.8, "1", "util", CUSTOMER)
    ctx.power.lv.voltage_V = V(400, "V", "volts", CUSTOMER)
    ctx.power.lv.phases = 3
    ctx.power.grid.power_factor = V(0.97, "1", "pf", CUSTOMER)
    ctx.power.lv.rack_feed_topology = topology
    if existing is not None:
        ctx.power.lv.existing_load_kW = V(existing, "kW", "existing busway load", CUSTOMER)
    return ctx


def _doc(existing=None, **lv):
    d = copy.deepcopy(REFERENCE)
    if existing is not None:
        d["lv"]["existing_busway_load_kW"] = existing
    d["lv"].update(lv)
    return d


# --- absent: nothing moves (golden taken from base b649b3e7) ------------------------------------------------------------------
@pytest.mark.parametrize("name", ["dublin_hall", "london_hall", "nordic_hall", "reference_hall"])
def test_absent_the_busway_result_and_every_rung_are_byte_identical_to_base(name):
    intake = load(ROOT / "examples" / "intake" / f"{name}.json")
    assert PATH not in intake.document.get("lv", {})
    for r in run_all(intake.context, intake.scenarios):
        want = GOLDEN[name][r.spec.id]
        bw = next(c for c in r.ladder.initial.constraints if c.id == "busway_ampacity")
        assert [bw.racks, bw.basis] == want["busway"], (name, r.spec.id)
        got = [[s.step, s.binding_id, s.racks_before, s.racks_after, s.taken] + ([s.basis] if s.binding_id == "busway_ampacity" else [])
               for s in r.ladder.steps]
        assert got == want["rungs"], (name, r.spec.id)


def test_absent_the_basis_still_carries_the_modelling_limit_that_existing_load_is_not_subtracted():
    basis = busway_ampacity(_ctx()).basis
    assert "existing load and occupied positions are not subtracted" in basis


def test_explicit_zero_changes_the_count_not_at_all_but_says_the_load_was_given():
    a, b = busway_ampacity(_ctx()), busway_ampacity(_ctx(0.0))
    assert a.racks == b.racks == 12
    assert "less" in b.basis and "already on the busway" in b.basis


# --- present: subtraction, hand-worked ------------------------------------------------------------------------------------------
@pytest.mark.parametrize("existing, racks", [(0, 12), (500, 9), (1000, 5), (1500, 1), (1720, 0), (2000, 0)])
def test_pooled_busway_subtracts_the_existing_load(existing, racks):
    # (1,720.4 - existing) / 135, floored, never below zero: 500 -> 9.04; 1,000 -> 5.33; 1,500 -> 1.63; 1,720 -> 0.003; beyond the total -> 0.
    assert busway_ampacity(_ctx(existing)).racks == math.floor(max(HALL_KW - existing, 0.0) / RACK_KW + 1e-9) == racks


@pytest.mark.parametrize("existing, racks", [(0, 8), (500, 8), (1000, 0), (1200, 0)])
def test_single_run_busway_spreads_the_load_evenly_over_the_runs_and_counts_whole_racks(existing, racks):
    # Per run: 215.05 - existing / 8, then whole racks per run, times 8 runs.  500: 215.05 - 62.5 = 152.55 -> 1 rack x 8 = 8.
    # 1,000: 215.05 - 125 = 90.05 -> 0 racks x 8 = 0 (the pooled count would be 5: spreading it cannot pool the leftover).
    per_run = max(PER_RUN_KW - existing / RUNS, 0.0)
    assert busway_ampacity(_ctx(existing, topology="single_run")).racks == math.floor(per_run / RACK_KW + 1e-9) * RUNS == racks


def test_the_basis_states_every_number_and_the_subtraction():
    basis = busway_ampacity(_ctx(500)).basis
    assert "-> 1,720 kW" in basis                          # the installed total (1,720.4, rendered rounded)
    assert "500 kW" in basis and "less" in basis and "already on the busway" in basis and "never below zero" in basis
    assert "= 1,220 kW" in basis and "left" in basis      # 1,720.4 - 500 = 1,220.4 kW left
    assert "not subtracted" not in basis


def test_the_basis_for_single_run_says_how_the_load_was_spread():
    assert "spread evenly over the 8 run(s)" in busway_ampacity(_ctx(500, topology="single_run")).basis


def test_load_that_uses_up_the_busway_leaves_zero_racks_never_negative():
    res = busway_ampacity(_ctx(5000))        # reachable only by building a context directly (the loader refuses a figure above the busway)
    assert res.racks == 0 and res.max_racks.band[0] >= 0


def test_more_existing_load_never_increases_racks():
    prev = math.inf
    for existing in range(0, 2200, 50):
        n = busway_ampacity(_ctx(existing)).racks
        assert n <= prev
        prev = n


def test_the_busway_relief_scales_the_installed_total_not_the_existing_load():
    ctx = _ctx(500)
    res = busway_ampacity(ctx)
    relieved = res.relief.apply(ctx)
    # 400 A -> 1,000 A: hall = 8 x sqrt(3) x 400 x 1000 x 0.8 x 0.97 = 4,301.2 kW; less 500 unchanged = 3,801.2; / 135 = 28.2 -> 28.
    assert relieved.power.lv.existing_load_kW.value == 500
    assert busway_ampacity(relieved).racks == math.floor((HALL_KW * 2.5 - 500) / RACK_KW) == 28
    assert res.relief.capex_eur.value == pytest.approx(busway_ampacity(_ctx()).relief.capex_eur.value)


# --- through the loader, independently recomputed from the raw intake ------------------------------------------------------------
@pytest.mark.parametrize("existing", [0, 250, 900, 1700, 1720])
def test_independent_recomputation_from_the_raw_intake(existing):
    lv = REFERENCE["lv"]
    amps = lv["busway_ampacity_A"]["value"] if isinstance(lv["busway_ampacity_A"], dict) else lv["busway_ampacity_A"]
    total = math.sqrt(3.0) * lv["voltage_V"] * amps * lv["busway_utilisation_limit"] * REFERENCE["grid"]["power_factor"] * lv["busway_runs"] / 1000.0
    intake = load_document(_doc(existing))
    ctx = intake.context
    got = busway_ampacity(ctx).racks
    assert got == math.floor(max(total - existing, 0.0) / RACK_KW + 1e-9)
    # the same through the whole screen: the rack count of the constraint is the one the envelope carries
    res = next(r for r in run_all(ctx, intake.scenarios) if r.spec.id == "hybrid_dlc")
    bw = next(c for c in res.envelope.constraints if c.id == "busway_ampacity")
    assert bw.racks == got


# --- loader refusals --------------------------------------------------------------------------------------------------------------
@pytest.mark.parametrize("bad, msg", [
    (-1, "cannot be negative"),
    ("lots", "number"),
    ("500", "number"),
    (True, "number"),
    (False, "number"),
    (3_000_000_000, "above"),
    ([], "number"),
])
def test_loader_refuses_nonsense_with_a_precise_message(bad, msg):
    with pytest.raises(IntakeError, match=msg) as e:
        load_document(_doc(bad))
    assert PATH in str(e.value)


@pytest.mark.parametrize("bad", [float("nan"), float("inf"), float("-inf")])
def test_non_finite_is_refused(bad):
    with pytest.raises(IntakeError, match=PATH):
        load_document(_doc(bad))


def test_a_figure_above_the_installed_busway_is_refused_naming_both_numbers():
    # Nameplate total (no utilisation derating): sqrt(3) x 400 x 400 x 0.97 x 8 / 1000 = 2,150.6 kW.
    with pytest.raises(IntakeError) as e:
        load_document(_doc(2200))
    msg = str(e.value)
    assert PATH in msg and "2200 kW" in msg and "2,151 kW" in msg and "lv.busway_ampacity_A" in msg


def test_a_figure_between_the_derated_limit_and_the_nameplate_is_accepted_leaves_no_rack_and_warns():
    intake = load_document(_doc(1900))          # above 1,720 kW (derated), below 2,150 kW (nameplate)
    assert busway_ampacity(intake.context).racks == 0
    assert any(PATH in w and "1,720" in w for w in intake.report.warnings)


def test_the_refusal_says_when_the_busway_figure_is_a_placeholder():
    d = _doc(5000)
    del d["lv"]["busway_ampacity_A"]
    with pytest.raises(IntakeError, match="not supplied"):
        load_document(d)


def test_the_occupied_positions_heuristic_warning_is_dropped_when_the_load_is_given():
    d = copy.deepcopy(REFERENCE)
    d["lv"]["busway_ampacity_A"] = 100                   # small enough that the heuristic fires for the 380 occupied positions
    heuristic = lambda i: [w for w in i.report.warnings if w.startswith("Busway:")]   # noqa: E731
    assert heuristic(load_document(d))
    d["lv"]["existing_busway_load_kW"] = 300
    assert not heuristic(load_document(d))


# --- provenance and the data request ----------------------------------------------------------------------------------------------
def test_supplied_figure_carries_its_source_note_and_declared_evidence():
    d = _doc({"value": 600, "source": "branch-circuit monitoring, March", "note": "peak of the month", "evidence": "E4"})
    intake = load_document(d)
    q = intake.context.power.lv.existing_load_kW
    assert q.value == 600 and q.evidence.short == "E4"
    assert PATH in intake.report.supplied and PATH not in [g.path for g in intake.report.gaps]
    assert any(s.path == PATH and s.source == "branch-circuit monitoring, March" for s in intake.report.sourced)
    d["lv"]["existing_busway_load_kW"]["evidence"] = "E9"
    with pytest.raises(IntakeError, match="not an evidence class"):
        load_document(d)


def test_unsupplied_the_field_is_asked_for_outside_the_completeness_ratio():
    intake = load_document(_doc())
    assert intake.context.power.lv.existing_load_kW is None
    gap = next(g for g in intake.report.gaps if g.path == PATH)
    assert not gap.required and gap.unit == "kW" and gap.why_it_binds and gap.how_to_get_it and gap.fallback_description
    assert "nothing subtracted" in gap.fallback_description
    assert not FIELD_BY_PATH[PATH].counts_toward_completeness
    counted = [f.path for f in INTAKE_FIELDS if f.counts_toward_completeness]
    missing = {g.path for g in intake.report.gaps if g.path in counted}
    assert intake.report.completeness == pytest.approx((len(counted) - len(missing)) / len(counted))
    assert load_document(_doc(600)).report.completeness == pytest.approx(intake.report.completeness)


def test_data_request_lists_the_field_as_optional(tmp_path, capsys):
    p = tmp_path / "intake.json"
    p.write_text(json.dumps(_doc()), encoding="utf-8")
    cli_main(["gaps", str(p)])
    assert "[optional] Load already on the busway (kW)" in capsys.readouterr().out


def test_template_carries_the_field():
    assert blank_intake()["lv"]["existing_busway_load_kW"] is None


def test_a_supplied_figure_changes_no_other_constraint():
    a, b = load_document(_doc()), load_document(_doc(500))
    for scen in ("hybrid_dlc", "full_dlc"):
        ra = next(r for r in run_all(a.context, a.scenarios) if r.spec.id == scen)
        rb = next(r for r in run_all(b.context, b.scenarios) if r.spec.id == scen)
        ca = {c.id: (c.racks, c.basis) for c in ra.envelope.constraints if c.id != "busway_ampacity"}
        cb = {c.id: (c.racks, c.basis) for c in rb.envelope.constraints if c.id != "busway_ampacity"}
        assert ca == cb
