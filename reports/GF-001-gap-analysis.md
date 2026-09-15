# GF-001 — Gap Analysis

**Method:** every gap below was reproduced before it was fixed, and each fix was
run against the pre-fix code to confirm the test actually fails on it. Counts of
failing-before / passing-after are given per gap.

---

## G1 — The repository was red, and the gate that protects it could not tell

**Found:** three tests failing on `main`. `0024-unblock-main.patch` (203 KB) was
tracked at the repository root and `inbox/0021-shareable-capacity-read.patch` was
unapplied. Baseline: **348 passed, 3 failed.**

**Also found, and worse:** `scripts/apply-inbox.sh` decides whether a patch may
stay on `main`, and it decided it from `python3 -m pytest … || true`. On a machine
where pytest is not installed — which is this machine — that command prints "No
module named pytest", exits 0 through the `|| true`, and the script reads an empty
failure list as **green**. The gate protecting `main` could not distinguish "the
suite passed" from "the test runner never ran", and would have applied and
committed a patch that breaks everything.

**Fixed:** landed 0024 through the repository's own intake semantics (0021's eleven
files are a strict subset of 0024's forty-two; both patch instructions were removed
in the commit that executed them). Then rewrote the script's runner handling: it
resolves a working pytest up front and refuses to run without one, and treats any
exit code above 1 as "no verdict" rather than as an empty failure list.

**Evidence:** 348→**393** Python tests passing. Two new tests in
`tests/test_patch_intake.py` cover the missing runner and the crashing runner; both
fail against the old script.

---

## G2 — A paid product with no database behind it *(the clearest no-shell violation)*

**Found:** `app/api/stripe/webhook` wrote a completed GridForge Intelligence
checkout to `rest/v1/subscriptions`; `app/api/subscription-status` read it to gate
`/account`; `app/api/scenarios` gated every read and write on it.
**No migration created either table** — `supabase/migrations/` stopped at `0007`
plus the `0008` that arrived inside the unapplied patch.

The failure was not merely unhandled, it was **invisible**. PostgREST answers a
missing relation with HTTP 404; `fetch` does not reject on 404; every call site
wrapped its request in a `catch` that only catches a throw. So:

- the insert failed with **no log line at all**;
- `/api/subscription-status` answered `200 {active:false}` — a claim about the
  *customer* — and `/account` showed a paying subscriber the upgrade prompt;
- `/api/scenarios` answered `200 {ok:true, scenarios:[]}` to a save that never
  happened.

Three further defects were found inside the same path:

- **b.** The webhook stored only the session and customer ids. Even with the table
  present, `customer.subscription.deleted` had nothing to resolve against, so a
  cancelled subscription would have stayed active forever.
- **c.** `SUBSCRIPTION_LOOKUPS` in `tests/test_stack_consistency.py` carried the
  comment *"add a third recurring product and it belongs here, or its cancellation
  will be silently unhandled."* Intelligence was the third. It was never added.
- **d.** The welcome email was sent on a write that had failed.

**Fixed:** migrations `0009_subscriptions.sql` and `0010_scenarios.sql`, including
the column cancellation needs and a partial unique index enforcing one active
subscription per email. One server-only data layer, `lib/subscribers.ts`, modelled
on the repository's existing `lib/watches.ts`: every request checks `res.ok`, the
write is idempotent on the Stripe session id, and a failure is logged loudly.
All three routes now use it, all three lifecycle events resolve `subscriptions`,
and a write that fails returns 500 so Stripe redelivers instead of the customer
being welcomed to nothing.

**Evidence:** 40 executable tests across `tests/site/scenarios.test.ts`,
`webhook.test.ts`, `subscription-status.test.ts`. Against the pre-fix code
**13 of 24** scenario tests and **9 of 16** webhook tests fail. Full purchase →
cancellation cycle driven over HTTP against a production build.

---

## G3 — The paid AI analyst was free whenever Supabase was unset

**Found:** `app/api/siting-analysis` wrapped its entire subscription check in
`if (url && skey)`. With Supabase unconfigured the gate was not merely open, it was
**not executed** — the subscriber-only analyst answered anybody who posted an email
address and a sentence. A surface that reads as protected and is not is worse than
one that is openly free, because nobody looks.

**Fixed:** the gate goes through `lib/subscribers.ts` and fails closed: 503 when the
store cannot be reached, 402 when the caller is genuinely not a subscriber.

**Evidence:** `tests/site/siting-analyst.test.ts`, 9 tests; **5 fail** against the
pre-fix route, including the unconfigured-Supabase case.

---

## G4 — A cancelled Hall Watch kept being delivered

**Found:** reported in the prior forensic pass; `customer.subscription.deleted` and
`invoice.payment_failed` resolved only `api_accounts`.

**Status: already fixed by patch 0024**, which this mission landed. Verified rather
than re-implemented — `tests/test_stack_consistency.py` asserts the join for every
recurring product, and this mission extended that assertion to the third product.

---

## G5 — The site layer had no executable test of any kind

**Found:** `package.json` declared no test runner. Every assertion about a Next.js
route was a regex over its source text, run from Python or from `node -e` in CI. A
regex can see that a handler *mentions* `status: 402`; it can never see whether it
returns one. No route handler had ever been executed by a test, and nothing drove
checkout → webhook → entitlement → delivery.

This is the reason G2 and G3 survived several releases.

**Fixed:** `vitest` as a devDependency, `npm test`, and `tests/site/` — which
imports the real route modules and calls them with real `Request` objects.
`tests/site/postgrest-fake.ts` is an in-memory PostgREST that can be told a table
does not exist, and then answers **404 without throwing**, exactly as the real one
does. A stub that threw would have let the original code pass.

Coverage follows the mission's checklist: malformed input, missing input, empty
input, oversized input, invalid state, authentication (forged and unsigned Stripe
signatures), authorization, cross-tenant read and delete, duplicate delivery,
unconfigured dependencies, and a store that is present but refusing.

**Evidence:** **59 tests**, wired into the CI `site` job ahead of `npm run build`.

---

## G6 — Two structural guards added, so this class cannot recur silently

1. `test_every_table_the_site_reads_or_writes_has_a_migration` — scans every
   `rest/v1/<table>` in `app/`, `lib/`, `components/` and fails if no migration
   creates it. This is the only join in the repository between our code and a
   database that is not in the repository, and it is exactly where G2 hid.
2. `test_no_route_reaches_supabase_without_checking_whether_it_worked` — the
   mechanism behind every bug above. It immediately found two more offenders
   (`app/api/chat`, `app/api/siting-analysis`), both now fixed.

---

## G7 — Open, and deliberately not decided here

`lib/subscriptions.ts` holds the Intelligence plan prices as `priceCents`
(€499 / €1,999 / €4,999 a month) and renders them through a formatter. The
repository's "one price list" rule says a euro figure may appear only in
`lib/products.ts`, but the guard looks for the `€` character, so a cents-denominated
price is invisible to it.

**Not fixed, on purpose.** Whether a recurring software subscription belongs in a
catalogue of engine engagements is a commercial decision, not a refactor. What this
mission did instead is make the exception *visible*:
`test_no_price_hides_from_the_guard_by_being_written_in_cents` declares each file
allowed to carry a cents price and the reason, and fails if a second one appears.

**Recommended next action:** decide whether Intelligence folds into
`lib/products.ts`, then delete the exception.
