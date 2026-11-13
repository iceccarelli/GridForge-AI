"""A portfolio total must not add halls that cannot be added, and "Start with" must not recommend a hall nobody evaluated.

Found by running the real handler (/v1/portfolio) on the shipped example halls:

  P1. examples/intake/reference_hall.json plus a copy with hall.id DH-03 (500 rack positions, 800 A busway, 125 A tap-off) on the SAME
      site.id and the same grid block: both halls were bound after the ladder by the one connection's firm supply, total_racks was 124,
      and warnings was absent -- a 12 MW connection counted twice. The existing guard only fired on identical documents.
  P2. Six halls including a qualifier-sparse hall (floor loading, transformer, UPS and plant never evaluated) and London (UPS missing):
      total_racks 338 whatever the objective was named, and for [sparse, london] the document said "34 racks (E0)" and
      "Start with Sparse Site / H1: 28 racks" although that hall's own row said its constraints were not evaluated. The JSON row carried
      the gap only as prose (`rank_note`).

Every test goes through the real solver and handler. The shared-site and sparse halls are built from examples/intake/*.json and
examples/api/qualify-request.json in this file; no new data file. They are synthetic, like the examples they come from.
"""
from __future__ import annotations

import copy
import itertools
import json
import re
from pathlib import Path

import pytest

from gridforge.api.server import Tier, handle_portfolio, qualify_to_intake
from gridforge.reporting import to_markdown
from gridforge.reporting.portfolio import SiteEntry, build, portfolio_rows, rank
from gridforge.reporting.gates import run_all_gates
from gridforge.reporting.study import collect_claims
from gridforge.intake.loader import load_document
from gridforge.scenario.objective import Objective
from gridforge.scenario.run import run_all

ROOT = Path(__file__).resolve().parents[1]


def doc(name: str) -> dict:
    return json.loads((ROOT / "examples" / "intake" / f"{name}_hall.json").read_text())


REF, DUB, LON, NOR = doc("reference"), doc("dublin"), doc("london"), doc("nordic")
QUALIFY = json.loads((ROOT / "examples" / "api" / "qualify-request.json").read_text())


def sparse(site_id: str = "SPARSE", name: str = "Sparse Site", hall_id: str = "H1", **qualify) -> dict:
    d = qualify_to_intake({**QUALIFY, **qualify})
    d["site"] = {"id": site_id, "name": name}
    d["hall"] = {**d.get("hall", {}), "id": hall_id}
    return d


def sibling_of_reference(hall_id: str = "DH-03") -> dict:
    """The reproduced case: the reference hall's twin on the same site and the same grid block, a different hall."""
    d = copy.deepcopy(REF)
    d["hall"]["id"] = hall_id
    d["hall"]["rack_positions"] = 500
    d["lv"]["busway_ampacity_A"]["value"] = 800
    d["lv"]["tapoff_max_A"] = 125
    return d


def no_lead_times() -> dict:
    d = copy.deepcopy(REF)
    d["site"].update(id="NOLEAD", name="No Lead Time")
    d["hall"]["id"] = "NL1"
    for t in d["transformers"]:
        t.pop("replacement_lead_time_weeks", None)
    for b in d["btm_options"]:
        b.pop("lead_time_weeks", None)
        b.pop("capex_eur_per_kW", None)
    return d


SPARSE, SIB, NOLEAD = sparse(), sibling_of_reference(), no_lead_times()
SIX = [REF, DUB, LON, NOR, SPARSE, NOLEAD]
OBJECTIVES = ("max_compute", "fastest", "min_cost")
LEGACY_ROW_KEYS = ["rank", "site", "hall", "metro", "racks", "racks_evidence", "weeks_to_full", "weeks_band", "weeks_evidence",
                   "schedule_complete", "date_basis", "date_evidence_class", "date_binding_item", "date_label", "capex_eur", "capex_band_eur",
                   "capex_evidence", "capex_complete", "decision_grade", "economics_limitations", "capex_per_rack_eur",
                   "capex_per_rack_band_eur", "binds_first", "intake_completeness", "rank_note"]


def post(docs: list[dict], objective: str | None = None, **more) -> dict:
    body: dict = {"intakes": docs, **more}
    if objective:
        body["objective"] = objective
    return handle_portfolio(body, Tier.CLIENT)


def md_of(docs: list[dict], objective: str | None = None) -> str:
    return post(docs, objective, format="md")["document"]["document"]


def start_with(document: str) -> str | None:
    m = re.search(r"Start with ([^:]+):", document)
    return m.group(1).strip() if m else None


def by_hall(out: dict) -> dict[str, dict]:
    return {h["hall"]: h for h in out["halls"]}


# ==== P1. a shared grid connection is not counted once per hall ==================================================================
def test_two_halls_on_one_site_are_flagged_and_their_sum_is_an_upper_bound():
    out = post([REF, SIB])
    rows = by_hall(out)
    assert rows["DH-02"]["shares_site_connection"] == ["DH-03"] and rows["DH-03"]["shares_site_connection"] == ["DH-02"]
    assert out["total_racks"] == sum(h["racks"] for h in out["halls"]) == 124       # the reproduced figure is still the sum of the rows
    assert out["total_racks_upper_bound"] == 124
    assert out["total_racks_by_site_max"] == 62                                        # one connection: the larger hall, not both
    assert any("DH-02" in w and "DH-03" in w and "one grid connection" in w and "upper bound" in w for w in out["warnings"])


def test_the_existing_keys_of_a_shared_site_portfolio_keep_their_values():
    out = post([REF, SIB])
    assert list(out["halls"][0])[:len(LEGACY_ROW_KEYS)] == LEGACY_ROW_KEYS
    assert out["total_racks_evidence"] == "E0_ASSUMPTION" and out["objective"] == "max_compute"


def test_the_document_says_the_connection_is_shared_and_gives_both_figures():
    document = md_of([REF, SIB])
    low = document.lower()
    assert "share" in low and "upper bound" in low
    assert "124" in document and "62" in document
    assert "DH-02" in document and "DH-03" in document


def test_a_hall_alone_on_its_site_shares_nothing_and_the_three_totals_agree():
    out = post([REF, DUB, NOR])
    assert all(h["shares_site_connection"] == [] and h["likely_shares_connection_with"] == [] for h in out["halls"])
    assert out["total_racks"] == out["total_racks_upper_bound"] == out["total_racks_by_site_max"]
    assert "warnings" not in out


def test_identical_grid_blocks_under_different_site_ids_are_a_likely_share_never_a_silent_merge():
    other = copy.deepcopy(REF)
    other["site"].update(id="OTHER-SITE", name="Other Site")
    other["hall"].update(id="X1", positions_available=90)
    out = post([REF, other])
    rows = by_hall(out)
    assert rows["DH-02"]["shares_site_connection"] == [] and rows["X1"]["shares_site_connection"] == []     # not the same declared site
    assert rows["DH-02"]["likely_shares_connection_with"] == ["X1"] and rows["X1"]["likely_shares_connection_with"] == ["DH-02"]
    assert out["total_racks_by_site_max"] == out["total_racks"]                                              # no silent merge
    assert any("identical grid" in w.lower() and "likely" in w.lower() for w in out["warnings"])


def test_a_figure_in_common_between_two_sites_is_not_a_likely_shared_connection():
    a = sparse(site_id="A", name="Site A", hall_id="HA")
    b = sparse(site_id="B", name="Site B", hall_id="HB", current_site_peak_MW=7.0)       # the same 12 MW contracted, a different peak
    out = post([a, b])
    assert all(h["likely_shares_connection_with"] == [] and h["shares_site_connection"] == [] for h in out["halls"])
    assert not any("identical grid" in w.lower() for w in out.get("warnings", []))


def test_halls_that_did_not_declare_a_site_are_never_grouped():
    a, b = qualify_to_intake(QUALIFY), qualify_to_intake({**QUALIFY, "contracted_MW": 8})
    out = post([a, b])
    assert [h["shares_site_connection"] for h in out["halls"]] == [[], []]
    assert out["total_racks_by_site_max"] == out["total_racks"]


def test_the_site_id_is_compared_without_case_or_stray_whitespace():
    twin = sibling_of_reference()
    twin["site"] = {**twin["site"], "id": "  ref-eu-01  "}
    from gridforge.reporting.portfolio_guard import declares_site_id
    assert declares_site_id(twin) and declares_site_id(REF)
    assert post([REF, twin])["total_racks_by_site_max"] == 62


def test_swapping_two_sibling_halls_never_changes_the_upper_bound_or_the_per_site_maxima():
    """Metamorphic: the order of the siblings, and which of them carries which hall id, cannot change the sums."""
    a, b = copy.deepcopy(REF), copy.deepcopy(SIB)
    outs = [post([a, b]), post([b, a])]
    swapped_a, swapped_b = copy.deepcopy(a), copy.deepcopy(b)
    swapped_a["hall"]["id"], swapped_b["hall"]["id"] = b["hall"]["id"], a["hall"]["id"]
    outs += [post([swapped_a, swapped_b]), post([swapped_b, swapped_a])]
    assert len({o["total_racks_upper_bound"] for o in outs}) == 1
    assert len({o["total_racks_by_site_max"] for o in outs}) == 1


def test_three_halls_on_one_site_take_the_largest_not_the_sum():
    third = sibling_of_reference("DH-04")
    third["hall"]["positions_available"] = 20
    out = post([REF, SIB, third])
    assert out["total_racks_by_site_max"] == max(h["racks"] for h in out["halls"])
    assert all(len(h["shares_site_connection"]) == 2 for h in out["halls"])


def test_the_library_and_therefore_the_command_line_carries_the_same_statement():
    entries = []
    for d in (REF, SIB):
        i = load_document(copy.deepcopy(d))
        entries.append(SiteEntry(intake=i, results=run_all(i.context, i.scenarios)))
    rows = portfolio_rows(entries)
    assert {r["hall"]: r["shares_site_connection"] for r in rows} == {"DH-02": ["DH-03"], "DH-03": ["DH-02"]}
    assert "upper bound" in to_markdown(build(entries)).lower()


def test_grid_fingerprint_ignores_notes_and_wrapping_but_not_figures():
    from gridforge.reporting.portfolio_guard import grid_fingerprint
    a = {"grid": {"contracted_MW": 12, "firm_capacity_MVA": {"value": 14, "note": "from the DNO letter"}, "current_site_peak_MW": 7.4}}
    b = {"grid": {"contracted_MW": {"value": 12, "evidence": "E5"}, "firm_capacity_MVA": 14.0, "current_site_peak_MW": 7.4}}
    c = {"grid": {"contracted_MW": 13, "firm_capacity_MVA": 14, "current_site_peak_MW": 7.4}}
    assert grid_fingerprint(a) == grid_fingerprint(b) != grid_fingerprint(c)
    assert grid_fingerprint({}) is None and grid_fingerprint({"grid": {}}) is None and grid_fingerprint("x") is None
    # one or two round numbers in common are a coincidence, not a shared connection
    assert grid_fingerprint({"grid": {"contracted_MW": 12}}) is None
    assert grid_fingerprint({"grid": {"contracted_MW": 12, "firm_capacity_MVA": 14}}) is None


# ==== P2. incomparable halls are not added, and not recommended =================================================================
def test_each_row_says_whether_it_is_rankable_and_why():
    out = post(SIX)
    rows = by_hall(out)
    sp, lon, ref = rows["H1"], rows["LON-03"], rows["DH-02"]
    assert sp["rankable"] is False and lon["rankable"] is False and ref["rankable"] is True
    assert sp["unassessed_banks"] == ["transformers", "UPS"] and lon["unassessed_banks"] == ["UPS"] and ref["unassessed_banks"] == []
    assert sp["required_gaps"] and lon["required_gaps"] and ref["required_gaps"] == []
    assert "hall.floor_loading_kPa" in sp["required_gaps"] and lon["required_gaps"] == ["ups"]      # paths, not labels
    assert "UPS" in lon["rankable_reason"] and ref["rankable_reason"]
    assert sp["evidence_floor"] == sp["racks_evidence"]


def test_the_comparable_total_adds_only_rankable_halls_and_total_racks_is_unchanged():
    out = post(SIX)
    assert out["total_racks"] == sum(h["racks"] for h in out["halls"]) == out["total_racks_upper_bound"]
    comparable = [h for h in out["halls"] if h["rankable"]]
    assert out["comparable_total_racks"] == sum(h["racks"] for h in comparable)
    assert out["comparable_total_racks"] < out["total_racks"]
    assert {h["hall"] for h in out["incomparable_halls"]} == {h["hall"] for h in out["halls"] if not h["rankable"]} == {"H1", "LON-03"}
    assert all(h["reason"] and "racks" in h for h in out["incomparable_halls"])
    assert out["comparable_total_racks_evidence"] == min(h["racks_evidence"] for h in comparable)


@pytest.mark.parametrize("objective", OBJECTIVES)
def test_a_hall_that_is_not_rankable_is_never_placed_above_one_that_is(objective):
    rankable_but_small = copy.deepcopy(REF)
    rankable_but_small["site"].update(id="SMALL", name="Small Rankable")
    rankable_but_small["hall"].update(id="S1", positions_available=10)
    empty = copy.deepcopy(REF)
    empty["site"].update(id="EMPTY", name="Empty Rankable")
    empty["hall"].update(id="E1", positions_available=0)
    big_sparse = sparse(site_id="BIGSPARSE", name="Big Sparse", hall_id="B1", contracted_MW=40)
    out = post([big_sparse, SPARSE, LON, rankable_but_small, empty, REF], objective)
    flags = [h["rankable"] for h in out["halls"]]
    assert flags == sorted(flags, reverse=True), [(h["hall"], h["racks"], h["rankable"]) for h in out["halls"]]
    assert by_hall(out)["B1"]["racks"] > by_hall(out)["S1"]["racks"]              # premise: the sort key, not the rack count, puts it last


def test_start_with_never_names_a_hall_that_is_not_rankable():
    document = md_of([SPARSE, LON])
    assert "Start with" not in document
    low = document.lower()
    assert "no hall can be recommended yet" in low
    for needed in ("Hall design floor loading", "Transformer schedule", "UPS schedule"):      # the data that would make a hall rankable
        assert needed in document, needed


def test_no_total_is_printed_when_no_hall_is_comparable():
    document = md_of([SPARSE, LON])
    assert "No total is given" in document and "Comparable deployable racks" not in document
    out = post([SPARSE, LON])
    assert out["comparable_total_racks"] is None and out["comparable_total_racks_by_site_max"] is None        # no total is not zero racks
    assert out["comparable_total_racks_evidence"] is None
    assert len(out["incomparable_halls"]) == 2


def test_start_with_names_the_best_rankable_hall_even_when_an_incomparable_hall_shows_more_racks():
    big_sparse = sparse(site_id="BIGSPARSE", name="Big Sparse", hall_id="B1", contracted_MW=40)
    out = post([big_sparse, REF])
    assert by_hall(out)["B1"]["racks"] > by_hall(out)["DH-02"]["racks"]            # premise
    document = md_of([big_sparse, REF])
    assert start_with(document) == f"{by_hall(out)['DH-02']['site']} / DH-02"


def test_the_total_statement_names_who_is_in_it_and_who_is_not_and_the_objective():
    for objective, phrase in zip(OBJECTIVES, ("deliverable compute", "time to power", "capex per rack")):
        document = md_of(SIX, objective)
        block = document.split("## 2.")[0]
        assert "Comparable deployable racks across the portfolio" in block
        assert phrase in block and "another objective" in block.lower()
        assert "Sparse Site / H1" in block and "Reference London Docklands / LON-03" in block.split("Not in this total")[1]
        assert "In this total" in block


def test_the_comparable_total_follows_the_objective_it_is_printed_for():
    totals = {o: post(SIX, o)["comparable_total_racks"] for o in OBJECTIVES}
    assert totals["max_compute"] >= totals["fastest"] and totals["max_compute"] >= totals["min_cost"]
    for o in OBJECTIVES:
        assert str(totals[o]) in md_of(SIX, o).split("## 2.")[0]


def test_ranking_notes_name_the_undeclared_banks():
    out = post(SIX)
    assert "transformers" in by_hall(out)["H1"]["rank_note"] and "UPS" in by_hall(out)["LON-03"]["rank_note"]


# ---- the roll-up of what binds, in the data and not only in the document -----------------------------------------------------
def test_the_constraint_rollup_counts_halls_as_found_and_after_relief():
    out = post(SIX)
    roll = out["constraint_rollup"]
    assert sum(r["halls"] for r in roll["as_found"]) == len(out["halls"]) == sum(r["halls"] for r in roll["after_relief"])
    found = {}
    for h in out["halls"]:
        found[h["binds_first"]] = found.get(h["binds_first"], 0) + 1
    assert {r["constraint"]: r["halls"] for r in roll["as_found"]} == found
    for r in roll["as_found"] + roll["after_relief"]:
        assert r["halls"] == len(r["members"]) and 0 <= r["incomparable_halls"] <= r["halls"]
    assert sum(r["incomparable_halls"] for r in roll["as_found"]) == len(out["incomparable_halls"])


def test_the_rollup_shows_the_one_connection_that_binds_both_siblings_after_relief():
    roll = post([REF, SIB])["constraint_rollup"]
    assert roll["after_relief"][0]["halls"] == 2 and "Firm supply" in roll["after_relief"][0]["constraint"]


def test_the_document_rolls_up_both_views():
    section = md_of(SIX).split("## 2.")[1].split("## 3.")[0]
    assert "as found" in section.lower() and "after the relief works" in section.lower()


# ---- metamorphic ------------------------------------------------------------------------------------------------------------
def _facts(docs, objective="max_compute"):
    out = post(docs, objective)
    return ({h["hall"] for h in out["halls"] if h["rankable"]}, out["comparable_total_racks"], out["total_racks_upper_bound"],
            [h["hall"] for h in out["halls"] if h["rankable"]])


@pytest.mark.parametrize("objective", OBJECTIVES)
def test_reordering_halls_never_changes_which_are_rankable_or_the_comparable_total(objective):
    base = _facts(SIX, objective)
    for perm in (list(reversed(SIX)), SIX[2:] + SIX[:2], SIX[1::2] + SIX[0::2]):
        assert _facts(perm, objective) == base


def test_adding_a_non_rankable_hall_never_changes_the_comparable_total_or_where_to_start():
    base_docs = [REF, DUB, NOR]
    base = post(base_docs)
    before = start_with(md_of(base_docs))
    for extra in (SPARSE, LON, sparse(site_id="S2", name="Second Sparse", hall_id="H2", contracted_MW=60)):
        out = post(base_docs + [extra])
        assert out["comparable_total_racks"] == base["comparable_total_racks"]
        assert [h["hall"] for h in out["halls"] if h["rankable"]] == [h["hall"] for h in base["halls"]]
        assert start_with(md_of(base_docs + [extra])) == before
        assert not by_hall(out)[extra["hall"]["id"]]["rankable"]


def test_a_portfolio_of_complete_halls_is_unchanged_in_every_pre_existing_key():
    """The additions are additive: for fully rankable halls on separate sites every old key is present, first and in order."""
    out = post([REF, DUB, NOR])
    assert list(out)[:4] == ["objective", "halls", "total_racks", "total_racks_evidence"]
    assert all(list(h)[:len(LEGACY_ROW_KEYS)] == LEGACY_ROW_KEYS for h in out["halls"])
    assert [h["racks"] for h in out["halls"]] == sorted((h["racks"] for h in out["halls"]), reverse=True)
    assert out["comparable_total_racks"] == out["total_racks"] and out["incomparable_halls"] == []
    assert all(h["rankable"] and h["rankable_reason"] for h in out["halls"])
    document = md_of([REF, DUB, NOR])
    assert "Total deployable racks across the portfolio" in document and "Not in this total" not in document
    top = out["halls"][0]
    assert start_with(document) == f"{top['site']} / {top['hall']}"


def test_the_document_passes_the_gates_for_a_mixed_and_a_shared_portfolio():
    for docs in (SIX, [REF, SIB], [SPARSE, LON]):
        entries = []
        for d in docs:
            i = load_document(copy.deepcopy(d))
            entries.append(SiteEntry(intake=i, results=run_all(i.context, i.scenarios)))
        report = build(entries)
        md = to_markdown(report)
        run_all_gates(report, md, collect_claims([r for e in entries for r in e.results]))


def test_rank_places_every_rankable_hall_first_for_any_order_of_the_input():
    entries = []
    for d in SIX:
        i = load_document(copy.deepcopy(d))
        entries.append(SiteEntry(intake=i, results=run_all(i.context, i.scenarios)))
    for perm in itertools.islice(itertools.permutations(entries), 0, 720, 97):
        flags = [e.rankable for e in rank(list(perm), Objective.MAX_COMPUTE)]
        assert flags == sorted(flags, reverse=True)
