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

**Modelled lead time:** 36 [24–52] weeks (E0)

*Limited by: What the capacity model assumed. A response that differs materially moves the energisation date.*

> ⚠️ EVIDENCE DISCLOSURE: the duties in section 3 are derived from a capacity model built partly on library defaults and assumed inputs, not on a measured survey of this hall. The claim kinds still below the evidence required for an issued deliverable are: capex, cooling performance, electrical capacity. These duties are sufficient to obtain comparable, competent quotations and to see which supplier moves the energisation date. They are NOT sufficient on their own to raise a purchase order for long-lead plant: confirm the governing figures against site measurement first. The study's evidence appendix names exactly which ones those are.

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

*Limited by: 62 racks at 135 [132–142] kW (E0) over 8 run(s) at 400 V (E5), three phase, power factor 0.95, derated to the site's 0.8 (E5) continuous limit. Installed: 400 A (E5).*

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
- Quote duties at the site conditions stated, not at a reference condition. A duty at a reference condition is not a response to this document.
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
| E5 | measured at site (customer data) |
| E6 | field-validated |
| E7 | observed in operation |

### A.1 Assumptions relied upon

- Library default, not a price. Replace with a quotation before this figure supports a capital decision.
- Tap-off units are a reported shortage item

### A.2 Sources


### A.3 Provenance of headline quantities

| Quantity | Evidence | Model | Digest |
| --- | --- | --- | --- |
| busway replacement for one hall | E0 | input@0.1 | `74129e356449` |
| busway and tap-off lead time | E0 | input@0.1 | `74ff17170551` |
| required busway ampacity per run | E3 | spec.busway_ampacity@0.1 | `584d4571c5b5` |
| required busway ampacity per run | E3 | spec.busway_ampacity@0.1 | `584d4571c5b5` |

---

Issued by GridForge AI on behalf of the client. We specify duty and interfaces only. We name no make or model, quote no equipment and take no margin on hardware.

Generated 2026-09-14 by the GridForge-AI envelope engine.
