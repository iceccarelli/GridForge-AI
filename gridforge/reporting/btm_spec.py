"""The Power Deployment Assessment's winning architecture, as a tender.

`gridforge/reporting/btm_assessment.py` names a next action: "proceed to
procurement for GRID + BESS + GENERATION." Until this module, that sentence was
a dead end — the generation and storage units a customer settled on had no path
into anything a supplier could quote against, unlike a hall's headroom ladder,
which already reaches `gridforge spec` via `gridforge.procurement.build`.

This is that path for BTM equipment. Same shape and the same honesty rules as
`gridforge.procurement.build` — duty and interfaces only, no make, no model, no
supplier, and every mandatory numeric requirement names the unit it came from —
built on the SAME `GenerationUnit` / `BatteryEnergyStorageSystem` objects the
assessment already solved, not a re-derived description of them.
"""
from __future__ import annotations

from dataclasses import dataclass, field

from ..power.generation import GenerationUnit
from ..power.storage import BatteryEnergyStorageSystem
from ..procurement.schema import (INFORMATIVE, MANDATORY, PREFERRED, EvaluationCriterion,
                                  ProcurementError, Requirement, ResponseField, ScopeItem)
from ..validation import Quantity


@dataclass
class BTMEquipmentSpec:
    """A tender package for one architecture's generation and storage units.

    Deliberately not `procurement.schema.SpecPackage` — that class's
    `racks_before`/`racks_after`/`sized_for_racks` fields describe a hall
    retrofit and have no honest value for a BTM generator or battery. Reusing
    `Requirement`, `ScopeItem`, `EvaluationCriterion` and `ResponseField` (all
    generic) while giving this its own container is composition, not
    duplication — the alternative was forcing a rack count of zero into a
    field that means something specific elsewhere in this codebase.
    """
    project: str
    architecture_label: str
    units: list[str]                       # unit ids covered, for the document header
    scope: list[ScopeItem] = field(default_factory=list)
    requirements: list[Requirement] = field(default_factory=list)
    criteria: list[EvaluationCriterion] = field(default_factory=list)
    response_fields: list[ResponseField] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)

    def validate(self) -> None:
        if not self.requirements:
            raise ProcurementError("a specification with no requirements is a letter")
        total = sum(c.weight for c in self.criteria)
        if self.criteria and total != 100:
            raise ProcurementError(
                f"evaluation weights total {total}, not 100 — a matrix that does not sum "
                f"is one a losing bidder can challenge")
        ids = [r.id for r in self.requirements]
        if len(set(ids)) != len(ids):
            raise ProcurementError("duplicate requirement ids")
        orphans = [r.id for r in self.requirements
                  if r.obligation == MANDATORY and r.value is not None and not r.derived_from]
        if orphans:
            raise ProcurementError(
                f"mandatory numeric requirements with no unit behind them: {', '.join(orphans)}. "
                f"A number nobody can trace is a number somebody invented.")

    def mandatory(self) -> list[Requirement]:
        return [r for r in self.requirements if r.obligation == MANDATORY]


def _q_from(q: Quantity, id_: str, clause: str, statement: str, derived_from: str,
           basis: str, verification: str, *, obligation: str = MANDATORY) -> Requirement:
    return Requirement(id=id_, clause=clause, statement=statement, obligation=obligation,
                       value=q, derived_from=derived_from, basis=basis,
                       verification=verification)


def _generation_requirements(unit: GenerationUnit, idx: int) -> list[Requirement]:
    p = f"G{idx}"
    reqs = [
        _q_from(unit.nameplate_MW, f"{p}-01", "Nameplate rating",
               "The unit shall be rated for continuous operation at not less than the "
               "capacity stated.", unit.id,
               f"Sized against the {unit.kind} candidate in the deployment assessment.",
               "Factory test certificate and rating plate."),
    ]
    if unit.forced_outage_rate is not None:
        reqs.append(_q_from(
            unit.forced_outage_rate, f"{p}-02", "Forced outage rate",
            "The response shall state the forced-outage rate the unit is warranted to, "
            "and the basis (fleet data or a specific test standard).",
            unit.id, "The assessment's firm-capacity figure for this unit assumed the "
                     "value stated; a warranted rate materially different changes the "
                     "contingency result.", "Warranty statement and supporting fleet data.",
            obligation=MANDATORY))
    if unit.startup_time_min is not None:
        reqs.append(_q_from(
            unit.startup_time_min, f"{p}-03", "Start-up time",
            "The unit shall reach minimum load in not more than the time stated, "
            "from a stopped state.", unit.id,
            "The contingency analysis assumed this response window when this unit "
            "was counted as available inside it.", "Witnessed start test."))
    if unit.ramp_MW_per_min is not None:
        reqs.append(Requirement(
            id=f"{p}-04", clause="Ramp rate",
            statement="The response shall state the ramp rate achieved from minimum to "
                     "full load, and confirm it is not less than the figure assumed in "
                     "the deployment assessment.",
            obligation=PREFERRED, value=unit.ramp_MW_per_min, derived_from=unit.id,
            basis="Governs how much of this unit's capacity is available inside a short "
                 "response window, not just at steady state.",
            verification="Witnessed ramp test."))
    reqs.append(Requirement(
        id=f"{p}-05", clause="Fuel",
        statement=f"The response shall state fuel type, on-site storage capacity, and "
                 f"delivery/resupply arrangements."
                 + (f" Declared fuel: {unit.fuel_type}." if unit.fuel_type else ""),
        obligation=MANDATORY, derived_from=unit.id,
        basis="Fuel security is a schedule and reliability question, not only a cost one.",
        verification="Fuel supply agreement or delivery plan."))
    return reqs


def _bess_requirements(unit: BatteryEnergyStorageSystem, idx: int) -> list[Requirement]:
    p = f"B{idx}"
    reqs = [
        _q_from(unit.power_MW, f"{p}-01", "Power rating (PCS/inverter)",
               "The system's power conversion equipment shall be rated for not less "
               "than the continuous power stated.", unit.id,
               "Sized against the BESS candidate in the deployment assessment.",
               "Factory test certificate."),
        _q_from(unit.energy_MWh, f"{p}-02", "Energy rating",
               "The system's nameplate energy shall be not less than the figure stated.",
               unit.id, "Sized against the same candidate.",
               "Factory test certificate and cell/module datasheets."),
        Requirement(
            id=f"{p}-03", clause="Usable energy window", obligation=MANDATORY,
            statement=f"The response shall state the SOC window the warranted energy "
                     f"figure is rated at (this assessment assumed "
                     f"{unit.soc_min.render()} to {unit.soc_max.render()}), and the "
                     f"round-trip efficiency at that window.",
            derived_from=unit.id,
            basis="Usable energy — not nameplate — is what the firm-capacity duration "
                 "calculation actually rests on; a wider or narrower warranted window "
                 "changes it directly.",
            verification="Warranty statement and acceptance test procedure."),
    ]
    if unit.reserve_MW is not None:
        reqs.append(_q_from(
            unit.reserve_MW, f"{p}-04", "Reserve capacity",
            "The response shall confirm the system can be configured to hold the stated "
            "power in reserve for a separate duty while still meeting the firm-capacity "
            "duty above.", unit.id,
            "The assessment's firm-capacity figure already nets this reserve off the "
            "power rating.", "Controls configuration document."))
    reqs.append(Requirement(
        id=f"{p}-05", clause="Grid-forming / grid-following", obligation=INFORMATIVE,
        statement=f"The response shall confirm grid-forming capability: "
                 f"{'required' if unit.grid_forming else 'not required for this duty'}. "
                 f"Black start: {'required' if unit.black_start else 'not required'}.",
        derived_from=unit.id,
        basis="Determines whether this unit can energise the site independently of the "
             "grid or another generator, which the islanded-operation cases depend on.",
        verification="Controls and protection design document."))
    return reqs


COMMON_SCOPE_OUT = (
    ScopeItem("X-1", "Interconnection approval",
             "Utility interconnection study, submission and approval is by others.", False),
    ScopeItem("X-2", "Protection coordination and arc-flash study",
             "Provided by the client's electrical engineer or a licensed specialist.", False),
    ScopeItem("X-3", "Fuel supply contract",
             "Negotiated by the client; this package states the duty the supply must meet.", False),
    ScopeItem("X-4", "Civil, structural and fire separation",
             "By others, to the equipment's own footprint and clearance requirements.", False),
)

CRITERIA = (
    EvaluationCriterion("C1", "Compliance with the mandatory duty", 30,
                       "Every 'shall' requirement met at the stated conditions."),
    EvaluationCriterion("C2", "Delivered programme", 30,
                       "Weeks to site and to energisation; assessed against the "
                       "deployment assessment's own time-to-power exposure."),
    EvaluationCriterion("C3", "Price", 25,
                       "Delivered capex, and price per MW of firm contribution rather "
                       "than price per unit of nameplate."),
    EvaluationCriterion("C4", "Evidence quality", 15,
                       "Test certificates and warranted figures at the stated "
                       "conditions, not datasheet figures at a reference condition."),
)


def _response_fields() -> list[ResponseField]:
    return [
        ResponseField("capex_eur", "Delivered price, excluding VAT", "EUR",
                      note="Delivered and installed. State exclusions separately."),
        ResponseField("lead_time_weeks", "Weeks from order to delivered on site", "weeks"),
        ResponseField("install_weeks", "Weeks from delivery to energised", "weeks",
                     required=False),
        ResponseField("warranted_availability", "Warranted availability / forced-outage rate",
                     "fraction", required=False),
        ResponseField("validity_days", "Price validity", "days", required=False),
    ]


def build_equipment_spec(architecture_label: str, *, project: str,
                         generation: list[GenerationUnit] = (),
                         bess: list[BatteryEnergyStorageSystem] = ()) -> BTMEquipmentSpec:
    """One tender package covering every generation and storage unit in a
    chosen architecture. Unlike `procurement.build_spec` (one relief per
    document, because a hall retrofit's reliefs are independent purchases),
    a BTM architecture's units are usually one coordinated award — the
    controls integration between a generator and a battery is the point —
    so this covers the whole architecture in one package."""
    if not generation and not bess:
        raise ProcurementError(
            f"'{architecture_label}' has no generation or storage units — nothing to tender")
    requirements: list[Requirement] = []
    for i, g in enumerate(generation, start=1):
        requirements.extend(_generation_requirements(g, i))
    for i, b in enumerate(bess, start=1):
        requirements.extend(_bess_requirements(b, i))
    requirements.extend([
        Requirement(id="C-01", clause="Price basis",
                   statement="Prices shall be delivered and installed, excluding VAT, in "
                            "EUR, with exclusions listed separately.",
                   basis="Comparability across responses.",
                   verification="Completed response schedule."),
        Requirement(id="C-02", clause="Validity",
                   statement="Prices shall remain valid for not less than 60 days.",
                   basis="The evaluation and approval cycle on a capital item of this size.",
                   verification="Stated on the quotation."),
    ])
    spec = BTMEquipmentSpec(
        project=project, architecture_label=architecture_label,
        units=[u.id for u in list(generation) + list(bess)],
        scope=[
            ScopeItem("S-1", "Supply", "Equipment meeting the duties specified."),
            ScopeItem("S-2", "Delivery", "Delivered to site, offloaded, positioned."),
            ScopeItem("S-3", "Installation and commissioning",
                     "Installation, commissioning and witnessed testing, including the "
                     "commissioning tests named in the deployment case."),
            ScopeItem("S-4", "Documentation",
                     "Test certificates, warranted performance figures, O&M."),
            *COMMON_SCOPE_OUT,
        ],
        requirements=requirements,
        criteria=list(CRITERIA),
        response_fields=_response_fields(),
        notes=[
            f"This package covers the '{architecture_label}' architecture from a BTM Power "
            f"Deployment Assessment: {', '.join(spec_unit for spec_unit in ([u.id for u in generation] + [u.id for u in bess]))}.",
            "Every numeric requirement is derived from the unit it describes, as declared in "
            "the deployment case. Nothing here specifies a make or a model: we state the duty "
            "and the interfaces, the supplier proposes the equipment, and we take no margin "
            "on it.",
            "Interconnection approval, protection coordination and fuel supply contracts are "
            "explicitly out of scope — see section 2 — and remain the schedule risk this "
            "package does not resolve.",
        ],
    )
    spec.validate()
    return spec
