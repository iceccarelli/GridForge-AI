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
            return ("Complete intake. This supports a full Capacity & Density Envelope Study "
                    "with site-specific conclusions.")
        if len(self.required_gaps) <= 3:
            return (f"{len(self.required_gaps)} required inputs missing. Request them before "
                    "starting; the study can proceed in parallel on everything else.")
        return ("Intake too thin for a full study. Sell the Density Screen instead: it produces "
                "the binding constraint and the data-request list, and its fee credits against "
                "the study when the data arrives.")
