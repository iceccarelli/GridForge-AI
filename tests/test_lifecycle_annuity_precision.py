"""The lifecycle cost keeps its energy bill for every discount rate, however small.

Defect (independent numerics audit, 2026-11-13): the annuity factor was ``(1 - (1 + r)^-n) / r``. For a tiny positive rate ``1 + r`` rounds to 1.0,
the numerator is exactly 0, and the recurring energy cost VANISHED from the lifecycle value: at r = 1e-15 it was 99.8 MEUR instead of 90.6 MEUR
(a factor of 22.2 for 20 years), and at r <= 1e-16 it was the capex alone (6.6 MEUR) with the whole 84 MEUR of energy gone.

The expected factors are written in exact rational arithmetic (``fractions.Fraction``), independently of the engine's floats.
"""
from __future__ import annotations

import copy
import json
import math
from fractions import Fraction as F
from pathlib import Path

import pytest

from gridforge.economics.model import annuity_factor
from gridforge.intake.loader import load_document
from gridforge.scenario.run import run_all

INTAKE = Path(__file__).resolve().parent.parent / "examples" / "intake"
RATES = (0.0, 1e-300, 1e-17, 1e-15, 1e-9, 1e-3, 0.08, 0.49)


def _exact(rate: float, years: int) -> F:
    if rate == 0:
        return F(years)
    r = F(rate)                                           # the double's exact value
    return (1 - (1 + r) ** -years) / r


class TestAnnuityFactor:
    @pytest.mark.parametrize("rate", RATES)
    def test_matches_the_exact_closed_form_for_every_horizon(self, rate):
        for years in range(1, 41):
            want = _exact(rate, years)
            got = annuity_factor(rate, years)
            assert math.isclose(got, float(want), rel_tol=1e-12), (rate, years, got, float(want))

    def test_the_audit_cases(self):
        assert (1.0 - (1.0 + 1e-15) ** -20) / 1e-15 == pytest.approx(22.204460492503128)    # the old formula: 22.2 years of cost for 20
        assert (1.0 - (1.0 + 1e-16) ** -20) / 1e-16 == 0.0                                  # the old formula: the bill vanishes
        for rate in (1e-15, 1e-16, 1e-17, 1e-300):
            assert annuity_factor(rate, 20) == pytest.approx(20.0, rel=1e-12)

    def test_no_rate_and_a_zero_rate_are_n_exactly(self):
        for years in (1, 7, 20, 40):
            assert annuity_factor(None, years) == years == annuity_factor(0.0, years) == annuity_factor(0, years)

    def test_it_falls_with_the_rate_and_never_exceeds_the_horizon(self):
        for years in (1, 10, 40):
            seq = [annuity_factor(r, years) for r in sorted(RATES)]
            assert all(a >= b for a, b in zip(seq, seq[1:])), seq
            assert all(0 < x <= years for x in seq)

    def test_a_rate_of_minus_one_or_below_keeps_the_plain_formula_and_does_not_raise_in_log1p(self):
        assert annuity_factor(-2.0, 3) == (1.0 - (1.0 + -2.0) ** -3) / -2.0               # not a rate the loader admits; unchanged behaviour


def _lifecycle(rate: float, horizon: int = 20):
    d = json.loads((INTAKE / "reference_hall.json").read_text())
    d.setdefault("economics", {}).update(horizon_years=horizon, discount_rate=rate)
    d["scenarios"] = ["hybrid_dlc"]
    it = load_document(copy.deepcopy(d))
    return run_all(it.context, it.scenarios)[0].economics


class TestLifecycleKeepsItsEnergyBill:
    @pytest.mark.parametrize("rate", RATES[:-1])
    def test_lifecycle_is_capex_plus_the_exact_annuity_of_the_annual_energy_cost(self, rate):
        e = _lifecycle(rate)
        want = e.capex_total_eur.value + float(_exact(rate, 20)) * e.annual_energy_cost_eur.value
        assert e.annual_energy_cost_eur.value > 1e6, "the energy bill must be there to be lost"
        assert e.lifecycle_cost_eur.value == pytest.approx(want, rel=1e-12)

    def test_a_vanishing_rate_and_no_rate_give_the_same_lifecycle_cost(self):
        undiscounted = _lifecycle(0.0).lifecycle_cost_eur.value
        for rate in (1e-300, 1e-17, 1e-16, 1e-15):
            assert _lifecycle(rate).lifecycle_cost_eur.value == pytest.approx(undiscounted, rel=1e-12), rate
        assert undiscounted > 80e6                              # about 90.6 MEUR on the reference hall: not the 6.6 MEUR capex alone
