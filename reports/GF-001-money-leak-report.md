# GF-001 — Money Leak Report

**Question asked of every paid surface:** can value be obtained without paying, and
can a paying customer be denied what they bought? Both directions cost money; the
second one costs more, because it churns a customer who had already decided to buy.

Every finding below was reproduced against running code before it was fixed, and
every fix was re-run against the pre-fix version to confirm the test fails on it.

---

## Surfaces attacked

| Surface | What it protects | Verdict |
|---|---|---|
| `/api/scenarios` | Intelligence subscriber's saved work | **Was leaking both ways** — fixed |
| `/api/subscription-status` | The paid view on `/account` | **Was denying paying customers** — fixed |
| `/api/stripe/webhook` | Every entitlement in the product | **Took money, recorded nothing** — fixed |
| `/api/siting-analysis` | The subscriber-only AI analyst | **Was free when Supabase was unset** — fixed |
| `/api/keys` | Metered API keys, recurring revenue | **Stranded paying customers at day 35** — fixed |
| `/api/admin/login` | The entire lead pipeline + deliverable release | **Unlimited free guesses** — fixed |
| `/api/insights` | Published aggregates over customer halls | **Published unanswered enquiries' metros** — fixed |
| `/api/deliverable/[token]` | A €4,500–€95,000 artifact | Draft never served; hardened a prototype lookup |
| `/api/cron/watches` | Scheduled paid work | Bearer secret, fails closed — **no finding** |
| `/api/checkout`, `/api/subscribe` | Payment initiation | Catalogue-driven, no client-supplied price — **no finding** |
| `/api/market`, `/grid`, `/queue`, `/constraints` | Public data | Free by design (distribution) — **no finding** |
| Engine `/v1/*` | Metered compute | 401 unkeyed, 402 over quota, offline-verified keys — **no finding** |

---

## L1 — A paying customer's API access died every 35 days *(highest value)*

**The loop.** Signed keys are stateless — that is what lets the engine verify them
with no database and no network call — and the price of that is a fixed 35-day
expiry baked into the token. The subscription renews monthly. Nothing reissued the
key: the webhook's own comment said *"Reissue silently"* and the code only set a
status field. `mintForAccount` was imported into that file and never called.

So on day 35 a paying customer's agents stopped. The engine's expiry message told
them to *"reissue from your account page"*. The account page's own docstring
promised to mint *"when the current one is near expiry"*. The code implemented
neither, and answered **"A key is already live for this account"** to somebody
holding a dead one.

That is the exact failure the webhook was written to prevent — its comment reads
*"the difference between 'it renewed and nobody noticed' and 'my agents stopped at
3am'"* — happening to the customers who paid every month.

**Fixed.** `keyLife()` in `lib/api-access.ts` is now the one place that knows
whether a key is alive. `/api/keys` mints on expiry or inside a 7-day window, and
reports `expired` / `days_left` / `needs_rotation` so the portal can warn while
there is still a working key. A dead key is revoked when replaced; a *near-expiry*
key is deliberately **not**, so the customer can deploy the new one before the old
one lapses and nothing stops in between. `invoice.paid` now emails the portal link
when rotation is due — the link, never the key, matching the existing rule.

**Verified live:** a key expired three days ago → portal reported `expired: true,
days_left: -3` → self-serve mint → old id on the revocation list → **the new key
verified on the real engine** with the right account and quota.

## L2 — The paid AI analyst was free whenever Supabase was unset

`app/api/siting-analysis` wrapped its subscription check in `if (url && skey)`.
With Supabase unconfigured the gate was not open — it was **not executed**. The
subscriber-only analyst answered anybody who posted an email address and a
sentence. A surface that reads as protected and is not is worse than one that is
openly free, because nobody goes looking. Now fails closed.

## L3 — Money in, nothing out *(covered in the gap analysis)*

`subscriptions` and `scenarios` had no migration. Fixed with migrations `0009` and
`0010`, one canonical data layer, and all three lifecycle events resolving the
third recurring product.

## L4 — Unlimited free guesses at the commercial asset

Behind `ADMIN_PASSWORD` sit every lead the business has — name, company, site,
contracted megawatts, score, pipeline status — and the button that releases a paid
deliverable. There was no throttle of any kind, so the password's strength was the
entire defence and a guess cost nothing.

Now 8 attempts per 10 minutes per caller, counted **before** the comparison and
counted on success too — a throttle that only counts failures can be reset by
interleaving a request it will answer.

**Stated honestly:** this is in-memory, therefore per-instance on a serverless
platform, and resets on a cold start. It is a cost multiplier on a guessing attack,
not a lockout. The real defence is still a long random `ADMIN_PASSWORD`. A
distributed lockout belongs with real client logins, which is when this whole gate
gets replaced.

## L5 — The published record included halls it never answered

`/api/insights` is the growth loop and the moat in one. Its small-sample floor
counted halls that produced a result, but the medians and the metro list were
computed over **every row** — so an enquiry the engine could not answer still had
its metro published, in a distribution its owner was never part of, and the
medians were drawn from a different population than the published basis statement
describes.

The second half is the one that matters commercially. This practice sells numbers
that carry their evidence; a published figure whose stated basis does not match its
own arithmetic is the single claim that would cost more than it earns. The public
route now summarises only the solved halls. The admin view still sees everything,
because internally "how many came in and how many did we answer" is the right
question.

---

## The checklist, and where each case is exercised

| Case | Result |
|---|---|
| anonymous / free user | 402 on every paid surface |
| paid user | full cycle verified over HTTP |
| expired user | **key now reissuable** — was a dead end |
| cancelled user | entitlement withdrawn; paid surfaces close; key minting refused |
| failed payment + retry | `past_due` still entitles; `invoice.paid` reinstates |
| webhook failure | 500, Stripe redelivers, write idempotent on session id |
| subscription lookup failure | 503 — a claim about us, never about the customer |
| database failure / missing table | 503 / 500, loudly, with a log line |
| missing configuration | fails closed everywhere; analyst 503, webhook 503 |
| direct API calls / alternate routes | handlers gate themselves; no UI-only checks |
| duplicate requests | idempotent on the Stripe session id |
| cross-tenant access | list empty, delete 404, owner's row intact |
| quota exhaustion | engine returns 402, not 429 |
| brute force | 429 with `Retry-After` |

**102 executable site tests**, plus 397 engine tests.

---

## Residual, declared rather than fixed

1. **Early revocation of a leaked API key still needs a manual env sync.** The
   engine reads revoked ids from `GRIDFORGE_REVOKED_KEYS`; `/api/keys` records them
   in Supabase. For an *expired* key this is moot — expiry does the work. For a key
   rotated early because it leaked, the old one keeps working until it expires
   unless that variable is updated. Fixing it properly means giving the engine a
   network dependency, which would undo the stateless design the whole key scheme
   is built on. **This is an architecture decision, not a bug fix, and it is the
   founder's to take.** Documented in `gridforge/api/keys.py` already.
2. **The admin throttle is per-instance.** See L4.
3. **Stripe's own API is still unexercised.** Signature verification and every
   webhook branch are verified; creating a live Checkout Session needs live keys.
