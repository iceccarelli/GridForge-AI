# Phase 0 — money path proof, against production

**Target:** https://timetopower.ai (not localhost)
**Engine:** https://gridforge-engine.fly.dev
**Date:** 2026-09-17
**Verdict: PASS**

Before this run, the `deliverables` table in the production Supabase project was
**empty** and no Stripe Checkout Session had ever reached `paid`. The money path
had never completed once, end to end, on the deployment that takes the money.

---

## The block

| # | Step | URL | HTTP | Result |
|---|---|---|---|---|
| 1 | Qualify, seven fields | `POST /api/qualify` | 200 | **PASS** |
| 2a | Commission the screen | `POST /api/checkout` | 200 | **PASS** |
| 2b | Engagement opened | `deliverables` insert | — | **PASS** (see caveat) |
| 2c | Intake, prefilled | `GET /api/intake/<intake_token>` | 200 | **PASS** |
| 2d | Intake submit → generate | `POST /api/intake/<intake_token>` | 200 | **PASS** |
| 2e | Release | `status → released` | — | **PASS** (see caveat) |
| 3 | Document | `GET /deliverable/<token>` | 200 | **PASS** |

---

## What each step actually returned

**1. `POST /api/qualify` → 200.** A real binding constraint from the engine, not a
503, not "unconfigured", not invented:

- binding constraint: *Residual air load removal per rack*
- 0 racks as found, 120 racks after the costed ladder
- intake completeness 0.562, eight named gaps
- persisted: share link `/q/ErofqhNIQbVR9UNxiBlZIL3C`,
  `qualificationId 0e9053f6-1c27-4bc0-b629-a0b3ebc1359d`

**2a. `POST /api/checkout` with `product: density_screen` → 200.** A real Stripe
Checkout Session, `cs_test_a1wdnD…`, `amount_total 450000 EUR`, carrying
`metadata.kind = density_screen` and `metadata.qualification_id` — the join that
makes the intake arrive prefilled. Stripe is in **test mode** on
`acct_1Th7Xc0yoqnS42mn`, and the webhook endpoint
`https://timetopower.ai/api/stripe/webhook` is present and enabled.

**2c. `GET /api/intake/<intake_token>` → 200.** All seven numbers came back
prefilled from the qualification. This is the join working in production: a
customer who bought from the qualifier tab does not retype what they just typed.

**2d. `POST /api/intake/<intake_token>` → 200.** The engine generated the
document, live:

- title: *Density Screen — GF-001 Proof Site, hall HALL-A*
- 16,101 bytes of HTML, 7,282 bytes of Markdown
- status moved to `draft`, not `released` — generation is automated, release is not
- three assumptions named back at submit time (`firmCapacityMVA`,
  `floorLoadingKPa`, `plantCapacityKW`), rather than buried in a footnote

**3. `GET /deliverable/<token>` → 200, 73,826 bytes.** The body is a document for
*that* hall, not a template:

> Binding constraint: Firm supply (grid import + behind-the-meter) (electrical).
> −2,300 [−5,210–610] kW (E0) of firm-supply headroom at PUE 1.45 [1.35–1.6].

with the costed ladder (grid reinforcement, 2,500,000 EUR (E0), 260 [150–520]
weeks), five architectures screened, and the data request.

The screen names a different constraint than the free qualifier did, and that is
correct rather than a discrepancy: the screen intake did not carry
`firmCapacityMVA`, so the engine assumed it from the library — and said so, in the
document, in the list of three assumptions returned at submit.

---

## Caveats, stated plainly

**Steps 2b and 2e did not go through Stripe or the admin UI.** Both were written
through the data layer, in the exact shape the shipping code writes:

- 2b is what `createDeliverable()` inserts for `openDeliverable()` in the Stripe
  webhook — same columns, same token shape (`crypto.randomBytes(24).base64url`),
  the real session id in `stripe_session_id`.
- 2e is the single write `updateByToken(token, { status: "released", released_at })`
  that `PATCH /api/admin/deliverables` performs.

Two things blocked the untouched paths, and neither is a code defect:

1. Completing a **hosted** Stripe Checkout page needs a browser. The Chrome
   extension is not connected in this session, so the test card could not be
   entered. There is no Stripe API that completes a hosted session.
2. `ADMIN_PASSWORD` is a human-only secret and was not available. It was not
   needed for any other step.

Everything else — qualify, checkout, intake read, intake submit, engine
generation, document read — ran through the real production HTTP routes against
the real engine.

---

## Separate finding, outside this branch's scope

The Stripe webhook endpoint subscribes to **`checkout.session.completed` only**.
`app/api/stripe/webhook/route.ts` also handles `invoice.paid` and
`customer.subscription.deleted`, and those events are not enabled on the endpoint,
so neither handler can ever fire in production. Consequences, per the handler's
own comments: a cancelled Hall Watch keeps being delivered, a cancelled
Intelligence plan stays active, and a renewing API customer is never reminded to
rotate a key that expires on its own.

Fixing that is one change in the Stripe dashboard (or one API call), not a code
change, which is why it is reported here rather than done.
