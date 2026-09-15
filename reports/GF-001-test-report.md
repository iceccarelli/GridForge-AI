# GF-001 — Test Report

## STATUS

**ENGINEERING PASS. NOT YET A COMMERCIAL PASS.**

The build is complete, every gate is green, and the full purchase→cancellation
cycle runs end to end locally. But the two migrations have not been applied to the
hosted Supabase project, so the promised customer outcome has not been observed on
the deployment that takes the money. Under the standing rule that a green pipeline
is an engineering gate and not a commercial one, this is PARTIAL until
`scripts/verify-entitlement.mjs --full` passes against production.

What follows is a PASS on everything that can be established without production
access. The two things that cannot be — the migrations against a hosted Supabase
project, and Stripe's own API — are stated in full under *WHAT DOES NOT WORK*.
Neither is mocked and neither is hidden; both are named, and the work they gate is
named with them.

---

## WHAT WAS TESTED

### Repository-native suites (run, not read)

| Suite | Command | Result |
|---|---|---|
| Engine, architecture, provenance, commercial joins | `python -m pytest tests -q` | **399 passed** |
| Site route handlers | `npm test` (`vitest run`) | **127 passed, 9 files** |
| Types | `npx tsc --noEmit` | clean |
| Lint | `npx next lint` | clean (1 pre-existing warning in `BackgroundReel.tsx`, untouched) |
| Production build | `npm run build` | compiled successfully; 44 routes; `/q/[token]` present, `/infrastructure` gone |

Baseline at `ea1f62d` was **348 passed, 3 failed**. Every one of those three is now
green, and the suite has grown to 399 + 127.

### The mission's testing checklist

| Case | Where | Result |
|---|---|---|
| Normal operation | full purchase→delivery E2E; engine CLI | pass |
| Malformed input | non-JSON body, JSON array where an object is required, `null` body | 400 |
| Missing input | no email, no id, no brief | 400 |
| Empty input | empty body, whitespace-only email | 400 |
| Large input | 5,000-character scenario name | truncated to 80 before the database sees it |
| Invalid state | `NaN` / object where a number is required | coerced to 0, never a null in a NOT NULL column |
| Authentication | forged Stripe signature; unsigned event; unconfigured webhook secret | 400 / 400 / 503 |
| Authorization | non-subscriber, cancelled, superseded, unconfigured store | 402 / 402 / 402 / 503 |
| Cross-tenant access | one paying subscriber listing and deleting another's rows | list empty; delete 404; owner's row untouched |
| Duplicate request | Stripe redelivering the same `checkout.session.completed` | one entitlement, not two |
| Retry | `invoice.payment_failed` → `invoice.paid` | past_due then reinstated; access kept throughout |
| Timeout | engine call carries `AbortSignal.timeout(20_000)`; unreachable engine path | 502/503 with no invented number |
| Deployment | production build served and driven over HTTP | pass |
| Real customer workflow | see below | pass |

### Negative control — do the new tests actually catch the old bugs?

Each fix was reverted to its `HEAD` version and the new tests re-run:

| Restored file | New tests failing |
|---|---|
| `app/api/scenarios/route.ts` | **13 of 24** |
| `app/api/stripe/webhook/route.ts` | **9 of 16** |
| `app/api/siting-analysis/route.ts` | **5 of 9** |
| `scripts/apply-inbox.sh` | **2 of 9** |
| `app/api/keys/route.ts` | **5 of 17** |
| `app/api/insights/route.ts` | **2 of 9** |
| `app/api/admin/login/route.ts` | **4 of 13** |

A suite that passes against the broken code proves nothing. These do not.

---

## WHAT ACTUALLY WORKS

**Engine, run this session:** `gridforge init` → `gaps` (100% complete, 16 supplied,
0 assumed) → `screen` → `study`, producing `envelope_study.md`, `.html` and
`model_pack.json`, naming *Rack feed / tap-off rating* as binding and
*Chilled-water plant capacity* as the item that sets the date.

**Free funnel, over HTTP against a production build:**
`POST /api/qualify` → real engine on :8080 → *"Nothing deployable today — rack feed
/ tap-off rating stops it. Clear the ladder and the hall carries about 28 NVIDIA
GB300 NVL72 racks."* → persisted → share link minted → `GET /q/<token>` returned the
read (200, 39 KB, `noindex`), an unminted token returned 404, `robots.txt` disallows
`/q/`. No EUR figure and no capex leaked into the free tier.

**Money path, over HTTP with real Stripe signatures — 18 assertions, all passing:**

```
forged signature rejected                                   HTTP 400
inactive before purchase                                    active:false
signed checkout.session.completed accepted                  HTTP 200
entitlement live                                            active:true, plan team
Stripe redelivers the same event                            still exactly one entitlement
scenario saved / listed / figures survive the round trip    HTTP 200
unsubscribed stranger refused a listing                     HTTP 402
a PAYING stranger sees none of the other tenant's rows      scenarios: []
cross-tenant delete refused as a miss                       HTTP 404, owner's row intact
invoice.payment_failed                                      still entitled (Stripe is retrying)
invoice.paid                                                reinstated
customer.subscription.deleted                               entitlement withdrawn
the paid surface closes with it                             HTTP 402
```

**The same run against a database missing the two migrations** — i.e. production as
it stood — now fails loudly where it used to fail silently:

| | before this branch | now |
|---|---|---|
| webhook | `200` + welcome email, nothing stored | `500`, Stripe redelivers, idempotent |
| subscription-status | `200 {active:false}` — blamed the customer | `503` — names the fault as ours |
| scenarios | `200 {ok:true, scenarios:[]}` | `503` |

---

## WHAT DOES NOT WORK

1. **The migrations have not been run against a hosted Supabase project.**
   `0009_subscriptions.sql` and `0010_scenarios.sql` are written, and the end-to-end
   run parsed and served *those exact files* through a local PostgREST stand-in — so
   the SQL's table and column names are proven consistent with the code. Postgres
   itself has not executed them. **Until they are applied, the Intelligence
   subscription is still not fulfilled in production.** It now fails loudly instead
   of silently, which is the difference between a bug you can see and one you cannot.
2. **Stripe's API was never called.** Signature verification and every webhook branch
   are verified against the real SDK. Creating a live Checkout Session needs live
   keys and was not attempted.
3. **No email was sent.** `RESEND_API_KEY` was deliberately unset throughout.
4. **No model was called.** The chat and analyst gates are verified; Anthropic was
   never reached.
5. **One pre-existing lint warning** in `components/BackgroundReel.tsx`, untouched
   because it is unrelated to this mission.

---

## MOCKS / PLACEHOLDERS REMAINING

**In shipped code: none added by this mission, and two removed.**

The only stand-in is in the test tree and is declared as such:
`tests/site/postgrest-fake.ts`, an in-memory PostgREST used by `npm test` and by the
local end-to-end run. It exists specifically so a *missing table* can be reproduced
— it answers 404 without throwing, which is what the real service does and what a
throwing stub would have hidden.

Removed: the `if (url && skey)` wrapper that made the analyst gate disappear, and
the swallow-everything `catch` blocks around three Supabase call sites.

---

## KNOWN RISKS

| Risk | Severity | Mitigation in place |
|---|---|---|
| Migrations not applied to production | **High** | Every affected surface now fails loudly and the deployment report gives the exact order. `test_every_table_the_site_reads_or_writes_has_a_migration` blocks the next occurrence at CI. |
| `subscriptions_one_active_per_email` could reject an insert if a supersede fails | Low | The supersede is checked for `res.ok` and the insert is abandoned rather than run into the index; the test fake enforces the same index so the path is exercised. |
| A subscriber in `past_due` retains access during Stripe's retry window | Accepted | Deliberate, and consistent with the rule the repository already applied to Hall Watch. Access is withdrawn on `customer.subscription.deleted`. |
| `vitest` added as a devDependency | Low | Dev-only. The Python engine keeps its zero-dependency guarantee untouched. |
| Intelligence prices outside the catalogue | Medium (commercial) | Now visible rather than invisible — see G7 in the gap analysis. Not decided here. |
| Nothing is field-validated | Accepted | The repository's own stated position, unchanged and still enforced by the calibration ledger and report gates. |

---

## COMMERCIAL WORKFLOW

Verified end to end this session — see *WHAT ACTUALLY WORKS*. Purchase becomes
entitlement, entitlement opens the paid surface, cancellation closes it, and a
customer whose card is being retried is not locked out.

---

## DEPLOYMENT

See `GF-001-deployment-report.md`. The short version: **apply `0009` and `0010`
before the next deploy**, or the Intelligence subscription will refuse loudly rather
than fail silently — better, but still not selling.

---

## NEXT ACTION

1. Run `supabase/migrations/0009_subscriptions.sql` and `0010_scenarios.sql`.
2. Re-run the purchase→cancellation cycle against the hosted project in Stripe test
   mode, which is the one thing this session could not do.
3. Decide G7: does GridForge Intelligence belong in `lib/products.ts`?
