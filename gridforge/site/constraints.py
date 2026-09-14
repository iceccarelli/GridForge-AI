"""Physical constraints. Floor loading is a gate, not a capacity, and it is the
one that most often stops a 130 kW rack from ever entering a 2015 hall."""
from __future__ import annotations

from ..common import ASSUMED, ESTIMATED, V
from ..costs import cost
from ..constraints import ConstraintResult, EnvelopeContext, ReliefOption, constraint, floor_racks
from .schema import FloorType

KPA_TO_KG_PER_M2 = 101.97


@constraint
def floor_loading(ctx: EnvelopeContext) -> ConstraintResult:
    hall = ctx.hall
    plat = ctx.cluster.platform
    # Averaged over the aisle pitch: the load a structural engineer actually assesses.
    pitch_area = (hall.aisle_pitch_m * V(0.6, "m", "rack width", ASSUMED)).relabel(
        "floor area per rack at installed aisle pitch", "site.pitch_area")
    imposed = (plat.rack_mass_kg / pitch_area).relabel(
        "imposed floor load averaged over aisle pitch", "site.imposed_load", step_evidence=ESTIMATED,
        assumptions=["Pitch-averaged, not point load. Structural engineer sign-off is required "
                     "before any deployment; this is a screening check only."])
    capacity = hall.floor_loading_kPa.convert(KPA_TO_KG_PER_M2, "kg/m2", "hall floor loading capacity")
    ok = imposed.value <= capacity.value
    racks = V(float("inf") if ok else 0.0, "racks", "racks permitted by floor loading", ESTIMATED)

    def _apply(c: EnvelopeContext) -> EnvelopeContext:
        c = c.copy()
        c.hall.floor_loading_kPa = V(20, "kPa", "floor capacity after load spreading / slab deployment",
                                     ASSUMED, band=(15, 25))
        c.hall.floor_type = FloorType.SLAB
        return c

    extra = ("Raised floor: 120 kW+ racks normally require load-spreading plates or removal of the "
             "raised floor and deployment on slab.") if hall.floor_type == FloorType.RAISED else ""
    return ConstraintResult(
        "floor_loading", "physical", "Floor loading",
        racks, gate=True,
        basis=f"{imposed.render()} imposed against {capacity.render()} design capacity",
        relief=ReliefOption(
            description="Load spreading / remove raised floor and deploy on slab",
            capex_eur=cost("floor.load_spreading", 260_000, "EUR",
                           "structural works for one hall"),
            cost_key="floor.load_spreading",
            lead_time_weeks=V(18, "weeks", "structural works", ASSUMED, band=(10, 30)),
            apply=_apply,
            risk="Requires structural survey; in multi-storey buildings this relief may not exist.",
        ),
        notes=tuple(x for x in (extra,
                                "TIA-942 Rated-3 design value is 12 kPa (~1223 kg/m2).") if x),
    )


@constraint
def floor_space(ctx: EnvelopeContext) -> ConstraintResult:
    hall = ctx.hall
    n = float(hall.deployable_positions)
    racks = V(n, "racks", "rack positions available in hall", ESTIMATED,
              assumptions=["Assumes positions can be released from existing tenancy"])
    return ConstraintResult(
        "floor_space", "physical", "Available rack positions",
        floor_racks(racks),
        basis=f"{hall.positions_available} of {hall.rack_positions} positions available in {hall.id}",
        relief=ReliefOption(
            description="De-tenant further positions / release white space",
            capex_eur=V(0, "EUR", "commercial, not capital", ASSUMED),
            lead_time_weeks=V(52, "weeks", "lease and migration cycle", ASSUMED, band=(26, 104)),
            apply=lambda c: c,
            cost_key="not-capital",
            risk="Commercial and contractual, not engineering. Tenancy revenue at risk.",
        ),
    )
