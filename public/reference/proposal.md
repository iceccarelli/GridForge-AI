# Proposal — Density Screen, Reference Colocation Campus hall DH-02

*Reference Project (synthetic) · prepared 2026-09-14 · valid to 2026-10-14 · target platform NVIDIA GB300 NVL72*

> **The findings below are a screening read produced before this engagement begins. They are modelled from the inputs supplied, not measured at the site.**

## 1. What we already found

We ran your hall through the capacity engine before writing this. The following is not a claim about what we might do; it is what the constraint set already says, on the inputs you supplied.

**Deployable NVIDIA GB300 NVL72 racks as the hall stands:** 0 racks (E3)

*Limited by: platform needs 205 [174–236] A (E0) per rack; installed tap-offs rated 63 A (E5)*

**Deployable after the costed ladder:** 62 racks (E3)

*Limited by: Full DLC plus behind-the-meter supply*

**Time to full capacity:** 160 [112–256] weeks (E3)

*Limited by: set by transformer capacity*

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

Intake is complete. Nothing further is required to begin; the clock starts on commissioning.

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

> ⚠️ EVIDENCE DISCLOSURE: the findings in section 1 are a screening read built partly on library defaults. electrical capacity is E0 where an issued deliverable requires E3; cooling performance is E0 where an issued deliverable requires E2; capex is E0 where an issued deliverable requires E1. They are sufficient to decide whether this engagement is worth commissioning, and not sufficient to support procurement, construction or an investment committee decision. Closing the gaps in section 3 is what changes that.

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


### A.2 Sources


### A.3 Provenance of headline quantities

| Quantity | Evidence | Model | Digest |
| --- | --- | --- | --- |
| deployable racks as found | E3 | input@0.1 | `37ccfd2a8602` |
| deployable racks after relief | E3 | input@0.1 | `5bb5a58337e6` |
| elapsed weeks to full energisation | E3 | input@0.1 | `85cf5cf7107b` |
| Density Screen fixed fee | E3 | input@0.1 | `7ca2ecfa0a05` |

---

GridForge AI — independent power and thermal engineering. We quote no equipment and take no margin on hardware.

Generated 2026-09-14 by the GridForge-AI envelope engine.
