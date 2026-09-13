from __future__ import annotations

from dataclasses import dataclass, field

from ..validation import Quantity


@dataclass
class GridConnection:
    dso: str
    firm_capacity_MVA: Quantity
    power_factor: Quantity
    contracted_MW: Quantity
    current_site_peak_MW: Quantity
    queue_note: str = ""
    curtailable_MW: Quantity | None = None


@dataclass
class TransformerBank:
    id: str
    unit_rating_MVA: Quantity
    units: int
    redundancy: str          # "N", "N+1", "2N"
    derating_factor: Quantity  # ambient / harmonics / loading policy
    replacement_lead_time_weeks: Quantity | None = None


@dataclass
class UPSBlock:
    id: str
    unit_rating_kW: Quantity
    units: int
    redundancy: str
    step_load_capability: Quantity  # fraction of rating accepted as an instantaneous step


@dataclass
class LVDistribution:
    voltage_V: Quantity
    phases: int
    busway_ampacity_A: Quantity
    busway_runs: int
    busway_utilisation_limit: Quantity   # e.g. 0.8 continuous-load derating
    tapoff_max_A: Quantity
    rack_feed_limit_kW: Quantity | None = None  # None -> derive from tap-off


@dataclass
class GenerationOption:
    """A behind-the-meter supply option.

    This is the commercial heart of a speed-to-power practice: where the grid
    cannot deliver capacity inside the decision horizon, on-site supply can. The
    engine treats it as a relief for the grid constraint, not as a product push -
    it only appears in the ladder when the grid is what binds.
    """
    id: str
    kind: str                 # "bess", "gas_engine", "chp", "pv", "fuel_cell", "grid_reinforcement"
    capacity_MW: Quantity
    capex_eur_per_kW: Quantity
    lead_time_weeks: Quantity
    firm: bool = False        # may it count toward firm capacity at all?
    firm_capacity_factor: Quantity | None = None   # what fraction of nameplate is firm
    opex_eur_per_MWh: Quantity | None = None
    installed: bool = False   # set True by the ladder when the option is taken
    permitting_note: str = ""


@dataclass
class PowerInput:
    grid: GridConnection
    current_it_load_MW: Quantity
    transformers: list[TransformerBank]
    ups: list[UPSBlock]
    lv: LVDistribution
    options: list[GenerationOption] = field(default_factory=list)
