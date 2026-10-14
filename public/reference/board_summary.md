# Board summary — Reference Colocation Campus, hall DH-02

*Reference Project (synthetic) · NVIDIA GB300 NVL72 · summary of the Capacity & Density Envelope Study*

> **SYNTHETIC REFERENCE DATA — NOT A CUSTOMER ASSET. All values are modelled or assumed; none is a measurement of a real site.**

## The answer

**Deployable NVIDIA GB300 NVL72 racks today:** 0 racks (E0)

*Limited by: rack feed / tap-off rating*

**Deployable racks after the costed works:** 62 racks (E0)

*Limited by: Full DLC plus behind-the-meter supply*

**IT load at that point:** 8,370 [8,180–8,800] kW (E0)

*Limited by: at the recommended architecture*

**Time to full capacity:** 160 [80–210] weeks (E0)

*Limited by: set by transformer capacity; works run in parallel*

**Indicative capital cost:** 18,800,000 [9,420,000–37,700,000] EUR (E0)

*Limited by: Class 5 (order of magnitude): -50% / +100% · LOWER BOUND: a cost it needs has no price*

> ⚠️ As the hall stands it cannot host a single rack of the target platform. Stopping here is a legitimate outcome of this study.

## What decides it

| Why it matters | Constraint | Relief | Cost | Lead time |
| --- | --- | --- | --- | --- |
| binds first | Achievable facility water temperature | Adiabatic assist plus trim chiller on the high-temperature loop | 350,000 [175,000–700,000] EUR (E0) | 32 [20–48] weeks (E0) |
| largest cost | Firm supply (grid import + behind-the-meter) | Behind-the-meter supply: GEN-5MW (gas_engine, 5 MW) | 4,000,000 [2,800,000–5,200,000] EUR (E0) | 44 [28.6–59.4] weeks (E0) |
| sets the date | Transformer capacity | Replace / add transformer capacity (uprate ~60%) | 1,920,000 [960,000–3,840,000] EUR (E0) | 160 [80–210] weeks (E0) |

*Of 20 steps on the full ladder; the study lists all of them.*

## How firm this is

- 8 of 8 priced lines are library defaults rather than quotations; the cost is an order-of-magnitude figure, not a budget.
- The economics are not decision-grade; 2 cost components have no price; the study lists every gap.
- The answer depends most on one assumed input: contracted power 20% lower takes it from 62 to 48 racks.
- This model has not yet been checked against any instrumented site (0 reconciled observations); every figure here is modelled, not measured.

> ⚠️ EVIDENCE DISCLOSURE: screening study on library defaults and assumed inputs: electrical capacity is E0 where an issued deliverable requires E3; cooling performance is E0 where an issued deliverable requires E2; capex is E0 where an issued deliverable requires E1. Sufficient to decide whether to spend money finding out; not sufficient for procurement, construction or an investment committee decision.

## What to decide next

- Gate 1 — get the DSO's position on firm capacity and any flexibility product in writing before committing capital.
- Gate 2 — commission a structural assessment of the floor and a hydraulic model of the secondary loop.
- Gate 3 — place long-lead orders only after Gates 1 and 2 clear.
- Gate 4 — instrument the hall and reconcile this model against twelve months of measured data.

## Appendix A — Assumptions, provenance and validation status

Every number in this report carries an evidence class. The class of a computed number is never higher than the weakest of its inputs.

| Class | Meaning |
| --- | --- |
| E0 | assumed |
| E1 | modelled |
| E2 | simulated |
| E3 | estimated |
| E4 | validated against test data |
| E5 | supplied by the client (not measured or surveyed by us) |
| E6 | field-validated |
| E7 | observed in operation |

*E5 means supplied by the client — a declared rating, contract term or design value, or the client's own data as given. It is not a measurement we made, and it has not been verified by a site survey.*

### A.1 Assumptions relied upon

- Excludes IT hardware, migration and lost tenancy revenue. Public retrofit benchmarks span 2-12 MEUR per MW; this default is neither a quotation nor a benchmark.
- Library default, not a price. Replace with a quotation before this figure supports a capital decision.
- Class 5 (order of magnitude): -50% / +100%
- Placeholder re-expressed per MVA from the earlier 1.2 MEUR lump at the reference hall's 9 MVA added (3 x 5 MVA, +60%). Not a market price. Excludes civils and outage management.
- Placeholder per nameplate kW of UPS added.
- Placeholder re-expressed per run from the earlier 450 kEUR lump for the reference hall's 8 runs. Not a market price.
- Placeholder covering the unit supplied and mechanically installed only. Hydraulic integration, controls and commissioning are separate components.

### A.2 Sources

- Lenovo Press LP2357, GB300 NVL72, 2026 [V]
- NVIDIA NVL72 AI Factory Reference Architecture, 2026 [V]

### A.3 Provenance of headline quantities

| Quantity | Evidence | Model | Digest |
| --- | --- | --- | --- |
| deployable racks as found | E0 | input@0.1 | `2251cf0df6fb` |
| deployable racks after relief | E0 | input@0.1 | `8869e76332d4` |
| deployable IT load | E0 | envelope.it_load@0.1 | `a4e3fd845acb` |
| elapsed weeks to full capacity | E0 | input@0.1 | `ddfa75087f01` |
| total capex | E0 | economics.total_capex@0.1 | `9eed5fbc0658` |
| adiabatic assist and trim chiller | E0 | input@0.1 | `af0380aad4fa` |
| lead time | E0 | input@0.1 | `3141b684dcc2` |
| GEN-5MW installed capex | E0 | power.btm_capex@0.1 | `1be583b10fb5` |
| GEN-5MW lead time | E0 | input@0.1 | `481a422b0494` |
| transformer and switchgear uprate | E0 | costs.scaled_relief@0.1 | `a9ead11db2b8` |
| power transformer lead time | E0 | input@0.1 | `010015f8a59e` |

---

One page for a board. The study it summarises carries the full ladder, scenarios, sensitivity and provenance. Engineering opinion supported by a documented model; not a design package.

Generated 2026-09-14 by the GridForge-AI envelope engine.
