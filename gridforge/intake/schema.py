"""Intake schema: what a customer must hand over, and what we assume when they don't.

Two jobs, and the second one is the commercial one.

1. Turn a filled-in JSON intake into an engineering context.
2. Record, field by field, what the customer supplied and what we had to assume —
   because the list of assumptions IS a deliverable. "Here are the eleven numbers
   that decide your answer, seven of which nobody has measured" is the sentence
   that sells the next engagement, and it is impossible to produce by hand at speed.

Every field carries the evidence class it gets when supplied. A number a customer
asserts about their own asset is E5 (customer data). A number we fall back to is
E0 (assumption), and it lands in the gap ledger.
"""
from __future__ import annotations

from dataclasses import dataclass, field

from ..validation import EvidenceClass


@dataclass(frozen=True)
class FieldSpec:
    path: str                     # dotted path in the intake document
    label: str
    unit: str
    required: bool                # a study cannot be issued without it
    supplied_evidence: EvidenceClass = EvidenceClass.E5_CUSTOMER_DATA
    why_it_binds: str = ""
    how_to_get_it: str = ""


# The intake pack from docs/01 §3, made machine-checkable. Order is the order a
# founder should ask for things on a first call.
INTAKE_FIELDS: tuple[FieldSpec, ...] = (
    FieldSpec("grid.firm_capacity_MVA", "Firm connection capacity", "MVA", True,
              why_it_binds="Sets the absolute ceiling on everything downstream.",
              how_to_get_it="Connection agreement with the DSO."),
    FieldSpec("grid.contracted_MW", "Contracted capacity", "MW", True,
              why_it_binds="Import is capped here even when the connection is larger.",
              how_to_get_it="Supply contract."),
    FieldSpec("grid.current_site_peak_MW", "Current site peak demand", "MW", True,
              why_it_binds="Headroom is ceiling minus this. Half-hourly data, not a nameplate.",
              how_to_get_it="12 months of half-hourly metered data."),
    FieldSpec("grid.current_it_load_MW", "Current protected IT load", "MW", True,
              why_it_binds="Determines UPS and plant headroom.",
              how_to_get_it="Branch-circuit monitoring or UPS output trend."),
    FieldSpec("lv.busway_ampacity_A", "Installed busway ampacity", "A", True,
              why_it_binds="400 A legacy versus 800-1000 A modern is the most common hard stop.",
              how_to_get_it="Busway nameplate or the electrical record drawings."),
    FieldSpec("lv.tapoff_max_A", "Installed tap-off rating", "A", True,
              why_it_binds="A rack that cannot be fed cannot be placed, whatever else is true.",
              how_to_get_it="Tap-off unit nameplate."),
    FieldSpec("hall.floor_loading_kPa", "Hall design floor loading", "kPa", True,
              why_it_binds="A 1.4 t rack against a 12 kPa design is a gate, not a margin.",
              how_to_get_it="Structural record drawings; a survey if the building changed hands."),
    FieldSpec("hall.positions_available", "Rack positions available", "positions", True,
              why_it_binds="Caps deployment regardless of power and cooling.",
              how_to_get_it="Floor plan plus the tenancy schedule."),
    FieldSpec("thermal.plant.chilled_water_capacity_kW", "Chilled-water plant capacity", "kW", True,
              why_it_binds="Carries the residual air load, and the liquid load in a hybrid scheme.",
              how_to_get_it="Chiller schedule; derate to the actual condensing conditions."),
    FieldSpec("thermal.plant.design_supply_C", "Plant supply temperature", "degC", True,
              why_it_binds="Legacy 6-7 degC plant against a 27-32 degC TCS need governs the scheme.",
              how_to_get_it="BMS setpoint and 12 months of trend."),
    FieldSpec("thermal.plant.pump_flow_capacity_l_per_min", "Available pumped flow", "l/min", False,
              supplied_evidence=EvidenceClass.E3_ENGINEERING_ESTIMATE,
              why_it_binds="Flow, not delta-T, governs a retrofit.",
              how_to_get_it="Pump curves and pipe schedule; a hydraulic model before design."),
    FieldSpec("thermal.residual_air_capacity_kW_per_rack", "Air removal per rack position", "kW",
              False, supplied_evidence=EvidenceClass.E3_ENGINEERING_ESTIMATE,
              why_it_binds="10-15% of a 135 kW rack is still 13-20 kW of air per position.",
              how_to_get_it="Measured per-tile airflow, or CFD."),
    FieldSpec("transformers", "Transformer schedule", "-", True,
              why_it_binds="Usually the schedule driver: 160+ week lead times in 2026.",
              how_to_get_it="Single-line diagram and transformer nameplates."),
    FieldSpec("ups", "UPS schedule", "-", True,
              why_it_binds="GPU racks present step loads, not just steady load.",
              how_to_get_it="UPS nameplate, topology and remaining design life."),
    FieldSpec("site.design_drybulb_C", "Summer design dry bulb", "degC", False,
              supplied_evidence=EvidenceClass.E3_ENGINEERING_ESTIMATE,
              why_it_binds="Decides whether dry coolers alone can hold the loop.",
              how_to_get_it="Nearest TMY station."),
    # Model-driving inputs the loader used to default silently. Not required to issue a study, but
    # each one moves a constraint, so a defaulted value belongs in the gap ledger and the data request.
    FieldSpec("grid.power_factor", "Site power factor", "-", False,
              supplied_evidence=EvidenceClass.E3_ENGINEERING_ESTIMATE,
              why_it_binds="Converts MVA of connection into MW of usable power.",
              how_to_get_it="Utility bills (billed power factor) or the incomer meter."),
    FieldSpec("lv.voltage_V", "LV distribution voltage", "V", False,
              why_it_binds="Busway kW is voltage times ampacity; 400 V and 415 V differ by 4%.",
              how_to_get_it="Busway nameplate or the single-line diagram."),
    FieldSpec("lv.busway_runs", "Number of busway runs", "-", False,
              why_it_binds="Total feed capacity scales with the runs that actually reach the white space.",
              how_to_get_it="Electrical record drawings."),
    FieldSpec("lv.busway_utilisation_limit", "Busway utilisation limit", "-", False,
              supplied_evidence=EvidenceClass.E3_ENGINEERING_ESTIMATE,
              why_it_binds="The fraction of nameplate the operator will actually load.",
              how_to_get_it="Operating policy and thermal derating from the busway manufacturer."),
    FieldSpec("hall.net_white_space_m2", "Net white space", "m2", False,
              why_it_binds="Caps rack count where positions are not yet counted.",
              how_to_get_it="Floor plan."),
    FieldSpec("hall.aisle_pitch_m", "Installed aisle pitch", "m", False,
              why_it_binds="Sets floor area per rack, and so the floor-loading figure per square metre.",
              how_to_get_it="Floor plan or a site walk."),
    FieldSpec("thermal.tcs_target_supply_C", "TCS target supply temperature", "degC", False,
              supplied_evidence=EvidenceClass.E3_ENGINEERING_ESTIMATE,
              why_it_binds="Whether the plant can hold the water temperature the chips need.",
              how_to_get_it="The platform vendor's reference design for the target rack."),
    FieldSpec("thermal.plant.design_return_C", "Plant design return temperature", "degC", False,
              why_it_binds="Delta-T across the plant sets the flow it must move.",
              how_to_get_it="Chiller schedule and BMS trend."),
    FieldSpec("thermal.cdus", "Installed CDU schedule", "-", False,
              why_it_binds=("When absent, the hybrid and full-DLC scenarios ASSUME three 1,350 kW N+1 "
                            "CDUs already installed at no cost, which supplies roughly 22 racks of liquid "
                            "capacity that the hall may not have."),
              how_to_get_it="CDU nameplates and the mechanical single-line diagram."),
    FieldSpec("compute.utilisation", "Annual average rack utilisation", "-", False,
              supplied_evidence=EvidenceClass.E3_ENGINEERING_ESTIMATE,
              why_it_binds="Scales energy cost and PUE-weighted operating figures.",
              how_to_get_it="The tenant's committed load profile."),
    FieldSpec("thermal.rdhx.capacity_kW_per_rack", "Rear-door heat exchanger capacity per rack", "kW", False,
              why_it_binds=("Decides whether the rear-door scenario can host the target rack at all. When absent the "
                            "engine uses a library default of 60 kW per rack (band 20-80), which is neither a "
                            "manufacturer's rating nor a site measurement."),
              how_to_get_it="The selected rear-door unit's datasheet at the site's water temperature and airflow."),
    FieldSpec("economics.electricity_eur_per_MWh", "All-in grid electricity price", "EUR/MWh", False,
              why_it_binds=("Every annual energy cost, cost per GPU-hour and lifecycle figure is priced at this. "
                            "When absent the engine uses a 140 EUR/MWh placeholder (band 90-220)."),
              how_to_get_it="The supply contract, or 12 months of invoices divided by metered energy."),
    FieldSpec("economics.horizon_years", "Lifecycle horizon", "years", False,
              why_it_binds=("A lifecycle cost needs a horizon. When absent NO lifecycle value is computed; the "
                            "annual operating cost is still stated."),
              how_to_get_it="The investment committee's evaluation period."),
    FieldSpec("economics.discount_rate", "Discount rate", "-", False,
              why_it_binds="When absent the lifecycle value is stated undiscounted and says so.",
              how_to_get_it="The client's hurdle rate."),
    FieldSpec("compute.platform", "Target platform", "-", True,
              why_it_binds="Defines rack power, heat split, flow and mass.",
              how_to_get_it="The tenant's actual order, not a press release."),
)

REQUIRED_PATHS = tuple(f.path for f in INTAKE_FIELDS if f.required)
FIELD_BY_PATH = {f.path: f for f in INTAKE_FIELDS}


@dataclass
class DataGap:
    path: str
    label: str
    unit: str
    required: bool
    fallback_description: str
    why_it_binds: str
    how_to_get_it: str
    sensitivity_rank: int | None = None   # filled in after the sensitivity run


@dataclass
class IntakeReport:
    """What we were given, what we assumed, and what that costs the conclusion."""
    supplied: list[str] = field(default_factory=list)
    gaps: list[DataGap] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    @property
    def required_gaps(self) -> list[DataGap]:
        return [g for g in self.gaps if g.required]

    @property
    def completeness(self) -> float:
        total = len(INTAKE_FIELDS)
        return (total - len(self.gaps)) / total if total else 1.0

    @property
    def can_issue(self) -> bool:
        """An ISSUED deliverable needs every required field from the customer."""
        return not self.required_gaps

    @property
    def engagement_recommendation(self) -> str:
        if self.can_issue:
            return ("The intake is complete. This supports a full Capacity & Density Envelope Study "
                    "with site-specific conclusions.")
        if len(self.required_gaps) <= 3:
            return (f"{len(self.required_gaps)} required inputs missing. Request them before "
                    "starting; the study can proceed in parallel on everything else.")
        return ("Intake too thin for a full study. Sell the Density Screen instead: it produces "
                "the binding constraint and the data-request list, and its fee credits against "
                "the study when the data arrives.")
