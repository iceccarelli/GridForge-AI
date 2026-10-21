"""Boundary, infeasible, adversarial, determinism and missing-input tests for the physics engine.

Fixtures are the SYNTHETIC reference hall (``examples.reference_site`` / ``examples/intake/reference_hall.json``).
Nothing here is real-world calibration and nothing here changes the fact that the calibration ledger is empty.
Where a test is marked ``xfail(strict=True)`` it documents a defect that was found and NOT fixed (the code is in a
file outside the physics modules, or fixing it would contradict an existing test); the reason says which.
"""
from __future__ import annotations

import copy
import json
import math
import os
import subprocess
import sys
from pathlib import Path

import pytest

from examples.reference_site import SCENARIOS, build_context
from gridforge.api.server import handle_compare
from gridforge.api.tiers import Tier
from gridforge.calibration import accuracy_block, load_ledger, may_claim_field_validated
from gridforge.common import ASSUMED, CUSTOMER, V
from gridforge.costs import CostEntry, cost_overlay, library, scaled_cost
from gridforge.economics.model import evaluate
from gridforge.envelope import ladder, solve
from gridforge.intake.loader import IntakeError, load_document
from gridforge.scenario import run, run_all
from gridforge.serialize import model_pack, scenario_dict
from gridforge.thermal.constraints import plant_capacity
from gridforge.thermal.schema import Architecture
from gridforge.validation import EvidenceClass, Quantity

ROOT = Path(__file__).resolve().parents[1]
REFERENCE_INTAKE = ROOT / "examples" / "intake" / "reference_hall.json"
ALL_INTAKES = sorted((ROOT / "examples" / "intake").glob("*.json"))
E0 = EvidenceClass.E0_ASSUMPTION


def _doc():
    return json.loads(REFERENCE_INTAKE.read_text())


def _set(doc, path, value):
    cur = doc
    parts = path.split(".")
    for p in parts[:-1]:
        cur = cur[int(p)] if isinstance(cur, list) else cur[p]
    last = parts[-1]
    if isinstance(cur, list):
        cur[int(last)] = value
    elif isinstance(cur.get(last), dict) and "value" in cur[last]:
        cur[last]["value"] = value
    else:
        cur[last] = value


# =====================================================================================================================
# Degenerate and hostile inputs through the whole pipeline
# =====================================================================================================================
DEGENERATE = [
    # (path, value that is legal for the loader but physically degenerate)
    ("hall.aisle_pitch_m", 0), ("hall.floor_loading_kPa", 0), ("hall.positions_available", 0),
    ("hall.rack_positions", 0), ("grid.firm_capacity_MVA", 0), ("grid.contracted_MW", 0),
    ("grid.current_site_peak_MW", 1e12), ("grid.current_it_load_MW", 1e12),
    ("transformers.0.units", 0), ("transformers.0.units", 1), ("ups.0.units", 0), ("ups.0.unit_rating_kW", 0),
    ("lv.busway_runs", 0), ("lv.busway_ampacity_A", 0), ("lv.voltage_V", 0), ("lv.tapoff_max_A", 0),
    ("thermal.plant.chilled_water_capacity_kW", 0), ("thermal.plant.pump_flow_capacity_l_per_min", 0),
    ("thermal.residual_air_capacity_kW_per_rack", 0), ("btm_options.0.capacity_MW", 0),
    ("btm_options.1.annual_run_hours", 0), ("btm_options.0.firm_capacity_factor", 1e-9),
    ("grid.firm_capacity_MVA", 1e12), ("hall.positions_available", 1e9),
]


@pytest.mark.parametrize("path, value", DEGENERATE)
def test_degenerate_inputs_never_crash_or_emit_nan_or_negative_capacity(path, value):
    doc = _doc()
    _set(doc, path, value)
    try:
        intake = load_document(doc)
    except IntakeError:
        return                                             # refused by name is an acceptable answer
    results = run_all(intake.context, intake.scenarios)
    pack = model_pack(intake, results)
    json.dumps(pack, allow_nan=False)                     # the browser's JSON.parse rejects NaN / Infinity
    for r in results:
        assert isinstance(r.unlocked_racks, int) and r.unlocked_racks >= 0
        assert r.headline_racks >= 0
        e = r.economics
        for q in (e.capex_total_eur, e.annual_energy_cost_eur, e.capex_conversion_eur, e.capex_relief_eur):
            assert math.isfinite(q.value) and q.value >= 0, (r.spec.id, q.prov.label, q.value)
        if r.unlocked_racks == 0:
            # a hall that hosts nothing buys nothing: no stranded capex presented as a plan
            assert r.ladder.cumulative_capex_eur == 0.0


def test_a_hall_with_zero_feasible_racks_has_zero_load_not_a_negative_or_nan_one():
    ctx = build_context()
    ctx.hall.positions_available = 0
    res = solve(ctx)
    assert res.max_racks == 0 and res.it_load_kW.value == 0.0 and res.facility_load_kW.value == 0.0 and res.gpus == 0


def test_the_binding_constraint_of_an_infeasible_hall_is_the_first_to_fail_not_an_arbitrary_one():
    ctx = build_context()
    ctx.power.grid.firm_capacity_MVA = V(0.0, "MVA", "no connection", CUSTOMER)
    res = solve(ctx)
    assert res.max_racks == 0
    assert res.binding.racks == 0.0


@pytest.mark.parametrize("bad", [float("nan"), float("inf"), float("-inf"), -1.0, True, "12 MW", [1]])
def test_the_loader_refuses_non_physical_numbers_by_name(bad):
    doc = _doc()
    _set(doc, "grid.contracted_MW", bad)
    with pytest.raises(IntakeError):
        load_document(doc)


@pytest.mark.parametrize("path, bad", [
    ("grid.power_factor", 1.5), ("grid.power_factor", 0), ("transformers.0.derating_factor", 5),
    ("lv.busway_utilisation_limit", 2), ("compute.utilisation", 0), ("compute.utilisation", 1.01),
    ("transformers.0.redundancy", "2N+1"), ("ups.0.redundancy", "N+3"), ("lv.phases", 2),
    ("hall.rack_positions", 1.5), ("hall.rack_positions", -1), ("economics.horizon_years", 0),
    ("economics.horizon_years", 51),
])
def test_physical_range_violations_are_refused(path, bad):
    doc = _doc()
    _set(doc, path, bad)
    with pytest.raises(IntakeError):
        load_document(doc)


def test_python_json_nan_literal_is_refused_not_propagated():
    doc = json.loads(REFERENCE_INTAKE.read_text().replace('"firm_capacity_MVA": 14.0', '"firm_capacity_MVA": NaN'))
    with pytest.raises(IntakeError):
        load_document(doc)


# =====================================================================================================================
# Feasibility: nothing infeasible is declared feasible
# =====================================================================================================================
class TestInfeasibleIsNeverFeasible:
    def test_as_found_reference_hall_hosts_no_gb300_rack_and_the_gates_say_why(self):
        res = solve(build_context())
        failing = {c.id for c in res.constraints if c.racks == 0.0}
        assert res.max_racks == 0
        assert {"rack_feed_tapoff", "residual_air_removal"} <= failing        # 205 A vs 63 A; 13.5 kW vs 9 kW

    def test_a_relieved_plan_is_re_solved_not_assumed_feasible(self):
        # Every taken step's racks_after is the result of solve() on the relieved context, so the final answer must
        # equal an independent solve of the final context.
        for spec in SCENARIOS:
            r = run(build_context(), spec)
            if r.unlocked_racks:
                assert solve(r.ladder.final_context).max_racks == r.unlocked_racks

    def test_no_relief_is_credited_where_the_relief_cannot_be_bought(self):
        r = run(build_context(), SCENARIOS[3])                                 # s4: grid-only full DLC
        grid = [s for s in r.ladder.steps if s.binding_id == "grid_firm_capacity"][-1]
        assert grid.taken is False and "cannot be obtained" in grid.not_taken_reason
        assert grid.racks_after == grid.racks_before                            # no capacity invented
        assert r.ladder.final.binding.id == "grid_firm_capacity"

    def test_the_unobtainable_grid_reinforcement_never_sets_a_date(self):
        # grid reinforcement carries a 260-week lead time on paper; it must not appear as the energisation date
        r = run(build_context(), SCENARIOS[3])
        from gridforge.envelope.time_to_power import schedule
        assert schedule(r.ladder).weeks_to_full < 260.0
        assert all(s.binding_id != "grid_firm_capacity" for s in r.ladder.taken_steps)

    def test_a_ladder_that_ends_at_zero_racks_buys_nothing(self):
        ctx = build_context()
        ctx.architecture = Architecture.RETAINED_AIR            # 22 kW capability vs 135 kW: no capex relieves it
        lad = ladder(ctx)
        assert lad.final.max_racks == 0 and not lad.taken_steps and lad.cumulative_capex_eur == 0.0

    def test_architecture_mismatch_has_no_relief_to_sell(self):
        lad = ladder(self._retained_air())
        assert lad.final.binding.id == "architecture_capability" and lad.final.binding.relief is None

    @staticmethod
    def _retained_air():
        ctx = build_context()
        ctx.architecture = Architecture.RETAINED_AIR
        return ctx

    def test_exactly_at_a_gate_threshold_passes_and_one_step_below_fails(self):
        ctx = build_context()
        ctx.power.lv.tapoff_max_A = V(205.0, "A", "tap-off at the platform feed current", CUSTOMER)
        from gridforge.power.constraints import rack_feed_tapoff
        assert rack_feed_tapoff(ctx).racks == math.inf
        ctx.power.lv.tapoff_max_A = V(math.nextafter(205.0, 0.0), "A", "tap-off just below", CUSTOMER)
        assert rack_feed_tapoff(ctx).racks == 0.0

    def test_a_solved_envelope_never_exceeds_any_constraint(self):
        for spec in SCENARIOS:
            r = run(build_context(), spec)
            for res in (r.envelope, r.ladder.final):
                assert all(res.max_racks <= c.racks for c in res.constraints)


# =====================================================================================================================
# Missing inputs: a missing cost, price or lead time is never a zero, a credible number or a clean total
# =====================================================================================================================
class TestMissingInputsPropagate:
    def test_unpriced_cdu_components_make_the_capex_a_lower_bound(self):
        r = run(build_context(), SCENARIOS[2])
        e = r.economics
        assert e.capex_complete is False and e.decision_grade is False
        keys = {u["key"] for u in e.unpriced}
        assert {"cdu.integration", "cdu.commissioning"} <= keys
        assert any("LOWER BOUND" in x for x in e.limitations)

    def test_a_relief_without_a_price_is_reported_not_costed_at_zero(self):
        r = run(build_context(), SCENARIOS[2])
        r.ladder.taken_steps[0].capex_eur = None
        e = evaluate(r.ladder.final, r.ladder, r.context.cluster.utilisation)
        assert e.capex_complete is False
        assert any(u["component"] == "the relief itself" for u in e.unpriced)

    def test_library_defaults_are_never_zero_and_are_labelled_as_placeholders(self):
        r = run(build_context(), SCENARIOS[2])
        for st in r.ladder.taken_steps:
            if st.cost_basis == "library_default" and st.capex_eur is not None:
                assert st.capex_eur.value > 0 or st.cost_key == "not-capital"
                assert st.capex_eur.evidence == E0

    def test_a_zero_or_negative_quotation_is_not_a_price(self):
        for value in (0.0, -1.0):
            with pytest.raises(ValueError, match="not a price|non-numeric"):
                CostEntry(key="plant.uprate", label="x", unit="EUR", value=value, basis="firm_quote",
                          supplier="Synthetic Supplier Ltd", quoted_on="2026-01-01", synthetic=True)

    @pytest.mark.parametrize("value", [float("nan"), float("inf")])
    def test_a_non_finite_quotation_is_refused(self, value):
        with pytest.raises(ValueError):
            CostEntry(key="plant.uprate", label="x", unit="EUR", value=value, basis="library_default")

    def test_a_quotation_in_another_currency_is_refused_not_converted(self):
        with pytest.raises(ValueError, match="not EUR"):
            CostEntry(key="plant.uprate", label="x", unit="EUR", value=1.0, currency="USD")

    @pytest.mark.parametrize("quantity", [-1.0, float("nan"), float("inf")])
    def test_a_relief_cannot_add_a_negative_or_non_finite_quantity(self, quantity):
        with pytest.raises(ValueError):
            scaled_cost("plant.uprate", 100.0, "EUR/kW", quantity, "kW", "x")

    def test_a_quote_stated_in_the_wrong_unit_is_refused(self):
        quote = CostEntry(key="plant.uprate", label="x", unit="EUR", value=1.0e6, basis="firm_quote",
                          supplier="Synthetic Supplier Ltd", quoted_on="2026-05-01", quoted_quantity=100.0,
                          quoted_quantity_unit="MVA", reviewer="r", reviewed_on="2026-05-02", synthetic=True)
        with cost_overlay([quote]):
            with pytest.raises(ValueError, match="Re-enter the quotation"):
                plant_capacity(build_context())

    def test_evidence_that_is_not_accepted_or_has_expired_changes_no_price(self, monkeypatch):
        monkeypatch.setenv("GRIDFORGE_REPORT_DATE", "2026-06-01")
        base = plant_capacity(build_context()).relief.capex_eur.value

        def quote(**kw):
            d = dict(key="plant.uprate", label="synthetic quotation", unit="EUR", value=1.0, basis="firm_quote",
                     supplier="Synthetic Supplier Ltd", quoted_on="2026-05-01", valid_until="2026-12-31",
                     evidence_id="ev-1", reviewer="r", reviewed_on="2026-05-02", synthetic=True)
            d.update(kw)
            return CostEntry(**d)

        stale = quote(valid_until="2026-05-31")
        for entry in (quote(status="received"), quote(status="rejected"), quote(status="withdrawn"),
                      quote(status="superseded"), quote(status="validated"), stale):
            with cost_overlay([entry]) as rep:
                assert plant_capacity(build_context()).relief.capex_eur.value == base
                assert rep.used == [] and len(rep.ignored) == 1 and rep.ignored[0]["reason"]

    def test_scenario_with_installed_btm_but_no_operating_inputs_prices_all_energy_at_the_grid_tariff_and_says_so(self):
        r = run(build_context(), SCENARIOS[4])               # full DLC + BTM; GEN-5MW declares opex but no run hours
        e = r.economics
        assert e.btm is not None and e.btm.applied is False and e.opex_complete is False
        assert any("annual_run_hours not declared" in m for m in e.btm.missing)
        assert any("no usable operating cost" in x for x in e.limitations)

    def test_no_horizon_no_lifecycle(self):
        assert run(build_context(), SCENARIOS[2]).economics.lifecycle_cost_eur is None

    def test_the_calibration_ledger_is_empty_and_nothing_may_claim_field_validation(self):
        led = load_ledger(published_only=True)
        assert led.observations == []
        block = accuracy_block(ledger=led)
        assert block["state"] == "uncalibrated" and block["observations"] == 0 and block["coverage"] == 0.0
        assert "has not been established" in block["statement"]
        assert may_claim_field_validated(["constraint.rack_feed_tapoff.racks"], led) is False
        assert may_claim_field_validated([], led) is False

    def test_no_engine_quantity_reaches_e6_or_e7(self):
        # E6 / E7 are earned through the calibration ledger; with it empty no output may carry them.
        for f in ALL_INTAKES:
            intake = load_document(json.loads(f.read_text()))
            for r in run_all(intake.context, intake.scenarios):
                for q in _quantities(r):
                    assert q.evidence < EvidenceClass.E6_FIELD_VALIDATED, (f.name, r.spec.id, q.prov.label)

    @pytest.mark.xfail(strict=True, reason=(
        "KNOWN DEFECT, NOT FIXED (gridforge/intake/loader.py, outside the physics modules): a BTM option that omits "
        "capex_eur_per_kW and lead_time_weeks silently gets 900 EUR/kW and 36 weeks, and neither is listed as a "
        "data gap. A missing cost or lead time should be reported as missing, not filled with a credible-looking "
        "number that then sets an energisation date."))
    def test_a_btm_option_with_no_cost_or_lead_time_is_reported_as_a_gap(self):
        doc = _doc()
        doc["btm_options"] = [{"id": "G", "kind": "gas_engine", "capacity_MW": 5}]
        intake = load_document(doc)
        assert any("btm" in g.path.lower() or "lead_time" in g.path for g in intake.report.gaps)

    @pytest.mark.xfail(strict=True, reason=(
        "KNOWN DEFECT, NOT FIXED (gridforge/intake/loader.py): defaults the loader invents when a field is absent "
        "(power factor 0.97, transformer derating 0.90, busway utilisation 0.80) are labelled E3 'engineering "
        "estimate', above the E0 they deserve as unreviewed library defaults."))
    def test_an_absent_power_factor_is_not_labelled_as_an_engineering_estimate(self):
        doc = _doc()
        del doc["grid"]["power_factor"]
        pf = load_document(doc).context.power.grid.power_factor
        assert pf.evidence == E0


def _quantities(res):
    out = []
    env = [res.envelope, res.ladder.final]
    for e in env:
        out += [e.it_load_kW, e.facility_load_kW] + [c.max_racks for c in e.constraints]
    for st in res.ladder.steps:
        out += [q for q in (st.capex_eur, st.lead_time_weeks) if q is not None]
    ec = res.economics
    out += [ec.capex_total_eur, ec.capex_conversion_eur, ec.capex_relief_eur, ec.annual_energy_cost_eur,
            ec.annual_energy_MWh, ec.energy_cost_per_gpu_hour_eur, ec.capex_eur_per_kW_it]
    return out


# =====================================================================================================================
# Evidence never rises above the inputs; intervals are never narrower than the inputs'
# =====================================================================================================================
@pytest.mark.parametrize("path", [pytest.param(p, id=p.name) for p in ALL_INTAKES])
def test_no_derived_quantity_is_stronger_than_any_input_it_was_computed_from(path):
    intake = load_document(json.loads(path.read_text()))
    checked = 0
    for r in run_all(intake.context, intake.scenarios):
        for q in _quantities(r):
            for node in q.prov.walk():
                if node.model_id == "input":
                    continue
                for parent in node.inputs:
                    assert node.evidence <= parent.evidence, (
                        f"{r.spec.id}: {node.label!r} is {node.evidence.name} but input {parent.label!r} "
                        f"is {parent.evidence.name}")
                    checked += 1
    assert checked > 500


def test_the_total_capex_band_is_never_narrower_than_the_cost_library_band_for_its_weakest_line():
    from gridforge.costs import BAND_BY_EVIDENCE
    r = run(build_context(), SCENARIOS[2])
    e = r.economics
    lo_f, hi_f = BAND_BY_EVIDENCE[e.capex_relief_eur.evidence]
    assert e.capex_relief_eur.band[0] <= e.capex_relief_eur.value * lo_f + 1e-6
    assert e.capex_relief_eur.band[1] >= e.capex_relief_eur.value * hi_f - 1e-6


def test_rack_count_band_brackets_the_nominal_count():
    for spec in SCENARIOS:
        r = run(build_context(), spec)
        for c in r.ladder.final.constraints:
            lo, hi = c.max_racks.band
            assert lo <= c.max_racks.value <= hi or c.max_racks.value == math.inf, (spec.id, c.id)


def test_the_envelope_never_overstates_an_e0_chain_as_customer_data():
    ctx = build_context()
    ctx.architecture = Architecture.HYBRID_DLC
    r = run(ctx, SCENARIOS[2])
    assert r.economics.capex_total_eur.evidence == E0
    assert r.envelope.it_load_kW.evidence == E0


# =====================================================================================================================
# Determinism
# =====================================================================================================================
_FINGERPRINT = """
import hashlib, json
from gridforge.intake.loader import load
from gridforge.scenario import run_all
from gridforge.serialize import scenario_dict
it = load({intake!r})
rs = run_all(it.context, it.scenarios)
blob = json.dumps([scenario_dict(r) for r in rs], sort_keys=True, default=str)
print(hashlib.sha256(blob.encode()).hexdigest())
"""


def _fingerprint(prelude="", env=None, intake=REFERENCE_INTAKE):
    r = subprocess.run([sys.executable, "-c", prelude + _FINGERPRINT.format(intake=str(intake))], cwd=ROOT,
                       env={**os.environ, "GRIDFORGE_REPORT_DATE": "2026-01-01", **(env or {})},
                       capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    return r.stdout.strip()


class TestDeterminism:
    def test_same_input_same_results_and_same_provenance_digests_in_process(self):
        a = [scenario_dict(r) for r in run_all(build_context(), SCENARIOS)]
        b = [scenario_dict(r) for r in run_all(build_context(), SCENARIOS)]
        assert json.dumps(a, sort_keys=True, default=str) == json.dumps(b, sort_keys=True, default=str)

    def test_hash_randomisation_does_not_change_a_single_digit_or_digest(self):
        prints = {_fingerprint(env={"PYTHONHASHSEED": seed}) for seed in ("0", "1", "4242")}
        assert len(prints) == 1, "result depends on set/dict iteration order"

    def test_import_order_does_not_change_which_constraint_binds(self):
        plain = _fingerprint()
        thermal_first = _fingerprint(prelude="import gridforge.thermal.constraints\n")
        site_first = _fingerprint(prelude="import gridforge.site.constraints\n")
        assert plain == thermal_first == site_first

    def test_json_round_trip_and_key_order_do_not_change_the_answer(self):
        doc = _doc()

        def reverse(o):
            if isinstance(o, dict):
                return {k: reverse(o[k]) for k in reversed(list(o))}
            if isinstance(o, list):
                return [reverse(x) for x in o]
            return o

        def fp(d):
            it = load_document(d)
            return json.dumps([scenario_dict(r) for r in run_all(it.context, it.scenarios)], sort_keys=True,
                              default=str)

        base = fp(doc)
        assert fp(json.loads(json.dumps(doc))) == base
        assert fp(reverse(doc)) == base

    def test_cli_and_python_api_agree_on_the_comparison(self, tmp_path, monkeypatch):
        monkeypatch.setenv("GRIDFORGE_REPORT_DATE", "2026-01-01")
        out = tmp_path / "cmp"
        r = subprocess.run([sys.executable, "-m", "gridforge", "compare", str(REFERENCE_INTAKE), "-o", str(out)],
                           cwd=ROOT, env={**os.environ, "GRIDFORGE_REPORT_DATE": "2026-01-01"},
                           capture_output=True, text=True)
        assert r.returncode == 0, r.stderr
        cli = json.loads((out / "ttp_compare.json").read_text())
        api = json.loads(json.dumps(handle_compare({"intake": _doc()}, Tier.CLIENT)))     # HTTP body round trip
        assert cli["request_digest"] == api["request_digest"]
        assert cli == api

    @pytest.mark.parametrize("path", [pytest.param(p, id=p.name) for p in ALL_INTAKES])
    def test_every_published_payload_is_strict_json(self, path):
        doc = json.loads(path.read_text())
        json.dumps(handle_compare({"intake": doc}, Tier.CLIENT), allow_nan=False)
        it = load_document(doc)
        json.dumps(model_pack(it, run_all(it.context, it.scenarios)), allow_nan=False)

    def test_a_changed_input_changes_the_request_digest(self):
        a = handle_compare({"intake": _doc()}, Tier.CLIENT)["request_digest"]
        d = _doc()
        d["lv"]["tapoff_max_A"] = 125
        b = handle_compare({"intake": d}, Tier.CLIENT)["request_digest"]
        assert a != b

    @pytest.mark.xfail(strict=True, reason=(
        "KNOWN LIMITATION, NOT FIXED: Provenance.digest hashes label, model, version, evidence class and the input "
        "digests but not the VALUE, so two inputs with the same label and class but different numbers share a "
        "digest. The digest identifies lineage, not content; the request digest (which covers the intake) is what "
        "changes with the numbers. Fixing it needs the value carried on Provenance and re-issues every digest."))
    def test_the_provenance_digest_of_a_leaf_covers_its_value(self):
        assert V(100, "kW", "same label", ASSUMED).prov.digest != V(200, "kW", "same label", ASSUMED).prov.digest


def test_floating_point_noise_does_not_flip_a_rack_count():
    # 1,900 kW / 135 kW = 14.07: a 1e-9 relative perturbation of the inputs moves the count by nothing.
    for eps in (-1e-9, 0.0, 1e-9):
        ctx = build_context()
        ctx.thermal.plant.chilled_water_capacity_kW = V(6800 * (1 + eps), "kW", "plant", CUSTOMER)
        assert plant_capacity(ctx).racks == 14


def test_a_rack_count_exactly_on_an_integer_floors_to_that_integer():
    # headroom 2,700 kW / 135 kW per rack = exactly 20 racks; (6,800 - 4,900 = 1,900; raise plant to 7,600 -> 2,700)
    ctx = build_context()
    ctx.thermal.plant.chilled_water_capacity_kW = V(7600, "kW", "plant", CUSTOMER)
    assert plant_capacity(ctx).racks == 20
