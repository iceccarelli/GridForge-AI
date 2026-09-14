"""Generic sensitivity knobs, applicable to any site.

They live beside the scenario engine rather than in the CLI because the API
needs them too, and an inner layer must never reach up into an outer one.
"""
from __future__ import annotations

from ..common import ASSUMED, V
from ..constraints import EnvelopeContext


def _scale_contract(f: float):
    def fn(c: EnvelopeContext) -> EnvelopeContext:
        c = c.copy()
        c.power.grid.contracted_MW = c.power.grid.contracted_MW * V(
            f, "1", f"contracted power x{f}", ASSUMED)
        return c
    return fn


def _scale_pue(f: float):
    def fn(c: EnvelopeContext) -> EnvelopeContext:
        c = c.copy()
        c.pue = c.pue * V(f, "1", f"PUE x{f}", ASSUMED)
        return c
    return fn


def _set_air(kW: float):
    def fn(c: EnvelopeContext) -> EnvelopeContext:
        c = c.copy()
        c.thermal.residual_air_capacity_kW_per_rack = V(
            kW, "kW", f"per-position air capacity {kW} kW", ASSUMED)
        return c
    return fn


def _scale_liquid(f: float):
    def fn(c: EnvelopeContext) -> EnvelopeContext:
        import dataclasses
        c = c.copy()
        lf = min(max(c.cluster.platform.liquid_fraction.value * f, 0.0), 0.98)
        c.cluster.platform = dataclasses.replace(
            c.cluster.platform,
            liquid_fraction=V(lf, "1", f"liquid capture fraction {lf:.2f}", ASSUMED))
        return c
    return fn


def _scale_rack_kW(f: float):
    def fn(c: EnvelopeContext) -> EnvelopeContext:
        import dataclasses
        c = c.copy()
        kw = c.cluster.platform.rack_kW.value * f
        c.cluster.platform = dataclasses.replace(
            c.cluster.platform, rack_kW=V(kw, "kW", f"platform rack power {kw:.0f} kW", ASSUMED))
        return c
    return fn


SENSITIVITY_KNOBS = {
    "Contracted power 20% lower": _scale_contract(0.8),
    "Contracted power at full firm capacity": _scale_contract(1.2),
    "PUE 10% worse than assumed": _scale_pue(1.1),
    "PUE 10% better than assumed": _scale_pue(0.9),
    "Per-position air capacity at 20 kW": _set_air(20.0),
    "Liquid capture fraction 5% lower": _scale_liquid(0.95),
    "Platform rack power 5% higher": _scale_rack_kW(1.05),
}


