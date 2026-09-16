# GridForge — Commercial Opportunity Review

**Method:** the catalogue, the engine's metered surface and the fulfilment paths
were read against each other, and every capability claim below was **executed**
against a running engine rather than inferred. Figures marked *hypothesis* are
mine and carry no evidence; figures marked *catalogue* are what the business
already prices.

---

## 1. What is actually priced today

| Product | Price | Shape | Annualised |
|---|---|---|---|
| Density Screen | €4,500 | one-off | — |
| Envelope Study deposit | €9,000 | opens €22k–45k | — |
| Procurement Specification | €18,000 | one-off | — |
| Portfolio Screen deposit | €15,000 | opens €60k–140k | — |
| Hall Watch | €6,000 / quarter | recurring | €24,000 |
| API — triage / scale / platform | €900 / €2,900 / €7,500 per month | recurring | €10.8k / €34.8k / €90k |
| Intelligence — developer / team / enterprise | €499 / €1,999 / €4,999 per month | recurring | €6k / €24k / €60k |

## 2. Where capability and revenue have come apart

The engine meters **nine** paid capabilities. The product catalogue attaches a
fulfilment endpoint to **three**.

| Engine capability | Units | Sold as | Fulfilled? |
|---|---|---|---|
| `/v1/screen` | 1 | Density Screen | ✅ verified |
| `/v1/study` | 5 | Envelope Study (deposit → human) | ✅ human path |
| `/v1/spec` | 3 | Procurement Specification | ⚠️ **two thirds of it** |
| `/v1/bids` | 2 | **promised inside the Specification** | ❌ **no surface exists** |
| `/v1/diff` | 2 | Hall Watch | ✅ verified |
| `/v1/portfolio` | 1 | Portfolio Screen | ✅ |
| `/v1/deck` | 3 | part of the Study | ✅ |
| `/v1/proposal` | 2 | internal (admin) | ✅ |
| `/v1/qualify` | 0 | the free funnel | ✅ verified |

---

## 3. The finding: one third of the most expensive product cannot be delivered

`lib/products.ts` states the Procurement Specification's deliverable as **three**
things:

> "Technical specification (HTML + Markdown), a machine-readable response schedule,
> **and a bid comparison against the capacity model showing what each response does
> to the energisation date**."

`lib/site.ts` repeats it — *"Specification, a response schedule, and your bids
ranked in racks and weeks"* — and the engagement ladder says *"Your bids come back
comparable."*

The first two are delivered. **The third has no surface anywhere in `app/` or
`lib/`.** Nothing calls `/v1/bids`. The only occurrences of the word are marketing
prose. A customer who has paid €18,000 has no way to submit the supplier responses
and no way to receive the comparison.

**The capability is not the problem — it is finished and good.** Run against the
live engine with three responses to a real relief:

| Rank | Supplier | Capex | Weeks to energised | €/rack | Score |
|---|---|---|---|---|---|
| 1 | Alpha | €480,000 | 26 | €17,143 | 65/100 |
| 2 | Gamma | €455,000 | 32 | €16,250 | 63/100 |
| 3 | Beta | €392,000 | 44+ | — | lower |

**The cheapest bid loses.** That is the entire product thesis — "compared in racks
and weeks, not only in euros" — demonstrated by the engine on its own. It also
returns the sentence that makes it defensible:

> *"2 weeks later than the modelled 24. Re-run the study with this figure before
> committing: if this relief sets the date, the whole envelope moves with it."*

and refuses to over-claim:

> *"Installation method and evidence quality are scored by the engineer, not by this
> tool — 15 points are unallocated until they are."*

---

## 4. Candidates, scored

### A. Complete the Procurement Specification — the bid comparison surface

| | |
|---|---|
| **Buyer** | Data-centre procurement, EPC, or the owner about to place the equipment order |
| **Problem** | Four quotes in four formats. Which one actually moves the energisation date? |
| **Existing spend** | Already paying €18,000 for the spec, and about to commit €400k+ of capex — *catalogue + observed bid values* |
| **Expected contract value** | No new price. Completes an existing €18,000 product |
| **Recurring potential** | Once per relief, per hall; the ladder has several reliefs |
| **Incremental revenue** | Protects the full €18,000 rather than adding to it, and makes the product honestly sellable |
| **Gross-margin effect** | Very high — the engine does the work; 2 metered units |
| **Conversion effect** | Removes a promise/delivery gap that surfaces *after* purchase, which is the most expensive place to find one |
| **Defensibility** | The comparison is against *this hall's* capacity model. A vendor cannot do it; a consultancy cannot do it in twelve days |
| **Engineering cost** | Moderate — a response-submission surface, a `/v1/bids` call, storage, rendering |
| **Implementation risk** | Low–moderate; the engine side is done and tested |
| **Time to revenue** | Immediate. The product is already priced, on the ladder, and purchasable |

### B. The three previously-rejected items

| | Screen→Study credit | `/commissioned` intake link | Early key revocation |
|---|---|---|---|
| Protects | €4,500 per conversion | a €4,500–€95,000 fulfilment | a leaked paid credential |
| Cost | low | low | moderate |
| Risk | low | **widens a credential** | **architecture** |
| Blocked on | nothing | a founder decision | a founder decision |

### C. Intelligence subscription

Blocked on the production migrations. No engineering left to do.

### D. Anything new

Rejected under §2. There is an €18,000 product that cannot fully deliver; building
a new one before fixing that would be manufacturing demand while leaving revenue
already sold unfulfilled.

---

## 5. Recommendation — **built**

**Status: implemented.** The recommendation below was acted on in the same pass;
what follows is the reasoning as it stood when the decision was taken.

`POST /api/deliverable/<token>/bids` accepts the completed response schedules and
returns the ranking, judged against the relief the specification was **written
for** — carried on the engagement — rather than whatever binds the hall by the time
the quotes come back. Four quotes answered one requirement; re-deriving it could
have compared them against a different one.

Verified end to end against the real engine: Procurement Specification purchased →
specification generated → response schedule issued → relief recorded
(`busway_ampacity`) → bids refused before release → released → three suppliers
compared → **Alpha €480,000 / 26 weeks beats Beta €392,000 / 50 weeks** → the
comparison kept as a downloadable working file → a Density Screen refused (409).

The stated assumption, which has not been confirmed: that bid comparisons are not
already being run by hand via `gridforge bids` as declared manual work. If they
are, this was still worth building — it turns an undeclared manual step into
product — but it was not the most urgent thing.

---

## 5a. The reasoning at the time

**Build A.** It is the only candidate that makes an already-priced, already-sellable
product able to deliver what its own catalogue entry promises, and the engine work
is complete. Everything in B is smaller; C is not engineering-blocked; D is
premature.

Against the ten-question test: the buyer is identified, the spend already exists,
the payment event has already happened, the margin is near-total, the frequency is
per-relief, the blocker is a missing surface over a finished capability, and the
cheapest real test — three supplier responses through `/v1/bids` — has already been
run and is in §3.

**The one thing that would change this recommendation:** if the founder delivers
bid comparisons by hand today via `gridforge bids` and is content to keep doing so
at current volume, then this is declared manual work rather than a gap, and A drops
below B. That is a question about how the business is actually run, and it has not
been asked.
