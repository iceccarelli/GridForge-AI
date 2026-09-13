import math

import pytest

from gridforge.common import ASSUMED, CUSTOMER, ESTIMATED, MODELLED, V
from gridforge.validation import EvidenceClass, Provenance, Quantity, Source


def test_evidence_is_minimum_of_inputs():
    measured = V(8.0, "MW", "contracted power", CUSTOMER)
    assumed = V(135.0, "kW", "platform rack power", ASSUMED)
    racks = measured.convert(1000.0, "kW", "contracted power in kW") / assumed
    assert racks.evidence == EvidenceClass.E0_ASSUMPTION, \
        "a model applied to measured data yields a modelled number, never a measurement"


def test_step_evidence_cannot_exceed_inputs():
    weak = V(1.0, "kW", "weak input", ASSUMED)
    p = Provenance.derive("optimistic", "test", [weak.prov],
                          step_evidence=EvidenceClass.E6_FIELD_VALIDATED)
    assert p.evidence == EvidenceClass.E0_ASSUMPTION


def test_interval_arithmetic_is_monotone():
    a = V(10.0, "kW", "a", ESTIMATED, band=0.1)     # 9 .. 11
    b = V(2.0, "kW", "b", ESTIMATED, band=0.5)      # 1 .. 3
    c = a / b
    lo, hi = c.band
    assert lo <= c.value <= hi
    assert math.isclose(lo, 3.0)
    assert math.isclose(hi, 11.0)


def test_unit_algebra_cancels():
    racks = V(10.0, "racks", "racks", ESTIMATED)
    cost = V(55_000.0, "EUR/rack", "cost per rack", ASSUMED)
    total = racks * cost
    assert total.unit == "EUR"
    assert total.value == 550_000.0


def test_units_must_match_for_addition():
    with pytest.raises(ValueError):
        V(1.0, "kW", "power", ASSUMED) + V(1.0, "EUR", "money", ASSUMED)


def test_temperature_minus_delta_is_temperature():
    t = V(30.0, "degC", "tcs target", ASSUMED) - V(5.0, "K", "approach", ASSUMED)
    assert t.unit == "degC" and t.value == 25.0


def test_no_fake_precision():
    q = V(47.318273, "kW", "modelled density", MODELLED)
    assert "47.3" in q.render() and "47.318" not in q.render()


def test_vendor_only_support_is_flagged():
    q = V(142.0, "kW", "rack power", ASSUMED,
          sources=[Source("Vendor datasheet", 2026, vendor=True)])
    assert q.prov.has_vendor_only_support()


def test_provenance_walk_collects_assumptions():
    a = V(1.0, "kW", "a", ASSUMED, assumptions=["assumption A"])
    b = V(2.0, "kW", "b", ASSUMED, assumptions=["assumption B"])
    c = a + b
    assert set(c.prov.all_assumptions()) == {"assumption A", "assumption B"}
