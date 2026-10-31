"""A battery is credited as FIRM only for what its energy can sustain over the window it must ride through.

The flat library factor (0.50) knew neither, so in the hall envelope a 2 MW / 0.1 MWh battery (about five minutes of discharge) was
credited exactly as a 2 MW / 8 MWh one, with no gap and no warning, and an explicit factor was never checked against a declared energy.
Each test is a way the credit could still overstate what the battery gives.
"""
import copy
import json
from pathlib import Path

import pytest

from gridforge.intake.loader import IntakeError, load_document
from gridforge.power.btm import DEFAULT_FIRM_FACTOR, bess_energy_limited_hours, bess_firm_factor_for_duration, firm_contribution_kW

ROOT = Path(__file__).resolve().parents[1]
BASE = json.loads((ROOT / "examples" / "intake" / "reference_hall.json").read_text())
FLAT = DEFAULT_FIRM_FACTOR["bess"]


def intake(**bess):
    d = copy.deepcopy(BASE)
    o = next(x for x in d["btm_options"] if x["kind"] == "bess")
    for k in ("energy_MWh", "ride_through_hours", "firm_capacity_factor"):
        o.pop(k, None)
    o.update(bess)
    return load_document(d)


def battery(i):
    return next(x for x in i.context.power.options if x.kind == "bess")


def factor(i):
    f = battery(i).firm_capacity_factor
    return f.value if f is not None else FLAT          # None means the flat library default applies


def gaps(i):
    return {g.path.split(".")[-1] for g in i.report.gaps if g.path.startswith("btm_options[BESS")}


def warned(i):
    return [w for w in i.report.warnings if "BESS" in w]


# --- the defect -----------------------------------------------------------------------------------------------------------


def test_a_tiny_battery_is_no_longer_credited_like_a_large_one():
    tiny, large = intake(energy_MWh=0.1), intake(energy_MWh=8)
    assert factor(tiny) < 0.05, "0.1 MWh sustains 1 MW for about five minutes: it is not 1 MW of firm capacity"
    assert factor(large) == FLAT
    assert firm_contribution_kW(battery(tiny)).value < firm_contribution_kW(battery(large)).value
    assert firm_contribution_kW(battery(large)).value == pytest.approx(FLAT * 2000)        # 0.50 x 2 MW, as before: nothing rose


@pytest.mark.parametrize("mwh", [0.01, 0.1, 0.5, 1, 2, 4, 8, 20, 100])
def test_an_assumed_window_never_raises_a_credit_above_the_flat_default(mwh):
    """The dangerous direction is optimistic. With no declared window the credit is the LESSER of the flat default and what the energy
    supports, for every size: a library window cannot make a battery look better than the default did."""
    assert factor(intake(energy_MWh=mwh)) <= FLAT


def test_the_credit_never_falls_as_the_battery_grows():
    fs = [factor(intake(energy_MWh=m)) for m in (0.05, 0.1, 0.5, 1, 2, 4, 8, 16)]
    assert fs == sorted(fs)


def test_a_reduced_credit_says_so_and_says_what_would_fix_it():
    i = intake(energy_MWh=0.1)
    assert any("no ride-through window was declared" in w and "less than the flat" in w for w in warned(i))
    assert "ride_through_hours" in gaps(i)


# --- what is unchanged ----------------------------------------------------------------------------------------------------


def test_declared_energy_and_window_is_the_unchanged_power_vs_energy_calculation():
    i = intake(energy_MWh=8, ride_through_hours=2)
    from gridforge.common import ASSUMED, V
    expected = bess_firm_factor_for_duration(battery(i), V(2.0, "h", "x", ASSUMED)).value
    assert factor(i) == pytest.approx(expected)
    assert gaps(i) == set() and warned(i) == []


def test_no_energy_keeps_the_flat_credit_and_names_the_gap():
    i = intake()
    assert factor(i) == FLAT and battery(i).firm_capacity_factor is None
    assert gaps(i) == {"energy_MWh"}


def test_a_customers_own_factor_with_no_energy_is_kept_and_the_gap_is_named():
    i = intake(firm_capacity_factor=0.4)
    assert factor(i) == pytest.approx(0.4)
    assert gaps(i) == {"energy_MWh"}


def test_a_battery_that_is_not_firm_is_not_checked():
    i = intake(firm=False, firm_capacity_factor=0.9, energy_MWh=0.01, ride_through_hours=6)
    assert gaps(i) == set() and warned(i) == []


# --- contradictions -------------------------------------------------------------------------------------------------------


def test_a_factor_that_needs_more_energy_than_the_battery_stores_is_refused_by_name():
    with pytest.raises(IntakeError) as e:
        intake(firm_capacity_factor=0.9, energy_MWh=0.5, ride_through_hours=3)
    msg = str(e.value)
    assert "BESS-2MW-8MWh" in msg and "5.4 MWh" in msg and "stores only 0.5 MWh" in msg and "contradict" in msg


def test_the_boundary_is_exact_a_factor_the_energy_just_covers_is_accepted():
    i = intake(firm_capacity_factor=0.5, energy_MWh=3, ride_through_hours=3)        # 0.5 x 2 MW x 3 h = 3 MWh = stored
    assert factor(i) == pytest.approx(0.5)


def test_a_factor_beyond_the_usable_energy_but_within_the_stored_energy_is_kept_with_a_warning():
    i = intake(firm_capacity_factor=0.5, energy_MWh=3, ride_through_hours=3)
    assert factor(i) == pytest.approx(0.5)
    assert any("usable state-of-charge" in w and "kept as declared" in w for w in warned(i))


def test_an_assumed_window_never_refuses_the_customers_figures():
    """Only a window the customer DECLARED can make their factor impossible; the library's 2 h is an assumption."""
    i = intake(firm_capacity_factor=0.9, energy_MWh=0.5)
    assert factor(i) == pytest.approx(0.9)
    assert any("unchecked" in w or "No ride-through window was declared" in w for w in warned(i))
    assert "ride_through_hours" in gaps(i)


# --- helpers --------------------------------------------------------------------------------------------------------------


def test_energy_limited_hours_is_the_arithmetic_it_claims_to_be():
    i = intake(energy_MWh=8)
    assert bess_energy_limited_hours(battery(i), 0.5, usable=False) == pytest.approx(8.0)           # 8 MWh / (0.5 x 2 MW)
    assert bess_energy_limited_hours(battery(i), 0.5, usable=True) < 8.0
    assert bess_energy_limited_hours(battery(intake()), 0.5) is None                                  # no declared energy
    assert bess_energy_limited_hours(battery(i), 0.0) is None
