"""Engineering readiness gates — what stands between an architecture and a purchase order.

The deployment assessment can say an architecture passes its own contingency
test. It has never said whether that architecture can actually be BUILT: is
there an interconnection agreement, has anyone looked at protection
coordination, is there a fuel contract, are permits in hand. Those questions
have real, different owners — a licensed protection engineer, a utility, an
environmental permitting consultant — and the honest answer from a screening
tool is never "yes" or "no" on its own authority. It is one of a small set of
states, each with a reason and a named owner.

This module is a checklist engine, not a second engineering discipline. It
never performs a short-circuit study, a load-flow, or a protection coordination
calculation — those require a licensed engineer and specialist software
(ETAP, PowerFactory, and equivalents), named explicitly rather than pretended
away. What it does is deterministic: given what a deployment request actually
declares, say which gates have enough evidence to be screened, which are
missing data, which can never be cleared by this tool at all, and which the
architecture's own physics (reliability) already answers for real.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum

from ..power.generation import GenerationUnit
from ..power.reliability import ContingencyResult, ContingencyStatus
from ..power.storage import BatteryEnergyStorageSystem


class GateStatus(str, Enum):
    PASS = "pass"
    FAIL = "fail"
    UNKNOWN = "unknown"
    MISSING_DATA = "missing_data"
    REQUIRES_ENGINEERING_STUDY = "requires_engineering_study"
    REQUIRES_LICENSED_REVIEW = "requires_licensed_review"
    NOT_APPLICABLE = "not_applicable"


#: Statuses that stop an architecture from being treated as ready to tender.
#: PASS and NOT_APPLICABLE do not block; everything else does, including
#: UNKNOWN — an unscreened gate is not a cleared one.
BLOCKING_STATUSES = frozenset({
    GateStatus.FAIL, GateStatus.UNKNOWN, GateStatus.MISSING_DATA,
    GateStatus.REQUIRES_ENGINEERING_STUDY, GateStatus.REQUIRES_LICENSED_REVIEW,
})


@dataclass
class GateResult:
    gate: str
    status: GateStatus
    reason: str
    evidence: list[str] = field(default_factory=list)   # fields actually used
    missing: list[str] = field(default_factory=list)     # fields that would resolve this
    review_requirement: str = ""                          # who has to sign off, if anyone
    blocking: bool = True

    def __post_init__(self) -> None:
        self.blocking = self.status in BLOCKING_STATUSES


def _interconnection_gate(interconnection: dict | None) -> GateResult:
    if not interconnection:
        return GateResult(
            "interconnection", GateStatus.MISSING_DATA,
            "No interconnection data declared — point of common coupling, voltage, and "
            "import/export capacity are unknown.",
            missing=["interconnection.pcc_voltage_kV", "interconnection.import_capacity_MW",
                    "interconnection.utility"],
            review_requirement="Utility interconnection study")
    missing = [k for k in ("pcc_voltage_kV", "import_capacity_MW", "utility")
              if interconnection.get(k) is None]
    if missing:
        return GateResult(
            "interconnection", GateStatus.MISSING_DATA,
            f"Interconnection data is partial — missing {', '.join(missing)}.",
            evidence=[k for k in interconnection if interconnection.get(k) is not None],
            missing=[f"interconnection.{k}" for k in missing],
            review_requirement="Utility interconnection study")
    return GateResult(
        "interconnection", GateStatus.REQUIRES_ENGINEERING_STUDY,
        f"PCC and capacity declared ({interconnection['utility']}, "
        f"{interconnection['pcc_voltage_kV']} kV) — screenable, but a formal utility "
        f"interconnection study is still required before this can be built.",
        evidence=["interconnection.pcc_voltage_kV", "interconnection.import_capacity_MW",
                 "interconnection.utility"],
        review_requirement="Utility interconnection study")


def _protection_gate(generation: list[GenerationUnit],
                     bess: list[BatteryEnergyStorageSystem]) -> GateResult:
    if not generation and not bess:
        return GateResult("protection", GateStatus.NOT_APPLICABLE,
                          "No on-site generation or storage — grid-only architecture has no "
                          "new protection scheme to coordinate.")
    return GateResult(
        "protection", GateStatus.REQUIRES_LICENSED_REVIEW,
        f"{len(generation) + len(bess)} on-site source(s) declared — protection coordination, "
        f"short-circuit and relay settings require a licensed protection engineer using "
        f"specialist software (e.g. ETAP, PowerFactory). This tool does not perform that "
        f"calculation and never will claim to.",
        evidence=[u.id for u in generation] + [u.id for u in bess],
        review_requirement="Licensed protection engineer")


def _fuel_gate(generation: list[GenerationUnit]) -> GateResult:
    fuelled = [g for g in generation if g.kind in ("gas_engine", "chp", "diesel")]
    if not fuelled:
        return GateResult("fuel", GateStatus.NOT_APPLICABLE,
                          "No combustion generation declared.")
    missing = [g.id for g in fuelled if not g.fuel_type]
    if missing:
        return GateResult(
            "fuel", GateStatus.MISSING_DATA,
            f"Fuel type not declared for: {', '.join(missing)}.",
            missing=[f"{g}.fuel_type" for g in missing],
            review_requirement="Fuel supply contract")
    return GateResult(
        "fuel", GateStatus.REQUIRES_ENGINEERING_STUDY,
        f"Fuel type declared for every combustion unit ({', '.join(g.fuel_type for g in fuelled)})"
        f" — supply capacity, pressure and delivery redundancy still need a contract, not just "
        f"a type.",
        evidence=[g.id for g in fuelled],
        review_requirement="Fuel supply contract")


def _permitting_gate(permitting: dict | None, generation: list[GenerationUnit]) -> GateResult:
    combustion = any(g.kind in ("gas_engine", "chp", "diesel") for g in generation)
    if not combustion and not permitting:
        return GateResult("permitting", GateStatus.NOT_APPLICABLE,
                          "No combustion generation and no permitting data declared — battery-"
                          "only architectures typically face a lighter permitting path, but "
                          "this is not a permitting determination.")
    if not permitting:
        return GateResult(
            "permitting", GateStatus.MISSING_DATA,
            "Combustion generation is declared but no emissions/noise permitting status was "
            "provided.",
            missing=["permitting.emissions_status", "permitting.noise_status"],
            review_requirement="Environmental permitting consultant")
    known = {k: v for k, v in permitting.items() if v}
    if not known:
        return GateResult("permitting", GateStatus.MISSING_DATA,
                          "Permitting fields were declared but left empty.",
                          missing=["permitting.emissions_status", "permitting.noise_status"],
                          review_requirement="Environmental permitting consultant")
    return GateResult(
        "permitting", GateStatus.REQUIRES_ENGINEERING_STUDY,
        f"Permitting status declared: {', '.join(f'{k}={v}' for k, v in known.items())}.",
        evidence=list(known), review_requirement="Environmental permitting consultant")


def _electrical_gate(bess: list[BatteryEnergyStorageSystem]) -> GateResult:
    forming = [b for b in bess if b.grid_forming]
    if len(forming) > 1:
        return GateResult(
            "electrical", GateStatus.REQUIRES_ENGINEERING_STUDY,
            f"{len(forming)} grid-forming units declared ({', '.join(b.id for b in forming)}) "
            f"— multiple grid-forming sources require a controls arbitration study to avoid "
            f"conflicting voltage/frequency references.",
            evidence=[b.id for b in forming],
            review_requirement="Controls/EMS engineer")
    if not bess:
        return GateResult("electrical", GateStatus.NOT_APPLICABLE,
                          "No storage declared — no grid-forming/following arbitration question.")
    return GateResult(
        "electrical", GateStatus.PASS,
        "At most one grid-forming source declared — no arbitration conflict from this "
        "screening's own inputs.",
        evidence=[b.id for b in bess])


def _reliability_gate(contingency: ContingencyResult | None) -> GateResult:
    if contingency is None:
        return GateResult("reliability", GateStatus.UNKNOWN,
                          "No contingency case was run for this architecture.")
    status_map = {
        ContingencyStatus.PASS: GateStatus.PASS,
        ContingencyStatus.FAIL: GateStatus.FAIL,
        ContingencyStatus.REQUIRES_ENGINEERING_STUDY: GateStatus.REQUIRES_ENGINEERING_STUDY,
    }
    return GateResult(
        "reliability", status_map[contingency.status], contingency.basis,
        evidence=[contingency.scenario],
        review_requirement="" if contingency.status == ContingencyStatus.PASS
        else "Engineering review of the contingency margin")


def evaluate_gates(*, generation: list[GenerationUnit] = (),
                   bess: list[BatteryEnergyStorageSystem] = (),
                   interconnection: dict | None = None,
                   permitting: dict | None = None,
                   contingency: ContingencyResult | None = None) -> list[GateResult]:
    """Every gate this tool can say anything honest about, for one architecture.

    Three gates this list deliberately does not include: CIVIL/SITE, THERMAL and
    COMMISSIONING/TELEMETRY. No field in a deployment request describes site
    civil works, structural loading or ambient cooling for a generator skid
    today, and a gate with literally no possible input is not a checklist item —
    it is a placeholder pretending to be one. Add it when a real input exists to
    check, not before.
    """
    generation, bess = list(generation), list(bess)
    return [
        _interconnection_gate(interconnection),
        _protection_gate(generation, bess),
        _fuel_gate(generation),
        _permitting_gate(permitting, generation),
        _electrical_gate(bess),
        _reliability_gate(contingency),
    ]
