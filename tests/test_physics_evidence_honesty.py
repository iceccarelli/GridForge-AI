"""Evidence honesty in the cost, economics, ranking and procurement layers (independent review, round 2).

Each section is one reproduced defect. The common thread is the honesty kernel: a basis a reviewer typed is a claim,
not a proof; arithmetic inherits the weakest input; a missing value never defaults to a credible number; an undated
scenario never wins 'fastest'.
"""
import copy
import dataclasses
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from gridforge.api import server as S
from gridforge.api.compare_payload import _rank
from gridforge.common import ASSUMED, V
from gridforge.costs import (AACE_BY_EVIDENCE, BAND_BY_EVIDENCE, CostEntry, CostLibrary, cost_overlay, declared_unit,
                             reload_library)
from gridforge.intake.loader import load_document
from gridforge.scenario.objective import Objective, pick_recommended
from gridforge.scenario.run import run_all
from gridforge.validation import EvidenceClass as E
from payg_rig import rig  # noqa: F401  (fixture)

ROOT = Path(__file__).resolve().parents[1]


def doc(name="dublin_hall"):
    return json.loads((ROOT / "examples" / "intake" / f"{name}.json").read_text())


def solve(d, scenario_id=None):
    intake = load_document(copy.deepcopy(d))
    results = run_all(intake.context, intake.scenarios)
    if scenario_id is None:
        return intake, results
    return intake, {r.spec.id: r for r in results}[scenario_id]


def line(key="x.y", basis="firm_quote", **kw):
    base = dict(key=key, label=key, unit="EUR", value=100.0, basis=basis, supplier="Synthetic Supplier Ltd",
                quoted_on="2026-09-01", valid_until="2099-12-31", region="IE", synthetic=True)
    base.update(kw)
    return base


@pytest.fixture
def private_library(tmp_path, monkeypatch):
    path = tmp_path / "cost_library.local.json"

    def install(entries):
        path.write_text(json.dumps({"entries": entries}))
        monkeypatch.setenv("GRIDFORGE_COST_LIBRARY", str(path))
        return reload_library()

    yield install
    monkeypatch.delenv("GRIDFORGE_COST_LIBRARY", raising=False)
    reload_library()


# === 1. a basis is a claim, not a proof =============================================================================

def test_a_firm_quote_with_no_validity_date_is_not_accepted_at_e5():
    undated = CostEntry(**line(valid_until=None))
    dated = CostEntry(**line())
    assert dated.evidence == E.E5_CUSTOMER_DATA
    assert undated.evidence == E.E3_ENGINEERING_ESTIMATE, "a quotation that never expires is not a firm quotation"
    q = undated.quantity()
    assert q.evidence == E.E3_ENGINEERING_ESTIMATE
    assert any("valid_until" in a for a in q.prov.all_assumptions()), "the provenance says why it was held back"
    lo, hi = BAND_BY_EVIDENCE[E.E3_ENGINEERING_ESTIMATE]
    assert q.band == pytest.approx((100.0 * lo, 100.0 * hi))


def test_contracted_is_never_granted_e7_by_a_cost_line():
    e = CostEntry(**line(basis="contracted", valid_until=None))
    assert e.evidence == E.E5_CUSTOMER_DATA
    assert e.quantity().evidence == E.E5_CUSTOMER_DATA
    assert any("E7" in a for a in e.quantity().prov.all_assumptions())
    lib = CostLibrary()
    lib.put(e)
    assert lib.weakest([e.key]) == E.E5_CUSTOMER_DATA
    assert lib.aace_class([e.key]) == AACE_BY_EVIDENCE[E.E5_CUSTOMER_DATA]


def test_an_overlay_lines_downgrade_is_reported_not_silent():
    with cost_overlay([line("a.b", valid_until=None), line("c.d", basis="contracted"), line("e.f")]) as rep:
        assert {d["key"] for d in rep.downgraded} == {"a.b", "c.d"}
        from gridforge.costs import library
        assert library().get("a.b").quantity().evidence == E.E3_ENGINEERING_ESTIMATE
        assert library().get("c.d").quantity().evidence == E.E5_CUSTOMER_DATA
        assert library().get("e.f").quantity().evidence == E.E5_CUSTOMER_DATA
    assert "downgraded" in rep.to_dict()


def test_an_expired_quotation_is_counted_as_expired_not_as_a_firm_quote_in_the_basis_mix():
    lib = CostLibrary()
    lib.put(CostEntry(**line("k.expired", valid_until="2020-06-30")))
    lib.put(CostEntry(**line("k.undated", valid_until=None)))
    lib.put(CostEntry(**line("k.firm")))
    mix = lib.basis_mix(["k.expired", "k.undated", "k.firm", "k.absent"])
    assert mix == {"expired_quote": 1, "firm_quote_undated": 1, "firm_quote": 1, "library_default": 1}


# === 2. decision grade and the band of the total ====================================================================

def _every_line_quoted(results_scenario, basis, **kw):
    keys = sorted(k for k in results_scenario.ladder.cost_keys if "." in k) + ["conversion.per_rack"]
    return [line(k, basis=basis, unit=declared_unit(k), value=1000.0, **kw) for k in dict.fromkeys(keys)]


def test_the_total_capex_band_and_class_follow_its_own_evidence_not_the_best_lines():
    _, base = solve(doc(), "full_dlc")
    entries = _every_line_quoted(base, "contracted")
    with cost_overlay(entries):
        _, r = solve(doc(), "full_dlc")
    e = r.economics
    inherited = e.capex_input_evidence
    # The racks the conversion is priced on rest on the hall's own (E0) inputs: the total cannot be firmer than that.
    assert inherited == E.E0_ASSUMPTION and e.capex_total_eur.evidence == E.E0_ASSUMPTION
    lo_f, hi_f = BAND_BY_EVIDENCE[inherited]
    assert e.capex_total_eur.band[0] <= e.capex_total_eur.value * lo_f + 1e-6
    assert e.capex_total_eur.band[1] >= e.capex_total_eur.value * hi_f - 1e-6
    assert e.aace_class == AACE_BY_EVIDENCE[inherited], "no 'Class 1 (check estimate)' on an E0 total"
    assert not e.decision_grade


def _grade_ready(e):
    """A result with every other reason for 'not decision-grade' removed, so one reason can be tested alone."""
    return dataclasses.replace(
        e, unpriced=[], synthetic_evidence=[], limited=[], tariff_declared=True, btm=None, horizon_years=10,
        cost_basis_mix={"firm_quote": 3}, stale_lines=[], weakest_line_evidence=E.E5_CUSTOMER_DATA,
        capex_input_evidence=E.E5_CUSTOMER_DATA, nothing_deployable=False)


def test_decision_grade_needs_fresh_lines_at_e3_or_better_and_a_total_at_e3_or_better():
    _, r = solve(doc(), "full_dlc")
    ready = _grade_ready(r.economics)
    assert ready.decision_grade, "the property is reachable when every line and the total are firm and fresh"
    assert not dataclasses.replace(ready, stale_lines=["transformer.replacement"]).decision_grade
    assert not dataclasses.replace(ready, weakest_line_evidence=E.E1_MODEL).decision_grade
    assert not dataclasses.replace(ready, capex_input_evidence=E.E1_MODEL).decision_grade
    assert not dataclasses.replace(ready, nothing_deployable=True).decision_grade
    for kw in (dict(stale_lines=["k"]), dict(weakest_line_evidence=E.E0_ASSUMPTION),
               dict(capex_input_evidence=E.E1_MODEL)):
        assert dataclasses.replace(ready, **kw).limitations, "and the reason is printed"


def test_a_stale_priced_line_is_named_and_blocks_decision_grade_end_to_end(private_library):
    private_library([line("transformer.replacement", value=700_000.0, valid_until="2020-06-30")])
    _, r = solve(doc(), "full_dlc_btm")
    e = r.economics
    assert "transformer.replacement" in e.stale_lines
    assert "firm_quote" not in e.cost_basis_mix and e.cost_basis_mix.get("expired_quote") == 1
    assert not e.decision_grade
    assert any("expired quotation" in x for x in e.limitations)


# === 3. 'fastest' names no leader on a tie, and racks never decide it ================================================

def _row(i, weeks, racks, cls="E3"):
    return {"id": i, "after_ladder": {"racks": racks},
            "time_to_power": {"weeks": weeks, "reason": None if weeks is not None else "no date", "evidence": cls},
            "economics": {"capex_complete": True, "capex_total_eur": {"value": 1.0}}}


def test_equal_weeks_at_the_same_evidence_class_is_a_tie_whatever_the_rack_counts():
    rk = _rank([_row("a", 30.0, 100), _row("b", 30.0, 140)], Objective.FASTEST_TO_POWER)
    assert rk["tie"] is True and rk["leader"] is None
    assert "not more capacity" not in rk["note"]
    assert "level" in rk["note"] and "does not decide who is fastest" in rk["note"]
    assert rk["order"] == ["b", "a"], "racks may order a tie for display, never name a leader"
    # ...and a different evidence class at the same weeks is level too: the date alone decides who is fastest.
    rk2 = _rank([_row("a", 30.0, 100, "E3"), _row("b", 30.0, 140, "E0")], Objective.FASTEST_TO_POWER)
    assert rk2["tie"] is True and rk2["leader"] is None


def test_a_real_difference_in_weeks_still_names_the_leader():
    rk = _rank([_row("a", 30.0, 100), _row("b", 28.0, 90)], Objective.FASTEST_TO_POWER)
    assert rk["tie"] is False and rk["leader"] == "b"


def test_undated_scenarios_are_excluded_from_fastest_and_never_lead():
    rk = _rank([_row("a", None, 500), _row("b", 40.0, 10)], Objective.FASTEST_TO_POWER)
    assert rk["leader"] == "b" and [x["id"] for x in rk["excluded"]] == ["a"]
    none = _rank([_row("a", None, 500), _row("b", None, 10)], Objective.FASTEST_TO_POWER)
    assert none["leader"] is None and none["order"] == []


def test_pick_recommended_for_fastest_does_not_fall_back_to_racks_when_every_candidate_is_undated(monkeypatch):
    import gridforge.envelope.time_to_power as ttp
    monkeypatch.setattr(ttp, "schedule", lambda ladder: SimpleNamespace(weeks_to_full=None))
    cands = [SimpleNamespace(spec=SimpleNamespace(id=n), unlocked_racks=n, ladder=None) for n in (10, 50, 30)]
    first = pick_recommended(cands, Objective.FASTEST_TO_POWER)
    assert first is cands[0], "no date, so no winner on capacity: the caller's own order stands"
    assert pick_recommended(list(reversed(cands)), Objective.FASTEST_TO_POWER) is cands[-1]


def test_pick_recommended_for_fastest_prefers_a_dated_candidate_whatever_the_racks(monkeypatch):
    import gridforge.envelope.time_to_power as ttp
    monkeypatch.setattr(ttp, "schedule", lambda ladder: SimpleNamespace(weeks_to_full=ladder))
    undated_big = SimpleNamespace(unlocked_racks=900, ladder=None)
    dated_small = SimpleNamespace(unlocked_racks=10, ladder=40.0)
    dated_later = SimpleNamespace(unlocked_racks=500, ladder=55.0)
    assert pick_recommended([undated_big, dated_later, dated_small], Objective.FASTEST_TO_POWER) is dated_small


# === 4. a bid with no install time is not a complete bid ============================================================

def _spec_and_bids():
    from gridforge.intake.loader import load
    from gridforge.procurement import SupplierResponse, build_spec, relief_steps
    intake = load(ROOT / "examples" / "intake" / "reference_hall.json")
    results = run_all(intake.context, intake.scenarios)
    best = max(results, key=lambda r: r.unlocked_racks)
    pkg = build_spec(intake, best, constraint_id=relief_steps(best)[0].binding_id)
    budget = pkg.budget_eur.value if getattr(pkg, "budget_eur", None) is not None else 1_000_000.0

    def bid(supplier, capex_x, lead, install):
        values = {"capex_eur": budget * capex_x, "lead_time_weeks": lead}
        if install is not None:
            values["install_weeks"] = install
        return SupplierResponse.from_dict({
            "supplier": supplier, "received_on": "2026-10-01", "valid_until": "2026-12-31", "values": values,
            "compliance": {q.id: "C" for q in pkg.mandatory()}})
    return pkg, bid


def test_a_bid_with_no_install_time_is_lead_only_flagged_and_ranked_after_complete_bids():
    from gridforge.procurement import rank_bids
    from gridforge.procurement.evaluate import schedule_impact
    pkg, bid = _spec_and_bids()
    ranked = rank_bids(pkg, [bid("Cheap-and-silent", 0.9, 10, None), bid("Complete-A", 1.0, 10, 6),
                             bid("Complete-B", 1.1, 14, 6)])
    names = [a.supplier for a in ranked]
    assert names[-1] == "Cheap-and-silent", "an incomplete programme never outranks a complete one"
    silent = ranked[-1]
    assert silent.install_weeks_missing is True and silent.install_weeks is None
    assert silent.weeks_to_energised == 10 and silent.programme_basis == "lead_only"
    assert silent.needs_engineering_review is True
    assert any("install time not quoted" in n for n in silent.notes)
    assert "install time not quoted" in silent.headline()
    assert "lower bound" in schedule_impact(pkg, silent) and "unknown" in schedule_impact(pkg, silent)
    assert silent.scores["C2"] == 0.0, "a lead-only figure is not scored as a complete programme"
    complete = [a for a in ranked if not a.install_weeks_missing]
    assert all(a.programme_basis == "complete" and not a.needs_engineering_review for a in complete)
    # The lead-only 10 weeks does not become the 'best' programme the complete bids are scaled against.
    a_bid = next(a for a in ranked if a.supplier == "Complete-A")
    assert a_bid.weeks_to_energised == 16 and a_bid.scores["C2"] > 0


def test_a_bid_that_states_a_zero_week_install_is_complete_not_flagged():
    from gridforge.procurement import rank_bids
    pkg, bid = _spec_and_bids()
    a = next(a for a in rank_bids(pkg, [bid("Zero", 1.0, 10, 0), bid("Other", 1.0, 12, 4)]) if a.supplier == "Zero")
    assert a.install_weeks_missing is False and a.programme_basis == "complete" and a.weeks_to_energised == 10


# === 5. engine-domain failures are the caller's input, an implausible site says so ====================================

def _unbounded_intake():
    d = doc("reference_hall")
    d["hall"].update(positions_available=1e12, rack_positions=1e12, floor_loading_kPa=1e9, net_white_space_m2=1e12)
    d["grid"].update(firm_capacity_MVA=1e9, contracted_MW=1e9)
    return d


def test_the_unbounded_intake_really_does_not_converge():
    from gridforge.envelope.solver import LadderDidNotConverge
    with pytest.raises(LadderDidNotConverge):
        solve(_unbounded_intake())


def test_ladder_non_convergence_is_a_422_and_refunded_over_rest(rig):
    key = rig.key("payg", quota=50)
    s, b, h = rig.post("/v1/screen", _unbounded_intake(), key=key)
    assert s == 422 and b["error"] == "the request could not be processed as given"
    assert h["X-GridForge-Charge-Cents"] == "0" and rig.meter.current("acme").units == 0
    assert [e["kind"] for e in rig.events()] == ["charge", "refund"]


def test_ladder_non_convergence_is_invalid_arguments_and_refunded_over_mcp(rig):
    key = rig.key("payg", quota=50)
    call = {"jsonrpc": "2.0", "id": 1, "method": "tools/call",
            "params": {"name": "gridforge_screen", "arguments": {"intake": _unbounded_intake()}}}
    s, b, h = rig.post("/mcp", call, key=key)
    assert s == 200 and b["error"]["code"] == -32602 and "LadderDidNotConverge" in b["error"]["message"]
    assert h["X-GridForge-Charge-Cents"] == "0" and rig.meter.current("acme").units == 0


def test_an_ordinary_runtime_error_is_still_our_fault(rig, monkeypatch):
    def boom(body, tier):
        raise RuntimeError("our bug")
    monkeypatch.setitem(S.ROUTES, "/v1/screen", (boom, S.Tier.CLIENT))
    s, b, _ = rig.post("/v1/screen", doc(), key=rig.key("payg", quota=50))
    assert s == 500 and b["error"] == "engine error"


@pytest.mark.parametrize("rack_kW", [0.0, -5.0, float("nan")])
def test_a_platform_with_no_rack_power_is_refused_at_load(monkeypatch, rack_kW):
    from gridforge.compute import library as lib
    gb = lib.PLATFORMS["gb300_nvl72"]
    bad = dataclasses.replace(gb, id="zero_kw", rack_kW=V(rack_kW, "kW", "rack power", ASSUMED))
    monkeypatch.setitem(lib.PLATFORMS, "zero_kw", bad)
    d = doc()
    d["compute"] = {"platform": "zero_kw"}
    # An IntakeError is a ValueError and so is a PlatformError: the API maps both to 422 (refunded).
    with pytest.raises(ValueError, match="rack_kW") as err:
        load_document(d)
    assert type(err.value).__name__ in ("PlatformError", "IntakeError")


def test_a_connection_that_cannot_carry_the_load_already_on_it_carries_a_warning():
    d = doc()
    d["grid"].update(firm_capacity_MVA=1.0, contracted_MW=1.0, current_site_peak_MW=40.0, current_it_load_MW=40.0)
    body = S.handle_screen({"intake": d}, S.Tier.CLIENT)
    assert all(s["after_ladder"]["racks"] == 0 for s in body["scenarios"])
    warns = body["intake"]["warnings"]
    assert any("cannot cover" in w and "current IT load" in w for w in warns), warns
    # A sane site is not warned.
    ok = S.handle_screen({"intake": doc()}, S.Tier.CLIENT)
    assert not any("cannot cover" in w for w in ok["intake"]["warnings"])


def test_a_scenario_that_deploys_nothing_has_no_capex_not_a_complete_zero():
    d = doc("reference_hall")
    d["hall"]["positions_available"] = 0
    _, results = solve(d)
    for r in results:
        e = r.economics
        assert r.unlocked_racks == 0 and e.nothing_deployable is True
        assert e.capex_complete is False
        assert any("n/a (nothing deployable)" in x for x in e.limitations)
        assert e.aace_class.startswith("n/a: nothing deployable")
        assert not e.decision_grade
    d2 = doc("reference_hall")
    intake, ok = solve(d2)
    assert all(not r.economics.nothing_deployable for r in ok if r.unlocked_racks > 0)


def test_the_comparison_row_of_a_zero_rack_scenario_says_capex_is_n_a():
    from gridforge.api.compare_payload import _scenario
    d = doc("reference_hall")
    d["hall"]["positions_available"] = 0
    _, results = solve(d)
    row = _scenario(results[0])
    assert row["economics"]["capex_total_eur"] is None
    assert row["economics"]["capex_na_reason"] == "n/a: nothing deployable"
    assert row["economics"]["capex_complete"] is False


def test_economics_dict_of_a_zero_rack_scenario_has_null_figures_but_keeps_provenance():
    from gridforge.serialize import economics_dict
    d = doc("reference_hall")
    d["hall"]["positions_available"] = 0
    _, results = solve(d)
    econ = economics_dict(results[0])
    assert econ["nothing_deployable"] is True and econ["capex_na_reason"] == "n/a: nothing deployable"
    for key in ("capex_total_eur", "capex_per_kW_it"):
        q = econ[key]
        assert q is not None and q["value"] is None and q["low"] is None and q["high"] is None, "never 0 EUR"
        assert q["evidence"] and q["digest"], "the model pack still carries the evidence on the number"
