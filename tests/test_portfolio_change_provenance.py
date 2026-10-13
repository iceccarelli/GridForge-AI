"""Portfolio Screen and Change Note: every number is labelled by what determines it.

The study (PR #51) derives a rack count's class from the constraints that cap it, a date's band from the lead
times that set it, and capex's band from the prices it sums. Portfolio and the change note had kept their own
labels: ``V(x, ..., ESTIMATED)`` over every rack count and date, ``ASSUMED`` with a fixed x0.5/x2 band over every
capex, and a capex-per-rack that divided by ``max(racks, 1)``. These tests use the real solver, reports, gates
and API handlers; the ones named ``..._old_behaviour...`` fail against the code before this change.
"""
from __future__ import annotations

import copy
import json
import math
from dataclasses import replace
from pathlib import Path

import pytest

from gridforge.api.server import Tier, handle_diff, handle_portfolio
from gridforge.change import EnvelopeState, diff, diff_from_state
from gridforge.common import V
from gridforge.costs import CostEntry, CostLibrary, reload_library
from gridforge.economics.model import evaluate
from gridforge.envelope.time_to_power import schedule
from gridforge.intake.loader import load_document
from gridforge.reporting import to_html, to_markdown
from gridforge.reporting.change_note import build as build_note
from gridforge.reporting.gates import run_all_gates
from gridforge.reporting.labels import capex_per_rack_q, full_capacity_q, rack_class, schedule_complete
from gridforge.reporting.portfolio import SiteEntry, build, portfolio_rows, rank
from gridforge.reporting.study import collect_claims
from gridforge.scenario.objective import Objective, pick_recommended
from gridforge.scenario.run import run_all
from gridforge.validation import EvidenceClass

ROOT = Path(__file__).resolve().parents[1]
INTAKES = ROOT / "examples" / "intake"
E = EvidenceClass


def doc(name):
    return json.loads((INTAKES / f"{name}.json").read_text())


def moved(base, **changes):
    d = copy.deepcopy(base)
    for path, value in changes.items():
        cur = d
        parts = path.split(".")
        for p in parts[:-1]:
            cur = cur.setdefault(p, {})
        existing = cur.get(parts[-1])
        if isinstance(existing, dict) and "value" in existing:
            existing["value"] = value
        else:
            cur[parts[-1]] = value
    return d


def entry(d, objective=Objective.MAX_COMPUTE):
    intake = load_document(copy.deepcopy(d))
    return SiteEntry(intake=intake, results=run_all(intake.context, intake.scenarios), objective=objective)


def renamed(d, site_id, hall_id):
    d = copy.deepcopy(d)
    d["site"]["id"] = site_id
    d["hall"]["id"] = hall_id
    return d


def render_gated(report, entries):
    md = to_markdown(report)
    claims = collect_claims([r for e in entries for r in e.results])
    run_all_gates(report, md, claims)       # the gates must still pass on the new labels
    return md


@pytest.fixture(scope="module")
def halls():
    return {n: entry(doc(n)) for n in ("reference_hall", "london_hall", "nordic_hall", "dublin_hall")}


@pytest.fixture
def quoted_library(tmp_path):
    """A cost library in which every line a ladder uses is a firm quotation (still valid)."""
    prices = {"tapoff.unit": (6000, "EUR/rack"), "inrow_rdhx.per_rack": (9000, "EUR/rack"),
              "transformer.replacement": (1_200_000, "EUR"), "ups.per_kW": (320, "EUR/kW"),
              "busway.replacement": (450_000, "EUR"), "plant.uprate": (900_000, "EUR"),
              "cdu.addition": (180_000, "EUR"), "trim_chiller.adiabatic": (350_000, "EUR"),
              "floor.load_spreading": (260_000, "EUR"), "pump.uprate": (420_000, "EUR"),
              "grid.reinforcement": (2_500_000, "EUR"), "conversion.per_rack": (55_000, "EUR/rack")}
    lib = CostLibrary()
    for k, (v, u) in prices.items():
        lib.put(CostEntry(key=k, label=k, unit=u, value=v, basis="firm_quote", supplier="Acme",
                          quoted_on="2026-09-01", valid_until="2099-12-31", region="DE"))
    path = lib.save(tmp_path / "cost_library.local.json")
    reload_library(path)
    yield path
    reload_library(tmp_path / "does-not-exist.json")


# --- A. evidence reflects provenance ---------------------------------------------------------------------------
def test_rack_counts_are_never_stronger_than_the_constraints_that_cap_them_old_behaviour_said_E3(halls):
    entries = list(halls.values())
    report = build(entries)
    rack_qs = [q for q in report.quantities() if q.unit == "racks"]
    assert rack_qs
    weakest = min(rack_class(e.best) for e in entries)
    assert weakest is E.E0_ASSUMPTION, "premise: the reference halls rest on library defaults"
    assert all(q.evidence <= E.E0_ASSUMPTION for q in rack_qs), (
        "portfolio asserted E3 'engineering estimate' over rack counts the study itself labels E0")


def test_a_rack_count_takes_the_weakest_constraint_even_when_the_rest_are_strong(halls):
    res = copy.deepcopy(halls["nordic_hall"].best)
    for r in (res.envelope, res.ladder.final):
        for c in r.constraints:
            if c.max_racks.value != math.inf:
                c.max_racks = V(c.max_racks.value, "racks", c.id, E.E5_CUSTOMER_DATA)
    assert rack_class(res) is E.E5_CUSTOMER_DATA
    weak = next(c for c in res.ladder.final.constraints if c.max_racks.value != math.inf)
    weak.max_racks = V(weak.max_racks.value, "racks", weak.id, E.E1_MODEL)       # one weak assumption
    assert rack_class(res) is E.E1_MODEL
    e = replace(halls["nordic_hall"], results=[res])
    q = next(q for q in build([e]).quantities() if q.unit == "racks" and "deployable racks" in q.prov.label)
    assert q.evidence is E.E1_MODEL, "one weak decision-relevant input must set the class of the count"


def test_the_total_and_the_counts_of_halls_take_the_weakest_hall(halls):
    strong = copy.deepcopy(halls["nordic_hall"])
    res = strong.best
    for r in (res.envelope, res.ladder.final):
        for c in r.constraints:
            if c.max_racks.value != math.inf:
                c.max_racks = V(c.max_racks.value, "racks", c.id, E.E5_CUSTOMER_DATA)
    report = build([strong, halls["london_hall"]])
    total = next(b.value for s in report.sections for b in s.blocks if getattr(b, "label", "").startswith("Total"))
    assert total.evidence is E.E0_ASSUMPTION       # london is on defaults; the sum cannot be stronger


# --- B. uncertainty is derived, not multiplied -----------------------------------------------------------------
def test_time_to_power_carries_the_band_of_the_lead_times_that_set_it_old_behaviour_had_none(halls):
    e = halls["nordic_hall"]
    q = full_capacity_q(e.best.ladder, schedule(e.best.ladder), "x")
    assert q is not None and q.band[0] < q.value < q.band[1]
    longest = max((s.lead_time_weeks for s in e.best.ladder.taken_steps), key=lambda x: x.value)
    assert q.value == longest.value and q.band[1] >= longest.band[1], "the band must contain the binding lead time's own"
    row = next(r for r in portfolio_rows([e])[:1])
    assert row["weeks_band"] == list(q.band) and row["weeks_evidence"] == q.evidence.name


def test_capex_is_the_economic_calculation_not_a_fixed_multiplier_old_behaviour_was_x05_x2(halls, quoted_library):
    default = entry(doc("nordic_hall"))
    # quotations: a narrower, more evidenced estimate must flow through to the portfolio
    quoted = entry(doc("nordic_hall"))
    assert quoted.capex_q.evidence >= default.capex_q.evidence
    lo, hi = quoted.capex_q.band
    assert hi / quoted.capex < 2.0 and lo / quoted.capex > 0.5, "a firm-quoted ladder must narrow the capex band"
    assert quoted.capex_q is quoted.best.economics.capex_total_eur
    row = portfolio_rows([quoted])[0]
    assert row["capex_band_eur"] == list(quoted.capex_q.band) and row["capex_evidence"] == quoted.capex_q.evidence.name


def test_capex_without_quotes_keeps_the_class_5_band(halls):
    e = halls["nordic_hall"]
    lo, hi = e.capex_q.band
    assert lo <= e.capex * 0.5 + 1 and hi >= e.capex * 2.0 - 1, "library defaults must not look firmer than Class 5"


def test_capex_per_rack_is_the_division_of_the_capex_estimate(halls):
    e = halls["nordic_hall"]
    cpr = e.capex_per_rack_q
    assert cpr.value == pytest.approx(e.capex / e.racks)
    assert cpr.band == (pytest.approx(e.capex_q.band[0] / e.racks), pytest.approx(e.capex_q.band[1] / e.racks))
    assert cpr.unit == "EUR/rack" and cpr.evidence <= e.capex_q.evidence


def test_per_rack_relief_prices_are_in_euros_not_euros_per_rack(halls):
    steps = [s for s in halls["reference_hall"].best.ladder.taken_steps if s.cost_key == "tapoff.unit"]
    assert steps and all(s.capex_eur.unit == "EUR" for s in steps), "EUR/rack x racks is EUR"


# --- C. maths and ranking --------------------------------------------------------------------------------------
@pytest.fixture(scope="module")
def zero_hall():
    return entry(moved(doc("london_hall"), **{"hall.positions_available": 0}))


def test_zero_racks_means_capex_per_rack_is_undefined_not_capex_over_one_rack(zero_hall):
    assert zero_hall.racks == 0
    assert capex_per_rack_q(zero_hall.best, "x") is None
    assert zero_hall.capex_per_rack == math.inf
    row = portfolio_rows([zero_hall])[0]
    assert row["capex_per_rack_eur"] is None and row["capex_per_rack_band_eur"] is None
    assert row["weeks_to_full"] is None and "no deployable racks" in row["rank_note"]
    md = render_gated(build([zero_hall]), [zero_hall])
    assert "no deployable racks" in md.lower()


@pytest.mark.parametrize("objective", list(Objective))
def test_a_hall_with_nothing_deployable_never_outranks_one_that_can_take_the_platform(halls, zero_hall, objective):
    for order in ([zero_hall, halls["london_hall"]], [halls["london_hall"], zero_hall]):
        ordered = rank(order, objective)
        assert ordered[0].racks > 0 and ordered[-1].racks == 0, (
            f"{objective}: an empty hall (capex of one made-up rack) must not rank first")


def test_a_missing_lead_time_gives_no_date_instead_of_zero_weeks(halls):
    e = copy.deepcopy(halls["nordic_hall"])
    taken = e.best.ladder.taken_steps
    longest = max(taken, key=lambda s: s.lead_time_weeks.value)
    assert schedule(e.best.ladder).weeks_to_full == longest.lead_time_weeks.value
    for s in taken:
        s.lead_time_weeks = None
    assert not schedule_complete(e.best.ladder)
    assert full_capacity_q(e.best.ladder, schedule(e.best.ladder), "x") is None
    assert e.weeks == math.inf
    row = portfolio_rows([e])[0]
    assert row["weeks_to_full"] is None and row["schedule_complete"] is False
    md = render_gated(build([e], objective=Objective.FASTEST_TO_POWER), [e])
    assert "lead time is missing" in md


def test_an_incomplete_schedule_ranks_below_a_dated_hall_on_fastest(halls):
    undated = copy.deepcopy(halls["nordic_hall"])         # most racks, but its date is unknown
    for s in undated.best.ladder.taken_steps:
        s.lead_time_weeks = None
    ordered = rank([undated, halls["london_hall"]], Objective.FASTEST_TO_POWER)
    assert ordered[0].ident == halls["london_hall"].ident and "no lead time" in portfolio_rows(
        [undated, halls["london_hall"]], Objective.FASTEST_TO_POWER)[1]["rank_note"]


def test_an_unpriced_relief_marks_capex_as_a_lower_bound(halls):
    res = copy.deepcopy(halls["nordic_hall"].best)
    res.ladder.taken_steps[0].capex_eur = None
    econ = evaluate(res.ladder.final, res.ladder, res.context.cluster.utilisation)
    assert econ.capex_complete is False
    res.economics = econ
    e = replace(halls["nordic_hall"], results=[res])
    assert "unpriced" in portfolio_rows([e])[0]["rank_note"]
    assert portfolio_rows([e])[0]["capex_complete"] is False


@pytest.mark.parametrize("objective", [Objective.MIN_COST_PER_RACK, Objective.FASTEST_TO_POWER])
def test_the_figures_shown_for_a_hall_belong_to_the_scenario_its_objective_selects_old_used_max_compute(halls, objective):
    e = halls["reference_hall"]
    chosen = pick_recommended(e.results, objective)
    compute = pick_recommended(e.results, Objective.MAX_COMPUTE)
    row = portfolio_rows([e], objective)[0]
    assert row["racks"] == chosen.unlocked_racks
    if objective is Objective.MIN_COST_PER_RACK:
        assert chosen.spec.id != compute.spec.id, "premise: the two objectives pick different architectures"
        assert row["capex_per_rack_eur"] == pytest.approx(
            chosen.economics.capex_total_eur.value / chosen.unlocked_racks)
    md = render_gated(build([e], objective=objective), [e])
    assert f"{chosen.unlocked_racks} racks" in md


def test_the_title_and_text_name_the_objective_that_ranked(halls):
    r = build(list(halls.values()), objective=Objective.MIN_COST_PER_RACK)
    assert "capex per rack" in r.title and "deliverable compute" not in r.title
    assert "Rank is by capex per rack" in to_markdown(r)


def test_ties_are_flagged_and_ordering_does_not_depend_on_input_order(halls):
    a = entry(renamed(doc("nordic_hall"), "SITE-B", "H-2"))
    b = entry(renamed(doc("nordic_hall"), "SITE-A", "H-1"))
    assert a.racks == b.racks and a.capex == b.capex
    fwd, rev = rank([a, b]), rank([b, a])
    assert [e.ident for e in fwd] == [e.ident for e in rev] == [("SITE-A", "H-1"), ("SITE-B", "H-2")]
    rows = portfolio_rows([a, b])
    assert all("ties" in r["rank_note"] for r in rows)


def test_halls_whose_bands_overlap_are_not_presented_as_a_settled_order(halls):
    rows = portfolio_rows([halls["nordic_hall"], halls["dublin_hall"], halls["reference_hall"]],
                          Objective.FASTEST_TO_POWER)
    assert all(r["weeks_to_full"] == 160 for r in rows)            # three halls, one transformer, one date
    assert all("ties" in r["rank_note"] or "overlaps" in r["rank_note"] for r in rows)
    # London as shipped supplies no UPS schedule: it must not win on a date that
    # ignores the UPS limit, and it says why.
    r = portfolio_rows([halls["nordic_hall"], halls["london_hall"]], Objective.FASTEST_TO_POWER)
    assert r[-1]["hall"] == "LON-03" and "required inputs not supplied" in r[-1]["rank_note"]
    complete = doc("london_hall")
    complete["ups"] = doc("dublin_hall")["ups"]
    r = portfolio_rows([halls["nordic_hall"], entry(complete)], Objective.FASTEST_TO_POWER)
    assert r[0]["hall"] == "LON-03" and r[0]["rank_note"] == "—", "36 [24-52] weeks vs 160 [80-210]: a settled order"


def test_unequal_completeness_is_visible_next_to_the_rank(halls):
    sparse = doc("london_hall")
    sparse["hall"].pop("floor_loading_kPa", None)
    e = entry(sparse)
    md = render_gated(build([halls["nordic_hall"], e]), [halls["nordic_hall"], e])
    assert "Intake completeness" in md and "%" in md


# --- E. consistency across Markdown, HTML, API and gates --------------------------------------------------------
def test_markdown_html_and_api_agree_on_every_hall(halls):
    entries = list(halls.values())
    report = build(entries)
    md, html = to_markdown(report), to_html(report)
    run_all_gates(report, md, collect_claims([r for e in entries for r in e.results]))
    payload = handle_portfolio({"intakes": [doc(n) for n in halls]}, Tier.CLIENT)
    assert payload["total_racks_evidence"] == "E0_ASSUMPTION"
    for row in payload["halls"]:
        q = next(e for e in entries if e.intake.context.hall.id == row["hall"])
        assert row["racks"] == q.racks and row["racks_evidence"] == q.rack_class.name
        assert row["capex_eur"] == q.capex and row["capex_band_eur"] == list(q.capex_q.band)
        for text in (md, html):
            assert f'{row["hall"]}' in text
    assert "racks (E3)" not in md, "no rack count may claim engineering-estimate evidence on library defaults"


def test_api_ranking_follows_the_requested_objective(halls):
    payload = handle_portfolio({"intakes": [doc(n) for n in halls], "objective": "min_cost"}, Tier.CLIENT)
    cpr = [h["capex_per_rack_eur"] for h in payload["halls"]]
    assert cpr == sorted(cpr) and payload["objective"] == "min_cost"
    assert payload["halls"][0]["racks"] == pick_recommended(
        halls[next(n for n in halls if halls[n].intake.context.hall.id == payload["halls"][0]["hall"])].results,
        Objective.MIN_COST_PER_RACK).unlocked_racks


# --- D. the change note ----------------------------------------------------------------------------------------
@pytest.fixture(scope="module")
def base():
    return doc("reference_hall")


def note(d):
    r = build_note(d, site="S", hall="H", client="C")
    md = to_markdown(r)
    run_all_gates(r, md)
    return r, md


def test_the_note_labels_figures_from_the_recorded_provenance_old_behaviour_said_E3_and_x05_x2(base):
    d = diff(base, moved(base, **{"grid.contracted_MW": 10.5}))
    assert d.after.racks_class == "E0_ASSUMPTION" and d.after.capex_class == "E0_ASSUMPTION"
    r, md = note(d)
    qs = {q.prov.label: q for q in r.quantities()}
    racks, weeks, capex = (qs["deployable racks, current inputs"], qs["weeks to full capacity, current inputs"],
                           qs["indicative capex, current inputs"])
    assert racks.evidence is E.E0_ASSUMPTION
    assert weeks.band == (d.after.weeks_lo, d.after.weeks_hi) and weeks.band[0] < weeks.value
    assert capex.band == (d.after.capex_lo, d.after.capex_hi), "capex band comes from the estimate, not x0.5/x2"
    assert "(E3)" not in md.split("## 2.")[0]


def test_a_firm_quoted_hall_gets_a_narrower_capex_band_in_the_note(base, quoted_library):
    d = diff(base, moved(base, **{"grid.contracted_MW": 10.5}))
    assert d.after.capex_hi / d.after.capex_eur < 2.0 and d.after.capex_lo / d.after.capex_eur > 0.5


def test_a_change_to_a_customer_input_is_attributed_to_that_input(base):
    d = diff(base, moved(base, **{"grid.contracted_MW": 10.5}))
    assert d.inputs == "changed" and d.drift == [] and d.drift_known
    r, md = note(d)
    assert "Contracted capacity" in md and "effect when moved alone" in md
    assert all(q.evidence <= E.E0_ASSUMPTION for q in r.quantities() if q.unit == "racks")


def test_an_input_change_that_leaves_the_answer_alone_says_so(base):
    d = diff(base, moved(base, **{"grid.contracted_MW": 12.0001}))
    if not d.material:
        _, md = note(d)
        assert "No action" in md


def test_a_binding_constraint_change_is_called_out(base):
    d = diff(base, moved(base, **{"lv.tapoff_max_A": 400}))
    assert d.binding_moved
    _, md = note(d)
    assert "What binds first has changed" in md


def test_interacting_changes_report_the_residual_and_do_not_claim_independence(base):
    # Two limits on the same grid headroom: each alone is partly masked by the other, so
    # the single-input probes cannot sum to the joint effect (62 -> 50, probes explain 42).
    d = diff(base, moved(base, **{"grid.firm_capacity_MVA": 11, "grid.contracted_MW": 10}))
    assert d.residual != 0
    _, md = note(d)
    assert "unexplained" in md and "interacting" in md


def test_when_contributions_sum_exactly_the_note_does_not_claim_independence(base):
    d = diff(base, moved(base, **{"grid.contracted_MW": 10.5, "lv.tapoff_max_A": 250}))
    assert d.residual == 0
    _, md = note(d)
    assert "does not show the inputs act independently" in md


def test_removed_inputs_are_listed_not_silently_dropped(base):
    after = copy.deepcopy(base)
    after["hall"].pop("floor_loading_kPa")
    d = diff(base, after)
    assert "hall.floor_loading_kPa" in d.changed_paths
    assert d.unprobeable == ["hall.floor_loading_kPa"] or "hall.floor_loading_kPa" in d.unprobeable
    _, md = note(d)
    assert "Floor loading" in md and "removed or cannot be solved alone" in md


def test_a_model_revision_with_no_customer_change_is_not_blamed_on_the_customer(base, quoted_library):
    reload_library(Path("/nonexistent/none.json"))                       # the library the earlier run used
    prev = diff(base, copy.deepcopy(base)).after
    reload_library(quoted_library)                                       # ...then a recorded price changes
    d = diff_from_state(prev, base)
    assert d.inputs == "unchanged" and d.drift_known and "prices" in d.drift
    assert not d.material, "a price cannot move a rack count; the note must still say our side changed"
    _, md = note(d)
    assert "Nothing you supplied has changed" in md and "cost library has been revised" in md
    assert "Each input was moved on its own" not in md
    assert "Capacity fell" not in md and "Capacity rose" not in md


def test_a_state_without_recorded_inputs_is_not_assumed_unchanged_old_behaviour_claimed_it(base):
    legacy = json.loads(json.dumps(diff(base, copy.deepcopy(base)).after.__dict__))
    for k in ("intake_digest", "price_basis_digest", "relief_path_digest", "racks_class", "weeks_lo", "weeks_hi",
              "weeks_class", "capex_lo", "capex_hi", "capex_class", "schedule_complete", "capex_complete"):
        legacy.pop(k)
    prev = EnvelopeState(**legacy)                       # a state recorded before provenance was kept
    prev.racks_after_ladder += 5                         # something moved
    d = diff_from_state(prev, base)
    assert d.inputs == "unknown" and not d.drift_known
    r, md = note(d)
    assert "Nothing you supplied has changed" not in md
    assert "cannot say whether anything you supplied changed" in md
    assert "evidence class not recorded" in md and "band not recorded" in md


def test_changed_inputs_with_no_record_of_the_old_ones_are_not_called_unchanged(base):
    prev = diff(base, copy.deepcopy(base)).after
    d = diff_from_state(prev, moved(base, **{"grid.contracted_MW": 10.5}))
    assert d.inputs == "changed" and not d.drivers
    _, md = note(d)
    assert "cannot be itemised" in md and "Nothing you supplied has changed" not in md


def test_unchanged_inputs_unchanged_answer_is_verified_not_assumed(base):
    prev = diff(base, copy.deepcopy(base)).after
    d = diff_from_state(prev, copy.deepcopy(base))
    assert d.inputs == "unchanged" and not d.material and d.drift == []
    _, md = note(d)
    assert "No action" in md


def test_a_capex_move_inside_both_bands_is_not_presented_as_a_cost_change(base):
    d = diff(base, moved(base, **{"grid.contracted_MW": 10.5}))
    d.after = replace(d.after, capex_eur=d.before.capex_eur * 1.05, capex_lo=d.before.capex_lo * 1.05,
                      capex_hi=d.before.capex_hi * 1.05)
    d.before = replace(d.before, capex_eur=d.before.capex_eur)
    _, md = note(d)
    assert "inside the uncertainty of both estimates" in md


def test_an_incomplete_schedule_gives_no_date_in_the_state_or_the_note(halls, base):
    res = copy.deepcopy(halls["reference_hall"].best)
    for s in res.ladder.taken_steps:
        s.lead_time_weeks = None
    st = EnvelopeState.of(res)
    assert st.schedule_complete is False and st.weeks_to_full is None and st.weeks_lo is None
    d = diff(base, moved(base, **{"grid.contracted_MW": 10.5}))
    d.after = replace(st, racks_after_ladder=st.racks_after_ladder - 3)       # a material move, so section 1 shows
    _, md = note(d)
    assert "No date is given for full capacity" in md


def test_the_api_diff_payload_and_markdown_agree(base):
    out = handle_diff({"before": base, "after": moved(base, **{"grid.contracted_MW": 10.5}), "format": "md"},
                      Tier.CLIENT)
    assert out["inputs"] == "changed" and out["model_drift"] == [] and out["model_drift_known"] is True
    assert out["after"]["racks_class"] == "E0_ASSUMPTION" and out["after"]["capex_lo"] is not None
    assert f'{out["racks_delta"]:+d}' in out["headline"] or out["racks_delta"] == 0
    assert "Contracted capacity" in out["document"]
    prev = out["after"]
    out2 = handle_diff({"previous_state": prev, "after": base}, Tier.CLIENT)
    assert out2["inputs"] == "changed"                    # recorded digest differs from the original hall


def test_state_round_trips_through_json_for_the_watch_store(base):
    st = diff(base, copy.deepcopy(base)).after
    again = EnvelopeState(**json.loads(json.dumps(st.__dict__)))
    assert again == st


def test_a_recorded_E0_is_reported_as_E0_not_as_unrecorded_or_as_a_stronger_class(base):
    # EvidenceClass is an IntEnum and E0 is falsy: `cls or fallback` would drop a recorded E0.
    d = diff(base, moved(base, **{"grid.contracted_MW": 10.5}))
    assert d.before.racks_class == "E0_ASSUMPTION"
    _, md = note(d)
    assert "was 62 (E0)" in md and "evidence class not recorded" not in md
    d.after = replace(d.after, racks_class="E5_CUSTOMER_DATA")
    d.drivers[0].racks_class = "E0_ASSUMPTION"           # a driver whose own trial rests on defaults
    r, _ = note(d)
    contribution = next(q for q in r.quantities() if q.prov.label.startswith("contribution of"))
    assert contribution.evidence is E.E0_ASSUMPTION, "must not fall through to the stronger 'after' class"
