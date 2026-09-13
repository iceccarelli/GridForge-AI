from __future__ import annotations

from dataclasses import dataclass

from ..validation import Quantity


@dataclass(frozen=True)
class GPUPlatform:
    id: str
    name: str
    status: str                       # "shipping" | "announced" | "roadmap"
    rack_kW: Quantity
    peak_rack_kW: Quantity
    liquid_fraction: Quantity
    max_inlet_liquid_C: Quantity
    flow_l_per_min_per_rack: Quantity
    rack_mass_kg: Quantity
    rack_footprint_m2: Quantity
    gpus_per_rack: int
    voltage_domain: str
    rack_feed_current_A: Quantity | None = None

    def residual_air_kW(self) -> Quantity:
        one = Quantity.given(1.0, "1", "unity", self.liquid_fraction.evidence)
        return (self.rack_kW * (one - self.liquid_fraction)).relabel(
            f"{self.id} residual air load per rack", "compute.residual_air")

    def liquid_kW(self) -> Quantity:
        return (self.rack_kW * self.liquid_fraction).relabel(
            f"{self.id} liquid load per rack", "compute.liquid_load")


@dataclass
class ClusterSpec:
    platform: GPUPlatform
    utilisation: Quantity          # annual average fraction of rack_kW actually drawn
    target_rack_count: int | None = None
