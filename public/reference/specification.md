# Technical Specification — Replace busway with 800-1000 A and new tap-off units

*Reference Project (synthetic) · hall DH-02 · issued 2026-09-14 · ref REF-TND-01*

> **Duties in this document are derived from a capacity model of this hall. They are modelled values, not measurements of installed plant, and each one names the constraint it came from.**

## 1. Purpose

This package procures the works required to relieve Busway ampacity in hall DH-02. In the capacity model for this hall that constraint is what limits deployable rack count; relieving it moves the hall from 12 to 22 racks, and it is part of a programme that reaches 62 racks in total.

Duties in section 3 are sized for the end state of 62 racks of NVIDIA GB300 NVL72 — the hall this relief is part of delivering — not for the 10 rack(s) this single step unlocks on its own. Nobody buys plant for a marginal rack.

In the capacity model this step moves the hall from 12 to 22 racks; the full ladder reaches 62.

Every numeric requirement is derived from the capacity model and names the constraint it came from. Nothing here specifies a make or a model: we state the duty and the interfaces, the supplier proposes the equipment, and we take no margin on it.

The budget figure is our modelled estimate, not a price. It is stated so the client can see whether a response is in the right universe, and it carries its own evidence class.

**Modelled budget for this relief:** 450,000 [225,000–900,000] EUR (E0)

*Limited by: Our estimate, not a price. Stated so a response that is in the wrong universe is visible immediately.*

**Modelled lead time (assumed lead time, not a date):** 36 [24–52] weeks (E0)

*Limited by: assumed lead time, not a date (E0): what the capacity model assumed, not a quotation or a commitment. A response that differs materially moves the energisation date.*

> ⚠️ EVIDENCE DISCLOSURE: the duties in section 3 are derived from a capacity model built partly on library defaults and assumed inputs, not on a measured survey of this hall. The claim kinds still below the evidence required for an issued deliverable are: capex, cooling performance, electrical capacity, schedule (lead times). These duties are sufficient to obtain comparable, competent quotations and to see which supplier moves the energisation date. They are NOT sufficient on their own to raise a purchase order for long-lead plant: confirm the governing figures against site measurement first. The study's evidence appendix names exactly which ones those are.

## 2. Scope of supply

Included in this package:

- Supply — Equipment meeting the duty specified in section 3.
- Delivery — Delivered to site, offloaded, positioned.
- Installation and commissioning — Installation in a live hall, commissioning and witnessed testing.
- Documentation — Test certificates, selection outputs at site conditions, O&M.

Explicitly excluded. Listed rather than omitted, because an unstated exclusion is a gap somebody discovers on site:

- Structural sign-off — Any structural strengthening arising from the works is by others.
- Protection and arc-flash studies — Provided by the client's electrical engineer.
- Migration and tenancy — Moving or decanting existing tenants is outside this package.

## 2A. Site conditions and assumptions

Every duty in section 3 is quoted at these site conditions. Each numeric requirement in section 3 is derived from the constraint named in its 'From constraint' column, and these conditions are the model inputs those constraints used. A condition the client did not supply is printed as 'not supplied: assumed ...' with its evidence class; it is not a measurement and is not silently defaulted. A responder who has better data for any line shall say so in the response.

| Ref | Condition | Value | Status | Basis |
| --- | --- | --- | --- | --- |
| SC-01 | Design ambient dry bulb (summer) | 34 degC (E3) | supplied | supplied by the client (not measured or surveyed by us) |
| SC-02 | Design ambient wet bulb (summer) | 21 degC (E5) | supplied | supplied by the client (not measured or surveyed by us) |
| SC-03 | Facility-water supply temperature (existing plant) | 6 degC (E5) | supplied | supplied by the client (not measured or surveyed by us) |
| SC-04 | Technology-loop (TCS) supply target | 30 [27–32] degC (E0) | assumed | not supplied: assumed 30 degC (E0) |
| SC-05 | Site altitude | not modelled | not modelled | not supplied: the capacity model has no altitude input, so no altitude derating of air-cooled plant, motors or electrical equipment has been applied to any duty. Responders shall quote at the site altitude the client confirms and state it. |
| SC-06 | LV distribution voltage | 400 V (E5) | supplied | supplied by the client (not measured or surveyed by us) · 3-phase |
| SC-07 | Supply frequency | not modelled | not modelled | not supplied: the capacity model has no frequency input. Responders shall state the frequency they have assumed for the equipment quoted. |
| SC-08 | Site power factor | 0.97 (E3) | supplied | supplied by the client (not measured or surveyed by us) |
| SC-09 | Rack power basis: NVIDIA GB300 NVL72 | 135 [132–142] kW (E0) | library | per-rack total TDP from the platform library, used for every electrical and thermal duty (utilisation is not applied to a duty) |
| SC-10 | Liquid heat-capture fraction: NVIDIA GB300 NVL72 | 0.9 [0.85–0.92] (E0) | library | platform library figure; the remainder is residual air load per rack |
| SC-11 | Redundancy, transformer bank TX-A/B | N+1 on 3 units | supplied | supplied by the client |
| SC-12 | Redundancy, UPS bank UPS-1 | N+1 on 6 units | supplied | supplied by the client |

*Values carry their unit and evidence class (E0 assumed ... E7 observed). 'library' is a platform figure; 'not modelled' means the engine has no input for the condition and has applied no derating for it.*

Inputs to the capacity model that were assumed rather than supplied (each is an assumption at evidence class E0 unless it states otherwise):

- BESS-2MW-8MWh battery energy rating (btm_options[BESS-2MW-8MWh].energy_MWh; MWh): not supplied: assumed your firm factor 0.5 accepted as declared, unchecked against the battery's energy (E0)
- GEN-5MW unit count and redundancy (btm_options[GEN-5MW].units; units): not supplied: assumed credited at nameplate x firm factor, as if no unit could be out of service (E0)
- Installed CDU schedule (thermal.cdus): not supplied: assumed nothing: no value was assumed in its place and the constraint it feeds is not assessed (E0)
- TCS target supply temperature (thermal.tcs_target_supply_C; degC): not supplied: assumed 30 [27–32] degC (E0)
- Rear-door heat exchanger capacity per rack (thermal.rdhx.capacity_kW_per_rack; kW): not supplied: assumed 60 [20–80] kW (E0)
- All-in grid electricity price (economics.electricity_eur_per_MWh; EUR/MWh): not supplied: assumed library placeholder of 140 EUR/MWh (E0)
- Discount rate (economics.discount_rate): not supplied: assumed no value (none: the lifecycle value is undiscounted) (E0)

## 3. Technical requirements

Obligation words carry their usual tender meaning: shall — non-compliance disqualifies the response; should — scored, not disqualifying; may — stated for context.

| Ref | Clause | Obl. | Value | From constraint |
| --- | --- | --- | --- | --- |
| E-10 | Busway continuous ampacity | shall | 1,990 A (E3) | busway_ampacity |
| E-11 | Phasing and outage | shall | — | busway_ampacity |
| E-12 | Tap-off provision | shall | — | busway_ampacity |
| C-01 | Price basis | shall | — | commercial |
| C-02 | Validity | shall | — | commercial |
| C-03 | Response schedule | shall | — | commercial |

*Every numeric requirement names the constraint it was derived from. A requirement nobody can trace back to a physical limit is one somebody invented.*

**E-10 — Busway continuous ampacity** (shall). Each busway run shall have a continuous ampacity not less than the figure stated, at the hall's design ambient and installed configuration.

**Required:** 1,990 A (E3)

*Limited by: 62 racks at 135 [132–142] kW (E0) over 8 run(s) at 400 V (E5), three phase, power factor 0.95, derated to the site's 0.8 (E3) continuous limit. Installed: 400 A (E5).*

*Verification:* Type test certificate to the applicable standard, with derating basis stated.

**E-11 — Phasing and outage** (shall). The programme shall allow replacement run by run with the hall in service. The response shall state the outage window per run.

*Basis:* Live tenancy in the hall during the works.

*Verification:* Method statement and programme.

**E-12 — Tap-off provision** (shall). Busway shall accept tap-off units at the density required by the rack pitch stated in the response schedule.

*Basis:* Hall aisle configuration; 62 positions to be fed.

*Verification:* Layout drawing.

**C-01 — Price basis** (shall). Prices shall be delivered and installed, excluding VAT, in EUR, with exclusions listed separately.

*Basis:* Comparability. Four quotations on four bases cannot be evaluated.

*Verification:* Completed response schedule.

**C-02 — Validity** (shall). Prices shall remain valid for not less than 60 days.

*Basis:* The evaluation and approval cycle on a capital item of this size.

*Verification:* Stated on the quotation.

**C-03 — Response schedule** (shall). The response schedule in section 6 shall be returned completed. An incomplete schedule will not be evaluated.

*Basis:* Every figure in it feeds a comparison the client can check. A bid that answers a different question cannot be compared with one that answers this one.

*Verification:* Returned document.

## 4. How responses will be evaluated

Price is one criterion of five. The item being bought exists to unlock compute on a date: a response that is cheaper and materially slower is the expensive one, and the weighting says so.

| Ref | Criterion | Weight | What moves it |
| --- | --- | --- | --- |
| C1 | Compliance with the mandatory duty | 35% | Every 'shall' requirement met, at the site conditions stated. A duty quoted at a reference condition rather than at ours scores nothing. |
| C2 | Delivered programme | 30% | Weeks to site and to energisation, and which long-lead item governs. Assessed against what the item does to the energisation date. |
| C3 | Price | 20% | Delivered capex, and price per kW actually unlocked rather than price per unit of equipment. |
| C4 | Installation in a live hall | 10% | Outage duration per run or per unit, and the method statement. |
| C5 | Evidence quality | 5% | Test certificates and selection outputs at our conditions, rather than datasheets at reference conditions. |

*Weights total 100.*

> ℹ️ A response that does not meet every 'shall' requirement is not ranked above one that does, whatever its price. That ordering is the entire point of a mandatory requirement.

## 5. Instructions to responders

- Return the response schedule in section 6, completed. An incomplete schedule is not evaluated.
- State compliance against every requirement in section 3 as C (compliant), CD (complies with deviation, deviation described) or N (non-compliant).
- Quote duties at the site conditions stated in section 2A, not at a reference condition. A duty at a reference condition is not a response to this document.
- List exclusions explicitly and price them separately where you can.
- State which long-lead component governs your delivery date.

## 6. Response schedule

Return these figures in these units. They feed a comparison the client can check line by line, which is only possible if every response answers the same question.

| Field | Unit | Required | Note |
| --- | --- | --- | --- |
| Delivered price, excluding VAT | EUR | yes | Delivered and installed. State exclusions separately. |
| Weeks from order to delivered on site | weeks | yes |  |
| Weeks from delivery to energised | weeks | no |  |
| Outage required per unit or per run | hours | no |  |
| Duty achieved at the site conditions stated | kW or A | no | At OUR conditions. A figure at a reference condition is not a bid. |
| Price validity | days | no |  |

*Machine-readable template: `gridforge spec … --template` writes a JSON file with these keys, which `gridforge bids` reads back.*

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

- Placeholder re-expressed per run from the earlier 450 kEUR lump for the reference hall's 8 runs. Not a market price.
- Library default, not a price. Replace with a quotation before this figure supports a capital decision.
- Tap-off units are a reported shortage item
- Legacy low-temperature plant
- Operators specify 27-30 degC for 500-700 W parts; the W45 equipment rating is not an operating point
- Cold plates on CPU/GPU/HBM/NVSwitch; residual air load must still be removed

### A.2 Sources

- DCD, hot water cold water, 2024
- Lenovo Press LP2357, GB300 NVL72, 2026 [V]
- NVIDIA NVL72 AI Factory Reference Architecture, 2026 [V]

### A.3 Provenance of headline quantities

| Quantity | Evidence | Model | Digest |
| --- | --- | --- | --- |
| busway and tap-off works, per run | E0 | costs.scaled_relief@0.1 | `8bca5c542732` |
| busway and tap-off lead time | E0 | input@0.1 | `74ff17170551` |
| summer design dry-bulb | E3 | input@0.1 | `7312d718f36d` |
| summer design wet-bulb | E5 | input@0.1 | `95eb471b48b2` |
| plant chilled-water supply temperature | E5 | input@0.1 | `782cb160ee30` |
| TCS supply temperature design point | E0 | input@0.1 | `1dc1aaf81e33` |
| LV distribution voltage | E5 | input@0.1 | `064883d0ef56` |
| site power factor | E3 | input@0.1 | `9083b4d7b27e` |
| GB300 NVL72 rack TDP | E0 | input@0.1 | `e6476e7cd728` |
| GB300 NVL72 liquid heat capture fraction | E0 | input@0.1 | `e205b1f86e3c` |
| required busway ampacity per run | E3 | spec.busway_ampacity@0.1 | `584d4571c5b5` |
| required busway ampacity per run | E3 | spec.busway_ampacity@0.1 | `584d4571c5b5` |

---

Issued by GridForge AI on behalf of the client. We specify duty and interfaces only. We name no make or model, quote no equipment and take no margin on hardware.

Generated 2026-09-14 by the GridForge-AI envelope engine.
