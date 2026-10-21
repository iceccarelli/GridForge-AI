# Proposal — Density Screen, Reference Colocation Campus hall DH-02

*Reference Project (synthetic) · prepared 2026-09-14 · valid to 2026-10-14 · target platform NVIDIA GB300 NVL72*

> **The findings below are a screening read produced before this engagement begins. They are modelled from the inputs supplied, not measured at the site.**

## 1. What we already found

We ran your hall through the capacity engine before writing this. The following is not a claim about what we might do; it is what the constraint set already says, on the inputs you supplied.

**Deployable NVIDIA GB300 NVL72 racks as the hall stands:** 0 racks (E0)

*Limited by: platform needs 205 [174–236] A (E0) per rack; installed tap-offs rated 63 A (E5)*

**Deployable after the costed ladder:** 62 racks (E0)

*Limited by: Full DLC plus behind-the-meter supply*

**Time to full capacity:** 160 [80–210] weeks (E0)

*Limited by: assumed lead time, not a date (E0) · set by transformer capacity*

> ➡️ Binding constraint: Rack feed / tap-off rating (electrical). platform needs 205 [174–236] A (E0) per rack; installed tap-offs rated 63 A (E5).

> ⚠️ On these inputs the hall cannot host a single rack of the target platform today. That is a finding, not a sales problem — and a credible 'not without these three things' is worth the fee on its own.

## 2. What this engagement answers

What stops this hall first, and how far can it go?

You receive: Density Screen document (HTML and Markdown), the first six rungs of the headroom ladder, and a data request you can hand your own engineers verbatim.

- The binding constraint as the hall stands, with the basis stated in engineering units.
- Deployable racks of your target platform, as found and after the costed ladder.
- The item that sets the date.
- Every cooling architecture screened against the same constraint set.
- The list of inputs still assumed, each with why it binds and where to get it.

## 3. What we need from you

Intake is 83% complete. Each row below is a number that moves the answer and that nobody has measured. Anything you cannot supply is filled from a library default and named as an assumption in the deliverable — nothing is invented silently.

| Input | Status | Assumed if not supplied | Where it comes from |
| --- | --- | --- | --- |
| Installed CDU schedule | optional | [] | CDU nameplates and the mechanical single-line diagram. |
| TCS target supply temperature | optional | 30 [27–32] degC (E0) | The platform vendor's reference design for the target rack. |
| Rear-door heat exchanger capacity per rack | optional | 60 [20–80] kW (E0) | The selected rear-door unit's datasheet at the site's water temperature and airflow. |
| All-in grid electricity price | optional | library placeholder of 140 EUR/MWh (E0) | The supply contract, or 12 months of invoices divided by metered energy. |
| Discount rate | optional | none: the lifecycle value is undiscounted | The client's hurdle rate. |

## 4. Fee, timing and terms

| Item | Terms |
| --- | --- |
| Fee | EUR 4,500, fixed |
| Turnaround | 5 working days from a complete intake |
| Payment | 100% on commissioning. The engagement opens when payment clears. |
| Credit | Credits in full against the envelope study. |
| Validity | This proposal is valid to 2026-10-14. |
| Independence | We quote no equipment and take no margin on hardware. Nothing in the deliverable routes you to a supplier we are paid by. |

*Fixed fee. We do not bill hours, because you are buying an answer.*

**Fee:** 4,500 EUR (E3)

*Limited by: 5 working days from a complete intake*

## 5. What is outside scope

This is an engineering opinion supported by a documented model. It is not a design package and confers no design liability. Specifically outside scope:

- Stamped design drawings, or any deliverable requiring a professional engineering signature.
- CFD of the hall — available as a priced add-on or a later phase.
- Equipment selection, bill of materials, pricing or procurement. We quote no equipment and take no margin on hardware.
- Structural sign-off. Our floor-loading check is a screening calculation only.
- Electrical protection and arc-flash studies.
- Commissioning, migration planning and tenancy strategy.

## 6. How the answer is produced

- Thirteen independent constraints across electrical, thermal and physical domains are evaluated over one model of your hall. The envelope is the minimum; the binding constraint is the one that produced it.
- Each constraint reports what relieves it, what that costs and how long it takes, so the answer is an ordered ladder rather than a single number.
- Every quantity carries an evidence class. A number you supply is your measured data; a number we fall back to is an assumption and is labelled as one. A model applied to measured data stays a model.
- The document cannot assert measurement over a modelled quantity — that check runs automatically before anything is released.
- You receive the model, not just the conclusion, so you can re-run it when your inputs change.

## 7. To proceed

Commission the engagement and you will receive an intake link for the hall's numbers. The clock starts when the intake is complete, not when payment clears.

> ℹ️ Before you spend anything with us: get the DSO position in writing on firm capacity and any flexibility product. It costs nothing but time, and on some sites it ends the question entirely. We would rather tell you that now than bill you to discover it.

> ⚠️ EVIDENCE DISCLOSURE: the findings in section 1 are a screening read built partly on library defaults. electrical capacity is E0 where an issued deliverable requires E3; cooling performance is E0 where an issued deliverable requires E2; capex is E0 where an issued deliverable requires E1; schedule (lead times) is E0 where an issued deliverable requires E1. They are sufficient to decide whether this engagement is worth commissioning, and not sufficient to support procurement, construction or an investment committee decision. Closing the gaps in section 3 is what changes that.

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


### A.2 Sources


### A.3 Provenance of headline quantities

| Quantity | Evidence | Model | Digest |
| --- | --- | --- | --- |
| deployable racks as found | E0 | input@0.1 | `2251cf0df6fb` |
| deployable racks after relief | E0 | input@0.1 | `8869e76332d4` |
| elapsed weeks to full energisation | E0 | input@0.1 | `6fc4e6a9b6e3` |
| Density Screen fixed fee | E3 | input@0.1 | `7ca2ecfa0a05` |

---

GridForge AI — independent power and thermal engineering. We quote no equipment and take no margin on hardware.

Generated 2026-09-14 by the GridForge-AI envelope engine.
