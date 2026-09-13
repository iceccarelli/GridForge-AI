# GridForge-AI — Target Architecture & First-Patch Spec v0.1
**Status: PRE-AUDIT DRAFT.** Written 2026-09-13 without access to the repositories.
**This document is a specification to be reconciled against the audit, not an instruction to write code.** Per the operating rules, the first patch lands only after the audit of GridForge-AI, ThermalForge-Liquid-Cooling, DERIM and GridOS. Where this spec conflicts with what already exists and works in GridForge-AI, **the existing working code wins** and this document gets amended.

---

## 1. Design rule

The architecture exists to deliver §4 of `01_PRODUCT_SPEC` — the Capacity & Density Envelope Study — and nothing else. Every module must be traceable to a numbered section of that deliverable. A module that no report section consumes does not get built.

## 2. Domain boundaries

```
gridforge/
├── site/           # asset of record: geometry, climate, structural, water, permits
├── power/          # grid import → transformer → UPS → LV distribution → rack feed
├── compute/        # GPU/rack platform library, cluster definition, load profiles
├── thermal/        # heat split, TCS/FWS, CDU, RDHx, plant, hydraulics, ambient
├── scenario/       # scenario definition, sweep, sensitivity, uncertainty propagation
├── economics/      # capex/opex, lead time, NPV, cost-per-useful-GPU-hour
├── validation/     # evidence class, provenance graph, engineering checks, CI rules
├── reporting/      # report model → docx/pdf/html; provenance appendix renderer
└── integrations/
    ├── thermalforge/   # extracted + wrapped ThermalForge capabilities
    ├── derim/          # adapter only — power-system/DER/forecast/optimisation
    └── gridos/         # adapter only — telemetry/twin/grid-state, dormant until pulled
```

**Dependency rule (enforced by an import-linter test in the first patch):**
`site` depends on nothing. `power`, `compute`, `thermal` depend only on `site` + `validation`. `scenario` depends on `power`/`compute`/`thermal`. `economics` depends on `scenario`. `reporting` depends on everything but is depended on by nothing. `integrations` is depended on by nothing — adapters are called *into* the domain via ports, never imported by domain modules. **No domain module may import from `integrations`.** This is what stops DERIM and GridOS from colonising the product.

## 3. Common schemas (the contract)

Single source of truth, versioned, with units in the field name or an explicit `Quantity` type. Everything below carries `Provenance` (§5).

- **`SiteSpec`** — id, location, TMY reference, hall records. `HallSpec`: build year, net white space m², slab|raised_floor, floor_loading_kPa, clear_height_m, aisle_pitch_m, rack_positions, containment type, design_density_kW_per_rack, tenancy constraints.
- **`PowerInput`** — `GridConnection` (firm_capacity_MVA, contracted_MW, installed_MW, dso, queue_position, curtailment_terms, flex_contract), `Transformer[]`, `UPSBlock[]` (topology, rating, redundancy, step_load_capability), `LVDistribution` (busway_ampacity_A, voltage, tap_offs, rack_pdu), `Generation[]` / `Storage[]` (BTM options only).
- **`ThermalInput`** — `PlantSpec` (chillers, dry coolers, capacity_kW, design_supply_C, design_return_C, delta_T_K, free_cooling_hours), `HydraulicSpec` (pump capacity, pipe DN, available head), `TCSSpec` (supply_C, delta_T_K, flow_l_per_min, pressure_kPa, water_quality), `CDUSpec[]`, `RDHxSpec[]`, `AmbientSpec`.
- **`ComputeSpec`** — `GPUPlatform` from the library (rack_kW, peak_kW, liquid_fraction, residual_air_kW, max_inlet_liquid_C, flow_l_per_min_per_rack, rack_mass_kg, voltage_domain, availability_status), `ClusterSpec` (rack count, topology, utilisation profile), `WorkloadProfile` (duty cycle, step-load behaviour).
- **`ScenarioSpec`** — named variant = a set of overrides + an architecture choice (retained_air | rdhx | hybrid_dlc | full_dlc | staged) + an investment set. Scenarios are **data, not code**.
- **`EnvelopeResult`** — the signature output: `max_useful_compute_MW`, `achievable_kW_per_rack` (per zone), `binding_constraint`, `headroom_ladder[]`, `uncertainty`, `provenance_root`.
- **`ReportModel`** — a typed tree that renders to docx/pdf/html. The renderer must be incapable of emitting a number that has no `Provenance`.

Schemas live in `gridforge/<domain>/schema.py` (pydantic v2 or dataclasses+jsonschema — decide from what the repo already uses). Every schema serialises to JSON so the **machine-readable model pack** in the deliverable is a free by-product.

## 4. The core solver — `max_useful_compute`

```
solve(site, power, thermal, compute, scenario) -> EnvelopeResult
```

Implemented as **a set of independent constraint functions over a common state**, each returning `(limit_kW, binding_quantity, provenance)`. The envelope is the **minimum**; the binding constraint is the `argmin`. This shape is deliberate: it makes the answer explainable, which is the product.

Minimum constraint set for v1 (each a separate, individually testable function):

**Electrical:** firm grid capacity · transformer rating with derating · UPS block capacity and step-load · busway ampacity and tap-off inventory · rack-level feed limit (400 A vs 800–1000 A is frequently the hard stop) · total facility load vs contracted load (IT + mechanical + losses).
**Thermal:** liquid heat capture at platform heat split · TCS supply temperature achievable from FWS given CDU approach · CDU aggregate capacity at *derated* approach temperature · hydraulic limit (pump head, pipe DN, flow ≈1.4–1.5 l/min/kW at 10 K ΔT) · residual-air removal capacity per rack · plant capacity at design ambient.
**Physical:** floor loading vs rack mass · aisle pitch and clear height · pipework and busway routing space.
**Economic:** capex budget · schedule (a transformer at 120–160+ weeks is a constraint, not a line item).

**Headroom Ladder** = sort every constraint by `limit_kW`, attach `€/kW` and `weeks` to relieve each, and emit the ordered list. That artefact is the proprietary IP; guard it as the primary output type, not as a report section.

**Uncertainty:** each constraint returns a distribution or a band, not a point. v1 = interval arithmetic + one-at-a-time sensitivity (cheap, explainable, sufficient for E3). Monte Carlo only if a customer asks — do not build it speculatively.

## 5. Provenance — implemented, not documented

`validation/provenance.py` defines `Provenance(inputs[], model_id, model_version, assumptions[], evidence_class, uncertainty, computed_at)` and a `Quantity` wrapper that carries it. Arithmetic on `Quantity` **propagates provenance and takes the minimum evidence class**. Evidence classes E0–E7 per `01_PRODUCT_SPEC` §6.

CI gates in the first patch:
1. No `ReportModel` node with a numeric value and no `Provenance` → build fails.
2. Any output with `evidence_class > min(inputs)` → build fails.
3. Any string in the report template asserting measurement over an E≤E2 quantity (regex on a banned-phrase list: "the hall's capacity is", "measured", "actual", "proven") → build fails.
4. Library entries flagged `[V]` (vendor marketing) cannot be referenced by an E≥E3 output without a corroborating source field.

This is the cheapest defensible moat available: **auditable numbers**. It is also what lets a chartered co-signatory put a name on the report.

## 6. Integration policy

**ThermalForge-Liquid-Cooling — extract, do not import.** Candidate extractions, each to be confirmed against the audit and each landing as its own reviewed patch with tests: liquid-cooling calculations · thermal network / heat-split model · rack-density analysis · thermal constraint expressions · hydraulic calculations (flow, pressure drop, pump head) · cooling architecture comparison · scenario modelling · thermal report generation. **Do not bring across:** UI, auth, portal, demo/fixture code, anything not exercised by a test, dependencies not needed by the extracted calculation. Each extraction must arrive with its validation status recorded — a ThermalForge calculation is E1 until we can point at the check that makes it E3.

**DERIM — adapter only.** Wanted: power-system modelling, energy-flow models, DER models, forecasting, optimisation, protocol ingestion where a customer needs it, scenario analysis. Consumed through `integrations/derim/` behind a port defined by `power/`. **Kill switch: if `power/` ever imports DERIM types directly, the product is becoming another DER platform — revert.**

**GridOS — dormant.** No migration. Adapter stub only, empty until a customer-facing workflow pulls telemetry representation, digital-twin state, grid-state models or visualisation. Write the port; do not write the implementation.

## 7. First patch — the smallest thing that is commercially justified

**Commercial justification:** without it, the reference project in `01_PRODUCT_SPEC` §8 cannot be produced, and there is nothing to show the first 20 conversations.

Sequence (each its own PR: small, reversible, tested, documented, with the justification in the PR body):

| PR | Content | Test | Reversible by |
|---|---|---|---|
| 1 | Package skeleton + dependency rule + import-linter test + CONTRIBUTING gate | import-linter passes; no behaviour change | delete dirs |
| 2 | `validation/` — `Provenance`, `Quantity`, evidence classes, propagation | property tests on min-class propagation | isolated package |
| 3 | `site/schema.py`, `power/schema.py`, `thermal/schema.py`, `compute/schema.py` + JSON round-trip tests | schema round-trip + example fixtures | additive |
| 4 | `scenario/` interfaces + `EnvelopeResult` + `ReportModel` schema | golden-file test on an empty report | additive |
| 5 | Constraint framework + 3 electrical + 3 thermal constraints, hand-checked against `02_ENGINEERING_REFERENCE` | unit test per constraint against a worked example | additive |
| 6 | First ThermalForge extraction (highest-value validated calculation only) | parity test vs ThermalForge original output | revert single PR |
| 7 | `reporting/` renderer + provenance appendix + CI gates 1–4 | end-to-end on synthetic reference site | additive |
| 8 | Adapter ports for DERIM and GridOS (interfaces only, no implementations) | ports have no concrete deps | delete |

**Nothing in PRs 1–8 deletes or rewrites existing GridForge-AI functionality.** Additive first; consolidation only after the audit says what is dead.

## 8. Open questions the audit must answer

1. What does GridForge-AI already compute, and what evidence class is each output honestly at?
2. Is there an existing schema/domain layer worth keeping, or is the code script-shaped?
3. What does the commit history say about what is real vs scaffolded?
4. Licences on all four repos and on every dependency — anything copyleft that blocks selling a report generated by it?
5. Which accuracy claims already exist in READMEs/docs/frontends? **Any claim implying measured or validated performance that is actually modelled must be corrected before a single prospect sees the repo or any derived material.** This is a legal and credibility exposure, and it is the highest-priority audit finding class.
6. What in ThermalForge is covered by tests? Untested calculations are E0 regardless of how good they look.
7. Does DERIM contain anything that shortens the electrical-envelope work, or is it demand-side only?
