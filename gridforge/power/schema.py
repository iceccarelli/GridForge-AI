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
    #: None means the client declared no price / no lead time. It is reported as unpriced / undated; it is never
    #: replaced by a default, and the ladder step that takes this option carries no capex and no date.
    capex_eur_per_kW: Quantity | None
    lead_time_weeks: Quantity | None
    firm: bool = False        # may it count toward firm capacity at all?
    firm_capacity_factor: Quantity | None = None   # what fraction of nameplate is firm
    opex_eur_per_MWh: Quantity | None = None
    installed: bool = False   # set True by the ladder when the option is taken
    permitting_note: str = ""
    #: A "bess" option's energy rating. Optional and additive: an intake that
    #: omits it (every one that predates this field) keeps using
    #: `btm.DEFAULT_FIRM_FACTOR`'s flat technology default. Declaring it is what
    #: lets `btm.bess_firm_factor_for_duration()` replace that flat guess with a
    #: real power-vs-energy calculation against a stated ride-through duration.
    energy_MWh: Quantity | None = None
    #: How many identical units make up `capacity_MW` (which stays the TOTAL nameplate of the option, so capex and economics are
    #: unchanged), and the redundancy scheme the plant is held to. Both optional and additive: an option that declares neither is credited as
    #: it always was, with the missing structure named as a gap. Declared, the firm contribution is `power.redundancy.usable_units` of
    #: `units`, the arithmetic every transformer, UPS and CDU bank already uses. Only meaningful for dispatchable generation.
    units: int | None = None
    redundancy: str | None = None
    # --- operating economics (all optional; a missing one is reported, never invented) ---------------------
    #: Equivalent full-load hours per year at rated output. Energy generated = capacity x this.
    annual_run_hours: Quantity | None = None
    #: Price of the fuel per MWh of FUEL energy. Used with ``electrical_efficiency``. Mutually exclusive with
    #: ``opex_eur_per_MWh``, which is an all-in variable cost per MWh generated and already contains the fuel.
    fuel_price_eur_per_MWh: Quantity | None = None
    electrical_efficiency: Quantity | None = None        # fraction, > 0 and <= 1
    variable_om_eur_per_MWh: Quantity | None = None      # used with the fuel route; not additive to opex_eur_per_MWh
    fixed_om_eur_per_kW_year: Quantity | None = None     # maintenance, staffing, insurance per kW per year


@dataclass
class PowerInput:
    grid: GridConnection
    current_it_load_MW: Quantity
    transformers: list[TransformerBank]
    ups: list[UPSBlock]
    lv: LVDistribution
    options: list[GenerationOption] = field(default_factory=list)
