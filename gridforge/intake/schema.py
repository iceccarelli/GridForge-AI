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
    #: False for an optional refinement that only sharpens one result and is not part of the intake a study is judged complete on.
    #: Such a field is still asked for in the data request and the blank template, but it is left out of `completeness`, so adding
    #: one never moves that figure for an intake that does not supply it.
    counts_toward_completeness: bool = True


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
              why_it_binds="400 A legacy versus 800-1000 A modern: a legacy busway can be the hard stop.",
              how_to_get_it="Busway nameplate or the electrical record drawings."),
    FieldSpec("lv.tapoff_max_A", "Installed tap-off rating", "A", True,
              why_it_binds="A rack that cannot be fed cannot be placed, whatever else is true.",
              how_to_get_it="Tap-off unit nameplate."),
    FieldSpec("lv.existing_busway_load_kW", "Load already on the busway", "kW", False,
              counts_toward_completeness=False,
              why_it_binds=("The busway result is the installed capacity as declared; the load already drawing from it is not subtracted, so the "
                            "racks it can still feed are overstated by that share. When this is given the engine subtracts it (never below "
                            "zero); when absent nothing is subtracted."),
              how_to_get_it="Branch-circuit or busway monitoring (peak kW over a representative month), or the sum of the metered rack loads on the busway."),
    FieldSpec("hall.floor_loading_kPa", "Hall design floor loading", "kPa", True,
              why_it_binds="A 1.4 t rack against a 12 kPa design is a gate, not a margin.",
              how_to_get_it="Structural record drawings; a survey if the building changed hands."),
    FieldSpec("hall.positions_available", "Rack positions available", "positions", True,
              why_it_binds="Caps deployment regardless of power and cooling.",
              how_to_get_it="Floor plan plus the tenancy schedule."),
    FieldSpec("hall.occupied_positions", "Rack positions occupied", "positions", False,
              counts_toward_completeness=False,
              why_it_binds=("Only the busway check against the load already in the hall reads it: the racks already installed are counted from this "
                            "figure at the hall's design density. When absent the engine does not know how many positions are occupied; it "
                            "reads every position that is not free (hall.rack_positions less hall.positions_available) as occupied, an "
                            "assumption (E0) that is only as good as the total, and says so. Zero is a statement (nothing is occupied) and is "
                            "asked for when free positions equal the total. It changes no rack count, cost or date."),
              how_to_get_it="The tenancy schedule or the floor plan's rack register: racks physically installed, which is not the same as positions sold."),
    FieldSpec("thermal.plant.chilled_water_capacity_kW", "Chilled-water plant capacity", "kW", True,
              why_it_binds="Carries the residual air load, and the liquid load in a hybrid scheme.",
              how_to_get_it="Chiller schedule; derate to the actual condensing conditions."),
    FieldSpec("thermal.plant.existing_non_it_heat_kW", "Other heat the existing hall already puts on the plant", "kW", False,
              supplied_evidence=EvidenceClass.E3_ENGINEERING_ESTIMATE,
              counts_toward_completeness=False,
              why_it_binds=("Plant headroom is the capacity less the IT load; UPS and distribution losses, fan-wall and pump power rejected "
                            "to the plant and lighting also land on it, so headroom is overstated by their share. When this is given the "
                            "engine subtracts it as well; when absent only the IT load is subtracted."),
              how_to_get_it="BMS plant load trend less the metered IT load, or the electrical single-line losses and the mechanical schedule's fan and pump power."),
    FieldSpec("thermal.plant.design_supply_C", "Plant supply temperature", "degC", True,
              why_it_binds="Legacy 6-7 degC plant against a 27-32 degC TCS need governs the scheme.",
              how_to_get_it="BMS setpoint and 12 months of trend."),
    FieldSpec("thermal.plant.pump_flow_capacity_l_per_min", "Available pumped flow", "l/min", False,
              supplied_evidence=EvidenceClass.E3_ENGINEERING_ESTIMATE,
              why_it_binds="Flow, not delta-T, governs a retrofit.",
              how_to_get_it="Pump curves and pipe schedule; a hydraulic model before design."),
    FieldSpec("thermal.plant.existing_flow_l_per_min", "Flow the existing hall already draws on the plant", "l/min", False,
              supplied_evidence=EvidenceClass.E3_ENGINEERING_ESTIMATE,
              counts_toward_completeness=False,
              why_it_binds=("If the available pumped flow above is the plant's TOTAL, the existing hall already uses part of it and the "
                            "hydraulic limit is overstated. When this is given the engine subtracts it before dividing by the flow per "
                            "rack; when absent nothing is subtracted and the figure above is read as flow available to the new load."),
              how_to_get_it="Commissioning flow readings or the BMS flow trend for the existing hall's loops; pump curves at the operating point."),
    FieldSpec("thermal.residual_air_capacity_kW_per_rack", "Air removal per rack position", "kW",
              False, supplied_evidence=EvidenceClass.E3_ENGINEERING_ESTIMATE,
              why_it_binds="10-15% of a 135 kW rack is still 13-20 kW of air per position.",
              how_to_get_it="Measured per-tile airflow, or CFD."),
    FieldSpec("transformers", "Transformer schedule", "-", True,
              why_it_binds="Often the schedule driver: transformer lead times are long and vary by type. Enter the quoted figure if you have one.",
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
    FieldSpec("lv.phases", "LV distribution phases", "-", False,
              counts_toward_completeness=False,
              why_it_binds=("A single-phase feed carries 1/sqrt(3) of the power of a three-phase one at the same voltage and ampacity, and a rack draws "
                            "sqrt(3) times the current from it: both the busway's capacity and the rack-feed (tap-off) limit follow the phase count. "
                            "When absent the engine reads the hall as three-phase, which is the more favourable reading."),
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
    FieldSpec("transformers.replacement_lead_time_weeks", "Power transformer replacement lead time", "weeks", False,
              why_it_binds=("Usually sets the date of the whole programme. When absent the engine uses a library "
                            "placeholder of 160 weeks (band 80-210), which is neither a manufacturer's quote nor a "
                            "delivery commitment, and it is indistinguishable in the result from a supplied figure."),
              how_to_get_it="A written lead time from the transformer manufacturer or the utility's equipment supplier."),
    FieldSpec("thermal.tcs_target_supply_C", "TCS target supply temperature", "degC", False,
              supplied_evidence=EvidenceClass.E3_ENGINEERING_ESTIMATE,
              why_it_binds="Whether the plant can hold the water temperature the chips need.",
              how_to_get_it="The platform vendor's reference design for the target rack."),
    FieldSpec("thermal.plant.design_return_C", "Plant design return temperature", "degC", False,
              why_it_binds="Delta-T across the plant sets the flow it must move.",
              how_to_get_it="Chiller schedule and BMS trend."),
    FieldSpec("thermal.cdus", "Installed CDU schedule", "-", False,
              why_it_binds=("When absent, the hybrid and full-DLC scenarios start from an ASSUMED kit of three 1,350 kW N+1 "
                            "CDUs, which supplies roughly 22 racks of liquid capacity that the hall may not have. The engine "
                            "prices that kit (a library placeholder, not a quotation) and dates the racks that depend on it, so the "
                            "cost and the schedule include a purchase nobody declared. Declare the CDUs already installed to remove it."),
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
    # Optional thermal and hall inputs the library used to fill WITHOUT a word (the report then printed the library figure as if it were
    # known). None is required and none is counted in `completeness`: each is asked for in the data request and named when absent.
    FieldSpec("thermal.cdus.rated_approach_K", "CDU rated approach temperature", "K", False,
              counts_toward_completeness=False,
              why_it_binds=("A CDU rating is stated AT an approach temperature and is derated linearly to the approach the site can offer, so the "
                            "rated approach sets how many racks a CDU carries at warm facility water. When a CDU in the schedule omits it the "
                            "library 5 K is used, an assumption (E0)."),
              how_to_get_it="The CDU datasheet's rating conditions (kW at which approach and flow)."),
    FieldSpec("thermal.cdus.rated_flow_l_per_min", "CDU rated flow", "l/min", False,
              counts_toward_completeness=False,
              why_it_binds=("A CDU that cannot move the flow its racks need cannot serve them however much heat it can transfer. When EVERY CDU in "
                            "the schedule declares its rated flow, the bank's flow (usable units x rated flow) is a limit beside its heat "
                            "capacity; when any omits it no flow limit is applied and the CDU capacity rests on heat alone."),
              how_to_get_it="The CDU datasheet: rated secondary (technology-loop) flow at the rated duty."),
    FieldSpec("thermal.plant.available_head_kPa", "Available pump head", "kPa", False,
              counts_toward_completeness=False,
              why_it_binds=("A flow figure without a head figure is not a duty point. No constraint compares head today; the figure is printed in "
                            "the procurement specification as the duty the supplier must confirm. When absent the library 250 kPa is printed, "
                            "an assumption (E0)."),
              how_to_get_it="Pump curves at the operating point, or commissioning pressure readings across the hall's loops."),
    FieldSpec("thermal.plant.free_cooling_hours_per_year", "Free-cooling hours per year", "h", False,
              counts_toward_completeness=False,
              why_it_binds=("What the existing plant achieves in free cooling sets how much a higher loop temperature is worth. No constraint reads "
                            "it and PUE is a fixed library figure; it is printed in the procurement specification. When absent the library "
                            "2,500 h is printed, an assumption (E0)."),
              how_to_get_it="BMS economiser run-hours over 12 months, or the plant's TMY-based energy model."),
    FieldSpec("thermal.plant.dry_cooler_capacity_kW", "Dry-cooler heat rejection on the dedicated loop", "kW", False,
              supplied_evidence=EvidenceClass.E3_ENGINEERING_ESTIMATE,
              counts_toward_completeness=False,
              why_it_binds=("Under full direct-to-chip cooling the liquid load goes to a dedicated high-temperature loop whose dry coolers must "
                            "reject it. When given, the dry-cooler capacity over the liquid load per rack is a limit on full DLC; it is read as "
                            "a nameplate with NO derating for the design dry bulb (the rating conditions are not known), so confirm it at site "
                            "conditions. When absent nothing limits the loop's heat rejection and the loop is an unpriced component of the capex."),
              how_to_get_it="The dry-cooler schedule: kW at the rated water and ambient temperatures, and those temperatures."),
    FieldSpec("hall.containment", "Aisle containment", "-", False,
              counts_toward_completeness=False,
              why_it_binds=("Containment quality decides how much heat an existing hall can remove per position. No constraint reads this field; the "
                            "air removal per position is the separate figure above. When absent the report prints the library cold-aisle "
                            "containment, an assumption (E0)."),
              how_to_get_it="A site walk or the mechanical drawings: none, cold aisle, hot aisle or chimney."),
    FieldSpec("hall.floor_type", "Floor type", "-", False,
              counts_toward_completeness=False,
              why_it_binds=("A raised floor adds a structural note to the floor-loading result (load-spreading plates, or removing the floor and "
                            "deploying on slab); the load capacity itself is the separate figure above. When absent the report prints the "
                            "library raised floor, an assumption (E0)."),
              how_to_get_it="Structural record drawings or a site walk: raised_floor or slab."),
    FieldSpec("hall.build_year", "Year the hall was built", "-", False,
              counts_toward_completeness=False,
              why_it_binds=("No constraint reads the build year; it dates the equipment the report describes. When absent the report prints the "
                            "library 2015, an assumption (E0)."),
              how_to_get_it="The building record or the lease."),
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
class SuppliedSource:
    """A figure the customer supplied together with where it comes from: the document and place a buyer confirmed it from, or a
    note they wrote. The report prints these beside the assumptions, so a number with provenance reads differently from a bare one."""
    path: str
    label: str
    unit: str
    value: float
    source: str | None
    note: str | None
    evidence: str


@dataclass
class IntakeReport:
    """What we were given, what we assumed, and what that costs the conclusion."""
    supplied: list[str] = field(default_factory=list)
    sourced: list[SuppliedSource] = field(default_factory=list)
    gaps: list[DataGap] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    @property
    def required_gaps(self) -> list[DataGap]:
        return [g for g in self.gaps if g.required]

    @property
    def completeness(self) -> float:
        # The share of the scalar intake fields that were supplied. Per-option gaps (a generator's unit count, a battery's duration)
        # are listed as data requests but are not among INTAKE_FIELDS, so they must not be subtracted from a ratio whose
        # denominator does not contain them: each honest request would otherwise lower "completeness" below what was supplied.
        counted = {f.path for f in INTAKE_FIELDS if f.counts_toward_completeness}
        total = len(counted)
        missing = len({g.path for g in self.gaps if g.path in counted})
        return (total - missing) / total if total else 1.0

    @property
    def item_gaps_note(self) -> str:
        """A sentence for the line that states the completeness percentage, or "" when it needs none.

        The percentage counts the single-value inputs only (per-item gaps are deliberately outside INTAKE_FIELDS: see `completeness`). A bank whose unit
        count or redundancy nobody declared is therefore a REQUIRED gap that leaves the percentage where it was, and "Intake completeness is 100%"
        printed above a table of open required rows reads as a contradiction. Said only when such a required per-item gap exists."""
        open_items = [g for g in self.gaps if g.required and "[" in g.path]
        if not open_items:
            return ""
        n = len(open_items)
        return (f" That percentage counts the single-value inputs only; {n} required input{'s' if n != 1 else ''} on individual "
                f"equipment items (listed below) {'are' if n != 1 else 'is'} not in it.")

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
