from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum

from ..validation import Quantity


class Architecture(str, Enum):
    RETAINED_AIR = "retained_air"
    RDHX = "rdhx"
    HYBRID_DLC = "hybrid_dlc"      # DLC for the chip load, existing air plant for residual
    FULL_DLC = "full_dlc"          # DLC + dedicated high-temperature loop + new air handling


@dataclass
class PlantSpec:
    id: str
    chilled_water_capacity_kW: Quantity
    design_supply_C: Quantity
    design_return_C: Quantity
    pump_flow_capacity_l_per_min: Quantity
    available_head_kPa: Quantity
    free_cooling_hours_per_year: Quantity
    dry_cooler_capacity_kW: Quantity | None = None
    dry_cooler_approach_K: Quantity | None = None


@dataclass
class CDUSpec:
    id: str
    rated_capacity_kW: Quantity
    rated_approach_K: Quantity
    rated_flow_l_per_min: Quantity
    units: int
    redundancy: str = "N+1"


@dataclass
class RDHxSpec:
    id: str
    capacity_kW_per_rack: Quantity
    requires_water_supply_C: Quantity


@dataclass
class ThermalInput:
    plant: PlantSpec
    tcs_target_supply_C: Quantity
    cdu_approach_K: Quantity
    residual_air_capacity_kW_per_rack: Quantity
    flow_l_per_min_per_kW: Quantity
    cdus: list[CDUSpec] = field(default_factory=list)
    rdhx: RDHxSpec | None = None
    tcs_delta_T_K: Quantity | None = None
    trim_chiller_installed: bool = False
