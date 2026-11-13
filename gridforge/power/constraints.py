"""Electrical constraints.

Uptime's field observation is that at high density power distribution binds
before cooling does (docs/04 §B). These functions are therefore the first place
to look for the answer, not the last.
"""
from __future__ import annotations

import math

from ..common import ASSUMED, ESTIMATED, V
from ..costs import cost, scaled_cost
from ..constraints import (ConstraintResult, EnvelopeContext, ReliefOption, constraint, floor_racks,
                           gate_racks)
from ..numerics import leq
from ..validation import Provenance, Quantity, qsum
from .btm import installed_firm_kW, next_option, option_capex
from .redundancy import usable_units

SQRT3 = math.sqrt(3.0)

#: Transformer relief: every bank is uprated by this factor (a screening assumption, not a product rating).
TRANSFORMER_UPRATE = 1.6


#: The units of a bank that count as usable capacity under its redundancy scheme: one rule, `power.redundancy.usable_units`, which generation options and
#: the loader's warnings use too. This module carried a second copy of the arithmetic; tests/test_intake_integrity.py pins them as the same function over
#: a grid of units x schemes. (`thermal.constraints` keeps its own: thermal may not import power.)
_effective_units = usable_units

#: Modules a UPS relief buys, IN TOTAL (not per block): see ``_ups_host``.
UPS_MODULES_PER_RELIEF = 2


def active_banks(banks):
    """The banks that exist: those with at least one unit. A bank declared with ``units`` 0 is a planned or empty bank, not equipment: it adds no
    capacity, is not priced, sets no lead time, and no relief puts units into it, so it is IGNORED wherever banks are counted, priced or dated
    (adding such a bank to a hall changes nothing). Before this a zero-unit transformer bank with a 300-week lead time moved the date from 160 to 300
    weeks, and a zero-unit UPS block doubled the UPS step's price. Refusing or warning about such a bank is the loader's concern, not this one's."""
    return [b for b in banks if b.units >= 1]


def _ups_usable_gain_kW(u) -> float:
    """Usable kW the relief's modules add if they go into block ``u``: the block's own redundancy decides how many of them count (two modules
    under N or N+1 are two usable, under 2N one)."""
    return u.unit_rating_kW.value * (_effective_units(u.units + UPS_MODULES_PER_RELIEF, u.redundancy) - _effective_units(u.units, u.redundancy))


def _ups_host(blocks):
    """The block that receives a UPS relief's modules, or None when no block has a module.

    THE RULE: a relief buys ``UPS_MODULES_PER_RELIEF`` (two) modules in total and puts them all in ONE block, the fewest blocks that can host them
    (nothing in the library caps the modules in a block). Which block is fixed by the plant and never by how it was listed: the block whose added
    modules carry the most usable kW (so a rung unlocks as much as the plant allows), then the larger module, then the smaller id, then the rest of
    the block's own figures. The price follows the kW actually added (two modules of that block's rating).

    The old relief added two modules to EVERY listed block, priced on the sum, so the same 6 x 1200 kW plant listed as 1, 2 or 6 blocks cost
    5.86, 6.63 and 9.70 MEUR for the same racks (audit N2, hybrid DLC on the reference hall with the UPS under N). Banks with no units are not hosts
    (``active_banks``)."""
    live = active_banks(blocks)
    if not live:
        return None
    return min(live, key=lambda u: (-_ups_usable_gain_kW(u), -u.unit_rating_kW.value, u.id, u.units, u.redundancy, u.step_load_capability.value))


def _lead_key(t_or_q) -> tuple:
    """Order of two lead times for "the slowest bank sets the date": the figure, then (among equals) the wider band, then the id of the bank."""
    q = getattr(t_or_q, "replacement_lead_time_weeks", t_or_q)
    lo, hi = q.band
    return (q.value, hi, -lo, getattr(t_or_q, "id", ""))


def _lesser_of(a: Quantity, b: Quantity, label: str) -> Quantity:
    """min(a, b) with the interval and the evidence of BOTH. Picking the nominal winner and returning its own
    provenance dropped the loser's lower band (the true minimum can fall below the winner's band) and let a weak
    loser hide behind a strong winner: "the ceiling is the contracted figure" is only as sure as the firm figure
    that was found to be higher."""
    prov = Provenance.derive(label, "power.lesser_of", [a.prov, b.prov], step_evidence=ESTIMATED)
    return Quantity(min(a.value, b.value), a.unit, prov,
                    min(a.band[0], b.band[0]), min(a.band[1], b.band[1]))


def _non_negative(q: Quantity) -> Quantity:
    """The quantity with its value and band clamped at zero: spare capacity can run out, it cannot go below nothing."""
    lo, hi = q.band
    return Quantity(max(q.value, 0.0), q.unit, q.prov, max(lo, 0.0), max(hi, 0.0))


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
    ceiling = _lesser_of(firm_kW, contracted_kW, "firm supply ceiling (lesser of firm connection and contracted)")
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
                        f"{opt.capacity_MW.render(with_class=False)}"
                        f"{f', {opt.units} units under {opt.redundancy}' if opt.units is not None else ''})",
            capex_eur=option_capex(opt),
            lead_time_weeks=opt.lead_time_weeks,
            basis_note=" ".join(x for x in (
                f"{opt.id} has no declared price: the step is unpriced, not free." if opt.capex_eur_per_kW is None else "",
                f"{opt.id} has no declared lead time: the step is undated, not instant." if opt.lead_time_weeks is None else "",
            ) if x),
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
                           note="Placeholder until a DSO connection offer is obtained. Availability depends on "
                                "the DSO and the metro; this model treats it as unavailable."),
            cost_key="grid.reinforcement",
            basis_note="One lump placeholder; the MVA a DSO would actually offer is not modelled, so it is not scaled.",
            lead_time_weeks=V(260, "weeks", "grid reinforcement lead time", ASSUMED, band=(150, 520),
                              assumptions=["A library placeholder, not a forecast for any metro: a DSO connection offer replaces it. One published utility "
                                           "statement (Mainova, Frankfurt: new high-power connections not expected until about the mid-2030s, "
                                           "press-reported 2026) is the kind of evidence that would."]),
            apply=lambda c: c,   # deliberately a no-op: we do not model capacity we cannot obtain
            risk="Where the DSO cannot offer new capacity inside the decision horizon this relief does not exist, "
                 "and behind-the-meter supply is then the only lever that moves this constraint. Obtain a connection offer.",
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
    banks = active_banks(ctx.power.transformers)         # a bank with no units is not equipment: no capacity, no price, no lead time
    if not banks:
        return _unbounded("transformer_capacity", "electrical", "Transformer capacity",
                          "no transformers declared" if not ctx.power.transformers else "no transformer bank with a unit is declared (every listed bank has 0 units)")
    caps = []
    lead, lead_bank = None, None
    for t in banks:
        n = _effective_units(t.units, t.redundancy)
        caps.append((t.unit_rating_MVA * ctx.power.grid.power_factor * t.derating_factor).convert(
            1000.0 * n, "kW", f"{t.id} usable capacity ({t.redundancy}, {n} of {t.units} units)"))
        # the slowest bank sets the date; among banks equally slow, the one with the wider band (then the larger upper end, then the id), so the
        # listing order cannot choose which band the date carries
        if t.replacement_lead_time_weeks is not None and (lead is None or _lead_key(t) > _lead_key(lead_bank)):
            lead, lead_bank = t.replacement_lead_time_weeks, t
    total = qsum(caps)         # order-independent (math.fsum): the same banks listed in another order are the same capacity
    headroom = (total - ctx.power.grid.current_site_peak_MW.convert(1000.0, "kW", "current site peak")).relabel(
        "transformer headroom", "power.transformer_headroom", step_evidence=ESTIMATED)
    racks = _it_headroom_to_racks(headroom, ctx, "transformer headroom")

    def _apply(c: EnvelopeContext) -> EnvelopeContext:
        c = c.copy()
        for tr in active_banks(c.power.transformers):
            tr.unit_rating_MVA = tr.unit_rating_MVA * V(TRANSFORMER_UPRATE, "1", "uprated transformer factor", ASSUMED)
        return c

    # What is bought is nameplate MVA: every bank is uprated, so the price follows the MVA added.
    added_MVA = math.fsum(t.units * t.unit_rating_MVA.value for t in banks) * (TRANSFORMER_UPRATE - 1.0)
    price = scaled_cost(
        "transformer.replacement", 1_200_000 / 9.0, "EUR/MVA", added_MVA, "MVA",
        "transformer and switchgear uprate",
        note="Placeholder re-expressed per MVA from the earlier 1.2 MEUR lump at the reference hall's 9 MVA "
             "added (3 x 5 MVA, +60%). Not a market price. Excludes civils and outage management.")
    relief = ReliefOption(
        description="Replace / add transformer capacity (uprate ~60%)",
        capex_eur=price.capex, cost_kind=price.kind, scope=price.scope,
            quantity=price.quantity, quantity_unit=price.quantity_unit, limited=price.limited,
            basis_note=price.note,
        cost_key="transformer.replacement",
        lead_time_weeks=lead if lead is not None else V(160, "weeks", "power transformer lead time", ASSUMED,
                                                        band=(80, 210),
                                                        assumptions=["Transformer lead times vary widely by type and market: this library range (80 to 210 weeks) is an assumption, "
                                                       "not a quotation"]),
        apply=_apply,
        risk="Lead time, not construction, is usually the schedule driver.",
    )
    return ConstraintResult(
        "transformer_capacity", "electrical", "Transformer capacity",
        floor_racks(racks),
        basis=f"{headroom.render()} usable after redundancy and derating (sized on sustained rack power; transients above it are not added, so headroom may be overstated)",
        relief=relief,
    )


@constraint
def ups_capacity(ctx: EnvelopeContext) -> ConstraintResult:
    blocks = active_banks(ctx.power.ups)                  # a block with no units is not equipment (see active_banks)
    if not blocks:
        return _unbounded("ups_capacity", "electrical", "UPS capacity",
                          "no UPS declared (unprotected load assumed)" if not ctx.power.ups else
                          "no UPS block with a module is declared (every listed block has 0 units; unprotected load assumed)")
    caps = []
    for u in blocks:
        n = _effective_units(u.units, u.redundancy)
        caps.append((u.unit_rating_kW * V(float(n), "1", f"{u.id} usable units ({u.redundancy})", ASSUMED)).relabel(
            f"{u.id} usable UPS capacity", "power.ups_capacity"))
    total = qsum(caps)         # order-independent (math.fsum): the same blocks listed in another order are the same capacity
    headroom = (total - ctx.power.current_it_load_MW.convert(1000.0, "kW", "existing protected IT load")).relabel(
        "UPS headroom for new IT load", "power.ups_headroom", step_evidence=ESTIMATED)
    racks = headroom / ctx.cluster.platform.rack_kW

    def _apply(c: EnvelopeContext) -> EnvelopeContext:
        c = c.copy()
        host = _ups_host(c.power.ups)           # the same block the price below was formed on (the ladder applies a relief to the context it came from)
        if host is not None:
            host.units += UPS_MODULES_PER_RELIEF
        return c

    # The relief buys two modules in total, in the one block that gains most (``_ups_host``); the price follows the nameplate kW actually added.
    # The same plant listed as one block or as several therefore gets the same step, the same price and the same date.
    host = _ups_host(ctx.power.ups)
    added_kW = UPS_MODULES_PER_RELIEF * host.unit_rating_kW.value
    price = scaled_cost("ups.per_kW", 320, "EUR/kW", added_kW, "kW", "UPS module addition, installed",
                        note="Placeholder per nameplate kW of UPS added.")
    rule = (f"Each step buys {UPS_MODULES_PER_RELIEF} modules in total ({UPS_MODULES_PER_RELIEF} x {host.unit_rating_kW.value:g} kW = {added_kW:g} kW), "
            f"put in one block ({host.id}): the fewest blocks that can host them, chosen as the block whose added modules carry the most usable kW "
            f"(then the larger module, then the id). The price follows the kW added, so the same plant listed as one block or as several is priced "
            f"and dated the same; a block declared with no units is ignored.")
    schemes = ", ".join(sorted({u.redundancy for u in blocks}))
    return ConstraintResult(
        "ups_capacity", "electrical", "UPS capacity (protected load)",
        floor_racks(racks),
        basis=(f"{headroom.render()} of protected-load headroom after {schemes} redundancy "
               f"(sized on sustained rack power; transients above it are not added, so headroom may be overstated)"),
        relief=ReliefOption(
            description="Add UPS modules / new UPS block",
            capex_eur=price.capex, cost_kind=price.kind, scope=price.scope,
            quantity=price.quantity, quantity_unit=price.quantity_unit, limited=price.limited,
            basis_note=" ".join(x for x in (price.note, rule) if x),
            cost_key="ups.per_kW",
            lead_time_weeks=V(30, "weeks", "UPS lead time", ASSUMED, band=(20, 52)),
            apply=_apply,
        ),
        notes=("GPU racks present step loads; confirm the UPS block accepts the step, not just the steady load.",),
    )


#: The tap-off rating the busway and tap-off reliefs install (a screening assumption, not a product rating).
RELIEF_TAPOFF_A = 400.0


def _better_tapoff(installed: Quantity, label: str) -> Quantity:
    """The tap-off rating after a relief: the BETTER of what is installed and the rating the relief buys.

    A relief assigned 400 A unconditionally, so on a hall whose installed tap-offs were rated above that (a 230 V single-phase feed needs
    about 618 A per rack, so a 630 A part is the right one) buying "higher-rated tap-offs" or a new busway REPLACED them with weaker ones, the
    rack-feed gate failed and the plan took the hall to zero racks. Installed equipment that already meets or beats the relief rating is kept
    exactly as declared, with its own provenance."""
    if installed.value >= RELIEF_TAPOFF_A:
        return installed
    return V(RELIEF_TAPOFF_A, "A", label, ASSUMED)


@constraint
def busway_ampacity(ctx: EnvelopeContext) -> ConstraintResult:
    lv = ctx.power.lv
    phase_factor = SQRT3 if lv.phases == 3 else 1.0         # single-phase: P = V * I, not sqrt(3) * V * I
    per_run_kW = (lv.voltage_V * lv.busway_ampacity_A * lv.busway_utilisation_limit *
                  ctx.power.grid.power_factor).convert(phase_factor / 1000.0, "kW",
                                                       "usable capacity per busway run")
    total = (per_run_kW * V(float(lv.busway_runs), "1", "busway runs in hall", ASSUMED)).relabel(
        "total usable busway capacity in hall", "power.busway_total", step_evidence=ESTIMATED)
    rack_kW = ctx.cluster.platform.rack_kW
    topology = lv.rack_feed_topology
    existing = lv.existing_load_kW
    left = ""
    if topology == "single_run":
        # Each rack hangs off ONE run, so a run's spare kW cannot be pooled with another's: whole racks are counted run by run.
        # (A run that carries 1.6 racks carries 1, however many runs there are.)
        if existing is None:
            racks = floor_racks(per_run_kW / rack_kW) * V(float(lv.busway_runs), "1", "busway runs in hall", ASSUMED)
        else:
            # The intake gives the hall's load already on the busway, not run by run: it is spread evenly over the runs (stated in the basis).
            share = existing.convert(1.0 / max(lv.busway_runs, 1), "kW", "existing load per busway run")
            net_run = _non_negative((per_run_kW - share).relabel("spare capacity per busway run", "power.busway_run_spare",
                                                                 step_evidence=ESTIMATED))
            racks = floor_racks(net_run / rack_kW) * V(float(lv.busway_runs), "1", "busway runs in hall", ASSUMED)
            left = f"{net_run.render(with_class=False)} left per run"
        topo_note = "; each rack is fed from one run, so racks are counted whole, run by run"
    else:
        available = total if existing is None else _non_negative((total - existing).relabel(
            "spare busway capacity in hall", "power.busway_spare", step_evidence=ESTIMATED))
        racks = available / rack_kW
        left = f"{available.render(with_class=False)} left"
        topo_note = ("; a rack's load is shared across runs, as declared" if topology == "pooled" else
                     "; this ASSUMES a rack's load can be shared across runs (A and B feeds): if each rack is fed from one run, declare "
                     "lv.rack_feed_topology = single_run and whole racks are counted run by run")

    def _apply(c: EnvelopeContext) -> EnvelopeContext:
        c = c.copy()
        if c.power.lv.busway_ampacity_A.value < 1000:
            c.power.lv.busway_ampacity_A = V(
                1000, "A", "replacement busway ampacity", ASSUMED,
                assumptions=["Modern AI halls use 800-1000 A busway vs 400 A legacy"])
            c.power.lv.tapoff_max_A = _better_tapoff(c.power.lv.tapoff_max_A, "replacement tap-off rating")
        else:
            # already at modern ampacity: the next increment is more runs, which
            # needs riser and routing space, not a bigger busway
            c.power.lv.busway_runs += 2
        return c

    # Replacing the busway renews every run; once the ampacity is modern the relief adds two runs. Either way
    # the price follows the runs the step actually buys.
    runs_bought = lv.busway_runs if lv.busway_ampacity_A.value < 1000 else 2
    bw_price = scaled_cost(
        "busway.replacement", 450_000 / 8.0, "EUR/run", float(runs_bought), "run",
        "busway and tap-off works, per run", scope_unit="busway run(s)",
        note="Placeholder re-expressed per run from the earlier 450 kEUR lump for the reference hall's 8 runs. "
             "Not a market price.")
    basis = (f"{lv.busway_runs} run(s) at {lv.busway_ampacity_A.render(with_class=False)} "
             f"derated to {lv.busway_utilisation_limit.render(with_class=False)} -> {total.render()}{topo_note}. Modelling limit: the "
             f"figure is the INSTALLED busway total as declared; existing load and occupied positions are not subtracted, so the rack count is overstated if the figure is not the hall's spare capacity")
    if existing is not None:
        spread = (f", spread evenly over the {lv.busway_runs} run(s) because the intake gives the hall's load, not each run's"
                  if topology == "single_run" else "")
        basis = (f"{lv.busway_runs} run(s) at {lv.busway_ampacity_A.render(with_class=False)} "
                 f"derated to {lv.busway_utilisation_limit.render(with_class=False)} -> {total.render()}{topo_note}; less "
                 f"{existing.render()} already on the busway{spread} = {left} (never below zero). Modelling limit: only the existing load the client "
                 f"gave is subtracted; positions that are occupied but whose load was not given are not counted")
    return ConstraintResult(
        "busway_ampacity", "electrical", "Busway ampacity",
        floor_racks(racks),
        basis=basis,
        relief=ReliefOption(
            description=("Replace busway with 800-1000 A and new tap-off units"
                         if lv.busway_ampacity_A.value < 1000 else
                         "Add two further busway runs (needs riser and routing space)"),
            capex_eur=bw_price.capex, cost_kind=bw_price.kind, scope=bw_price.scope,
            quantity=bw_price.quantity, quantity_unit=bw_price.quantity_unit, limited=bw_price.limited,
            basis_note=bw_price.note,
            cost_key="busway.replacement",
            lead_time_weeks=V(36, "weeks", "busway and tap-off lead time", ASSUMED, band=(24, 52),
                              assumptions=["Tap-off units are a reported shortage item"]),
            apply=_apply,
            risk="Requires hall outage or phased de-tenanting.",
        ),
    )


#: The voltage and phase count the compute library states a rack's feed current at ("assumed rack feed current at 400 V 3ph").
LIBRARY_FEED_VOLTAGE_V = 400.0


def rack_feed_current_at(need: Quantity, lv) -> tuple[Quantity, str]:
    """The rack's feed current at THIS hall's busway voltage and phase count, and the sentence that says so ("" when nothing changed).

    The library states the figure at 400 V three-phase. The same rack draws more current from a lower voltage or a single-phase feed
    (I = P / (sqrt3 * V * pf) three-phase; I = P / (V * pf) single-phase), and a tap-off is rated for CURRENT, so a 208 V or
    single-phase hall must not be tested against a 400 V figure: it would pass a tap-off that cannot carry the rack. A higher voltage
    lowers the current, and that is credited too. One function, because the capacity model and the procurement specification must
    state the same required rating.
    """
    volts = lv.voltage_V.value
    scale = (LIBRARY_FEED_VOLTAGE_V / volts if volts > 0 else float("inf")) * (math.sqrt(3.0) if lv.phases == 1 else 1.0)
    if abs(scale - 1.0) <= 1e-9:
        return need, ""
    kind = "single" if lv.phases == 1 else "three"
    scaled = need * V(scale, "1", f"scaling of the rack feed current from {LIBRARY_FEED_VOLTAGE_V:g} V three-phase to the hall's "
                                  f"{volts:g} V {kind}-phase busway", ESTIMATED)
    return scaled, f" (library figure at {LIBRARY_FEED_VOLTAGE_V:g} V three-phase, scaled to this hall's {volts:g} V {kind}-phase feed)"


@constraint
def rack_feed_tapoff(ctx: EnvelopeContext) -> ConstraintResult:
    """Hard gate: can a single rack even be fed?"""
    lv = ctx.power.lv
    need = ctx.cluster.platform.rack_feed_current_A
    if need is None:
        return _unbounded("rack_feed_tapoff", "electrical", "Rack feed / tap-off rating",
                          "platform rack feed current not declared")
    need, feed_note = rack_feed_current_at(need, lv)
    # leq, not <=: 76 A x 400 V / 500 V is 60.800000000000004 in binary, so a 60.8 A tap-off failed the rack it exactly carries and the hall
    # was priced a EUR 6.17M plan to 0 racks (a 60.81 A part gave 36). A part exactly at the need passes (numerics.LIMIT_REL_TOL).
    ok = leq(need.value, lv.tapoff_max_A.value)
    racks = gate_racks(ok, "racks permitted by tap-off rating", need, lv.tapoff_max_A)

    def _apply(c: EnvelopeContext) -> EnvelopeContext:
        c = c.copy()
        c.power.lv.tapoff_max_A = _better_tapoff(c.power.lv.tapoff_max_A, "upgraded tap-off rating")
        return c

    return ConstraintResult(
        "rack_feed_tapoff", "electrical", "Rack feed / tap-off rating",
        racks, gate=True,
        basis=(f"platform needs {need.render()} per rack{feed_note}; installed tap-offs rated "
               f"{lv.tapoff_max_A.render()}. The tap-off rating is compared at 100% of its rating, with no continuous-load derating "
               f"(the busway is derated to {lv.busway_utilisation_limit.render(with_class=False)})"),
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
