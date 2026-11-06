"""Adversarial acceptance tests for the intake and the deliverables, driven through the REAL handlers (gridforge.api.server._invoke over the
route table, the same entry the HTTP layer calls) and the real report gates. Written by an independent QA pass; nothing here changes product
code, assumptions or any existing test.

How to read the results: a test that PASSES pins behaviour that is correct today. A test marked ``xfail(strict=True, reason='confirmed
defect: ...')`` pins a defect that is REAL on this commit: it fails today, the suite stays green, and the moment the product is fixed the
strict xfail turns red so the marker is removed on purpose. Nothing is weakened to get green.

What "correct" means is stated in each docstring as one of: REFUSE (a structured 4xx, never a 5xx, a hang or an escaped exception),
DEGRADE WITH DISCLOSURE (an answer that says, where the reader sees it, what was assumed or contradictory), or QUALIFY (the stronger claim
is clamped and the clamp is stated).
"""
from __future__ import annotations

import copy
import dataclasses
import json
import re
from pathlib import Path

import pytest

from gridforge.api import server as S
from gridforge.api.tiers import Tier
from gridforge.intake.loader import IntakeError, load_document

ROOT = Path(__file__).resolve().parent.parent
REF = json.loads((ROOT / "examples" / "intake" / "reference_hall.json").read_text())

#: What the HTTP layer turns into a 4xx (see Handler._do_post): anything else escaping a handler would be a 500 "engine error".
REFUSALS = (S.ApiError, IntakeError, ValueError, TypeError, KeyError, ArithmeticError)


def doc(**edits):
    """A deep copy of the reference intake with dotted-path edits applied: ``doc(**{"grid.contracted_MW": 5})``. List items by index:
    ``"transformers.0.units"``. The value ``DELETE`` removes the key."""
    d = copy.deepcopy(REF)
    for path, val in edits.items():
        cur = d
        parts = path.split(".")
        for p in parts[:-1]:
            cur = cur[int(p)] if p.isdigit() else cur.setdefault(p, {})
        last = parts[-1]
        if val is DELETE:
            cur.pop(last, None)
        elif last.isdigit():
            cur[int(last)] = val
        else:
            cur[last] = val
    return d


DELETE = object()


def call(route: str, body):
    """('ok', payload) or ('refused', exception). Anything other than a refusal that escapes is a crash and fails the test here."""
    handler, tier = S.ROUTES[route]
    try:
        return "ok", S._invoke(route, handler, body, tier)
    except REFUSALS as exc:
        return "refused", exc


def body_for(route: str, intake):
    if route == "/v1/portfolio":
        return {"intakes": [intake]}
    if route == "/v1/bids":
        return {"intake": intake, "responses": [{"supplier": "Synthetic Supplier", "received_on": "2026-10-01", "values": {"capex_eur": 1}}]}
    return {"intake": intake}


INTAKE_ROUTES = ["/v1/screen", "/v1/study", "/v1/compare", "/v1/deck", "/v1/proposal", "/v1/spec", "/v1/bids", "/v1/portfolio"]
WRONG_SHAPES = {"list": [1], "str": "x", "int": 7, "null": None, "bool": True, "float": 1.5, "empty_list": [], "empty_obj": {}}


def racks(out, scenario="full_dlc_btm"):
    return next(s["after_ladder"]["racks"] for s in out["scenarios"] if s["id"] == scenario)


def text_of(out) -> str:
    return json.dumps(out, default=str)


# ===================================================================================================================================
# 1. Nested malformed objects on every intake route, and issue #104
# ===================================================================================================================================


@pytest.mark.parametrize("route", ["/v1/deck", "/v1/proposal", "/v1/spec", "/v1/bids"])
@pytest.mark.parametrize("shape", ["list", "str", "int", "null", "bool", "float"])
def test_104_a_non_object_project_is_refused_not_an_attribute_error(route, shape):
    """Issue #104: ``intake.project`` that is not an object escaped as AttributeError on deck, proposal, spec and bids (a 500 'engine error').
    REFUSE: a structured 422 naming ``project``. Independently reproduced on this commit: STILL-OPEN is false, the issue is FIXED
    (loader._project_block raises IntakeError, which the HTTP layer maps to 422)."""
    status, exc = call(route, body_for(route, doc(project=WRONG_SHAPES[shape])))
    assert status == "refused" and "project" in str(exc), (route, shape, exc)


@pytest.mark.parametrize("route", INTAKE_ROUTES)
@pytest.mark.parametrize("block", ["project", "ups", "transformers", "btm_options", "scenarios"])
@pytest.mark.parametrize("shape", ["list", "str", "int", "bool", "float"])
def test_wrong_typed_structured_blocks_never_escape_as_a_server_fault(route, block, shape):
    """REFUSE: a list-or-object block of the wrong type is a 4xx on every route, never an escaped AttributeError/RecursionError."""
    status, out = call(route, body_for(route, doc(**{block: WRONG_SHAPES[shape]})))
    assert status == "refused", (route, block, shape)


@pytest.mark.parametrize("block", ["site", "hall", "grid", "lv", "thermal", "compute", "economics"])
@pytest.mark.parametrize("shape", ["list", "str", "int", "null", "bool", "float"])
@pytest.mark.parametrize("route", ["/v1/screen", "/v1/compare"])
def test_wrong_typed_scalar_blocks_do_not_crash(route, block, shape):
    """Crash safety only (a 4xx or an answer, never an escaped exception); whether the answer is honest is the next test."""
    status, _ = call(route, body_for(route, doc(**{block: WRONG_SHAPES[shape]})))
    assert status in ("ok", "refused")


@pytest.mark.parametrize("block", ["site", "hall", "grid", "lv", "thermal", "compute", "economics"])
def test_a_block_sent_as_the_wrong_type_is_refused_or_named_in_a_warning(block):
    """REFUSE or DEGRADE WITH DISCLOSURE. ``"grid": "oops"`` throws away every grid figure the client typed and solves on library defaults
    (E0), exactly as if the block had been omitted. ``project`` is refused for this; the other blocks must be too, or at least the intake
    report must say the block was discarded. Reproducer:
        load_document({**reference_hall, "grid": "oops"}).report.warnings == []   and no IntakeError."""
    try:
        intake = load_document(doc(**{block: "oops"}))
    except IntakeError:
        return
    assert any(block in w and ("object" in w or "ignored" in w or "discard" in w) for w in intake.report.warnings)


@pytest.mark.parametrize("route", INTAKE_ROUTES)
def test_a_deeply_nested_object_in_a_scalar_slot_is_refused(route):
    """REFUSE: 60 levels of nesting (inside the body limit of 64) where a number belongs is a clean refusal naming nothing dangerous, not a
    RecursionError and not a hang."""
    deep: object = 1
    for _ in range(40):
        deep = {"value": deep}
    status, _ = call(route, body_for(route, doc(**{"grid.contracted_MW": deep})))
    assert status == "refused"


@pytest.mark.parametrize("route", INTAKE_ROUTES)
@pytest.mark.parametrize("where", ["hall", "grid", "transformers", "ups"])
def test_nesting_beyond_the_limit_is_refused_before_any_solving(route, where):
    """REFUSE (422, 'levels deep'): a 200-deep structure under an intake block."""
    deep: object = 1
    for _ in range(200):
        deep = [deep]
    d = doc()
    d[where] = deep
    handler, tier = S.ROUTES[route]
    with pytest.raises(S.ApiError) as exc:
        S._invoke(route, handler, body_for(route, d), tier)
    assert exc.value.status == 422 and "levels deep" in exc.value.message


# ===================================================================================================================================
# 2. Duplicate halls in a portfolio (issue #112)
# ===================================================================================================================================


def portfolio(*docs):
    return call("/v1/portfolio", {"intakes": list(docs)})


def test_112_the_same_document_twice_is_refused_and_total_racks_not_inflated():
    """Issue #112. REFUSE (422 naming the repeat): a hall counts once. FIXED on this commit."""
    status, exc = portfolio(REF, REF)
    assert status == "refused" and exc.status == 422 and "repeats" in exc.message and exc.extra["duplicate_of"] == 0


def test_the_same_declared_site_and_hall_id_twice_is_refused_even_when_the_content_differs():
    """REFUSE: two entries that declare the same site.id and hall.id are the same hall however the rest differs (project label, positions).
    Adding both would count one physical hall twice."""
    other = doc(**{"hall.positions_available": 100, "project.reference": "OTHER"})
    status, exc = portfolio(REF, other)
    assert status == "refused" and exc.extra["index"] == 1


def test_key_order_does_not_hide_a_duplicate():
    """REFUSE: the same hall serialised with sorted keys is still the same hall."""
    status, _ = portfolio(REF, json.loads(json.dumps(REF, sort_keys=True)))
    assert status == "refused"


def test_sparse_identical_documents_with_default_ids_are_refused_as_duplicates():
    """REFUSE: two identical sparse documents (both SITE-1/HALL-1 by default) are identical documents, so one hall twice."""
    s = {"grid": {"contracted_MW": 12, "firm_capacity_MVA": 14}}
    status, _ = portfolio(s, copy.deepcopy(s))
    assert status == "refused"


def test_distinct_sparse_halls_with_the_same_default_ids_are_both_ranked_not_refused():
    """The other side of the rule: two genuinely different halls that both took the library default ids are not 'the same hall'."""
    status, out = portfolio({"grid": {"contracted_MW": 12, "firm_capacity_MVA": 14}}, {"grid": {"contracted_MW": 8, "firm_capacity_MVA": 14}})
    assert status == "ok" and len(out["halls"]) == 2 and out["total_racks"] == sum(h["racks"] for h in out["halls"])


def test_total_racks_is_the_sum_of_the_ranked_halls():
    """Invariant: total_racks equals the sum of the rows it ranks (no hidden extra term)."""
    status, out = portfolio(REF, json.loads((ROOT / "examples" / "intake" / "dublin_hall.json").read_text()))
    assert status == "ok" and out["total_racks"] == sum(h["racks"] for h in out["halls"])


def test_an_identical_hall_under_renamed_ids_is_refused_or_flagged():
    """REFUSE or DEGRADE WITH DISCLOSURE. Two entries that are identical in every figure and differ only in site.id/hall.id share one grid
    connection, one transformer bank and one set of peak figures: far more likely one hall listed twice than two halls. Today total_racks is
    124 for a hall whose single answer is 62 and the response is silent. Reproducer:
        post /v1/portfolio {"intakes": [reference_hall, {**reference_hall, site.id: "S-X", hall.id: "H-X"}]}  -> 200, total_racks 124."""
    renamed = doc(**{"site.id": "S-X", "hall.id": "H-X"})
    status, out = portfolio(REF, renamed)
    assert status == "refused" or "identical" in text_of(out).lower() or "duplicate" in text_of(out).lower()


@pytest.mark.parametrize("variant", [" DH-02 ", "dh-02", "DH-02\t"], ids=["padded", "lowercase", "tab"])
def test_a_cosmetic_variant_of_a_declared_hall_id_is_still_the_same_hall(variant):
    """REFUSE. The same declared site and a hall id that differs only by whitespace or case names the same hall; it must not evade the
    duplicate rule. Reproducer: second intake with hall.id ' DH-02 ' -> 200, total_racks 124."""
    status, _ = portfolio(REF, doc(**{"hall.id": variant}))
    assert status == "refused"


# ===================================================================================================================================
# 3. Conflicting identifiers
# ===================================================================================================================================


@pytest.mark.parametrize("edit", [{"project.reference": "REF-EU-09/XX-99"}, {"hall.id": "DH-77"}, {"site.id": "REF-EU-77"}],
                         ids=["reference-names-another-hall", "hall-id-disagrees", "site-id-disagrees"])
def test_hall_id_project_reference_and_site_id_that_disagree_are_refused_or_qualified(edit):
    """REFUSE or QUALIFY. The reference is '<site.id>/<hall.id>' in every shipped example. When the three disagree the document is about two
    halls at once; the engine must refuse or put a warning that names both identifiers. Today: no warning, no error."""
    d = doc(**edit)
    status, out = call("/v1/screen", {"intake": d})
    if status == "refused":
        return
    warnings = " ".join(out.get("warnings") or []) + " ".join(load_document(d).report.warnings)
    assert "reference" in warnings.lower() and ("site" in warnings.lower() or "hall" in warnings.lower())


# ===================================================================================================================================
# 4. Missing transformer data
# ===================================================================================================================================


def test_a_transformer_without_a_rating_is_refused_by_name():
    """REFUSE: a bank with no unit_rating_MVA cannot be modelled; the refusal names the field."""
    d = doc()
    d["transformers"][0].pop("unit_rating_MVA")
    status, exc = call("/v1/screen", {"intake": d})
    assert status == "refused" and "unit_rating_MVA" in str(exc)


def test_screen_discloses_that_transformer_capacity_was_not_evaluated():
    """DEGRADE WITH DISCLOSURE: with no transformer schedule the screen says transformer capacity is not evaluated and may bind."""
    status, out = call("/v1/screen", {"intake": doc(transformers=[])})
    assert status == "ok" and any("transformer capacity is not evaluated" in w for w in out["intake"]["warnings"])


@pytest.mark.parametrize("route", ["/v1/compare", "/v1/deck"])
def test_every_ranking_surface_discloses_a_missing_transformer_schedule(route):
    """DEGRADE WITH DISCLOSURE on every surface that ranks racks, not only the screen. Reproducer:
        POST /v1/compare {"intake": {**reference_hall, "transformers": []}} -> 200 whose text never says 'not evaluated'."""
    status, out = call(route, {"intake": doc(transformers=[])})
    assert status == "ok" and "not evaluated" in text_of(out)


@pytest.mark.parametrize("edit", [{"transformers.0.unit_rating_MVA": 0}, {"transformers.0.units": 0}], ids=["rating-0", "units-0"])
def test_a_zero_transformer_bank_makes_the_transformer_the_binding_constraint_not_a_silent_zero(edit):
    """DEGRADE WITH DISCLOSURE: a zero-capacity bank is not ignored; every scenario reports transformer_capacity as the binding constraint."""
    status, out = call("/v1/compare", {"intake": doc(**edit)})
    assert status == "ok" and {s["as_found"]["binding"] for s in out["scenarios"]} == {"transformer_capacity"}


# ===================================================================================================================================
# 5. Transformer uncertainty ranges (issue #107)
# ===================================================================================================================================


@pytest.mark.parametrize("weeks", [36, 44, 160, 200, 300, 520])
def test_107_a_supplied_transformer_lead_time_lies_inside_its_own_stated_range(weeks):
    """Issue #107. QUALIFY: whenever a transformer sets the date, low <= weeks <= high. FIXED on this commit (band = +-35% around the supplied
    value). Checked on every dated scenario of /v1/compare."""
    # The CDU schedule is declared: with none, the loader assumes a kit and every liquid scenario is undated (nothing would be checked here).
    cdus = [{"id": "CDU-ROW", "rated_capacity_kW": 1350, "rated_approach_K": 5, "rated_flow_l_per_min": 2000, "units": 3, "redundancy": "N+1"}]
    status, out = call("/v1/compare", {"intake": doc(**{"transformers.0.replacement_lead_time_weeks": weeks, "thermal.cdus": cdus})})
    assert status == "ok"
    dated = [s["time_to_power"] for s in out["scenarios"] if s["time_to_power"]["weeks"] is not None]
    assert dated
    for t in dated:
        assert t["low"] <= t["weeks"] <= t["high"], t


@pytest.mark.parametrize("edit", [{"transformers.0.derating_factor": 1.5}, {"transformers.0.derating_factor": 0}, {"transformers.0.derating_factor": -0.1},
                                  {"transformers.0.units": -1}, {"transformers.0.replacement_lead_time_weeks": -5},
                                  {"transformers.0.replacement_lead_time_weeks": 1e9}])
def test_impossible_transformer_figures_are_refused(edit):
    """REFUSE: a derating above 1 (or <=0), a negative count or lead time, and a lead time beyond the plausibility ceiling."""
    status, _ = call("/v1/screen", {"intake": doc(**edit)})
    assert status == "refused"


@pytest.mark.parametrize("value", [0.3, 0.99, 1.0])
def test_a_supplied_derating_lies_inside_its_own_band(value):
    """QUALIFY: a figure the client supplied must lie within the band printed with it (the invariant #107 asked for on the lead time).
    Reproducer: load_document({..., transformers[0].derating_factor: 0.99}).context.power.transformers[0].derating_factor.band == (0.85, 0.95)."""
    t = load_document(doc(**{"transformers.0.derating_factor": value})).context.power.transformers[0].derating_factor
    assert t.band[0] <= t.value <= t.band[1], (t.value, t.band)


def test_a_supplied_ups_step_load_lies_inside_its_own_band():
    """QUALIFY: same invariant as the transformer derating, on the UPS step-load capability."""
    u = load_document(doc(**{"ups.0.step_load_capability": 0.9})).context.power.ups[0].step_load_capability
    assert u.band[0] <= u.value <= u.band[1], (u.value, u.band)


# ===================================================================================================================================
# 6. Existing-load subtraction
# ===================================================================================================================================


def test_a_negative_existing_it_load_is_refused():
    """REFUSE: an IT load below zero is not a load."""
    assert call("/v1/screen", {"intake": doc(**{"grid.current_it_load_MW": -1})})[0] == "refused"


def test_more_existing_it_load_never_adds_racks():
    """Metamorphic: raising the load already on the supply can only keep or lower the racks that fit (monotonic non-increasing)."""
    seen = []
    for load in (0.5, 2.0, 4.9, 6.5, 7.4):
        status, out = call("/v1/compare", {"intake": doc(**{"grid.current_it_load_MW": load})})
        assert status == "ok"
        seen.append(racks(out, "full_dlc"))
    assert seen == sorted(seen, reverse=True), seen


@pytest.mark.parametrize("edit", [{"grid.current_it_load_MW": 4900}, {"grid.contracted_MW": 4000}, {"grid.current_site_peak_MW": 4900}],
                         ids=["it-load-kW-as-MW", "contracted-kW-as-MW", "peak-kW-as-MW"])
def test_a_kW_figure_typed_as_MW_is_refused_or_the_contradiction_is_stated(edit):
    """REFUSE or DEGRADE WITH DISCLOSURE: a 1000x unit slip that survives the plausibility ceiling must be named in /v1/compare's caveats."""
    status, out = call("/v1/compare", {"intake": doc(**edit)})
    assert status == "refused" or any("units" in c or "firm" in c for c in out["caveats"])


@pytest.mark.parametrize("edit", [{"grid.current_site_peak_MW": 7400}, {"grid.contracted_MW": 12000}, {"grid.current_it_load_MW": 12000}],
                         ids=["peak", "contracted", "it-load"])
def test_a_figure_over_the_plausibility_ceiling_is_refused_naming_the_unit(edit):
    """REFUSE: above 5000 MW is refused with 'Check the unit'."""
    status, exc = call("/v1/screen", {"intake": doc(**edit)})
    assert status == "refused" and "unit" in str(exc)


@pytest.mark.parametrize("peak", [0, 1.0, 4.0])
def test_a_site_peak_below_the_it_load_is_refused_or_named(peak):
    """REFUSE or DEGRADE WITH DISCLOSURE. current_site_peak_MW 0 with current_it_load_MW 4.9 means the existing load is subtracted from
    nothing, which frees supply that does not exist. Reproducer: POST /v1/compare with grid.current_site_peak_MW = 0 -> hybrid_dlc 68 racks
    (reference 26), caveats silent."""
    status, out = call("/v1/compare", {"intake": doc(**{"grid.current_site_peak_MW": peak})})
    if status == "refused":
        return
    assert any("peak" in c.lower() and "it load" in c.lower() for c in out["caveats"]), out["caveats"]


def test_an_it_load_above_the_site_peak_is_named_as_a_contradiction():
    """DEGRADE WITH DISCLOSURE: zero racks here is the inputs disagreeing, not a full hall; the caveats must say so."""
    status, out = call("/v1/compare", {"intake": doc(**{"grid.current_it_load_MW": 9.0})})
    assert status == "refused" or any("peak" in c.lower() and "it load" in c.lower() for c in out["caveats"])


# ===================================================================================================================================
# 7. Unsupported cooling architecture
# ===================================================================================================================================


@pytest.mark.parametrize("arch", ["immersion_magic", "", "FULL_DLC", "full dlc", 5, ["full_dlc"], {"a": 1}, True], ids=repr)
def test_an_unsupported_cooling_architecture_is_refused_listing_the_supported_ones(arch):
    """REFUSE: ``compute.default_architecture`` outside the catalogue is a 422 that lists what is available (never silently mapped)."""
    status, exc = call("/v1/screen", {"intake": doc(**{"compute.default_architecture": arch})})
    assert status == "refused" and "Available" in str(exc)


@pytest.mark.parametrize("scn", ["bogus", ["bogus"], ["retained_air", "x"], [1]], ids=repr)
def test_an_unsupported_scenario_name_is_refused(scn):
    """REFUSE: unknown scenario ids in the intake or the compare request are 4xx."""
    assert call("/v1/screen", {"intake": doc(scenarios=scn)})[0] == "refused"
    assert call("/v1/compare", {"intake": doc(), "scenarios": scn})[0] == "refused"


# ===================================================================================================================================
# 8. Physically impossible battery
# ===================================================================================================================================


@pytest.mark.parametrize("edit", [{"btm_options.0.capacity_MW": -2}, {"btm_options.0.energy_MWh": -8}, {"btm_options.0.capacity_MW": 1e9},
                                  {"btm_options.0.energy_MWh": 1e9}, {"btm_options.0.firm_capacity_factor": 1.01}], ids=repr)
def test_negative_or_absurd_battery_figures_are_refused(edit):
    """REFUSE: negative power or energy, or beyond the plausibility ceiling, or a firm factor above 1."""
    assert call("/v1/screen", {"intake": doc(**edit)})[0] == "refused"


@pytest.mark.parametrize("energy", [0, 0.001], ids=["0-MWh", "1-kWh"])
def test_a_battery_with_no_usable_energy_is_named_in_the_screen(energy):
    """DEGRADE WITH DISCLOSURE: a 2 MW battery credited 1 MW firm on 0 MWh is stated in the screen warnings (kept as declared, flagged)."""
    status, out = call("/v1/screen", {"intake": doc(**{"btm_options.0.energy_MWh": energy})})
    assert status == "ok" and any("sustains that for" in w for w in out["intake"]["warnings"])


def test_a_power_far_above_its_energy_is_named_in_the_screen():
    """DEGRADE WITH DISCLOSURE: 2000 MW on 8 MWh (about 15 seconds) credited 1000 MW firm is flagged in the screen warnings."""
    status, out = call("/v1/screen", {"intake": doc(**{"btm_options.0.capacity_MW": 2000, "btm_options.0.energy_MWh": 8})})
    assert status == "ok" and any("sustains that for" in w for w in out["intake"]["warnings"])


@pytest.mark.parametrize("route", ["/v1/compare", "/v1/deck"])
def test_the_battery_warning_travels_with_every_rack_count_it_affects(route):
    """DEGRADE WITH DISCLOSURE. Reproducer: POST /v1/compare with btm_options[0] = {capacity_MW: 2000, energy_MWh: 8, firm_capacity_factor: 0.5}
    -> full_dlc_btm 180 racks and no mention of the 15-second battery."""
    status, out = call(route, {"intake": doc(**{"btm_options.0.capacity_MW": 2000, "btm_options.0.energy_MWh": 8})})
    assert status == "ok" and "sustains that for" in text_of(out)


# ===================================================================================================================================
# 9. Unjustified firm generator capacity
# ===================================================================================================================================


GEN = REF["btm_options"][1]


@pytest.mark.parametrize("edit", [{"firm_capacity_factor": 1.5}, {"firm_capacity_factor": 0}, {"firm_capacity_factor": -0.2}, {"units": 0}, {"units": -1},
                                  {"units": 1.5}, {"redundancy": "N+1", "units": None}, {"redundancy": "N+99", "units": 3}, {"units": 4, "redundancy": 5}],
                         ids=repr)
def test_an_unjustified_generator_structure_is_refused(edit):
    """REFUSE: a firm factor above 1 (or <=0), zero or fractional units, a redundancy scheme with no unit count, an unknown scheme."""
    option = {**GEN, **edit}
    option = {k: v for k, v in option.items() if v is not None}
    assert call("/v1/screen", {"intake": doc(**{"btm_options.1": option})})[0] == "refused"


@pytest.mark.parametrize("scheme", ["N+1", "2N"])
def test_n_plus_one_on_a_single_unit_credits_nothing_and_says_so_in_the_screen(scheme):
    """DEGRADE WITH DISCLOSURE: one 5 MW engine under N+1 leaves no usable unit; the screen says it adds no firm capacity and the rack count
    is no higher than with the engine marked non-firm."""
    one = {**GEN, "units": 1, "redundancy": scheme}
    status, out = call("/v1/screen", {"intake": doc(**{"btm_options.1": one})})
    assert status == "ok" and any("no usable unit" in w for w in out["intake"]["warnings"])
    _, c_one = call("/v1/compare", {"intake": doc(**{"btm_options.1": one})})
    _, c_two = call("/v1/compare", {"intake": doc(**{"btm_options.1": {**GEN, "units": 2, "redundancy": "N+1"}})})
    assert racks(c_one) < racks(c_two)


@pytest.mark.parametrize("route", ["/v1/compare", "/v1/deck"])
def test_the_generator_redundancy_warning_travels_with_every_surface(route):
    """DEGRADE WITH DISCLOSURE. Reproducer: btm_options[1] units=1 redundancy='N+1' -> /v1/compare 200 with no mention."""
    status, out = call(route, {"intake": doc(**{"btm_options.1": {**GEN, "units": 1, "redundancy": "N+1"}})})
    assert status == "ok" and "no usable unit" in text_of(out)


@pytest.mark.parametrize("value", ["false", "no", "0", "False", [0]], ids=repr)
def test_a_non_boolean_firm_flag_is_refused_not_read_as_true(value):
    """REFUSE (or read as declared). ``"firm": "false"`` must not become firm=True. Reproducer:
        load_document({..., btm_options[1].firm: "false"}).context.power.options[1].firm  ->  True"""
    try:
        opt = load_document(doc(**{"btm_options.1": {**GEN, "firm": value}})).context.power.options[1]
    except IntakeError:
        return
    assert opt.firm is False


# ===================================================================================================================================
# 10. Supplier provenance (issue #110) reaches the report and the model pack
# ===================================================================================================================================

ANNOTATED = [("hall", "build_year", 2012), ("hall", "rack_positions", 400), ("hall", "positions_available", 180), ("lv", "phases", 3),
             ("lv", "busway_runs", 8), ("economics", "horizon_years", 10), ("economics", "discount_rate", 0.08)]


def annotated(section, key, value, **extra):
    d = doc()
    d.setdefault(section, {})[key] = {"value": value, "source": "SRC-MARK", "note": "NOTE-MARK", **extra}
    return d


@pytest.mark.parametrize("section,key,value", ANNOTATED)
def test_110_source_and_note_survive_into_the_model_pack(section, key, value):
    """Issue #110. QUALIFY: the machine-readable model pack (POST /v1/study, json) carries the source and the note of every annotated figure.
    FIXED on this commit."""
    status, out = call("/v1/study", {"intake": annotated(section, key, value)})
    pack = text_of(out)
    assert status == "ok" and "SRC-MARK" in pack and "NOTE-MARK" in pack


@pytest.mark.parametrize("section,key,value", ANNOTATED)
def test_110_source_and_note_survive_into_the_screen_document(section, key, value):
    """Issue #110. QUALIFY: the rendered screen shows source and note beside the figure. FIXED on this commit."""
    status, out = call("/v1/screen", {"intake": annotated(section, key, value), "format": "md"})
    assert status == "ok" and "SRC-MARK" in out["document"] and "NOTE-MARK" in out["document"]


@pytest.mark.parametrize("section,key,value", ANNOTATED)
def test_110_a_declared_evidence_class_is_kept_and_an_overstated_one_is_stated_as_capped_in_the_model_pack(section, key, value):
    """QUALIFY: a declared E3 reaches the model pack as E3; a declared E7 reaches it together with the statement that it was capped at E5."""
    status, out = call("/v1/study", {"intake": annotated(section, key, value, evidence="E3")})
    assert status == "ok" and '"evidence": "E3"' in text_of(out) and "capped at E5" not in text_of(out)
    status, out = call("/v1/study", {"intake": annotated(section, key, value, evidence="E7")})
    assert status == "ok" and f"{section}.{key}: declared evidence E7 capped at E5" in text_of(out)


def test_110_the_study_document_that_prints_an_annotated_figure_prints_its_source():
    """QUALIFY: whatever figure a document prints it must print with the source the client declared for it."""
    status, out = call("/v1/study", {"intake": annotated("hall", "build_year", 2012), "format": "md"})
    assert status == "ok" and "Built | 2012" in out["document"] and "SRC-MARK" in out["document"]


@pytest.mark.parametrize("bad", [{"value": 12, "source": ["x"]}, {"value": 12, "note": 3}, {"value": 12, "source": {"a": 1}}, {"source": "S"}], ids=repr)
def test_a_malformed_annotation_is_refused(bad):
    """REFUSE: a source/note that is not text, or an annotation without a value, is a 4xx naming the field."""
    assert call("/v1/screen", {"intake": doc(**{"grid.contracted_MW": bad})})[0] == "refused"


# ===================================================================================================================================
# 11. Overstated evidence class
# ===================================================================================================================================


@pytest.mark.parametrize("claimed", ["E6", "E7", "e7", "E7_VALIDATED"])
@pytest.mark.parametrize("path", ["grid.contracted_MW", "grid.firm_capacity_MVA", "hall.design_density_kW_per_rack", "lv.busway_ampacity_A",
                                  "thermal.plant.chilled_water_capacity_kW", "hall.build_year"])
def test_a_client_declared_E6_or_E7_is_capped_at_E5_with_a_warning(path, claimed):
    """QUALIFY: the client can attest to their own data, never to our validation. The class is clamped to E5 and the clamp is in the warnings."""
    d = doc()
    sec, key = path.rsplit(".", 1)
    cur = d
    for part in sec.split("."):
        cur = cur[part]
    cur[key] = {"value": cur[key]["value"] if isinstance(cur[key], dict) else cur[key], "source": "client", "evidence": claimed}
    intake = load_document(d)
    assert any(path in w and "capped at E5" in w for w in intake.report.warnings)
    assert next(s for s in intake.report.sourced if s.path == path).evidence == "E5"


@pytest.mark.parametrize("claimed", ["E9", "E8", 7, "7", "E", "Z3", ""], ids=repr)
def test_an_evidence_class_that_does_not_exist_is_refused(claimed):
    """REFUSE: only E0..E7 exist. (An empty string is 'not declared' and is accepted; the others are 422.)"""
    d = doc(**{"grid.contracted_MW": {"value": 12, "source": "x", "evidence": claimed}})
    if claimed == "":
        assert load_document(d)
    else:
        assert call("/v1/screen", {"intake": d})[0] == "refused"


def test_no_rack_count_in_a_comparison_exceeds_E5_when_every_grid_input_claims_E7():
    """QUALIFY: an answer resting on client-declared inputs can never be above E5 (E6/E7 are earned by the calibration ledger)."""
    d = doc()
    for k in ("contracted_MW", "firm_capacity_MVA", "current_it_load_MW"):
        d["grid"][k] = {"value": REF["grid"][k], "evidence": "E7"}
    status, out = call("/v1/compare", {"intake": d})
    assert status == "ok"
    # The evidence classes the answer CARRIES: structured values only. The notes may quote "E6 and E7 are earned through the calibration
    # ledger" while disclosing the cap, and that sentence is the honest behaviour, not a claim of E6/E7.
    classes: set[str] = set()

    def walk(node, key=""):
        if isinstance(node, dict):
            for k, v in node.items():
                walk(v, str(k))
        elif isinstance(node, list):
            for v in node:
                walk(v, key)
        elif isinstance(node, str) and ("evidence" in key.lower() or "class" in key.lower()):
            classes.update(re.findall(r"^E[0-7]", node))

    walk(out)
    assert classes, "the comparison must carry evidence classes for this test to mean anything"
    assert not classes & {"E6", "E7"}, classes


# ===================================================================================================================================
# 12. Stale / invalid model version in requests that carry one
# ===================================================================================================================================


def _state(scenario="full_dlc"):
    from gridforge.change import EnvelopeState
    from gridforge.scenario import run_all
    intake = load_document(REF)
    res = next(r for r in run_all(intake.context, intake.scenarios) if r.spec.id == scenario)
    return dataclasses.asdict(EnvelopeState.of(res, REF))


@pytest.mark.parametrize("stale,expected", [({"price_basis_digest": "deadbeef"}, "prices"), ({"relief_path_digest": "old"}, "relief path")],
                         ids=["stale-price-basis", "stale-relief-path"])
def test_a_recorded_state_from_an_older_model_is_reported_as_model_drift(stale, expected):
    """DEGRADE WITH DISCLOSURE: a previous_state recorded under other prices or another relief path is not silently compared as if the model
    were unchanged; ``model_drift`` names what differs and model_drift_known is true."""
    status, out = call("/v1/diff", {"previous_state": {**_state(), **stale}, "after": REF})
    assert status == "ok" and expected in out["model_drift"] and out["model_drift_known"] is True


def test_the_change_note_document_states_the_model_drift():
    """DEGRADE WITH DISCLOSURE: the rendered change note (not only the JSON) tells the reader the model moved."""
    status, out = call("/v1/diff", {"previous_state": {**_state(), "price_basis_digest": "deadbeef"}, "after": REF, "format": "md"})
    assert status == "ok" and re.search(r"price", out["document"], re.I)


@pytest.mark.parametrize("extra", [{"engine_version": "0.1.0"}, {"model_version": "0.0"}, {"schema": "gridforge/envelope-state/0"}], ids=repr)
def test_a_state_carrying_a_version_field_this_product_never_issued_is_refused(extra):
    """REFUSE: unknown fields in a recorded state (a forged or foreign version stamp) are a 422 naming the field."""
    status, exc = call("/v1/diff", {"previous_state": {**_state(), **extra}, "after": REF})
    assert status == "refused" and "unknown field" in str(exc)


@pytest.mark.parametrize("breakage", [{"weeks_lo": 500, "weeks_hi": 10}, {"racks_after_ladder": -3}, {"weeks_class": "E9"}, {"capex_eur": float("nan")},
                                      {"racks_as_found": True}, {"intake_digest": 5}], ids=repr)
def test_a_corrupt_recorded_state_is_refused_by_field(breakage):
    """REFUSE: a state this product could not have issued (inverted interval, negative racks, unknown evidence class, NaN, bool as a count)."""
    status, exc = call("/v1/diff", {"previous_state": {**_state(), **breakage}, "after": REF})
    assert status == "refused" and isinstance(exc, S.ApiError) and exc.status == 422


@pytest.mark.parametrize("version", ["1999-01-01", "2024-11-05", "banana", 5, None, ["x"]], ids=repr)
def test_mcp_initialize_with_a_stale_or_invalid_protocol_version_negotiates_down_to_the_one_served(version):
    """QUALIFY: a client asking for a protocol revision the server does not speak is answered with the server's own revision (JSON-RPC
    version negotiation), never echoed back and never an error that kills the session."""
    out = S.handle_mcp({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": version}}, Tier.PUBLIC, None)
    assert out["result"]["protocolVersion"] == S.PROTOCOL_VERSION


# ===================================================================================================================================
# 13. Incomplete deliverable (a release with missing sections)
# ===================================================================================================================================


def _screen_report_and_claims():
    from gridforge.reporting.screen import build as build_screen
    from gridforge.reporting.study import Objective, collect_claims
    from gridforge.scenario import run_all
    intake = load_document(REF)
    results = run_all(intake.context, intake.scenarios)
    return build_screen(intake, results, objective=Objective("max_compute")), collect_claims(results)


def _gate_verdict(report, claims) -> bool:
    """True when the real report gates would let this report leave the building."""
    from gridforge.reporting import to_markdown
    from gridforge.reporting.gates import GateFailure, ReportMode, run_all_gates
    try:
        run_all_gates(report, to_markdown(report), claims=claims, mode=ReportMode.SCREENING)
        return True
    except GateFailure:
        return False


def test_the_complete_screen_passes_the_gates():
    """Control: the unmodified screen is released."""
    report, claims = _screen_report_and_claims()
    assert _gate_verdict(report, claims)


def test_a_screen_stripped_of_every_section_is_not_released():
    """REFUSE: a deliverable with no sections at all cannot leave the building (today the claim-floor gate happens to stop it, because the
    evidence disclosure went with the sections)."""
    report, claims = _screen_report_and_claims()
    report = copy.copy(report)
    report.sections = []
    assert not _gate_verdict(report, claims)


@pytest.mark.parametrize("heading", ["1. The answer", "2. What stops this hall, in order", "3. Architectures screened", "5. Recommended next step"])
def test_a_screen_missing_a_required_section_is_not_released(heading):
    """REFUSE: the gates stand between a modelled number and a customer; a release that lacks the section that states the answer, the binding
    constraint, the architectures compared or the next step is an incomplete deliverable and must fail a gate. Reproducer:
        report.sections = [s for s in report.sections if s.heading != '1. The answer']; run_all_gates(report, to_markdown(report), claims)
        -> returns without raising."""
    report, claims = _screen_report_and_claims()
    report = copy.copy(report)
    assert heading in [s.heading for s in report.sections]
    report.sections = [s for s in report.sections if s.heading != heading]
    assert not _gate_verdict(report, claims)


@pytest.mark.parametrize("heading", ["4. Fee, timing and terms", "5. What is outside scope"])
def test_a_proposal_missing_its_commercial_sections_is_not_released(heading):
    """REFUSE: a proposal that omits the fee and terms, or what is out of scope, is an incomplete deliverable."""
    from gridforge.commercial import engagement
    from gridforge.reporting.proposal import build as build_proposal
    from gridforge.reporting.study import Objective, collect_claims
    from gridforge.scenario import run_all
    intake = load_document(REF)
    results = run_all(intake.context, intake.scenarios)
    report = build_proposal(intake, results, engagement("density_screen"), objective=Objective("max_compute"), valid_days=30, contact="")
    report = copy.copy(report)
    report.sections = [s for s in report.sections if s.heading != heading]
    assert not _gate_verdict(report, collect_claims(results))


# ===================================================================================================================================
# 14. Numbers
# ===================================================================================================================================

NUMERIC_FIELDS = ["grid.contracted_MW", "grid.firm_capacity_MVA", "grid.current_it_load_MW", "hall.positions_available", "hall.rack_positions",
                  "transformers.0.units", "transformers.0.unit_rating_MVA", "btm_options.1.capacity_MW", "compute.utilisation",
                  "thermal.plant.chilled_water_capacity_kW", "lv.busway_runs", "economics.horizon_years"]
HOSTILE_NUMBERS = {
    "1e308": 1e308, "huge-int": 10 ** 400, "nan": float("nan"), "inf": float("inf"), "-inf": float("-inf"), "true": True, "false": False,
    "arabic-digits": "١٢٣", "kW-string": "12 kW", "numeric-string": "12", "empty-string": "", "list": [12], "object": {"v": 12}, "negative": -1,
    "fullwidth-digits": "１２",
}


@pytest.mark.parametrize("field", NUMERIC_FIELDS)
@pytest.mark.parametrize("name", sorted(HOSTILE_NUMBERS))
def test_a_hostile_number_in_any_numeric_field_is_refused(field, name):
    """REFUSE: 1e308, an integer too large for a float, NaN, +-Infinity, booleans, unicode digits, 'kW' strings, numeric strings, lists and
    objects where a number belongs are all refusals naming the field (never a crash, never a silent coercion)."""
    status, _ = call("/v1/screen", {"intake": doc(**{field: HOSTILE_NUMBERS[name]})})
    assert status == "refused", (field, name)


@pytest.mark.parametrize("field", ["grid.contracted_MW", "grid.current_it_load_MW", "grid.current_site_peak_MW"])
def test_negative_zero_is_a_zero_not_a_negative_load(field):
    """QUALIFY: -0.0 is accepted as zero and never leaks a negative rack count, a '-0' or a NaN into the answer."""
    status, out = call("/v1/compare", {"intake": doc(**{field: -0.0})})
    assert status == "ok"
    assert all(s["after_ladder"]["racks"] >= 0 for s in out["scenarios"])
    assert "NaN" not in text_of(out) and "Infinity" not in text_of(out)


def test_zero_free_positions_is_a_zero_rack_answer_that_says_nothing_is_deployable():
    """DEGRADE WITH DISCLOSURE: 0 positions available gives 0 racks everywhere and a ranking with no leader, not a crash or a phantom winner."""
    status, out = call("/v1/compare", {"intake": doc(**{"hall.positions_available": 0})})
    assert status == "ok" and all(s["after_ladder"]["racks"] == 0 for s in out["scenarios"])
    assert out["ranking"]["leader"] is None or out["ranking"]["order"] == []


def test_a_zero_rack_hall_in_a_portfolio_is_ranked_with_zero_not_dropped_or_crashed():
    """The portfolio keeps a hall that yields 0 racks (it is information) and the total is the sum of what is ranked."""
    status, out = portfolio(REF, doc(**{"site.id": "S-2", "hall.id": "H-2", "hall.positions_available": 0}))
    assert status == "ok" and sorted(h["racks"] for h in out["halls"]) == [0, 62] and out["total_racks"] == 62


def test_a_rack_position_total_of_zero_with_free_positions_is_refused():
    """REFUSE: zero racks in the hall but 180 free positions is a contradiction the loader names."""
    status, exc = call("/v1/screen", {"intake": doc(**{"hall.rack_positions": 0})})
    assert status == "refused" and "positions_available" in str(exc)


QUALIFY_BODY = {"contracted_MW": 12, "current_site_peak_MW": 7.4, "current_it_load_MW": 4.9, "busway_ampacity_A": 400, "tapoff_max_A": 63,
                "plant_supply_C": 6, "positions_available": 180}


@pytest.mark.parametrize("value", [1e308, float("nan"), float("inf"), float("-inf"), "12 kW", "abc", "", [1], {"v": 1}], ids=repr)
@pytest.mark.parametrize("field", sorted(QUALIFY_BODY))
def test_the_free_qualifier_refuses_hostile_numbers_with_a_4xx(field, value):
    """REFUSE (public endpoint, no key): the seven-question qualifier never answers an enormous, non-finite, unit-suffixed or structured value
    and never 500s."""
    status, _ = call("/v1/qualify", {**QUALIFY_BODY, field: value})
    assert status == "refused", (field, value)


@pytest.mark.parametrize("value", [True, "12", "١٢", "１２"], ids=["bool", "numeric-string", "arabic-digits", "fullwidth-digits"])
@pytest.mark.parametrize("field", ["contracted_MW", "positions_available"])
def test_the_free_qualifier_refuses_booleans_and_text_as_numbers(field, value):
    """REFUSE: the same rule as the intake loader (a quantity is a JSON number, and nothing else). Reproducer:
        POST /v1/qualify {...contracted_MW: true...} -> 200, solved as a 1 MW contract."""
    status, _ = call("/v1/qualify", {**QUALIFY_BODY, field: value})
    assert status == "refused"
