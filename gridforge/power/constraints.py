"""Electrical constraints.

Uptime's field observation is that at high density power distribution binds
before cooling does (docs/04 §B). These functions are therefore the first place
to look for the answer, not the last.
"""
from __future__ import annotations

import math

from ..common import ASSUMED, ESTIMATED, V
from ..costs import cost
from ..constraints import ConstraintResult, EnvelopeContext, ReliefOption, constraint, floor_racks
from ..validation import Quantity
from .btm import installed_firm_kW, next_option, option_capex

SQRT3 = math.sqrt(3.0)


def _effective_units(units: int, redundancy: str) -> int:
    r = redundancy.upper().replace(" ", "")
    if r in ("N", "N+0"):
        return units
    if r == "N+1":
        return max(units - 1, 0)
    if r in ("2N", "N+N"):
        return units // 2
    if r == "N+2":
        return max(units - 2, 0)
    return units


def _it_headroom_to_racks(headroom_kW: Quantity, ctx: EnvelopeContext, label: str) -> Quantity:
    """Facility-power headroom -> new IT power -> racks. This division by PUE is
    where power and thermal actually couple: a worse cooling architecture eats
    the grid capacity that would otherwise have gone to compute."""
    it_kW = (headroom_kW / ctx.pue).relabel(label + " available for new IT load", "power.it_headroom")
    return it_kW / ctx.cluster.platform.rack_kW


@constraint
def grid_firm_capacity(ctx: EnvelopeContext) -> ConstraintResult:
    """The terminal constraint in every European metro we target.

    Relief is NOT grid reinforcement where no reinforcement is obtainable. It is
    behind-the-meter supply, which is why a speed-to-power practice exists.
    """
    g = ctx.power.grid
    firm_kW = (g.firm_capacity_MVA * g.power_factor).convert(1000.0, "kW", "firm grid capacity")
    contracted_kW = g.contracted_MW.convert(1000.0, "kW", "contracted capacity")
    ceiling = firm_kW if firm_kW.value <= contracted_kW.value else contracted_kW
    btm = installed_firm_kW(ctx.power)
    if btm.value > 0:
        ceiling = (ceiling + btm).relabel(
            "firm supply: grid import plus behind-the-meter", "power.total_firm_supply",
            step_evidence=ESTIMATED)
    headroom = (ceiling - g.current_site_peak_MW.convert(1000.0, "kW", "current site peak")).relabel(
        "firm supply headroom", "power.grid_headroom", step_evidence=ESTIMATED)
    racks = _it_headroom_to_racks(headroom, ctx, "firm supply headroom")

    opt = next_option(ctx.power)
    if opt is not None:
        def _apply(c: EnvelopeContext, oid: str = opt.id) -> EnvelopeContext:
            c = c.copy()
            for o in c.power.options:
                if o.id == oid:
                    o.installed = True
            return c

        relief = ReliefOption(
            description=f"Behind-the-meter supply: {opt.id} ({opt.kind}, "
                        f"{opt.capacity_MW.render(with_class=False)})",
            capex_eur=option_capex(opt),
            lead_time_weeks=opt.lead_time_weeks,
            apply=_apply,
            # Priced from the client's own declared option: their quotation for
            # their site beats anything in our library.
            cost_key="client-supplied",
            risk=(opt.permitting_note or
                  "Permitting, fuel supply and emissions consent govern the schedule; "
                  "confirm before relying on the lead time."),
        )
    else:
        relief = ReliefOption(
            description="Grid reinforcement / new connection capacity from the DSO",
            capex_eur=cost("grid.reinforcement", 2_500_000, "EUR",
                           "grid reinforcement capex",
                           note="Placeholder until a DSO connection offer is obtained. In most "
                                "FLAP-D metros this option is unavailable at any price before 2030."),
            cost_key="grid.reinforcement",
            lead_time_weeks=V(260, "weeks", "grid reinforcement lead time", ASSUMED, band=(150, 520),
                              assumptions=["Frankfurt: no new large connections before 2030; "
                                           "Amsterdam queue ~10 years"]),
            apply=lambda c: c,   # deliberately a no-op: we do not model capacity we cannot obtain
            risk="In most target metros this relief does not exist inside the decision horizon. "
                 "Behind-the-meter supply is the only lever that moves this constraint.",
        )

    basis = f"{headroom.render()} of firm-supply headroom at PUE {ctx.pue.render(with_class=False)}"
    if btm.value > 0:
        basis += f", including {btm.render()} of behind-the-meter firm capacity"
    return ConstraintResult(
        "grid_firm_capacity", "electrical", "Firm supply (grid import + behind-the-meter)",
        floor_racks(racks),
        basis=basis,
        relief=relief,
        notes=(g.queue_note,) if g.queue_note else (),
    )


@constraint
def transformer_capacity(ctx: EnvelopeContext) -> ConstraintResult:
    if not ctx.power.transformers:
        return _unbounded("transformer_capacity", "electrical", "Transformer capacity", "no transformers declared")
    total = None
    lead = None
    for t in ctx.power.transformers:
        n = _effective_units(t.units, t.redundancy)
        cap = (t.unit_rating_MVA * ctx.power.grid.power_factor * t.derating_factor).convert(
            1000.0 * n, "kW", f"{t.id} usable capacity ({t.redundancy}, {n} of {t.units} units)")
        total = cap if total is None else total + cap
        if t.replacement_lead_time_weeks is not None:
            lead = t.replacement_lead_time_weeks
    headroom = (total - ctx.power.grid.current_site_peak_MW.convert(1000.0, "kW", "current site peak")).relabel(
        "transformer headroom", "power.transformer_headroom", step_evidence=ESTIMATED)
    racks = _it_headroom_to_racks(headroom, ctx, "transformer headroom")

    def _apply(c: EnvelopeContext) -> EnvelopeContext:
        c = c.copy()
        for tr in c.power.transformers:
            tr.unit_rating_MVA = tr.unit_rating_MVA * V(1.6, "1", "uprated transformer factor", ASSUMED)
        return c

    relief = ReliefOption(
        description="Replace / add transformer capacity (uprate ~60%)",
        capex_eur=cost("transformer.replacement", 1_200_000, "EUR",
                       "transformer and switchgear replacement",
                       note="Excludes civils and outage management."),
        cost_key="transformer.replacement",
        lead_time_weeks=lead if lead is not None else V(160, "weeks", "power transformer lead time", ASSUMED,
                                                        band=(80, 210),
                                                        assumptions=["120 weeks in 2024, 160+ weeks in 2026"]),
        apply=_apply,
        risk="Lead time, not construction, is usually the schedule driver.",
    )
    return ConstraintResult(
        "transformer_capacity", "electrical", "Transformer capacity",
        floor_racks(racks),
        basis=f"{headroom.render()} usable after redundancy and derating",
        relief=relief,
    )


@constraint
def ups_capacity(ctx: EnvelopeContext) -> ConstraintResult:
    if not ctx.power.ups:
        return _unbounded("ups_capacity", "electrical", "UPS capacity", "no UPS declared (unprotected load assumed)")
    total = None
    for u in ctx.power.ups:
        n = _effective_units(u.units, u.redundancy)
        cap = (u.unit_rating_kW * V(float(n), "1", f"{u.id} usable units ({u.redundancy})", ASSUMED)).relabel(
            f"{u.id} usable UPS capacity", "power.ups_capacity")
        total = cap if total is None else total + cap
    headroom = (total - ctx.power.current_it_load_MW.convert(1000.0, "kW", "existing protected IT load")).relabel(
        "UPS headroom for new IT load", "power.ups_headroom", step_evidence=ESTIMATED)
    racks = headroom / ctx.cluster.platform.rack_kW

    def _apply(c: EnvelopeContext) -> EnvelopeContext:
        c = c.copy()
        for u in c.power.ups:
            u.units += 2
        return c

    return ConstraintResult(
        "ups_capacity", "electrical", "UPS capacity (protected load)",
        floor_racks(racks),
        basis=f"{headroom.render()} of protected-load headroom after {ctx.power.ups[0].redundancy} redundancy",
        relief=ReliefOption(
            description="Add UPS modules / new UPS block",
            capex_eur=(cost("ups.per_kW", 320, "EUR/kW", "UPS capacity, installed") *
                       ctx.cluster.platform.rack_kW *
                       V(20.0, "1", "20-rack capacity increment", ASSUMED)).relabel(
                           "UPS module addition capex", "power.ups_relief_capex"),
            cost_key="ups.per_kW",
            lead_time_weeks=V(30, "weeks", "UPS lead time", ASSUMED, band=(20, 52)),
            apply=_apply,
        ),
        notes=("GPU racks present step loads; confirm the UPS block accepts the step, not just the steady load.",),
    )


@constraint
def busway_ampacity(ctx: EnvelopeContext) -> ConstraintResult:
    lv = ctx.power.lv
    per_run_kW = (lv.voltage_V * lv.busway_ampacity_A * lv.busway_utilisation_limit *
                  ctx.power.grid.power_factor).convert(SQRT3 / 1000.0, "kW",
                                                       "usable capacity per busway run")
    total = (per_run_kW * V(float(lv.busway_runs), "1", "busway runs in hall", ASSUMED)).relabel(
        "total usable busway capacity in hall", "power.busway_total", step_evidence=ESTIMATED)
    racks = total / ctx.cluster.platform.rack_kW

    def _apply(c: EnvelopeContext) -> EnvelopeContext:
        c = c.copy()
        if c.power.lv.busway_ampacity_A.value < 1000:
            c.power.lv.busway_ampacity_A = V(
                1000, "A", "replacement busway ampacity", ASSUMED,
                assumptions=["Modern AI halls use 800-1000 A busway vs 400 A legacy"])
            c.power.lv.tapoff_max_A = V(400, "A", "replacement tap-off rating", ASSUMED)
        else:
            # already at modern ampacity: the next increment is more runs, which
            # needs riser and routing space, not a bigger busway
            c.power.lv.busway_runs += 2
        return c

    return ConstraintResult(
        "busway_ampacity", "electrical", "Busway ampacity",
        floor_racks(racks),
        basis=(f"{lv.busway_runs} run(s) at {lv.busway_ampacity_A.render(with_class=False)} "
               f"derated to {lv.busway_utilisation_limit.render(with_class=False)} -> {total.render()}"),
        relief=ReliefOption(
            description=("Replace busway with 800-1000 A and new tap-off units"
                         if lv.busway_ampacity_A.value < 1000 else
                         "Add two further busway runs (needs riser and routing space)"),
            capex_eur=cost("busway.replacement", 450_000, "EUR",
                           "busway replacement for one hall"),
            cost_key="busway.replacement",
            lead_time_weeks=V(36, "weeks", "busway and tap-off lead time", ASSUMED, band=(24, 52),
                              assumptions=["Tap-off units are a reported shortage item"]),
            apply=_apply,
            risk="Requires hall outage or phased de-tenanting.",
        ),
    )


@constraint
def rack_feed_tapoff(ctx: EnvelopeContext) -> ConstraintResult:
    """Hard gate: can a single rack even be fed?"""
    lv = ctx.power.lv
    need = ctx.cluster.platform.rack_feed_current_A
    if need is None:
        return _unbounded("rack_feed_tapoff", "electrical", "Rack feed / tap-off rating",
                          "platform rack feed current not declared")
    ok = need.value <= lv.tapoff_max_A.value
    racks = V(float("inf") if ok else 0.0, "racks", "racks permitted by tap-off rating", ESTIMATED)

    def _apply(c: EnvelopeContext) -> EnvelopeContext:
        c = c.copy()
        c.power.lv.tapoff_max_A = V(400, "A", "upgraded tap-off rating", ASSUMED)
        return c

    return ConstraintResult(
        "rack_feed_tapoff", "electrical", "Rack feed / tap-off rating",
        racks, gate=True,
        basis=(f"platform needs {need.render()} per rack; installed tap-offs rated "
               f"{lv.tapoff_max_A.render()}"),
        relief=ReliefOption(
            description="Higher-rated tap-off units (and busway if ampacity does not allow)",
            capex_eur=cost("tapoff.unit", 6_000, "EUR/rack", "tap-off unit and rack feed"),
            cost_key="tapoff.unit",
            lead_time_weeks=V(24, "weeks", "tap-off lead time", ASSUMED, band=(12, 40)),
            apply=_apply, per_rack=True,
        ),
    )


def _unbounded(cid: str, domain: str, name: str, basis: str) -> ConstraintResult:
    return ConstraintResult(cid, domain, name,
                            V(float("inf"), "racks", f"{name}: not limiting", ESTIMATED), basis=basis)
