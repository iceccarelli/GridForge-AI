"""A generation option's firm credit accounts for the units it is made of and the redundancy scheme it is held to.

Before: `capacity_MW` is the option's total nameplate and nothing said how many units made it up, so a single 5 MW engine was credited 4.6 MW
firm although, under N+1, that engine is exactly the unit whose loss the plant must survive. In the reference hall the same 5 MW is worth 62
racks as undeclared nameplate and 34 as one engine under N+1. Each test is a way the credit could still overstate what the plant gives, or
a way declaring the structure could break a valid payload.
"""
import copy
import itertools
import json
import math
from pathlib import Path

import pytest

from gridforge.common import ASSUMED, V
from gridforge.intake.loader import IntakeError, load_document
from gridforge.power.btm import UNIT_BASED_KINDS, firm_contribution_kW, firm_factor
from gridforge.power.constraints import _effective_units as power_bank_units
from gridforge.power.redundancy import DEFAULT_GENERATION_REDUNDANCY, SCHEMES, usable_units
from gridforge.power.schema import GenerationOption
from gridforge.scenario.run import run_all
from gridforge.thermal.constraints import _effective_units as thermal_bank_units

ROOT = Path(__file__).resolve().parents[1]
BASE = json.loads((ROOT / "examples" / "intake" / "reference_hall.json").read_text())
ALL_SCHEMES = [*SCHEMES, "N+0", "N+N"]


def intake(**gen):
    d = copy.deepcopy(BASE)
    next(x for x in d["btm_options"] if x["kind"] == "gas_engine").update(gen)
    return load_document(d)


def engine(i):
    return next(x for x in i.context.power.options if x.kind == "gas_engine")


def firm_kW(i):
    return firm_contribution_kW(engine(i)).value


def gap_paths(i):
    return {g.path for g in i.report.gaps if "GEN-5MW" in g.path}


def warned(i):
    return [w for w in i.report.warnings if "GEN-5MW" in w]


def option(units=None, redundancy=None, capacity=5.0, **kw):
    return GenerationOption(id="G", kind="gas_engine", capacity_MW=V(capacity, "MW", "c", ASSUMED), capex_eur_per_kW=None,
                            lead_time_weeks=None, firm=True, units=units, redundancy=redundancy, **kw)


LEGACY = 5000 * firm_factor(option()).value                  # nameplate x the gas-engine factor, what was always credited


# --- one definition of N+1 ----------------------------------------------------------------------------------------------


@pytest.mark.parametrize("scheme", ALL_SCHEMES)
@pytest.mark.parametrize("units", range(0, 13))
def test_generators_banks_and_cooling_share_one_definition_of_usable_units(units, scheme):
    """The envelope holds three copies of this arithmetic (the shared one, the power banks', the cooling banks'). A generator plant and
    the transformers carrying its output must not be held to different definitions of N+1, so the copies are pinned equal."""
    assert usable_units(units, scheme) == power_bank_units(units, scheme) == thermal_bank_units(units, scheme)


def test_an_unknown_scheme_is_refused_not_treated_as_n():
    with pytest.raises(ValueError):
        usable_units(4, "2N+1")


# --- the arithmetic -------------------------------------------------------------------------------------------------------


@pytest.mark.parametrize("units,scheme,expected_kW", [
    (1, "N+1", 0), (2, "N+1", 2300), (4, "N+1", 3450), (5, "N+1", 3680),      # 5 MW x 0.92 x (n-1)/n
    (4, "N", 4600), (1, "N", 4600), (4, "N+2", 2300), (2, "N+2", 0), (4, "2N", 2300), (3, "2N", 1533.3333),
])
def test_firm_contribution_is_usable_units_over_units_times_nameplate_times_factor(units, scheme, expected_kW):
    assert firm_contribution_kW(option(units, scheme)).value == pytest.approx(expected_kW, abs=1e-3)


def test_an_option_that_declares_no_structure_is_credited_exactly_as_before():
    assert firm_contribution_kW(option()).value == pytest.approx(4600.0)
    assert LEGACY == pytest.approx(4600.0)


# --- properties over the whole input space --------------------------------------------------------------------------------


@pytest.mark.parametrize("scheme", ALL_SCHEMES)
@pytest.mark.parametrize("units", range(1, 41))
def test_declaring_the_structure_can_only_lower_a_credit_never_raise_it(units, scheme):
    """The dangerous direction is optimistic. Whatever is declared, the credit is at most what an undeclared option always got."""
    assert firm_contribution_kW(option(units, scheme)).value <= LEGACY + 1e-9


@pytest.mark.parametrize("scheme", ["N+1", "N+2"])
def test_splitting_the_same_capacity_into_more_units_never_lowers_the_credit(scheme):
    credits = [firm_contribution_kW(option(n, scheme)).value for n in range(1, 41)]
    assert credits == sorted(credits)
    assert credits[0] == 0.0 and credits[-1] < LEGACY


def test_n_is_never_below_n_plus_1_which_is_never_below_n_plus_2():
    for n in range(1, 41):
        a, b, c = (firm_contribution_kW(option(n, s)).value for s in ("N", "N+1", "N+2"))
        assert a >= b >= c


def test_n_plus_1_is_never_below_2n():
    for n in range(1, 41):
        assert firm_contribution_kW(option(n, "N+1")).value >= firm_contribution_kW(option(n, "2N")).value - 1e-9


def test_a_lone_unit_is_never_n_plus_1_firm():
    assert firm_contribution_kW(option(1, "N+1")).value == 0.0


def test_the_credit_scales_linearly_with_capacity_so_the_structure_is_a_fraction_not_a_constant():
    for cap in (0.5, 5.0, 50.0):
        assert firm_contribution_kW(option(4, "N+1", capacity=cap)).value == pytest.approx(0.75 * cap * 1000 * firm_factor(option()).value)


# --- the loader -----------------------------------------------------------------------------------------------------------


def test_undeclared_structure_changes_no_number_and_is_a_named_gap():
    i = intake()
    assert firm_kW(i) == pytest.approx(4600.0)
    assert gap_paths(i) == {"btm_options[GEN-5MW].units"}
    g = next(g for g in i.report.gaps if g.path.endswith(".units"))
    assert not g.required and "none of it as one unit" in g.why_it_binds and g.how_to_get_it


def test_a_declared_structure_closes_the_gap():
    assert gap_paths(intake(units=4, redundancy="N+1")) == set()


def test_units_without_a_scheme_assume_the_convention_of_every_other_bank_and_say_so():
    i = intake(units=4)
    assert engine(i).redundancy == DEFAULT_GENERATION_REDUNDANCY == "N+1"
    assert firm_kW(i) == pytest.approx(3450.0)
    assert any("no redundancy scheme" in w and "N+1 is assumed" in w for w in warned(i))


def test_an_explicit_n_is_taken_at_its_word_without_a_warning():
    i = intake(units=4, redundancy="N")
    assert firm_kW(i) == pytest.approx(4600.0) and warned(i) == []


def test_a_plant_that_leaves_no_usable_unit_says_so_and_credits_nothing():
    i = intake(units=1, redundancy="N+1")
    assert firm_kW(i) == 0.0
    assert any("no usable unit" in w and "adds no firm capacity" in w for w in warned(i))


def test_a_scheme_is_normalised_but_what_the_customer_wrote_is_what_is_stored():
    assert firm_kW(intake(units=4, redundancy="n+1")) == pytest.approx(3450.0)
    assert firm_kW(intake(units=4, redundancy=" N + 1 ")) == pytest.approx(3450.0)


def test_null_means_undeclared_like_every_other_optional_field():
    i = intake(units=None, redundancy=None)
    assert firm_kW(i) == pytest.approx(4600.0) and gap_paths(i) == {"btm_options[GEN-5MW].units"}


def test_an_option_that_is_not_firm_is_not_checked_and_asks_for_nothing():
    i = intake(firm=False, units=1, redundancy="N+1")
    assert firm_contribution_kW(engine(i)).value == 0.0
    assert warned(i) == [] and gap_paths(i) == set()


def test_a_non_firm_option_without_structure_is_not_a_gap():
    assert gap_paths(intake(firm=False)) == set()


# --- refusals, by name ----------------------------------------------------------------------------------------------------


@pytest.mark.parametrize("scheme", ["N+1", "N+2", "2N"])
def test_a_scheme_with_no_unit_count_is_refused_not_silently_ignored(scheme):
    with pytest.raises(IntakeError, match=r"GEN-5MW.*needs units.*how many identical units"):
        intake(redundancy=scheme)


def test_n_with_no_unit_count_asks_for_nothing_more_than_the_nameplate_gives():
    assert firm_kW(intake(redundancy="N")) == pytest.approx(4600.0)


@pytest.mark.parametrize("units", [0, -1, 2.5, "3", True, False, 1e9, 101, float("nan"), float("inf"), [], {}, [4]])
def test_a_unit_count_must_be_a_whole_number_of_at_least_one_and_plausible(units):
    with pytest.raises(IntakeError):
        intake(units=units, redundancy="N+1")


@pytest.mark.parametrize("scheme", ["2N+1", "N+3", "", "n plus 1", 1, True, ["N+1"], {"a": 1}])
def test_an_unrecognised_scheme_is_refused_by_name_never_defaulted_to_n(scheme):
    with pytest.raises(IntakeError):
        intake(units=4, redundancy=scheme)


@pytest.mark.parametrize("kind", ["bess", "pv", "wind", "grid_reinforcement", "diesel", "fuel_cel"])
def test_units_on_a_technology_that_is_not_made_of_such_units_are_refused(kind):
    d = copy.deepcopy(BASE)
    d["btm_options"].append({"id": "X", "kind": kind, "capacity_MW": 1.0, "units": 2, "redundancy": "N+1"})
    with pytest.raises(IntakeError, match=r"X.*units and redundancy describe generating units"):
        load_document(d)


@pytest.mark.parametrize("kind", sorted(UNIT_BASED_KINDS))
def test_every_unit_based_technology_accepts_the_structure(kind):
    d = copy.deepcopy(BASE)
    d["btm_options"].append({"id": "X", "kind": kind, "capacity_MW": 4.0, "units": 4, "redundancy": "N+1"})
    o = next(x for x in load_document(d).context.power.options if x.id == "X")
    assert firm_contribution_kW(o).value == pytest.approx(0.75 * 4000 * firm_factor(o).value)


def test_the_error_names_the_option_and_the_field_but_never_echoes_a_customer_string_blindly():
    with pytest.raises(IntakeError) as e:
        intake(units=0)
    assert "GEN-5MW" in str(e.value) and "units" in str(e.value)


# --- what it does to the answer -------------------------------------------------------------------------------------------


def best_racks(i):
    return max(r.unlocked_racks for r in run_all(i.context, i.scenarios))


def test_the_same_capacity_is_worth_more_racks_the_more_units_share_it():
    """Reference hall: 62 racks undeclared, 55 as four units, 48 as two, 34 as one engine under N+1 (no better than no on-site supply)."""
    undeclared, four, two, one = (best_racks(intake(**k)) for k in ({}, dict(units=4), dict(units=2), dict(units=1)))
    assert undeclared >= four > two > one
    assert undeclared > one + 10, "the structure must matter to the answer, or declaring it is decoration"


def test_a_single_engine_under_n_plus_1_is_worth_no_more_than_having_no_on_site_supply():
    d = copy.deepcopy(BASE)
    d["btm_options"] = [o for o in d["btm_options"] if o["kind"] != "gas_engine"]
    without = best_racks(load_document(d))
    assert best_racks(intake(units=1, redundancy="N+1")) <= without + 1


def _relief_descriptions(i):
    return [st.relief_description for r in run_all(i.context, i.scenarios) for st in r.ladder.steps
            if st.relief_description and "GEN-5MW" in st.relief_description]


def test_the_relief_step_names_the_plant_it_is_taking():
    """The ladder step that takes the engine says how many units it is and what scheme, so the reader sees what the credit rests on."""
    declared = _relief_descriptions(intake(units=4, redundancy="N+1"))
    assert declared, "the reference hall's BTM scenario must take the engine, or this test proves nothing"
    assert all("(gas_engine, 5 MW, 4 units under N+1)" in d for d in declared)


def test_the_relief_step_for_an_option_with_no_structure_reads_exactly_as_it_always_did():
    undeclared = _relief_descriptions(intake())
    assert undeclared and all(d.endswith("(gas_engine, 5 MW)") for d in undeclared)


# --- hostile input: nothing but a clean refusal or an answer, through the real handler ------------------------------------

HOSTILE = [None, True, False, 0, -1, 1, 2, 3.5, 10 ** 400, -(10 ** 400), 2 ** 63, float("nan"), float("inf"), -float("inf"), 1e308, -0.0,
           "", " ", "N", "N+1", "2N", "3", "0", "\u0000", "N+1" * 1000, [], [1], [[]], {}, {"a": 1}, {"value": 4}]
KINDS = ["gas_engine", "chp", "fuel_cell", "bess", "pv", "wind", "grid_reinforcement", "diesel", "", "GAS_ENGINE", 5, None, ["x"]]


@pytest.mark.parametrize("kind", KINDS, ids=repr)
def test_no_value_of_either_field_on_any_kind_escapes_as_a_server_fault(kind):
    """Through handle_screen, the paid route: the only outcomes are an answer or an IntakeError (which the API turns into a 422)."""
    from gridforge.api import server as S
    from gridforge.api.tiers import Tier
    for units, scheme in itertools.product(HOSTILE, HOSTILE):
        d = copy.deepcopy(BASE)
        o = {"id": "X", "kind": kind, "capacity_MW": 2.0, "units": units, "redundancy": scheme}
        d["btm_options"] = [o]
        try:
            out = S.handle_screen({"intake": d}, Tier.CLIENT)
        except IntakeError:
            continue                                                    # a clean, named refusal
        assert isinstance(out, dict), (kind, units, scheme)


def test_a_refusal_carries_no_traceback_text_and_names_the_option():
    for units in (0, -1, 2.5, "3", float("nan"), [4]):
        with pytest.raises(IntakeError) as e:
            intake(units=units, redundancy="N+1")
        msg = str(e.value)
        assert "GEN-5MW" in msg and "Traceback" not in msg and "object at 0x" not in msg


def test_a_valid_payload_that_never_mentions_the_fields_is_untouched_by_all_of_this():
    """Every example intake that predates the fields still loads, and no number on any of them moved."""
    for f in sorted((ROOT / "examples" / "intake").glob("*.json")):
        doc = json.loads(f.read_text())
        assert load_document(doc).context.power is not None
        for o in doc.get("btm_options", []) or []:
            assert "units" not in o and "redundancy" not in o
