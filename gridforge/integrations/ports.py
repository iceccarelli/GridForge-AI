"""Adapter ports.

These are interfaces the DOMAIN defines and external systems implement. No
module under gridforge/{site,power,compute,thermal,scenario,economics,envelope}
may import from gridforge.integrations — that rule is enforced by
tests/test_architecture.py and it is what stops DERIM or GridOS from colonising
the product.

Nothing here is implemented yet. Writing the port is cheap and reversible;
migrating an architecture is neither.
"""
from __future__ import annotations

from typing import Protocol, runtime_checkable

from ..validation import Quantity


@runtime_checkable
class HydraulicModel(Protocol):
    """Candidate ThermalForge extraction: secondary-loop pressure drop and flow
    distribution. Until a parity test exists against the ThermalForge original,
    any result from an implementation of this port is E1 at best."""

    def pressure_drop_kPa(self, flow_l_per_min: float, circuit_id: str) -> Quantity: ...

    def achievable_flow_l_per_min(self, available_head_kPa: float, circuit_id: str) -> Quantity: ...


@runtime_checkable
class ThermalNetworkModel(Protocol):
    """Candidate ThermalForge extraction: rack/row/hall thermal network solve."""

    def rack_inlet_temperature_C(self, rack_id: str, load_kW: float) -> Quantity: ...


@runtime_checkable
class PowerFlowModel(Protocol):
    """Candidate DERIM extraction. Consumed only through this port."""

    def feeder_loading(self, scenario_id: str) -> dict[str, Quantity]: ...

    def losses_kW(self, scenario_id: str) -> Quantity: ...


@runtime_checkable
class DERDispatchModel(Protocol):
    """Candidate DERIM extraction: BESS / generation dispatch against a load profile.
    Used only where behind-the-meter capacity actually relieves a binding constraint."""

    def firm_capacity_contribution_MW(self, scenario_id: str) -> Quantity: ...


@runtime_checkable
class EnergyValueModel(Protocol):
    """Value of operating behind-the-meter assets against a real tariff.

    A capacity study says a battery CAN be installed. A buyer also wants to know
    what it earns once it is: arbitrage, demand-charge reduction, and what the
    throughput costs. GridOS already solves exactly this.
    """

    def annual_net_value_eur(self, scenario_id: str) -> Quantity: ...

    def payback_years(self, scenario_id: str) -> Quantity: ...


@runtime_checkable
class TelemetrySource(Protocol):
    """Candidate GridOS extraction. DORMANT. Implement only when a customer-facing
    workflow requires live site state — not before."""

    def series(self, point_id: str, start: str, end: str) -> list[tuple[str, float]]: ...


class NotWired(NotImplementedError):
    """Raised by stub adapters. Explicit beats a silent zero."""
