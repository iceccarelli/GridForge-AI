# Product Spec — Capacity & Density Envelope Study (CDES v0.1)
**The €22k–€45k product.** Pre-audit draft, 2026-09-13.

---

## 1. The question the customer is buying an answer to

> *"For this existing hall, with this grid connection, what is the maximum AI compute I can install and operate — what binds first, at what density, and what does it cost me to move each constraint?"*

Deliverable promise, stated on the proposal: **a defensible number, the constraint that produced it, and a costed ladder of options — in 3–5 weeks, with no equipment quoted.**

## 2. Scope boundaries (say these out loud in the sales call)

**In scope:** capacity envelope, binding-constraint identification, architecture comparison at concept level, costed headroom ladder, scenario and sensitivity analysis, uncertainty bands, risk register, recommendation.

**Out of scope, explicitly:** stamped design drawings; CFD of the actual hall (offered as a paid add-on via a partner, or as a later phase); equipment selection or BOM; procurement; commissioning; structural sign-off; anything requiring a site survey we have not priced. We produce an **engineering opinion supported by a documented model**, not a design package. Put this in the SoW so the liability line is unambiguous.

## 3. Inputs required from the customer (the intake pack)

Gate the project on these. If ≥4 are missing, the project is a Density Screen (#0), not a CDES.

| # | Input | Why it binds | If missing |
|---|---|---|---|
| 1 | Grid connection agreement: firm capacity (MVA), contracted vs installed, curtailment/flex terms, DSO name | Sets the absolute ceiling and is the whole European thesis | Hard stop — request from customer, cannot be assumed |
| 2 | Single-line diagram + transformer/switchgear ratings and ages | Electrical is usually the binding constraint | Model with generic ratings, flag as E1 |
| 3 | UPS topology, rating, redundancy, remaining life | Step-load behaviour of GPU racks | Assume, flag |
| 4 | LV distribution: busway ampacity, tap-off inventory, rack PDU types | 400 A legacy vs 800–1000 A modern is the single most common hard stop | Assume 400 A legacy, flag as conservative |
| 5 | Hall geometry: net white space, slab vs raised floor, floor-loading certificate, ceiling height, aisle pitch | 1.4 t racks vs ~1,223 kg/m² TIA-942 Rated-3 design | Assume raised floor, require structural review as a condition |
| 6 | Cooling plant: chiller/dry-cooler capacity, design supply/return temps, ΔT, pump and pipework sizes | Legacy 6–7 °C plant vs 27–32 °C TCS need | Hard stop for thermal conclusions |
| 7 | 12 months of hall electrical and cooling trend data (kW, temps, flow) | The only *measured* customer data in the study | Downgrade all utilisation claims to E1 |
| 8 | Current IT load, rack count, existing kW/rack distribution, tenancy/lease constraints | Determines how much can actually be emptied | Hard stop |
| 9 | Target workload: GPU platform, cluster size, utilisation profile, timeline | Defines "useful compute" | Use platform library defaults, flag |
| 10 | Site climate data / location | Dry-cooler vs chiller hours, free-cooling economics | Use nearest TMY, flag |
| 11 | Water availability, discharge and permits | Adiabatic feasibility | Flag |
| 12 | Local grid/permit context: DSO queue position, any flex or curtailment offers | Scenario branch | Flag |

## 4. Deliverable structure (maps 1:1 to the brief's 14 items)

**A. Engineering report, ~45–70 pp:**
1. Executive answer — one page: max useful compute, binding constraint, confidence, recommendation.
2. **Headroom Ladder** — the centrepiece. Ordered constraints, kW/rack at which each binds, €/kW and weeks to relieve.
3. Site & baseline — measured data, clearly separated from modelled.
4. Electrical capacity analysis — grid → transformer → UPS → busway → rack, with derating.
5. Grid & interconnection constraints — firm capacity, queue position, curtailment, flex options.
6. Available-power scenarios.
7. Generation & storage options (BTM, only where it relieves a binding constraint — never as a product push).
8. Rack-density analysis — achievable kW/rack per zone, not a single site number.
9. Thermal architecture options — retained air / RDHx / DLC hybrid / full DLC, with facility-side requirements.
10. Liquid-cooling requirements — heat split, TCS/FWS temperatures, CDU sizing, flow, pressure drop, water quality.
11. Power↔thermal interaction — the coupled envelope, where the two constraint sets cross.
12. Operating envelope — ambient, load, redundancy, failure modes.
13. CAPEX/OPEX estimate with stated accuracy class (AACE Class 5/4 — say which).
14. Timeline, including lead times (transformers 120–160+ weeks is often the schedule driver, not construction).
15. Risk register.
16. Scenario comparison.
17. Recommended architecture + decision gates.
18. **Assumptions, provenance and validation-status appendix** (non-negotiable, see §6).

**B. Machine-readable model pack:** input set, scenario definitions, results, provenance graph. This is what makes project N+1 cheap and is the seed of the software.
**C. 90-minute walkthrough** with the customer's engineering team.
**D. One-page board summary** the sponsor can forward without editing.

## 5. Delivery process and founder-hours

| Stage | Days | Founder-h (first) | (templated) |
|---|---|---|---|
| Intake, data request, NDA/SoW | 1–3 | 6 | 3 |
| Data QA + baseline reconstruction | 4–8 | 10 | 5 |
| Electrical envelope | 6–12 | 10 | 5 |
| Thermal envelope + hydraulics | 8–14 | 12 | 5 |
| Coupled solve, scenarios, UQ | 12–18 | 10 | 4 |
| Economics | 15–20 | 8 | 3 |
| Report + review + walkthrough | 18–25 | 12 | 5 |
| **Total** | **3–5 weeks** | **~68 h** | **~30 h** |

At €30k / 68 h = **€441/h** first project; at €30k / 30 h = **€1,000/h** templated. Portfolio Screen (#2) at €100k for 5 halls ≈ 150 h = **€667/h** while carrying far more reusable work. **This is the leverage path — it is scenario reuse across halls, not SaaS.**

Sub-contract, never do in-house: structural sign-off, CFD, any stamped drawing, electrical protection studies requiring ETAP licence. Keep founder hours on the envelope and the argument.

## 6. Provenance and validation status — the non-negotiable

Every number that reaches a customer carries six fields. This is enforced in the engine (`03_TARGET_ARCHITECTURE` §5), not by discipline.

`ASSUMPTIONS · INPUT DATA · MODEL · UNCERTAINTY · OUTPUT · VALIDATION STATUS`

**Evidence classes** (the brief's ladder, made machine-checkable):

| Class | Name | Means | Allowed language |
|---|---|---|---|
| **E0** | ASSUMPTION | No data; engineering judgement or library default | "assumed", "taken as" |
| **E1** | MODEL | Computed from a documented model on assumed inputs | "modelled", "indicates" |
| **E2** | SIMULATION | Numerical simulation (hydraulic, thermal network, time-series) | "simulated" |
| **E3** | ENGINEERING ESTIMATE | Model + reviewed by a qualified engineer against practice | "estimated" |
| **E4** | EXPERIMENTAL VALIDATION | Compared against lab/rig/vendor test data | "validated against test data" |
| **E5** | CUSTOMER DATA | Customer's own measured trend data, as supplied | "measured at site (customer data)" |
| **E6** | FIELD VALIDATED | Our model reconciled against measured site performance | "field-validated" |
| **E7** | DEPLOYED | Operating outcome observed post-implementation | "observed in operation" |

**Hard rules, enforced by CI:**
- No output may be labelled with a class higher than the **lowest** class among its inputs. (Provenance is a min-operator.)
- **E1/E2 output must never be rendered in language that implies measurement.** A modelled capacity is never "the hall's capacity"; it is "the modelled capacity under stated assumptions."
- Every capacity claim carries an uncertainty band and the dominant sensitivity.
- **No fake precision:** 47 kW/rack, never 47.3. Rounding rules are part of the report schema.
- Electrical capacity claims require E3 minimum plus named derating basis; cooling-performance claims require E2 minimum plus stated CDU approach temperature.
- Vendor marketing figures enter the library flagged `[V]` and can never rise above E0 without independent corroboration.

## 7. What is reusable (the automation ledger — start it at project 1)

Track, per project, which artefacts were reused vs rebuilt. When any line hits 3 customers, it gets automated; at 10, productised.

Seeds: GPU platform library (rack kW, heat split, TCS temps, flow) · CDU/RDHx capability library · busway & tap-off ampacity tables · derating rules · climate/TMY set · capex unit-cost library · scenario templates (retained-air / RDHx / hybrid DLC / full DLC / staged) · report template · provenance renderer · intake questionnaire · data-QA checks.

## 8. Reference project (build first, before outbound)

One exemplary study on a **synthetic but realistic European colo hall**: ~12 MW site, 8 MW contracted, hall built 2015 at 8 kW/rack design, raised floor, 6/12 °C chilled water, 400 A busway, FLAP-D metro with a blocked connection queue. Show the full ladder from 8 kW/rack baseline to whatever the honest ceiling is, with at least one scenario where the answer is **"no, not without a new transformer and 30 months."**

**Every page watermarked `SYNTHETIC REFERENCE DATA — NOT A CUSTOMER ASSET`.** No customer logo, no real site, no implied client. This is the single most important sales asset and the single easiest way to destroy credibility if mislabelled.
