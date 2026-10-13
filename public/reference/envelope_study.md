# Capacity & Density Envelope Study — Reference Colocation Campus, hall DH-02

*Reference Project (synthetic) · target platform NVIDIA GB300 NVL72 · 5 architectures compared · GridForge-AI envelope engine v0.1*

> **SYNTHETIC REFERENCE DATA — NOT A CUSTOMER ASSET. All values are modelled or assumed; none is a measurement of a real site.**

## 1. The answer

**Deployable NVIDIA GB300 NVL72 racks today, before any investment:** 0 racks (E0)

*Limited by: platform needs 205 [174–236] A (E0) per rack; installed tap-offs rated 63 A (E5)*

The binding constraint as found is rack feed / tap-off rating (electrical). platform needs 205 [174–236] A (E0) per rack; installed tap-offs rated 63 A (E5).

**Deployable racks after the full headroom ladder:** 62 racks (E0)

*Limited by: Firm supply (grid import + behind-the-meter) becomes binding*

**IT load unlocked:** 8,370 [8,180–8,800] kW (E0)

*Limited by: at the recommended architecture*

**Time to full capacity:** 160 [80–210] weeks (E0)

*Limited by: set by transformer capacity; reliefs assumed to run in parallel; the range is that item's own lead-time range*

**Indicative capex to reach it:** 19,300,000 [9,660,000–38,600,000] EUR (E0)

*Limited by: Class 5 (order of magnitude): -50% / +100%*

> ➡️ Recommended architecture: Full DLC plus behind-the-meter supply. The same hall with on-site firm supply where the grid connection binds. The only scenario whose capacity is set by what can be built rather than by the queue.

Selection objective: Maximum deployable compute. On an AI site the revenue attached to a rack dominates the capital cost of enabling it, so capacity is ranked first and capex is the tie-break. Section 9 shows every architecture against all three objectives so the ranking can be overruled with the evidence in view.

> ℹ️ Dominant sensitivity: contracted power 20% lower takes the answer from 62 to 48 racks (section 10).

> ⚠️ As found, this hall cannot host a single rack of the target platform. The value of this study is the ordered, costed list of what has to change — and the option to stop, which is a legitimate outcome.

## 2. Headroom ladder

Each row is the constraint that binds at that point, what it costs to move it, and how long that takes. Reliefs are assumed to run in parallel, so the schedule is governed by the longest lead time rather than the sum.

| # | Constraint | Domain | Racks before | Racks after | Relief | Capex | Lead time | EUR per kW unlocked |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Rack feed / tap-off rating | electrical | 0 racks (E0) | 0 racks (E0) | Higher-rated tap-off units (and busway if ampacity does not allow)  — adds no racks on its own: another constraint limits the hall to the same figure, so this relieves one of several tied constraints | 372,000 [186,000–744,000] EUR (E0) | 24 [12–40] weeks (E0) | — |
| 2 | Residual air load removal per rack | thermal | 0 racks (E0) | 0 racks (E0) | Add in-row cooling or rear-door heat exchangers for the residual air load  — adds no racks on its own: another constraint limits the hall to the same figure, so this relieves one of several tied constraints | 558,000 [279,000–1,120,000] EUR (E0) | 20 [12–32] weeks (E0) | — |
| 3 | Achievable facility water temperature | thermal | 0 racks (E0) | 8 racks (E0) | Adiabatic assist plus trim chiller on the high-temperature loop | 350,000 [175,000–700,000] EUR (E0) | 32 [20–48] weeks (E0) | 324 EUR/kW (E0) |
| 4 | Transformer capacity | electrical | 8 racks (E0) | 8 racks (E0) | Replace / add transformer capacity (uprate ~60%)  — adds no racks on its own: another constraint limits the hall to the same figure, so this relieves one of several tied constraints | 1,200,000 [600,000–2,400,000] EUR (E0) | 160 [80–210] weeks (E0) | — |
| 5 | UPS capacity (protected load) | electrical | 8 racks (E0) | 12 racks (E0) | Add UPS modules / new UPS block | 864,000 [422,000–1,820,000] EUR (E0) | 30 [20–52] weeks (E0) | 1,600 EUR/kW (E0) |
| 6 | Busway ampacity | electrical | 12 racks (E0) | 22 racks (E0) | Replace busway with 800-1000 A and new tap-off units | 450,000 [225,000–900,000] EUR (E0) | 36 [24–52] weeks (E0) | 333 EUR/kW (E0) |
| 7 | CDU capacity (derated to site water temperature) | thermal | 22 racks (E0) | 25 racks (E0) | Add CDU capacity (one further unit per bank) | 180,000 [90,000–360,000] EUR (E0) | 26 [16–40] weeks (E0) | 444 EUR/kW (E0) |
| 8 | UPS capacity (protected load) | electrical | 25 racks (E0) | 28 racks (E0) | Add UPS modules / new UPS block | 864,000 [422,000–1,820,000] EUR (E0) | 30 [20–52] weeks (E0) | 2,130 EUR/kW (E0) |
| 9 | Firm supply (grid import + behind-the-meter) | electrical | 28 racks (E0) | 31 racks (E0) | Behind-the-meter supply: BESS-2MW-8MWh (bess, 2 MW) | 1,800,000 [1,260,000–2,340,000] EUR (E0) | 30 [19.5–40.5] weeks (E0) | 4,440 EUR/kW (E0) |
| 10 | Busway ampacity | electrical | 31 racks (E0) | 33 racks (E0) | Add two further busway runs (needs riser and routing space) | 450,000 [225,000–900,000] EUR (E0) | 36 [24–52] weeks (E0) | 1,670 EUR/kW (E0) |
| 11 | CDU capacity (derated to site water temperature) | thermal | 33 racks (E0) | 34 racks (E0) | Add CDU capacity (one further unit per bank) | 180,000 [90,000–360,000] EUR (E0) | 26 [16–40] weeks (E0) | 1,330 EUR/kW (E0) |
| 12 | Firm supply (grid import + behind-the-meter) | electrical | 34 racks (E0) | 39 racks (E0) | Behind-the-meter supply: GEN-5MW (gas_engine, 5 MW) | 4,000,000 [2,800,000–5,200,000] EUR (E0) | 44 [28.6–59.4] weeks (E0) | 5,930 EUR/kW (E0) |
| 13 | Busway ampacity | electrical | 39 racks (E0) | 40 racks (E0) | Add two further busway runs (needs riser and routing space) | 450,000 [225,000–900,000] EUR (E0) | 36 [24–52] weeks (E0) | 3,330 EUR/kW (E0) |
| 14 | Transformer capacity | electrical | 40 racks (E0) | 43 racks (E0) | Replace / add transformer capacity (uprate ~60%) | 1,200,000 [600,000–2,400,000] EUR (E0) | 160 [80–210] weeks (E0) | 2,960 EUR/kW (E0) |
| 15 | UPS capacity (protected load) | electrical | 43 racks (E0) | 44 racks (E0) | Add UPS modules / new UPS block | 864,000 [422,000–1,820,000] EUR (E0) | 30 [20–52] weeks (E0) | 6,400 EUR/kW (E0) |
| 16 | CDU capacity (derated to site water temperature) | thermal | 44 racks (E0) | 47 racks (E0) | Add CDU capacity (one further unit per bank) | 180,000 [90,000–360,000] EUR (E0) | 26 [16–40] weeks (E0) | 444 EUR/kW (E0) |
| 17 | Busway ampacity | electrical | 47 racks (E0) | 55 racks (E0) | Add two further busway runs (needs riser and routing space) | 450,000 [225,000–900,000] EUR (E0) | 36 [24–52] weeks (E0) | 417 EUR/kW (E0) |
| 18 | Busway ampacity | electrical | 55 racks (E0) | 55 racks (E0) | Add two further busway runs (needs riser and routing space)  — adds no racks on its own: another constraint limits the hall to the same figure, so this relieves one of several tied constraints | 450,000 [225,000–900,000] EUR (E0) | 36 [24–52] weeks (E0) | — |
| 19 | CDU capacity (derated to site water temperature) | thermal | 55 racks (E0) | 61 racks (E0) | Add CDU capacity (one further unit per bank) | 180,000 [90,000–360,000] EUR (E0) | 26 [16–40] weeks (E0) | 222 EUR/kW (E0) |
| 20 | UPS capacity (protected load) | electrical | 61 racks (E0) | 62 racks (E0) | Add UPS modules / new UPS block | 864,000 [422,000–1,820,000] EUR (E0) | 30 [20–52] weeks (E0) | 6,400 EUR/kW (E0) |
| 21 | Firm supply (grid import + behind-the-meter) | electrical | 62 racks (E0) | 62 racks (E0) | Grid reinforcement / new connection capacity from the DSO  — NOT TAKEN: this relief cannot be obtained in the decision horizon | 2,500,000 [1,250,000–5,000,000] EUR (E0) | 260 [150–520] weeks (E0) | — |

*Headroom ladder for the recommended architecture.*

Steps marked NOT TAKEN are shown because they are the next thing that binds, not because they are recommended. Their cost is excluded from the totals below.

Rungs 1, 2, 4, 18 are charged but add no racks on their own. Each relieves one of several constraints that limit the hall to the same figure at that point; without it a later rung cannot deliver its gain. They are kept, and costed, because dropping any one of them lowers the final answer — that is checked, not assumed. The EUR-per-kW column is left blank for them for the same reason: no racks are unlocked at that step.

**Cumulative relief capex:** 15,900,000 [7,950,000–31,800,000] EUR (E0)

*Limited by: Class 5 (order of magnitude): -50% / +100%*

**Critical-path lead time:** 160 [80–210] weeks (E0)

*Limited by: Lead time, not construction, is usually the schedule driver.*

## 3. Time to power

Capacity without a date is not a decision. Each relief on the ladder carries a lead time; reliefs are assumed to run in parallel, so the racks unlocked by the first N steps become available at the longest lead time among those N. One item sets the date, and it is almost never the construction work.

| Elapsed | Racks energised | Unlocked by | Domain |
| --- | --- | --- | --- |
| 32 [20–48] weeks (E0) | 8 racks (E0) | Achievable facility water temperature | thermal |
| 160 [80–210] weeks (E0) | 12 racks (E0) | UPS capacity (protected load) | electrical |
| 160 [80–210] weeks (E0) | 22 racks (E0) | Busway ampacity | electrical |
| 160 [80–210] weeks (E0) | 25 racks (E0) | CDU capacity (derated to site water temperature) | thermal |
| 160 [80–210] weeks (E0) | 28 racks (E0) | UPS capacity (protected load) | electrical |
| 160 [80–210] weeks (E0) | 31 racks (E0) | Firm supply (grid import + behind-the-meter) | electrical |
| 160 [80–210] weeks (E0) | 33 racks (E0) | Busway ampacity | electrical |
| 160 [80–210] weeks (E0) | 34 racks (E0) | CDU capacity (derated to site water temperature) | thermal |
| 160 [80–210] weeks (E0) | 39 racks (E0) | Firm supply (grid import + behind-the-meter) | electrical |
| 160 [80–210] weeks (E0) | 40 racks (E0) | Busway ampacity | electrical |
| 160 [80–210] weeks (E0) | 43 racks (E0) | Transformer capacity | electrical |
| 160 [80–210] weeks (E0) | 44 racks (E0) | UPS capacity (protected load) | electrical |
| 160 [80–210] weeks (E0) | 47 racks (E0) | CDU capacity (derated to site water temperature) | thermal |
| 160 [80–210] weeks (E0) | 55 racks (E0) | Busway ampacity | electrical |
| 160 [80–210] weeks (E0) | 61 racks (E0) | CDU capacity (derated to site water temperature) | thermal |
| 160 [80–210] weeks (E0) | 62 racks (E0) | UPS capacity (protected load) | electrical |

*Energisation curve for the recommended architecture.*

> ℹ️ The date is set by transformer capacity. Every week of that lead time is a week of the site's contracted power earning nothing, so it is the first thing to attack — before any further engineering optimisation.

| Scenario | Racks | Time to full capacity | Item that sets the date |
| --- | --- | --- | --- |
| Retained air, grid only | 0 racks (E0) | — | — |
| Rear-door heat exchangers, grid only | 0 racks (E0) | — | — |
| Hybrid DLC on retained plant, grid only | 26 racks (E0) | 160 [80–210] weeks (E0) | Transformer capacity |
| Full DLC, grid only | 28 racks (E0) | 160 [80–210] weeks (E0) | Transformer capacity |
| Full DLC plus behind-the-meter supply | 62 racks (E0) | 160 [80–210] weeks (E0) | Transformer capacity |

*Time to power across the architectures compared.*

## 4. Site and baseline

| Item | Value |
| --- | --- |
| Site | Reference Colocation Campus |
| Metro | Frankfurt |
| Country | DE |
| Hall | DH-02 |
| Built | 2015 |
| Floor | raised floor |
| Containment | cold aisle |
| Rack positions | 560 positions (E3) |
| Positions available | 180 positions (E3) |
| Design density | 8 kW (E5) |
| Net white space | 2,400 m2 (E5) |
| Floor loading | 12 kPa (E5) |
| Clear height | 3.2 m (E5) |
| Design dry bulb | 34 degC (E3) |
| Firm grid capacity | 14 MVA (E5) |
| Contracted power | 12 MW (E5) |
| Current site peak | 7.4 MW (E5) |
| Current IT load | 4.9 MW (E5) |
| Busway ampacity | 400 A (E5) |
| Tap-off rating | 63 A (E5) |
| Plant capacity | 6,800 kW (E5) |
| Plant supply / return | 6 degC (E5) / 12 degC (E5) |
| Pumped flow available | 9,000 l/min (E3) |

*Baseline as supplied. E5 means supplied by the client — a declared rating, contract term or design value as given to us, not measured or surveyed by us. E3 marks a figure that is estimate-grade by nature; E0 marks a library default.*

> ℹ️ No new or increased connection capacity is available from the DSO in this metro before the 2030s. The existing firm capacity is therefore the asset, and the whole question is how much compute can be produced from it.

## 5. Electrical capacity analysis

| Constraint | Type | Racks permitted | Basis | Relief |
| --- | --- | --- | --- | --- |
| Rack feed / tap-off rating | gate | 0 racks (E0) | platform needs 205 [174–236] A (E0) per rack; installed tap-offs rated 63 A (E5) | Higher-rated tap-off units (and busway if ampacity does not allow) |
| Transformer capacity | capacity | 8 [4–11] racks (E0) | 1,330 [845–1,810] kW (E3) usable after redundancy and derating | Replace / add transformer capacity (uprate ~60%) |
| UPS capacity (protected load) | capacity | 8 [7–8] racks (E0) | 1,100 kW (E0) of protected-load headroom after N+1 redundancy | Add UPS modules / new UPS block |
| Busway ampacity | capacity | 12 [12–13] racks (E0) | 8 run(s) at 400 A derated to 0.8 -> 1,720 kW (E0) | Replace busway with 800-1000 A and new tap-off units |
| Firm supply (grid import + behind-the-meter) | capacity | 28 [25–30] racks (E0) | 4,600 kW (E3) of firm-supply headroom at PUE 1.2 [1.15–1.28] | Behind-the-meter supply: BESS-2MW-8MWh (bess, 2 MW) |

*A gate either passes (it does not limit the hall) or fails (it permits no racks until relieved). Rack counts carry the weakest evidence class among the constraints evaluated.*

- No new or increased connection capacity is available from the DSO in this metro before the 2030s. The existing firm capacity is therefore the asset, and the whole question is how much compute can be produced from it.
- GPU racks present step loads; confirm the UPS block accepts the step, not just the steady load.

## 6. Thermal and cooling analysis

| Constraint | Type | Racks permitted | Basis | Relief |
| --- | --- | --- | --- | --- |
| Residual air load removal per rack | gate | 0 racks (E0) | 13.5 [10.6–21.3] kW (E0) of air-side load per rack against 9 kW (E3) the hall can remove per position | Add in-row cooling or rear-door heat exchangers for the residual air load |
| Achievable facility water temperature | gate | 0 racks (E0) | TCS target 30 [27–32] degC (E0) needs facility water at or below 25 [21–28] degC (E0); dry coolers at design dry-bulb delivers 44 [42–46] degC (E0) | Adiabatic assist plus trim chiller on the high-temperature loop |
| CDU capacity (derated to site water temperature) | capacity | 22 [15–26] racks (E0) | 2,700 [2,070–2,970] kW (E0) usable against 122 [112–131] kW (E0) of liquid load per rack; 24 [21–26] degC (E0) approach available | Add CDU capacity (one further unit per bank) |
| Hydraulic flow capacity | capacity | 69 [64–75] racks (E0) | 9,000 l/min (E3) available against 130 [120–140] l/min (E0) per rack (~1.45 l/min/kW at 10 K delta-T) | Uprate pumps and secondary pipework |
| Chilled-water plant capacity | capacity | 140 [89–179] racks (E0) | 1,900 kW (E3) of plant headroom against 13.5 [10.6–21.3] kW (E0) per rack — residual air load only (liquid rejected to a dedicated high-temperature loop) | Uprate chilled-water plant (+50%) or add a dedicated high-temperature loop |
| Cooling architecture per-rack capability | gate | passes — not limiting | full_dlc is practically capable of 150 [120–160] kW (E0) per rack; the target platform draws 135 [132–142] kW (E0) | — |

*A gate either passes (it does not limit the hall) or fails (it permits no racks until relieved). Rack counts carry the weakest evidence class among the constraints evaluated.*

- No capex relieves this constraint. If it binds, the architecture is wrong for the platform and a different scenario must be selected.
- TCS water quality per OCP: conductivity <1500 uS/cm, pH 8.0-10.5, 50 um inline filtration, sidestream <5 um at 10% of flow.
- Pressure drop budget and pipe DN are not modelled at screening level; a hydraulic model is required before design.
- A rack whose residual air load cannot be removed cannot be placed at all, however much liquid cooling is installed.
- The ASHRAE W45 rating on the platform is an equipment survival rating, not an operating point; operators specify 27-30 degC for 500-700 W parts.

## 7. Physical constraints

| Constraint | Type | Racks permitted | Basis | Relief |
| --- | --- | --- | --- | --- |
| Available rack positions | capacity | 180 racks (E3) | 180 of 560 positions available in DH-02 | De-tenant further positions / release white space |
| Floor loading | gate | passes — not limiting | 972 [894–1,050] kg/m2 (E0) imposed against 1,224 kg/m2 (E5) design capacity | Load spreading / remove raised floor and deploy on slab |

*A gate either passes (it does not limit the hall) or fails (it permits no racks until relieved). Rack counts carry the weakest evidence class among the constraints evaluated.*

- Raised floor: 120 kW+ racks normally require load-spreading plates or removal of the raised floor and deployment on slab.
- TIA-942 Rated-3 design value is 12 kPa (~1223 kg/m2).

## 8. Power and thermal interaction

Power and thermal are not independent budgets. Every kilowatt the cooling architecture consumes is a kilowatt of grid capacity that cannot be sold as compute, so the choice of cooling architecture directly changes the electrical envelope. The table shows the same hall under each architecture.

| Scenario | Architecture | PUE used | Racks as found | Racks after ladder | Binds first | Binds last |
| --- | --- | --- | --- | --- | --- | --- |
| Retained air, grid only | retained_air | 1.45 [1.35–1.6] (E0) | 0 racks (E0) | 0 racks (E0) | Rack feed / tap-off rating | Cooling architecture per-rack capability |
| Rear-door heat exchangers, grid only | rdhx | 1.35 [1.28–1.45] (E0) | 0 racks (E0) | 0 racks (E0) | Rack feed / tap-off rating | Cooling architecture per-rack capability |
| Hybrid DLC on retained plant, grid only | hybrid_dlc | 1.3 [1.22–1.4] (E0) | 0 racks (E0) | 26 racks (E0) | Rack feed / tap-off rating | Firm supply (grid import + behind-the-meter) |
| Full DLC, grid only | full_dlc | 1.2 [1.15–1.28] (E0) | 0 racks (E0) | 28 racks (E0) | Rack feed / tap-off rating | Firm supply (grid import + behind-the-meter) |
| Full DLC plus behind-the-meter supply | full_dlc | 1.2 [1.15–1.28] (E0) | 0 racks (E0) | 62 racks (E0) | Rack feed / tap-off rating | Firm supply (grid import + behind-the-meter) |

*A better cooling architecture buys compute out of the same grid connection.*

## 9. Economics

| Scenario | Racks | Total capex | Capex per rack enabled | Annual energy cost | Energy cost per GPU-hour | Critical path |
| --- | --- | --- | --- | --- | --- | --- |
| Retained air, grid only | 0 racks (E0) | — | — | — | — | — |
| Rear-door heat exchangers, grid only | 0 racks (E0) | — | — | — | — | — |
| Hybrid DLC on retained plant, grid only | 26 racks (E0) | 6,280,000 [3,120,000–12,700,000] EUR (E0) | 241,000 [120,000–490,000] EUR/rack (E0) | 4,200,000 [2,480,000–7,470,000] EUR (E0) | 0.256 [0.151–0.456] EUR/gpu*h (E0) | 160 [80–210] weeks (E0) |
| Full DLC, grid only | 28 racks (E0) | 5,870,000 [2,910,000–11,900,000] EUR (E0) | 210,000 [104,000–426,000] EUR/rack (E0) | 4,170,000 [2,510,000–7,360,000] EUR (E0) | 0.236 [0.142–0.417] EUR/gpu*h (E0) | 160 [80–210] weeks (E0) |
| Full DLC plus behind-the-meter supply | 62 racks (E0) | 19,300,000 [9,660,000–38,600,000] EUR (E0) | 312,000 [156,000–623,000] EUR/rack (E0) | 9,240,000 [5,570,000–16,300,000] EUR (E0) | 0.236 [0.142–0.417] EUR/gpu*h (E0) | 160 [80–210] weeks (E0) |

*Cost basis: Class 5 (order of magnitude): -50% / +100%. Excludes IT hardware, migration and lost tenancy revenue. A dash means no rack can be deployed in that architecture and no relief exists, so the figure is undefined rather than zero.*

| Objective | What it optimises | Architecture it selects | Racks |
| --- | --- | --- | --- |
| max compute | Maximum deployable compute. | Full DLC plus behind-the-meter supply | 62 racks (E0) |
| min cost | Lowest capital cost per rack enabled. | Full DLC, grid only | 28 racks (E0) |
| fastest | Earliest full energisation. | Full DLC plus behind-the-meter supply | 62 racks (E0) |

*The same scenarios ranked under each objective. The recommendation above uses the stated objective; where another objective selects a different architecture, that is a judgement for the client, not for the model.*

| How the recommended capex is built | Amount |
| --- | --- |
| Relief works along the headroom ladder (section 2) | 15,900,000 [7,950,000–31,800,000] EUR (E0) |
| In-hall conversion of the 62 racks deployed | 3,410,000 [1,700,000–6,820,000] EUR (E0) |
| Total (the headline capex) | 19,300,000 [9,660,000–38,600,000] EUR (E0) |

*The ladder's cumulative figure covers the relief works only; the headline adds the per-rack conversion inside the hall.*

| Cost basis | Lines |
| --- | --- |
| library default | 8 lines |

*What each price in this study rests on. The accuracy class above follows the weakest line, not the average.*

> ⚠️ 8 of 8 priced lines are library placeholders rather than quotations, which is why this estimate is stated at the accuracy class above. Each quotation obtained replaces a placeholder and tightens the whole estimate; the constraint that binds is worth quoting first.

> ⚠️ Public retrofit cost benchmarks currently span roughly 2 to 12 MEUR per MW — a four- to sixfold spread. No figure in this section should be treated as a market benchmark; they are screening estimates pending site-specific quotations.

## 10. Sensitivity

One-at-a-time sensitivity on the recommended architecture, evaluated against the relieved case rather than the hall as found. Inputs are ranked by how far each moves the answer; the ones at the top are the ones worth paying to measure.

| Input varied | Racks | Change vs base case |
| --- | --- | --- |
| Contracted power 20% lower | 48 racks (E0) | -14 racks (E0) |
| PUE 10% worse than assumed | 57 racks (E0) | -5 racks (E0) |
| Platform rack power 5% higher | 59 racks (E0) | -3 racks (E0) |
| Contracted power at full firm capacity | 63 racks (E0) | 1 racks (E0) |
| PUE 10% better than assumed | 63 racks (E0) | 1 racks (E0) |
| Per-position air capacity at 20 kW | 62 racks (E0) | 0 racks (E0) |
| Liquid capture fraction 5% lower | 62 racks (E0) | 0 racks (E0) |

## 11. Risk register

| Risk | Description | Lead time exposure |
| --- | --- | --- |
| Achievable facility water temperature | Adiabatic assist reintroduces water consumption; check permits and WUE targets. | 32 [20–48] weeks (E0) |
| Transformer capacity | Lead time, not construction, is usually the schedule driver. Applies to 2 rungs of the ladder. | 160 [80–210] weeks (E0) |
| Busway ampacity | Requires hall outage or phased de-tenanting. Applies to 5 rungs of the ladder. | 36 [24–52] weeks (E0) |
| Firm supply (grid import + behind-the-meter) | No combustion consent required; grid-code compliance and fire separation govern the programme. | 30 [19.5–40.5] weeks (E0) |
| Firm supply (grid import + behind-the-meter) | Emissions consent and fuel supply are the schedule risk, not the equipment. | 44 [28.6–59.4] weeks (E0) |
| Firm supply (grid import + behind-the-meter) | In most target metros this relief does not exist inside the decision horizon. Behind-the-meter supply is the only lever that moves this constraint. | 260 [150–520] weeks (E0) |
| Evidence base | The dominant inputs in this study are assumed rather than measured. Twelve months of hall trend data would move the headline from an estimate to a reconciled figure. | — |
| Structural | Floor loading is screened, not assessed. A structural engineer must sign off before any deployment. | — |
| Hydraulics | Pressure drop and pipe sizing are not modelled at screening level; a hydraulic model is required before design. | — |
| Tenancy | Releasing positions is a commercial and contractual exercise with revenue at risk, not an engineering one. | — |

## 12. Recommendation and decision gates

Proceed with Full DLC plus behind-the-meter supply. The same hall with on-site firm supply where the grid connection binds. The only scenario whose capacity is set by what can be built rather than by the queue. On the modelled inputs this unlocks 62 racks of NVIDIA GB300 NVL72 against 0 as found.

- Gate 1 — obtain the DSO position in writing on firm capacity and any flexibility product before committing capital. In most target metros this is the shortest path to a definitive answer and it costs nothing but time.
- Gate 2 — commission a structural assessment of the hall floor and a hydraulic model of the secondary loop. Both are cheap relative to the decision and both can invalidate it.
- Gate 3 — place long-lead orders (transformer, busway, CDU) only after Gates 1 and 2 clear; lead time, not construction, governs the programme.
- Gate 4 — instrument the hall and reconcile this model against twelve months of measured data before the second phase. That reconciliation is what moves these numbers from estimated to field-validated.

## 13. Scope, basis and limitations

This study is an engineering opinion supported by a documented model. It is not a design package and confers no design liability. The following are outside scope:

- Stamped design drawings and any deliverable requiring a professional engineering signature.
- CFD of the hall (available as a priced add-on or a later phase).
- Equipment selection, bill of materials, pricing or procurement.
- Structural sign-off — the floor-loading check here is a screening calculation only.
- Electrical protection and arc-flash studies.
- Commissioning, migration planning and tenancy/lease strategy.

Every quantity in this report carries an evidence class; Appendix A lists the assumptions and sources relied upon and the provenance digest of each headline quantity. No number here is a measurement of a physical asset unless it is labelled E5 or above — and E5 means supplied by the client (a declared rating, contract term or design value, or the client's own data as given), not measured or surveyed by us.

> ⚠️ EVIDENCE DISCLOSURE: this is a screening study built on library defaults and assumed inputs. electrical capacity is E0 where an issued deliverable requires E3; cooling performance is E0 where an issued deliverable requires E2; capex is E0 where an issued deliverable requires E1. These conclusions are not sufficient to support procurement, construction or an investment committee decision on their own; they are sufficient to decide whether to spend money finding out. The inputs listed in Appendix A.1 are what must be measured to lift them.

## 14. Model accuracy against instrumented sites

Two different things get called accuracy. The ranges shown throughout this report are input uncertainty propagated through the model — they say how much the answer moves when an input is uncertain. This section is the other one: how far this engine's outputs have been reconciled against data from instrumented sites, which is the only thing that can tell you whether the model itself is right.

> ⚠️ Model accuracy against instrumented sites has not been established: 0 reconciled observations across 0 sites, covering 0 of 5 model outputs. Every figure in this report is modelled. The uncertainty ranges shown come from input uncertainty propagated through the model, not from the difference between this engine's predictions and site data — no such difference has been recorded yet.

| Model output | State | Observations | Sites | Median bias | Last observation |
| --- | --- | --- | --- | --- | --- |
| Racks permitted by rack feed tapoff | uncalibrated | 0 | 0 | — | — |
| Racks of the target platform actually deployed | uncalibrated | 0 | 0 | — | — |
| Deployable IT load in the hall | uncalibrated | 0 | 0 | — | — |
| Weeks from go-ahead to full capacity | uncalibrated | 0 | 0 | — | — |
| Delivered capex for the works | uncalibrated | 0 | 0 | — | — |

*Bias is the median of observed / predicted, so a positive figure means the model has run conservative. An output with no observations is reported as uncalibrated rather than omitted.*

Reconciliation is how a figure in this report moves from estimated to field-validated. It requires site data we do not have and cannot generate: interval metering at the relevant point, a BMS trend, or a commissioning record. Where this study recommends instrumentation, that is what it is for — the client gets a better answer next time, and the model gets an observation it can be held to.

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
- Excludes civils and outage management.
- Tap-off units are a reported shortage item
- Placeholder until a DSO connection offer is obtained. In most FLAP-D metros this option is unavailable at any price before 2030.
- Frankfurt: no new large connections before 2030; Amsterdam queue ~10 years
- Design value from the building record, not a survey
- 12 months of half-hourly metered data
- Legacy 400 A busway; modern AI halls use 800-1000 A
- Vendor claims of 1.05-1.15 are unproven; 1.15-1.25 used for design per docs/02 §7
- Rating quoted at 5 K approach; site offers 24 K. Linear derate is a screening approximation - confirm against the manufacturer's performance curve.
- Cold plates on CPU/GPU/HBM/NVSwitch; residual air load must still be removed
- Assumes positions can be released from existing tenancy
- Legacy low-temperature plant retained for residual air load, so free-cooling benefit is largely forgone
- Placeholder. Replace with the site's actual contracted tariff.

### A.2 Sources

- Lenovo Press LP2357, GB300 NVL72, 2026 [V]
- NVIDIA NVL72 AI Factory Reference Architecture, 2026 [V]
- Vertiv, quantifying PUE when introducing liquid cooling (modelled), 2023 [V]
- Uptime Institute Global Survey, 2025

### A.3 Provenance of headline quantities

| Quantity | Evidence | Model | Digest |
| --- | --- | --- | --- |
| deployable racks as found | E0 | input@0.1 | `2251cf0df6fb` |
| deployable racks after relief measures | E0 | input@0.1 | `90db47981317` |
| deployable IT load | E0 | envelope.it_load@0.1 | `a4e3fd845acb` |
| elapsed weeks to energise the full envelope | E0 | input@0.1 | `d0aab02069a1` |
| total capex | E0 | economics.total_capex@0.1 | `deb75b48d05b` |
| racks before step 1 | E0 | input@0.1 | `57e2e78db498` |
| racks after step 1 | E0 | input@0.1 | `85b2bc621f00` |
| Higher-rated tap-off units (and busway if ampacity does not allow) for 62 racks | E0 | envelope.relief_capex@0.1 | `147ba26046e4` |
| tap-off lead time | E0 | input@0.1 | `7a5fc57ce1e4` |
| racks before step 2 | E0 | input@0.1 | `158e8bfa6770` |
| racks after step 2 | E0 | input@0.1 | `700ff34e59e2` |
| Add in-row cooling or rear-door heat exchangers for the residual air load for 62 racks | E0 | envelope.relief_capex@0.1 | `edd4d4501790` |
| in-row / RDHx lead time | E0 | input@0.1 | `fe48412ff79a` |
| racks before step 3 | E0 | input@0.1 | `97d684abc6e0` |
| racks after step 3 | E0 | input@0.1 | `d9cc107e9ef0` |
| adiabatic assist and trim chiller | E0 | input@0.1 | `af0380aad4fa` |
| lead time | E0 | input@0.1 | `3141b684dcc2` |
| cost per kW unlocked at step 3 | E0 | input@0.1 | `2429f9df92bf` |
| racks before step 4 | E0 | input@0.1 | `ec6a187a151c` |
| racks after step 4 | E0 | input@0.1 | `e5f4587dc18d` |
| transformer and switchgear replacement | E0 | input@0.1 | `b8816fd15315` |
| power transformer lead time | E0 | input@0.1 | `010015f8a59e` |
| racks before step 5 | E0 | input@0.1 | `fee83603c8b2` |
| racks after step 5 | E0 | input@0.1 | `9fa15f724191` |
| UPS module addition capex | E0 | power.ups_relief_capex@0.1 | `1423200e04d9` |
| UPS lead time | E0 | input@0.1 | `843c6ad78c29` |
| cost per kW unlocked at step 5 | E0 | input@0.1 | `829a9d9356bc` |
| racks before step 6 | E0 | input@0.1 | `ad285ced026e` |
| racks after step 6 | E0 | input@0.1 | `77feda0334a7` |
| busway replacement for one hall | E0 | input@0.1 | `74129e356449` |
| busway and tap-off lead time | E0 | input@0.1 | `74ff17170551` |
| cost per kW unlocked at step 6 | E0 | input@0.1 | `338dcc79c4e4` |
| racks before step 7 | E0 | input@0.1 | `f40dcd6f1aa0` |
| racks after step 7 | E0 | input@0.1 | `d1074967c022` |
| additional row CDU, installed | E0 | input@0.1 | `e2a2ad42d89f` |
| CDU lead time | E0 | input@0.1 | `77ae364db11a` |
| cost per kW unlocked at step 7 | E0 | input@0.1 | `628ad8c40217` |
| racks before step 8 | E0 | input@0.1 | `3387af96d966` |
| racks after step 8 | E0 | input@0.1 | `cb2676ac8d5d` |
| UPS module addition capex | E0 | power.ups_relief_capex@0.1 | `1423200e04d9` |
| UPS lead time | E0 | input@0.1 | `843c6ad78c29` |
| cost per kW unlocked at step 8 | E0 | input@0.1 | `8f918f41cfe3` |
| racks before step 9 | E0 | input@0.1 | `16a2bb6299a8` |
| racks after step 9 | E0 | input@0.1 | `960dbf5dd25c` |
| BESS-2MW-8MWh installed capex | E0 | power.btm_capex@0.1 | `6d5723d85dba` |
| BESS-2MW-8MWh lead time | E0 | input@0.1 | `6b920c9df84d` |
| cost per kW unlocked at step 9 | E0 | input@0.1 | `1e2d4014ffb6` |
| racks before step 10 | E0 | input@0.1 | `de69563717d8` |
| racks after step 10 | E0 | input@0.1 | `fbdcf5cb2f3f` |
| busway replacement for one hall | E0 | input@0.1 | `74129e356449` |
| busway and tap-off lead time | E0 | input@0.1 | `74ff17170551` |
| cost per kW unlocked at step 10 | E0 | input@0.1 | `5968e91375ca` |
| racks before step 11 | E0 | input@0.1 | `a8109f1916d5` |
| racks after step 11 | E0 | input@0.1 | `519c3c15d3dd` |
| additional row CDU, installed | E0 | input@0.1 | `e2a2ad42d89f` |
| CDU lead time | E0 | input@0.1 | `77ae364db11a` |
| cost per kW unlocked at step 11 | E0 | input@0.1 | `a0505c39fe74` |
| racks before step 12 | E0 | input@0.1 | `78e4bb9838e6` |
| racks after step 12 | E0 | input@0.1 | `0c680a5c5b56` |
| GEN-5MW installed capex | E0 | power.btm_capex@0.1 | `1be583b10fb5` |
| GEN-5MW lead time | E0 | input@0.1 | `481a422b0494` |
| cost per kW unlocked at step 12 | E0 | input@0.1 | `1ab1faf58c6a` |
| racks before step 13 | E0 | input@0.1 | `a4ddfec8e8bd` |
| racks after step 13 | E0 | input@0.1 | `2209fe0bf7d0` |
| busway replacement for one hall | E0 | input@0.1 | `74129e356449` |
| busway and tap-off lead time | E0 | input@0.1 | `74ff17170551` |
| cost per kW unlocked at step 13 | E0 | input@0.1 | `eee5feb9ead9` |
| racks before step 14 | E0 | input@0.1 | `68af5e73ee6b` |
| racks after step 14 | E0 | input@0.1 | `165631b4129f` |
| transformer and switchgear replacement | E0 | input@0.1 | `b8816fd15315` |
| power transformer lead time | E0 | input@0.1 | `010015f8a59e` |
| cost per kW unlocked at step 14 | E0 | input@0.1 | `d0dffe923585` |
| racks before step 15 | E0 | input@0.1 | `af265f35b839` |
| racks after step 15 | E0 | input@0.1 | `e22ce0c897d7` |
| UPS module addition capex | E0 | power.ups_relief_capex@0.1 | `1423200e04d9` |
| UPS lead time | E0 | input@0.1 | `843c6ad78c29` |
| cost per kW unlocked at step 15 | E0 | input@0.1 | `31fa46fb8fba` |
| racks before step 16 | E0 | input@0.1 | `74a2f3ac10bf` |
| racks after step 16 | E0 | input@0.1 | `df141571107d` |
| additional row CDU, installed | E0 | input@0.1 | `e2a2ad42d89f` |
| CDU lead time | E0 | input@0.1 | `77ae364db11a` |
| cost per kW unlocked at step 16 | E0 | input@0.1 | `f67577db3fdd` |
| racks before step 17 | E0 | input@0.1 | `fd92b7157817` |
| racks after step 17 | E0 | input@0.1 | `b1dbf0553bee` |
| busway replacement for one hall | E0 | input@0.1 | `74129e356449` |
| busway and tap-off lead time | E0 | input@0.1 | `74ff17170551` |
| cost per kW unlocked at step 17 | E0 | input@0.1 | `2be504be40dc` |
| racks before step 18 | E0 | input@0.1 | `284dc52db335` |
| racks after step 18 | E0 | input@0.1 | `2634a2d87285` |
| busway replacement for one hall | E0 | input@0.1 | `74129e356449` |
| busway and tap-off lead time | E0 | input@0.1 | `74ff17170551` |
| racks before step 19 | E0 | input@0.1 | `3f9ddadacb88` |
| racks after step 19 | E0 | input@0.1 | `21b37f3b00d9` |
| additional row CDU, installed | E0 | input@0.1 | `e2a2ad42d89f` |
| CDU lead time | E0 | input@0.1 | `77ae364db11a` |
| cost per kW unlocked at step 19 | E0 | input@0.1 | `d9490469db4e` |
| racks before step 20 | E0 | input@0.1 | `25b83a93faec` |
| racks after step 20 | E0 | input@0.1 | `b6813b6b8083` |
| UPS module addition capex | E0 | power.ups_relief_capex@0.1 | `1423200e04d9` |
| UPS lead time | E0 | input@0.1 | `843c6ad78c29` |
| cost per kW unlocked at step 20 | E0 | input@0.1 | `32589fd051c3` |
| racks before step 21 | E0 | input@0.1 | `24f076aba591` |
| racks after step 21 | E0 | input@0.1 | `083abc3511b5` |
| grid reinforcement capex | E0 | input@0.1 | `f5f7e0079a68` |
| grid reinforcement lead time | E0 | input@0.1 | `47721a918c66` |
| capex of relief measures taken along the headroom ladder | E0 | economics.relief_capex@0.1 | `ba6364f31cf6` |
| longest relief lead time on the path | E0 | input@0.1 | `505fa5f7a1d4` |
| elapsed at 8 racks | E0 | input@0.1 | `de5547aa0005` |
| racks energised at week 32 | E0 | input@0.1 | `8af3af83e35b` |
| elapsed at 12 racks | E0 | input@0.1 | `383dd97ad586` |
| racks energised at week 160 | E0 | input@0.1 | `6b7f40267215` |
| elapsed at 22 racks | E0 | input@0.1 | `ad779bcadf66` |
| racks energised at week 160 | E0 | input@0.1 | `6b7f40267215` |
| elapsed at 25 racks | E0 | input@0.1 | `9439e9463b2e` |
| racks energised at week 160 | E0 | input@0.1 | `6b7f40267215` |
| elapsed at 28 racks | E0 | input@0.1 | `9665f0a2280d` |
| racks energised at week 160 | E0 | input@0.1 | `6b7f40267215` |
| elapsed at 31 racks | E0 | input@0.1 | `4153e0045c8b` |
| racks energised at week 160 | E0 | input@0.1 | `6b7f40267215` |
| elapsed at 33 racks | E0 | input@0.1 | `e4f25ae43d0e` |
| racks energised at week 160 | E0 | input@0.1 | `6b7f40267215` |
| elapsed at 34 racks | E0 | input@0.1 | `e413af818eac` |
| racks energised at week 160 | E0 | input@0.1 | `6b7f40267215` |
| elapsed at 39 racks | E0 | input@0.1 | `f9cd10496cdc` |
| racks energised at week 160 | E0 | input@0.1 | `6b7f40267215` |
| elapsed at 40 racks | E0 | input@0.1 | `49d2236f51bd` |
| racks energised at week 160 | E0 | input@0.1 | `6b7f40267215` |
| elapsed at 43 racks | E0 | input@0.1 | `24ba0011ed58` |
| racks energised at week 160 | E0 | input@0.1 | `6b7f40267215` |
| elapsed at 44 racks | E0 | input@0.1 | `cddac00fae3f` |
| racks energised at week 160 | E0 | input@0.1 | `6b7f40267215` |
| elapsed at 47 racks | E0 | input@0.1 | `ed70ce380373` |
| racks energised at week 160 | E0 | input@0.1 | `6b7f40267215` |
| elapsed at 55 racks | E0 | input@0.1 | `70b008bb79b9` |
| racks energised at week 160 | E0 | input@0.1 | `6b7f40267215` |
| elapsed at 61 racks | E0 | input@0.1 | `ae1de8ef84ce` |
| racks energised at week 160 | E0 | input@0.1 | `6b7f40267215` |
| elapsed at 62 racks | E0 | input@0.1 | `624861550c6c` |
| racks energised at week 160 | E0 | input@0.1 | `6b7f40267215` |
| retained_air: racks after ladder | E0 | input@0.1 | `c9d9dbe18f92` |
| rdhx: racks after ladder | E0 | input@0.1 | `10d77c74a6ae` |
| hybrid_dlc: racks after ladder | E0 | input@0.1 | `cc55e0a89bc3` |
| hybrid_dlc: weeks to full capacity | E0 | input@0.1 | `6407c94095d9` |
| full_dlc: racks after ladder | E0 | input@0.1 | `bcaf71527669` |
| full_dlc: weeks to full capacity | E0 | input@0.1 | `2fe03c190ef9` |
| full_dlc_btm: racks after ladder | E0 | input@0.1 | `2d259c82f5e9` |
| full_dlc_btm: weeks to full capacity | E0 | input@0.1 | `f1c9d982adec` |
| installed rack positions | E3 | input@0.1 | `67bea46c790d` |
| positions available for redeployment | E3 | input@0.1 | `c7ed0c853ebf` |
| hall design density per rack | E5 | input@0.1 | `d8eb3acbba02` |
| hall net white space | E5 | input@0.1 | `f3528504b5a3` |
| hall design floor loading | E5 | input@0.1 | `ad256b73d58a` |
| clear height | E5 | input@0.1 | `cf6bc40ec84a` |
| summer design dry-bulb | E3 | input@0.1 | `7312d718f36d` |
| firm connection capacity | E5 | input@0.1 | `12bfb67ec92b` |
| contracted capacity | E5 | input@0.1 | `cebe404ab198` |
| current site peak demand | E5 | input@0.1 | `f3099d912f28` |
| current protected IT load | E5 | input@0.1 | `20c4f264d7da` |
| installed busway ampacity | E5 | input@0.1 | `0de2f4c2f72e` |
| installed tap-off rating | E5 | input@0.1 | `97fcd8433c84` |
| chilled-water plant capacity | E5 | input@0.1 | `cedbd39b6085` |
| available pumped flow | E3 | input@0.1 | `7ebcc1ab3857` |
| Rack feed / tap-off rating: gate fails | E0 | input@0.1 | `4aa8886b8226` |
| (transformer headroom available for new IT load / GB300 NVL72 rack TDP) (floored to whole racks) | E0 | constraints.floor_racks@0.1 | `edb30cfae0fa` |
| (UPS headroom for new IT load / GB300 NVL72 rack TDP) (floored to whole racks) | E0 | constraints.floor_racks@0.1 | `c8e62be34b0a` |
| (total usable busway capacity in hall / GB300 NVL72 rack TDP) (floored to whole racks) | E0 | constraints.floor_racks@0.1 | `bf7b469cd3d1` |
| (firm supply headroom available for new IT load / GB300 NVL72 rack TDP) (floored to whole racks) | E0 | constraints.floor_racks@0.1 | `0fecb91fef87` |
| Residual air load removal per rack: gate fails | E0 | input@0.1 | `26165e87d919` |
| Achievable facility water temperature: gate fails | E0 | input@0.1 | `220f8c8a7543` |
| (CDU-ROW-assumed usable capacity at site conditions / gb300_nvl72 liquid load per rack) (floored to whole racks) | E0 | constraints.floor_racks@0.1 | `25573ad8fd4c` |
| racks permitted by available pumped flow (floored to whole racks) | E0 | constraints.floor_racks@0.1 | `a0c7fccb5cd0` |
| (chilled-water plant headroom / gb300_nvl72 residual air load per rack) (floored to whole racks) | E0 | constraints.floor_racks@0.1 | `2a32802480d0` |
| rack positions available in hall (floored to whole racks) | E3 | constraints.floor_racks@0.1 | `659e992bdc64` |
| PUE, retained air architecture | E0 | input@0.1 | `9f96820c74f4` |
| retained_air: racks as found | E0 | input@0.1 | `8471d3c25f5c` |
| retained_air: racks after ladder | E0 | input@0.1 | `c9d9dbe18f92` |
| PUE, rear-door heat exchanger architecture | E0 | input@0.1 | `9cd90386fca6` |
| rdhx: racks as found | E0 | input@0.1 | `77908b548fb2` |
| rdhx: racks after ladder | E0 | input@0.1 | `10d77c74a6ae` |
| PUE, hybrid DLC on legacy plant | E0 | input@0.1 | `9c10874a8f81` |
| hybrid_dlc: racks as found | E0 | input@0.1 | `1011ee0e8e06` |
| hybrid_dlc: racks after ladder | E0 | input@0.1 | `cc55e0a89bc3` |
| PUE, full DLC with high-temperature loop | E0 | input@0.1 | `37e16e4a98d9` |
| full_dlc: racks as found | E0 | input@0.1 | `079192290378` |
| full_dlc: racks after ladder | E0 | input@0.1 | `bcaf71527669` |
| PUE, full DLC with high-temperature loop | E0 | input@0.1 | `37e16e4a98d9` |
| full_dlc_btm: racks as found | E0 | input@0.1 | `980324e921db` |
| full_dlc_btm: racks after ladder | E0 | input@0.1 | `2d259c82f5e9` |
| retained_air: racks unlocked | E0 | input@0.1 | `2e4138fcac55` |
| rdhx: racks unlocked | E0 | input@0.1 | `e9952b43b4be` |
| hybrid_dlc: racks unlocked | E0 | input@0.1 | `8eba1a207998` |
| total capex | E0 | economics.total_capex@0.1 | `07d48b0ef41b` |
| hybrid_dlc: capex per rack enabled | E0 | economics.capex_per_rack@0.1 | `c7afdff35fca` |
| annual energy cost | E0 | economics.energy_cost@0.1 | `f5f775cde4f8` |
| energy cost per GPU-hour | E0 | economics.energy_per_gpu_hour@0.1 | `8e1e0844ef3b` |
| hybrid_dlc: critical path | E0 | input@0.1 | `fd4bb27c96c2` |
| full_dlc: racks unlocked | E0 | input@0.1 | `8887e6b75586` |
| total capex | E0 | economics.total_capex@0.1 | `ccf1b3a39e01` |
| full_dlc: capex per rack enabled | E0 | economics.capex_per_rack@0.1 | `7fac320b3d61` |
| annual energy cost | E0 | economics.energy_cost@0.1 | `ec9363fe2c9c` |
| energy cost per GPU-hour | E0 | economics.energy_per_gpu_hour@0.1 | `45f8b23cee89` |
| full_dlc: critical path | E0 | input@0.1 | `e150e1d1a44b` |
| full_dlc_btm: racks unlocked | E0 | input@0.1 | `7d7b81a69f10` |
| total capex | E0 | economics.total_capex@0.1 | `deb75b48d05b` |
| full_dlc_btm: capex per rack enabled | E0 | economics.capex_per_rack@0.1 | `f037eeced423` |
| annual energy cost | E0 | economics.energy_cost@0.1 | `ec9363fe2c9c` |
| energy cost per GPU-hour | E0 | economics.energy_per_gpu_hour@0.1 | `45f8b23cee89` |
| full_dlc_btm: critical path | E0 | input@0.1 | `1bfd8e2425a5` |
| full_dlc_btm: racks under max_compute | E0 | input@0.1 | `03622d66b673` |
| full_dlc: racks under min_cost | E0 | input@0.1 | `4a678bdcfdb2` |
| full_dlc_btm: racks under fastest | E0 | input@0.1 | `11903e200727` |
| capex of relief measures taken along the headroom ladder | E0 | economics.relief_capex@0.1 | `ba6364f31cf6` |
| in-hall conversion capex | E0 | economics.conversion_capex@0.1 | `31aac42971b6` |
| total capex | E0 | economics.total_capex@0.1 | `deb75b48d05b` |
| racks under: Contracted power 20% lower | E0 | input@0.1 | `869b37a4a341` |
| delta under: Contracted power 20% lower | E0 | input@0.1 | `65f882b76c13` |
| racks under: PUE 10% worse than assumed | E0 | input@0.1 | `43065380960f` |
| delta under: PUE 10% worse than assumed | E0 | input@0.1 | `8bd7a84fd489` |
| racks under: Platform rack power 5% higher | E0 | input@0.1 | `1c4b952ff282` |
| delta under: Platform rack power 5% higher | E0 | input@0.1 | `765a68517e43` |
| racks under: Contracted power at full firm capacity | E0 | input@0.1 | `853b07183efd` |
| delta under: Contracted power at full firm capacity | E0 | input@0.1 | `9bcc976d41f2` |
| racks under: PUE 10% better than assumed | E0 | input@0.1 | `0116a41b8998` |
| delta under: PUE 10% better than assumed | E0 | input@0.1 | `fbe558725f7e` |
| racks under: Per-position air capacity at 20 kW | E0 | input@0.1 | `01e03cd90e75` |
| delta under: Per-position air capacity at 20 kW | E0 | input@0.1 | `dd3f45be83c3` |
| racks under: Liquid capture fraction 5% lower | E0 | input@0.1 | `29d531906239` |
| delta under: Liquid capture fraction 5% lower | E0 | input@0.1 | `5626cc77bcc2` |
| lead time | E0 | input@0.1 | `3141b684dcc2` |
| power transformer lead time | E0 | input@0.1 | `010015f8a59e` |
| busway and tap-off lead time | E0 | input@0.1 | `74ff17170551` |
| BESS-2MW-8MWh lead time | E0 | input@0.1 | `6b920c9df84d` |
| GEN-5MW lead time | E0 | input@0.1 | `481a422b0494` |
| grid reinforcement lead time | E0 | input@0.1 | `47721a918c66` |

---

Engineering opinion supported by a documented model. Not a design package. Professional indemnity and named-signatory arrangements govern reliance on this report.

Generated 2026-09-14 by the GridForge-AI envelope engine.
