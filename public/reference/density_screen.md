# Density Screen — Reference Colocation Campus, hall DH-02

*Reference Project (synthetic) · ref REF-EU-01/DH-02 · target platform NVIDIA GB300 NVL72 · 5 architectures screened*

> **SYNTHETIC REFERENCE DATA — NOT A CUSTOMER ASSET. All values are modelled or assumed; none is a measurement of a real site.**

> **SCREENING OPINION — modelled from the inputs supplied. Not a design package, and not a measurement of this asset.**

## 1. The answer

**Deployable NVIDIA GB300 NVL72 racks as the hall stands:** 0 racks (E0)

*Limited by: platform needs 205 [174–236] A (E0) per rack; installed tap-offs rated 63 A (E5). The tap-off rating is compared at 100% of its rating, with no continuous-load derating (the busway is derated to 0.8)*

**Deployable after the costed ladder:** 62 racks (E0)

*Limited by: Full DLC plus behind-the-meter supply*

**Time to full capacity:** 160 [104–216] weeks (E0)

*Limited by: assumed lead time, not a date (E0) · set by transformer capacity; the range is that item's own lead-time range*

**Indicative capex:** 18,800,000 [9,420,000–37,700,000] EUR (E0)

*Limited by: Class 5 (order of magnitude): -50% / +100% · LOWER BOUND: a cost it needs has no price*

> ⚠️ These economics are not decision-grade. The capex total is a LOWER BOUND: no price exists for CDU commissioning and flushing (7 x unit, needed in 5 places); CDU hydraulic integration and controls (7 x unit, needed in 5 places). The weakest priced line is class E0, below E3: a decision needs every priced line at an engineering estimate or better. The capex total inherits class E0 from its inputs, below E3. 8 of 8 priced lines are library placeholders, not prices. The grid electricity price is a placeholder (140 EUR/MWh), not the site's tariff. Installed behind-the-meter generation has no usable operating cost: BESS-2MW-8MWh: annual_run_hours not declared; BESS-2MW-8MWh: no energy cost basis (declare opex_eur_per_MWh, or fuel_price_eur_per_MWh with electrical_efficiency); BESS-2MW-8MWh: variable_om_eur_per_MWh not declared (0 if the fuel route already includes it); BESS-2MW-8MWh: fixed_om_eur_per_kW_year not declared (0 if carried elsewhere). The energy cost prices all energy at the grid tariff.

> ➡️ Binding constraint: Rack feed / tap-off rating (electrical). platform needs 205 [174–236] A (E0) per rack; installed tap-offs rated 63 A (E5). The tap-off rating is compared at 100% of its rating, with no continuous-load derating (the busway is derated to 0.8).

## 2. What stops this hall, in order

| # | Constraint | Domain | Racks after | Relief | Capex | Lead time |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Rack feed / tap-off rating | electrical | 0 racks (E0) | Higher-rated tap-off units (and busway if ampacity does not allow)  — adds no racks on its own: another constraint limits the hall to the same figure, so this relieves one of several tied constraints | 372,000 [186,000–744,000] EUR (E0) | 24 [12–40] weeks (E0) |
| 2 | Residual air load removal per rack | thermal | 0 racks (E0) | Add in-row cooling or rear-door heat exchangers for the residual air load  — adds no racks on its own: another constraint limits the hall to the same figure, so this relieves one of several tied constraints | 558,000 [279,000–1,120,000] EUR (E0) | 20 [12–32] weeks (E0) |
| 3 | Achievable facility water temperature | thermal | 8 racks (E0) | Adiabatic assist plus trim chiller on the high-temperature loop | 350,000 [175,000–700,000] EUR (E0) | 32 [20–48] weeks (E0) |
| 4 | Transformer capacity | electrical | 8 racks (E0) | Replace / add transformer capacity (uprate ~60%)  — adds no racks on its own: another constraint limits the hall to the same figure, so this relieves one of several tied constraints | 1,200,000 [600,000–2,400,000] EUR (E0) | 160 [104–216] weeks (E0) |
| 5 | UPS capacity (protected load) | electrical | 12 racks (E0) | Add UPS modules / new UPS block | 768,000 [384,000–1,540,000] EUR (E0) | 30 [20–52] weeks (E0) |
| 6 | Busway ampacity | electrical | 22 racks (E0) | Replace busway with 800-1000 A and new tap-off units | 450,000 [225,000–900,000] EUR (E0) | 36 [24–52] weeks (E0) |

*First six rungs of the headroom ladder. The full study carries the complete ladder, the scenario comparison and the sensitivity analysis.*

## 3. Architectures screened

| Architecture | As found | After ladder | Binds first |
| --- | --- | --- | --- |
| Retained air, grid only | 0 racks (E0) | 0 racks (E0) | Rack feed / tap-off rating |
| Rear-door heat exchangers, grid only | 0 racks (E0) | 0 racks (E0) | Rack feed / tap-off rating |
| Hybrid DLC on retained plant, grid only | 0 racks (E0) | 26 racks (E0) | Rack feed / tap-off rating |
| Full DLC, grid only | 0 racks (E0) | 28 racks (E0) | Rack feed / tap-off rating |
| Full DLC plus behind-the-meter supply | 0 racks (E0) | 62 racks (E0) | Rack feed / tap-off rating |

## 4. What we had to assume — and what it would take to stop assuming

Intake completeness is 84%. Each row below is a number that moves the answer and that nobody has measured. This list is the deliverable as much as the number above it.

| Input | Status | Assumed | Why it binds | How to get it |
| --- | --- | --- | --- | --- |
| BESS-2MW-8MWh battery energy rating | optional | your firm factor 0.5 accepted as declared, unchecked against the battery's energy | a battery is firm only for what its stored energy can sustain: with no energy rating its firm credit is the same whatever its size, so the capacity it adds to the envelope is unchecked | the battery datasheet or supplier quotation: usable energy in MWh at the discharge rate the duty needs |
| GEN-5MW unit count and redundancy | optional | credited at nameplate x firm factor, as if no unit could be out of service | firm capacity under N+1 is what is left after the largest unit is lost: the same capacity is none of it as one unit, half as two, three quarters as four. Nameplate alone cannot say which it is | the generator schedule: how many units make up the option's capacity_MW, and the redundancy scheme your resilience design requires (N, N+1, N+2 or 2N) |
| Installed CDU schedule | optional | [] | When absent, the hybrid and full-DLC scenarios ASSUME three 1,350 kW N+1 CDUs already installed at no cost, which supplies roughly 22 racks of liquid capacity that the hall may not have. | CDU nameplates and the mechanical single-line diagram. |
| Flow the existing hall already draws on the plant | optional | 0 l/min, nothing subtracted (the pumped flow is read as flow available to the new load) | If the available pumped flow above is the plant's TOTAL, the existing hall already uses part of it and the hydraulic limit is overstated. When this is given the engine subtracts it before dividing by the flow per rack; when absent nothing is subtracted and the figure above is read as flow available to the new load. | Commissioning flow readings or the BMS flow trend for the existing hall's loops; pump curves at the operating point. |
| Other heat the existing hall already puts on the plant | optional | 0 kW, nothing subtracted (plant headroom is the plant capacity less the IT load only) | Plant headroom is the capacity less the IT load; UPS and distribution losses, fan-wall and pump power rejected to the plant and lighting also land on it, so headroom is overstated by their share. When this is given the engine subtracts it as well; when absent only the IT load is subtracted. | BMS plant load trend less the metered IT load, or the electrical single-line losses and the mechanical schedule's fan and pump power. |
| TCS target supply temperature | optional | 30 [27–32] degC (E0) | Whether the plant can hold the water temperature the chips need. | The platform vendor's reference design for the target rack. |
| Rear-door heat exchanger capacity per rack | optional | 60 [20–80] kW (E0) | Decides whether the rear-door scenario can host the target rack at all. When absent the engine uses a library default of 60 kW per rack (band 20-80), which is neither a manufacturer's rating nor a site measurement. | The selected rear-door unit's datasheet at the site's water temperature and airflow. |
| All-in grid electricity price | optional | library placeholder of 140 EUR/MWh (E0) | Every annual energy cost, cost per GPU-hour and lifecycle figure is priced at this. When absent the engine uses a 140 EUR/MWh placeholder (band 90-220). | The supply contract, or 12 months of invoices divided by metered energy. |
| Discount rate | optional | none: the lifecycle value is undiscounted | When absent the lifecycle value is stated undiscounted and says so. | The client's hurdle rate. |
| Load already on the busway | optional | 0 kW, nothing subtracted (busway_ampacity_A is read as the whole installed total) | The busway result is the installed capacity as declared; the load already drawing from it is not subtracted, so the racks it can still feed are overstated by that share. When this is given the engine subtracts it (never below zero); when absent nothing is subtracted. | Branch-circuit or busway monitoring (peak kW over a representative month), or the sum of the metered rack loads on the busway. |
| Rack positions occupied | optional | no occupied count; every position not free is read as occupied for the busway check only | Only the busway check against the load already in the hall reads it: the racks already installed are counted from this figure at the hall's design density. When absent the engine does not know how many positions are occupied; it reads every position that is not free (hall.rack_positions less hall.positions_available) as occupied, an assumption (E0) that is only as good as the total, and says so. Zero is a statement (nothing is occupied) and is asked for when free positions equal the total. It changes no rack count, cost or date. | The tenancy schedule or the floor plan's rack register: racks physically installed, which is not the same as positions sold. |

Figures supplied with a source. These are the client's own data, stated with where they come from. GridForge has not independently verified the documents; the evidence class is the most a client's own attestation can earn.

| Input | Value | Evidence | Source | Note |
| --- | --- | --- | --- | --- |
| hall design floor loading | 12 kPa | E5 | — | Design value from the building record, not a survey |
| current site peak demand | 7.4 MW | E5 | — | 12 months of half-hourly metered data |
| installed busway ampacity | 400 A | E5 | — | Legacy 400 A busway; modern AI halls use 800-1000 A |
| plant chilled-water supply temperature | 6 degC | E5 | — | Legacy low-temperature plant |
| air removal capacity per position | 9 kW | E3 | — | Derived from hall design density and containment; confirm by measurement |

> ⚠️ BTM option BESS-2MW-8MWh: it is credited as firm capacity with NO declared energy rating. A battery is firm only for what its stored energy can sustain, and recharge is not modelled, so the racks this adds are unverified.

> ⚠️ BTM option GEN-5MW: no unit count was declared, so it is credited at nameplate x firm factor as if no unit could be out of service. A single unit under N+1 would count as zero firm capacity; the racks this adds are unverified.

> ⚠️ Busway: hall.occupied_positions was not supplied, so the occupied positions are an assumption (E0), not a count. Reading every position that is not free as occupied (560 in total less 180 free = 380 positions), at their 8 kW design density, would draw 3,040 kW, more than the 1,720 kW the declared busway can carry. busway_ampacity_A is read as the installed total and existing load is not subtracted, so check whether the figure you gave is the whole hall's busway, and give hall.occupied_positions so this check runs on a count rather than an assumption.

> ⚠️ EVIDENCE DISCLOSURE: this is a screening opinion built partly on library defaults. electrical capacity is E0 where an issued deliverable requires E3; cooling performance is E0 where an issued deliverable requires E2; capex is E0 where an issued deliverable requires E1; schedule (lead times) is E0 where an issued deliverable requires E1. It is sufficient to decide whether to spend money finding out, and not sufficient to support procurement, construction or an investment committee decision.

## 5. Grid wait: what has been observed elsewhere (context only)

This document does not date grid reinforcement: a connection date needs the network operator's written offer. For scale only, here is what has been observed elsewhere. It is an external statistic, not a model output, and it is not an input to any figure in this document.

- US generation and storage requests that reached commercial operation took a median of 53 months from request to operation (middle half 37-70 months), across 1439 projects (US, requests that reached operation 2018-2025). Source: Lawrence Berkeley National Laboratory, Queued Up 2026 edition, CC BY 4.0.
- Only 23% of the 5633 requests that entered a queue in 2010-2015 reached operation (4153 were withdrawn, 181 unresolved). The figure above describes only the requests that did.
- The site is not in the observed data's country, or none is declared, so treat this as a scale reference only.
- The grid-reinforcement wait this document assumes is 30 weeks (evidence class E0); it sits below p25 of that observed distribution (0.131x the observed median). Its evidence class is unchanged by this comparison. The two measure different processes (a generation interconnection request, and the grid reinforcement this hall needs), so treat this as a prompt to ask the network operator, not as a correction of the assumption.

> ℹ️ Context only: this is not a connection time for a load or a data centre, it says nothing about this site's network operator, tariff or study status, and it changes no figure, date or evidence class in this document.

## 6. Electricity price: what has been published (context only)

This document prices energy at the figure stated in its economics. For scale only, here is what has been published about what customers actually paid. It is an external statistic, not a model output, and it is not an input to any figure in this document.

- U.S. Total, 2026-08: industrial customers paid 96.4 US dollars per MWh on average and commercial customers 144.7 US dollars per MWh. Source: U.S. Energy Information Administration, Electric Power Monthly, Table 5.6.A (Form EIA-861M), released October 23, 2026.
- These are averages over every customer in the sector for one month, delivery included, and the latest month is preliminary. They are not a data-centre price, not a tariff this site would be offered, and not a forecast.
- The site is not stated to be in the United States, so a US average is a scale reference at most.
- This document uses 140 euros per MWh (library placeholder (evidence class E0); no contracted tariff supplied). The two figures are in different currencies and are not converted here; convert at your own rate before comparing. Its evidence class is unchanged by this comparison.

> ℹ️ Context only: this is not the tariff for this site and it changes no figure, cost or evidence class in this document. The contracted tariff, once known, replaces the price used here.

## 7. Recommended next step

The intake is complete. This supports a full Capacity & Density Envelope Study with site-specific conclusions.

- Capacity & Density Envelope Study — full ladder, all architectures, scenario and sensitivity analysis, economics, risk register, machine-readable model pack. 25 working days from a complete intake.
- This screen's fee credits in full against it.
- Before anything else: get the DSO position in writing on firm capacity and any flexibility product. It costs nothing but time and it can end the question.

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

- Excludes IT hardware, migration and lost tenancy revenue. This default is neither a quotation nor a benchmark.
- Library default, not a price. Replace with a quotation before this figure supports a capital decision.
- Class 5 (order of magnitude): -50% / +100%
- Placeholder re-expressed per MVA from the earlier 1.2 MEUR lump at the reference hall's 9 MVA added (3 x 5 MVA, +60%). Not a market price. Excludes civils and outage management.
- Placeholder per nameplate kW of UPS added.
- Placeholder re-expressed per run from the earlier 450 kEUR lump for the reference hall's 8 runs. Not a market price.
- Placeholder covering the unit supplied and mechanically installed only. Hydraulic integration, controls and commissioning are separate components.
- Tap-off units are a reported shortage item

### A.2 Sources


### A.3 Provenance of headline quantities

| Quantity | Evidence | Model | Digest |
| --- | --- | --- | --- |
| deployable racks as found | E0 | input@0.1 | `2251cf0df6fb` |
| deployable racks after relief | E0 | input@0.1 | `8869e76332d4` |
| elapsed weeks to full energisation | E0 | input@0.1 | `6fc4e6a9b6e3` |
| total capex | E0 | economics.total_capex@0.1 | `9eed5fbc0658` |
| racks after step 1 | E0 | input@0.1 | `85b2bc621f00` |
| Higher-rated tap-off units (and busway if ampacity does not allow) for 62 racks | E0 | envelope.relief_capex@0.1 | `147ba26046e4` |
| tap-off lead time | E0 | input@0.1 | `7a5fc57ce1e4` |
| racks after step 2 | E0 | input@0.1 | `700ff34e59e2` |
| Add in-row cooling or rear-door heat exchangers for the residual air load for 62 racks | E0 | envelope.relief_capex@0.1 | `edd4d4501790` |
| in-row / RDHx lead time | E0 | input@0.1 | `fe48412ff79a` |
| racks after step 3 | E0 | input@0.1 | `d9cc107e9ef0` |
| adiabatic assist and trim chiller | E0 | input@0.1 | `af0380aad4fa` |
| lead time | E0 | input@0.1 | `3141b684dcc2` |
| racks after step 4 | E0 | input@0.1 | `e5f4587dc18d` |
| transformer and switchgear uprate | E0 | costs.scaled_relief@0.1 | `a9ead11db2b8` |
| power transformer lead time | E0 | input@0.1 | `010015f8a59e` |
| racks after step 5 | E0 | input@0.1 | `9fa15f724191` |
| UPS module addition, installed | E0 | costs.scaled_relief@0.1 | `c872f896fe0c` |
| UPS lead time | E0 | input@0.1 | `843c6ad78c29` |
| racks after step 6 | E0 | input@0.1 | `77feda0334a7` |
| busway and tap-off works, per run | E0 | costs.scaled_relief@0.1 | `8bca5c542732` |
| busway and tap-off lead time | E0 | input@0.1 | `74ff17170551` |
| retained_air: as found | E0 | input@0.1 | `16fb829314a5` |
| retained_air: after ladder | E0 | input@0.1 | `9757155224e4` |
| rdhx: as found | E0 | input@0.1 | `56f0cdb5473e` |
| rdhx: after ladder | E0 | input@0.1 | `1df820df1c84` |
| hybrid_dlc: as found | E0 | input@0.1 | `eaf7eaad71ab` |
| hybrid_dlc: after ladder | E0 | input@0.1 | `fd04939efc4f` |
| full_dlc: as found | E0 | input@0.1 | `8aedfe649b07` |
| full_dlc: after ladder | E0 | input@0.1 | `7cea1ab86122` |
| full_dlc_btm: as found | E0 | input@0.1 | `0acfc96fffd1` |
| full_dlc_btm: after ladder | E0 | input@0.1 | `145c0aad295e` |

---

Screening opinion supported by a documented model. The fee for this screen credits in full against a Capacity & Density Envelope Study.

Generated 2026-09-14 by the GridForge-AI envelope engine.
