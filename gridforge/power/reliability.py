"""Contingency analysis: does the architecture survive losing a piece of itself.

A firm-capacity total is not a reliability answer. "182 MW firm" says nothing
about what happens when the largest single generator trips, which is the
question N+1 redundancy exists to answer and the question every data-center
customer's own reliability policy is actually written against. This module
removes the largest contributor(s), per the declared redundancy policy, and
recomputes — deterministically, against the same `GenerationUnit` and
`BatteryEnergyStorageSystem` models the rest of the BTM engine now uses.

It never returns "compliant" or "certified". A protection study, a short-circuit
study and a licensed engineer's sign-off are still required before any of this is
built — see `gridforge.power.gates`. What this returns is PASS, FAIL, or
REQUIRES_ENGINEERING_STUDY where the declared inputs are not enough to say either
way, which is a more honest and more useful answer than a badge.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum

from ..common import ASSUMED, V
from ..validation import Quantity
from .generation import GenerationUnit
from .storage import BatteryEnergyStorageSystem


class Redundancy(str, Enum):
    N = "N"            # no declared spare — every contributor is needed
    N_PLUS_1 = "N+1"   # architecture must survive losing its single largest contributor
    N_PLUS_2 = "N+2"   # must survive losing its two largest contributors
    TWO_N = "2N"        # the whole supply is duplicated; one full path may fail entirely


class ContingencyStatus(str, Enum):
    PASS = "pass"
    FAIL = "fail"
    REQUIRES_ENGINEERING_STUDY = "requires_engineering_study"


UNDECLARED_RIDE_THROUGH_LABEL = "ride-through window (undeclared default of ContingencyCase)"


@dataclass
class ContingencyCase:
    """What is being tested. `ride_through_hours` is the duration a battery must
    be sized against for this specific contingency — the outage window the
    customer's own reliability policy declares, not a library default; there is
    no physically meaningful answer to "is this battery firm" without one."""
    critical_load_MW: Quantity
    grid_firm_MW: Quantity                 # firm import available from the grid connection, 0 if none
    generation: list[GenerationUnit] = field(default_factory=list)
    bess: list[BatteryEnergyStorageSystem] = field(default_factory=list)
    ride_through_hours: Quantity = field(
        default_factory=lambda: V(2.0, "h", UNDECLARED_RIDE_THROUGH_LABEL, ASSUMED))
    redundancy: Redundancy = Redundancy.N


@dataclass
class ContingencyResult:
    status: ContingencyStatus
    scenario: str                          # what was removed to produce this result
    available_MW: Quantity
    required_MW: Quantity
    margin_MW: Quantity                    # available - required; negative means shortfall
    basis: str
    blocking: list[str] = field(default_factory=list)


def _total_firm_MW(case: ContingencyCase, *,
                   excluded_generation: set[str] = frozenset(),
                   excluded_bess: set[str] = frozenset()) -> Quantity:
    total = case.grid_firm_MW
    for g in case.generation:
        if g.id in excluded_generation:
            continue
        total = total + g.firm_MW().convert(1.0, "MW", f"{g.id} firm MW")
    for b in case.bess:
        if b.id in excluded_bess:
            continue
        total = total + b.firm_MW_for_duration(case.ride_through_hours)
    return total.relabel("available firm capacity under this scenario",
                         "power.contingency_available")


def _largest(units: list, key) -> list[str]:
    return [u.id for u in sorted(units, key=key, reverse=True)]


def _startup_bridge_notes(case: ContingencyCase, excl_gen: set[str], excl_bess: set[str]) -> list[str]:
    """A unit the customer declares as held on STANDBY has to start before it carries anything. Until it is online the share of the
    load that the case relies on it for must be carried by something else; the only thing declared that can do that here is storage.

    Only a unit declared `standby` is examined. `continuous` is never examined (it is already running), and an undeclared unit is not
    either, so no result that existed before this field changes. This only ADDS a caveat that can turn a PASS into
    REQUIRES_ENGINEERING_STUDY; it changes no number and never produces a FAIL, because declared storage is only part of what can
    bridge a start (a UPS in the hall is not modelled here) and saying FAIL would claim more than the inputs support.
    """
    standby = [g for g in case.generation
               if g.operating_mode == "standby" and g.id not in excl_gen and g.firm_MW().value > 0]
    if not standby:
        return []
    bess = [b for b in case.bess if b.id not in excl_bess]
    others = case.grid_firm_MW.value + sum(b.firm_MW_for_duration(case.ride_through_hours).value for b in bess)
    gap_MW = case.critical_load_MW.value - others
    if gap_MW <= 0:
        return []                                  # the load is carried without the generation; its start is not on the critical path
    bridge_MW = sum(b.available_power_MW().value for b in bess)
    bridge_MWh = sum(b.usable_energy_MWh().value for b in bess)
    notes: list[str] = []
    for g in standby:
        t = g.startup_time_min
        if t is None:
            notes.append(f"{g.id} is declared standby with no start-up time. This case relies on generation for at least {gap_MW:.2f} MW, "
                         f"and how long the load must be carried until it is online has not been checked: declare its start-up time.")
        elif t.value > 0 and not (bridge_MW >= gap_MW and bridge_MWh >= gap_MW * t.value / 60.0):
            notes.append(f"{g.id} is declared standby and takes {t.value:g} min to start. This case relies on generation for at least "
                         f"{gap_MW:.2f} MW; the declared storage ({bridge_MW:.2f} MW, {bridge_MWh:.2f} MWh usable) cannot carry that for "
                         f"{t.value:g} min, so the load would drop until it is online unless something not declared here bridges it.")
    return notes


def evaluate(case: ContingencyCase) -> ContingencyResult:
    """Run the single scenario the declared redundancy policy actually implies.
    N -> no unit is removed, the base case is the test. N+1/N+2 -> remove the
    largest one or two contributors (generation and storage are both eligible;
    the largest MW is the largest MW regardless of technology). 2N -> the load
    must survive on half the declared supply, modelled as removing every unit
    that is not in the "first half" by nameplate order — a simplification stated
    plainly, because a real 2N architecture is two independently complete paths
    and this model does not yet know which units belong to which path."""
    if not case.generation and not case.bess and case.grid_firm_MW.value <= 0:
        return ContingencyResult(
            ContingencyStatus.REQUIRES_ENGINEERING_STUDY, "no supply declared",
            V(0.0, "MW", "available firm capacity", ASSUMED), case.critical_load_MW,
            V(-case.critical_load_MW.value, "MW", "margin", ASSUMED),
            "No grid, generation or storage declared on this case — there is nothing to "
            "evaluate a contingency against.",
            blocking=["Declare at least one firm supply source."])

    scenario_name = "base case (no unit removed)"
    excl_gen: set[str] = set()
    excl_bess: set[str] = set()
    blocking: list[str] = []

    if case.redundancy in (Redundancy.N_PLUS_1, Redundancy.N_PLUS_2):
        contributors = [("gen", g.id, g.firm_MW().value) for g in case.generation] + \
                       [("bess", b.id, b.firm_MW_for_duration(case.ride_through_hours).value)
                        for b in case.bess]
        if not contributors:
            scenario_name = (f"{case.redundancy.value} requested, but no generation or storage "
                            f"is declared to lose — this policy is only meaningful once at "
                            f"least one unit exists")
        else:
            contributors.sort(key=lambda c: -c[2])
            n_removed = 1 if case.redundancy is Redundancy.N_PLUS_1 else 2
            removed = contributors[:n_removed]
            for kind, cid, _ in removed:
                (excl_gen if kind == "gen" else excl_bess).add(cid)
            scenario_name = (f"loss of {' and '.join(cid for _, cid, _ in removed)} "
                            f"(largest {n_removed} contributor(s), per {case.redundancy.value})")
    elif case.redundancy is Redundancy.TWO_N:
        contributors = [("gen", g.id, g.firm_MW().value) for g in case.generation] + \
                       [("bess", b.id, b.firm_MW_for_duration(case.ride_through_hours).value)
                        for b in case.bess]
        contributors.sort(key=lambda c: -c[2])
        # One whole path is lost, and which path is unknown: assume the larger side, so the
        # contingency is never reported milder than it could be.
        half = contributors[:(len(contributors) + 1) // 2]
        for kind, cid, _ in half:
            (excl_gen if kind == "gen" else excl_bess).add(cid)
        scenario_name = "loss of one full 2N path (modelled as half the declared units by size)"
        blocking.append(
            "2N is modelled here as 'half the declared units by nameplate', not by actual "
            "electrical path — confirm the real two-path split before relying on this figure.")

    available = _total_firm_MW(case, excluded_generation=excl_gen, excluded_bess=excl_bess)
    margin = (available - case.critical_load_MW).relabel(
        "margin under this contingency", "power.contingency_margin")
    weak_evidence = any(
        g.forced_outage_rate is None and g.availability is None for g in case.generation)
    if weak_evidence:
        blocking.append(
            "one or more generation units has no declared availability or forced-outage "
            "rate — the firm figure above assumes 100% availability for that unit, which "
            "overstates the result.")

    blocking.extend(_startup_bridge_notes(case, excl_gen, excl_bess))

    if case.bess and case.ride_through_hours.prov.label == UNDECLARED_RIDE_THROUGH_LABEL:
        blocking.append(
            "no ride-through window was declared: the battery figure above uses a 2 h library default. Declare "
            "the outage window the site's own reliability policy requires before relying on this result.")

    if blocking and margin.value >= 0:
        status = ContingencyStatus.REQUIRES_ENGINEERING_STUDY
    else:
        status = ContingencyStatus.PASS if margin.value >= 0 else ContingencyStatus.FAIL

    undeclared = [g.id for g in case.generation if g.operating_mode is None and g.id not in excl_gen]
    mode_note = (f" Operating mode not declared for {', '.join(undeclared)}: treated as running, so no start-up is bridged; "
                 f"declare 'standby' for a unit held offline until needed." if undeclared else "")
    basis = (f"{case.redundancy.value} against {case.critical_load_MW.render()} critical load, "
            f"ride-through {case.ride_through_hours.render()}: {available.render()} available "
            f"under '{scenario_name}'.{mode_note}")
    return ContingencyResult(status, scenario_name, available, case.critical_load_MW,
                             margin, basis, blocking)
