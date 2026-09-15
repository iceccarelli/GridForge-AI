# GF-001 — Review Report

## STATUS

**PASS on the engineering. NOT a commercial PASS** — see the deployment report. The
migrations are unapplied, so the promised outcome has not been observed on the
deployment that takes the money.

## WHAT WAS TESTED

The whole branch diff (`4e4ce29..HEAD`, 53 files) read against five questions: does
it duplicate something that already existed; does it weaken a guard to go green;
does any path report success it has not earned; is every claim in these reports
backed by something executed; and did any fix create a worse failure than the one
it removed.

## WHAT ACTUALLY WORKS

### No engine was duplicated and no working system rewritten

Twenty-two shipped files changed, plus three migrations and CI. The largest new
file, `lib/subscribers.ts`, is modelled directly on the existing `lib/watches.ts`
and **replaces three inline copies of the same query rather than adding a fourth**.
`keyLife()` went into `lib/api-access.ts` beside the code it serves;
`checkoutOrigin()` into `lib/site.ts`, already the single registry for the site's
own address; `INTELLIGENCE_PLANS` into `lib/products.ts`, already declared the one
file where a euro figure may live. Nothing new was invented to hold them.

`gridforge/` — the engine, and the thing being sold — is **untouched**. Every
change sits at the joins around it.

### No guard was weakened to make anything pass

Five of the repository's own guards went red during this work. All five were fixed
by changing the **code**, never the assertion:

| Guard | What it caught | Fix |
|---|---|---|
| root hygiene | `vitest.config.ts` | declared in `ROOT_FILES` with a reason |
| one domain | hardcoded URLs in the new tests | tests read `siteUrl()` from the registry |
| one price list | a `€` written in a code comment | reworded the comment |
| `res.ok` guard (new) | two further offending routes | both fixed |
| token-page guard (new) | `/intake/[token]` never resolving | resolves server-side now |

Four guards were **strengthened**: `SUBSCRIPTION_LOOKUPS` gained the third recurring
product its own comment had asked for; the price rule gained a cents-aware
companion; every `rest/v1/<table>` must now have a migration; and no route may
reach Supabase without checking whether it worked.

### Every new success path is earned

The three that return 200 do so only after `res.ok`. `recordSubscription`,
`createScenario` and `deleteScenario` return the row or `null`;
`deleteScenario` uses `return=representation` so a cross-tenant attempt reads as a
miss, not a success. The three `open*` helpers in the webhook return a boolean the
caller acts on, and a failure is a 500 rather than a silent 200.

### Every claim is executed

Each fixed file was reverted and its new tests re-run: 13/24, 9/16, 5/17, 5/9, 4/13,
2/9, 2/9, 6/8, 2/40. A suite that passes against the broken code proves nothing.

## WHAT DOES NOT WORK

Nothing found in review beyond what the test and deployment reports already
declare.

## MOCKS / PLACEHOLDERS REMAINING

None in shipped code. Two declared test doubles, both in the test tree and both
existing to reproduce a real condition honestly: `tests/site/postgrest-fake.ts`
(answers 404 without throwing, like the real service) and
`tests/e2e/postgrest-stub.mjs` (creates only the tables the migrations declare).

## KNOWN RISKS — including ones these changes created

1. **A failed fulfilment now returns 500 and Stripe retries.** Correct — a customer
   must not be told a purchase succeeded when nothing was written — but if the
   migrations are never applied, those events will visibly fail in the Stripe
   dashboard after the retry window. That visibility is the intent; the previous
   behaviour was a green checkmark over a lost customer.
2. **`0011` creates partial unique indexes on tables that may hold rows.** A
   failure to create means two fulfilments already exist for one payment. Nothing
   is damaged, the migration stops, and that is worth knowing.
3. **The admin throttle is per-instance.** In-memory, so it resets on a cold start.
   A cost multiplier on guessing, not a lockout, and the code and tests say so.
4. **`tests/site/` and `tests/e2e/` now have to be maintained** alongside the
   routes. That is the cost of having executable tests at all, and a better cost
   than the one it replaces.
5. **Early revocation of a leaked API key still needs a manual env sync.** Expiry
   covers the lapsed-subscription case. Fixing the leaked-key case means giving the
   engine a network dependency and undoing the stateless design the key scheme
   rests on — an architecture decision, and the founder's.

## TWO JUDGEMENT CALLS WORTH A SECOND OPINION

1. **Folding the Intelligence prices into `lib/products.ts`.** The first position
   in this branch was the opposite, on the reasoning that a recurring software
   subscription is not an engine engagement. The catalogue disproved it — it
   already prices `hall_watch` and three metered API subscriptions. Recorded in the
   gap analysis as a position that was wrong, rather than quietly reversed.
2. **`past_due` still entitles.** A customer whose card is being retried keeps
   access until `customer.subscription.deleted`. It follows the rule the repository
   had already set for Hall Watch, but it is a commercial choice, not a technical
   one.

## TWO THINGS DELIBERATELY NOT BUILT

Recorded because deciding not to build is a decision, and an unrecorded one looks
like an oversight.

**1. The Screen's credit against the Study is a manual step.** Two customer-facing
surfaces promise *"it credits in full against the full study"*, and
`lib/products.ts` declares `creditsAgainst: "envelope_study_deposit"`. Nothing
consumes it.

That is correct as it stands. The Envelope Study is sold as a **deposit** that
opens a human engagement and is invoiced by a person, and that person has
`fetchDeliverables` and can search by email — so the data needed to honour the
credit is in front of whoever raises the invoice. Building a credit-tracking
mechanism would be engineering time spent on a step a human is already in.

*What would change the answer:* volume. Once Screen→Study conversions are frequent
enough that the operator stops remembering each one, the credit wants recording
against the engagement rather than in someone's head. **Declared manual work, not
hidden manual work.**

**2. `/commissioned` could show the intake link instead of only promising an
email.** After paying, the only route to the product is a message from Resend. The
page carries Stripe's `session_id`, `deliverables.stripe_session_id` is indexed,
and `deliverableBySession()` already exists — so the page *could* resolve the
purchase and hand over the link immediately, removing email as a single point of
failure on a four- to five-figure fulfilment.

**Not done, because it is an access-control decision rather than a UI one.** The
deliverable token is the same credential for `/intake/<token>` **and**
`/deliverable/<token>`, so publishing it on a page keyed by `session_id` makes that
session id equivalent to the document credential — and puts it in browser history,
referrers and any analytics on the page. Stripe session ids are long and reach only
the payer, so the risk is small; but the repository is deliberate about
token-addressed surfaces (noindex, robots-disallowed, resolved server-side), and
widening what counts as a credential is the founder's call.

*The mitigation that was made instead:* `emailIntakeLink` now checks Resend's
status and logs the failure **with the link**, so a message that never left is
recoverable rather than invisible. The page's own fallback — reply to the Stripe
receipt — is a declared manual path.

## COMMERCIAL WORKFLOW

Every stage of the Product 01 workflow is VERIFIED in the capability matrix with
per-stage evidence, and the whole surface is re-runnable: `npm run verify:local`
(40 criteria, in CI) locally, `scripts/verify-entitlement.mjs` against the hosted
stack.

## DEPLOYMENT

See the deployment report. The migration step is a genuine prerequisite and is
stated as one.

## NEXT ACTION

1. Apply `0009`, `0010`, `0011`.
2. `node scripts/verify-entitlement.mjs --schema` → expect 14/14.
3. Deploy, then `--full --yes-write-to-this-database` → expect 29/29.
4. One real purchase in Stripe **test mode**, for the Checkout Session creation no
   script here can stand in for.
5. Decide G8 — whether a Density Screen may accept a thin intake.
