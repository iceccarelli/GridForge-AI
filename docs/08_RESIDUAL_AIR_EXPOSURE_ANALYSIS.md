# Residual air removal — exposure analysis, no CFD

**HANDOFF.md §6d #16.** `residual_air_removal` (`gridforge/thermal/constraints.py`)
is a screening-level, steady-state, single-number gate: one hall-wide
`residual_air_capacity_kW_per_rack` input compared against the platform's per-rack
air-side load, with no computational fluid dynamics behind either side. The open
question was whether that scope-out is safe — whether the missing physics could be
silently moving the answer — or whether it is exposure we should disclose more
loudly than "screening level."

This is a first, bounded answer, not a closed one. It is a **model-only** analysis
over the four published example halls (`examples/intake/*.json` — three synthetic,
one the published reference hall). It is not measured data, it does not touch a
real customer's hall, and it does not resolve whether the *model itself* is
accurate — only how much a given hall's headline answer moves when the one input
this constraint depends on is varied across a defensible range. Method and results
below are reproducible with the commands given; nothing here is asserted without
the command that produced it.

## Method

For every example intake, every architecture the scenario library evaluates was
solved once as published, then the residual-air constraint was evaluated in
isolation and, separately, the whole envelope was re-solved with
`thermal.residual_air_capacity_kW_per_rack` swept across
**15, 18, 20, 22, 25, 28, 30, 35, 40 kW** — a band wide enough to cover the
library's own default (`RESIDUAL_AIR_CAPACITY_LEGACY_kW`), the in-row/RDHx relief's
post-augmentation assumption (20–30 kW, `gridforge/thermal/constraints.py:188`),
and a further margin either side. `gridforge.scenario.knobs._set_air` is the
existing sensitivity primitive (already used by the founder-shipped
`SENSITIVITY_KNOBS["Per-position air capacity at 20 kW"]`); this analysis is a
wider, systematic sweep of the same knob rather than a new mechanism.

## Result 1 — the constraint is a hard gate, and it already does its job

`residual_air_removal` computes `need` as the **full rack power** for
`RETAINED_AIR` and `RDHX` architectures (the constraint's own comment: *"10–15% of
135 kW is still 13–20 kW per rack"* refers to the *residual* load once a liquid
loop has captured the rest — for an air-only architecture there is no liquid loop,
so the requirement is the whole load). Run against the four example halls as
published:

| Hall | `retained_air` | `rdhx` |
|---|---|---|
| dublin_hall | 0 racks — gates on `architecture_capability` first | 0 racks — gates on `architecture_capability` first |
| london_hall | 0 racks — **gates on `rack_feed_tapoff`** | 0 racks — **gates on `rack_feed_tapoff`** |
| nordic_hall | 0 racks — gates on `architecture_capability` first | 0 racks — gates on `architecture_capability` first |
| reference_hall | 0 racks — **gates on `rack_feed_tapoff`** | 0 racks — **gates on `rack_feed_tapoff`** |

On every example hall, an air-only architecture at this platform's density is
infeasible, and the envelope solver reports a *different* constraint as binding
because it also reports zero and is evaluated first. `residual_air_removal` would
gate to zero here too — direct evaluation of the function confirms it — it simply
never gets to be the named `argmin` because it is not the unique minimum. This
matters for how the finding below reads: the air-removal gate is not being missed,
it is being tied.

## Result 2 — where residual air is not already gated out, it is not what binds either

For `hybrid_dlc` and `full_dlc` (the architectures where `residual_air_removal`
checks the *residual* load rather than the whole rack, and where a real answer
above zero exists), the constraint that actually binds across all four halls is
`ups_capacity` or `tcs_supply_achievable` — never `residual_air_removal`. Sweeping
the per-position air capacity from 15 to 40 kW against each hall's own
recommended, post-ladder scenario changes the final deployable rack count by
**zero, on all four halls, across the entire swept range**:

```
dublin_hall     binding=tcs_supply_achievable   racks (post-ladder, recommended scenario) = 69, unmoved across the whole 15–40 kW sweep
london_hall     binding=rack_feed_tapoff        racks (post-ladder, recommended scenario) = 6,  unmoved across the whole 15–40 kW sweep
nordic_hall     binding=tcs_supply_achievable   racks (post-ladder, recommended scenario) = 88, unmoved across the whole 15–40 kW sweep
reference_hall  binding=rack_feed_tapoff        racks (post-ladder, recommended scenario) = 62, unmoved across the whole 15–40 kW sweep
```

(Reproduce with `python3 -m gridforge.cli screen <intake> --out /tmp/x` per hall, or
the sweep in `tests/test_residual_air_exposure.py::test_reference_halls_are_insensitive_to_air_capacity_assumption`,
which asserts exactly this and would fail the moment it stops being true.)

## Conclusion — narrow, and stated at the strength the evidence earns

On these four halls, at the current library defaults, the missing-CFD scope-out on
`residual_air_removal` is **not currently costing accuracy on the headline
number** — something else always binds first, with margin, across the whole
plausible range of the one input this constraint depends on. That is a fact about
**these four halls' other constraints being tighter**, not a fact about CFD being
unnecessary in general. A hall where the electrical and hydraulic constraints are
comparatively slack — a well-fed busway on a hall with older, air-only cooling
attempting a hybrid-DLC retrofit — is exactly the profile where this constraint
would bind, and this analysis says nothing about that case because none of the
four examples are that hall.

**What this earns, honestly:** the scope-out does not need to be reversed today,
but it should not be silently safe by assumption either. The regression test
below exists so that the moment a future change to the library, the ladder, or a
new example hall makes `residual_air_removal` newly binding, the test fails and
this document is revisited — rather than the gap re-opening unnoticed. The right
next escalation, per the original item, is a real instrumented hall where this
constraint binds; nothing in this repository can manufacture that, and this
document does not pretend to.

## What this does not do

- It does not validate the model against measured airflow of any kind.
- It does not cover every architecture/hall combination that could exist — only
  the four bundled examples.
- It does not upgrade any evidence class. Every figure above stays exactly the
  class it already was (`E3_ENGINEERING_ESTIMATE` / `ASSUMED`), and this document
  is not cited as if it were field validation.
