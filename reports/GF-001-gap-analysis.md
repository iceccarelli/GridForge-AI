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

## G7 — A second price list, invisible to the guard that exists to stop them *(resolved)*

`lib/subscriptions.ts` held the Intelligence plan prices as `priceCents`
(€499 / €1,999 / €4,999 a month) and rendered them through a formatter. The
repository's "one price list" rule says a euro figure may appear only in
`lib/products.ts` — but the guard looks for the `€` character, so a
cents-denominated price was invisible to it. A second fee structure, in plain
sight, that nothing could see.

**First position, and it was wrong.** This was initially left open on the reasoning
that "a recurring software subscription is not an engine engagement, so whether it
belongs in the catalogue is a commercial decision". The catalogue contradicts that:
`lib/products.ts` already prices `hall_watch`, which recurs, and `api_triage` /
`api_scale` / `api_platform`, which are metered software subscriptions involving no
engineering hours at all. Intelligence is the same shape as those and was simply
missing. The evidence was in the file the whole time.

**Resolved.** The prices moved to `INTELLIGENCE_PLANS` in `lib/products.ts`;
`lib/subscriptions.ts` keeps only the sales copy — tagline, features, which tier is
highlighted — and reads name and price from the catalogue. Its public API is
unchanged, so `/intelligence` and `/api/subscribe` were untouched; verified live
rendering €499 / €1,999 / €4,999 from the catalogue.

The guard exception is **deleted**, because the exception no longer exists.
`tests/test_catalogue_parity.py` gains four checks, including the rule already
applied to the API plans: a monthly subscription must stay clearly under the
flagship study, or a buyer is comparing a JSON feed with an engineering opinion
that carries a named signatory and finding them similarly priced.

---

## G8 — The €4,500 product refused the customer it was designed for *(resolved)*

**The defect, quantified.** The free qualifier answers on **seven** numbers. The
paid engagement form demanded **twelve**. The five extra were `siteName` and
`hallId` — identity, fair to require — and three physics numbers the free tier had
never needed:

| Field | Where a customer gets it |
|---|---|
| `firmCapacityMVA` | the DSO connection agreement |
| `floorLoadingKPa` | the structural record for the hall |
| `plantCapacityKW` | the mechanical schedule for the chilled-water plant |

None is on an operations engineer's desk. So a customer ran the qualifier, saw a
real binding constraint, paid €4,500 — and was then blocked. **The buyer most
likely to convert was the one most likely to be stopped, after paying.**

**The engine had already ruled on it.** A missing required field is a *gap*, not a
rejection; `can_issue` goes false and `engagement_recommendation` reads *"Sell the
Density Screen instead: it produces the binding constraint and the data-request
list"*. The Density Screen **is** the product for thin data, and its form would not
accept thin data.

**The cheapest real test, run before changing anything.** Asked directly with those
three removed, the engine returns:

```
FULL intake   binding: Rack feed / tap-off rating   completeness 0.688   gaps 5
THIN intake   binding: Rack feed / tap-off rating   completeness 0.500   gaps 8
```

Same binding constraint, same basis, same rack counts — on the customer's own E5
figures. Only the gap count moves, and **the gaps are the deliverable**. (Note the
"complete" form submission is itself only 0.688 complete by the engine's standard:
the twelve fields were an arbitrary subset, never the engine's requirement.)

**Resolved — product-aware, not weakened.**

- `screenIntakeSchema` — the Density Screen requires what the free qualifier
  requires and no more. The three become gaps.
- `engagementIntakeSchema` — the €18,000 Procurement Specification still requires
  all of them. That document states duties a supplier quotes against and a purchase
  order is raised from; sizing plant from an assumed plant capacity is not a gap in
  a report, it is a number on an order.
- `intakeSchemaFor(kind)` — an unknown kind gets the **strict** shape, so a product
  added to the catalogue without a decision costs a form field rather than a wrong
  number in a specification.

**The floor is deliberate.** Nothing below the free tier's own bar: a Screen built
on fewer numbers than the qualifier answers on would have no site-specific content
to sell, and selling one would be worse than the friction removed. Five tests
assert each of the seven is still mandatory.

**Engineering truth preserved, not traded away.** Blanks are sent to the engine as
*absent keys*, never zeroes — a zero asserts the hall has no firm connection. The
form names, before submit, each field it will assume and where to get it; the route
returns the same list on submit; the engine names every assumption in the document
and lists them in the data request. Verified end to end: the released document for
a thin intake declares its assumptions and carries the data-request list.

**Evidence:** 19 unit tests (5 fail against the pre-fix code) and 9 new end-to-end
criteria against the real engine, including *"a Procurement Specification still
refuses the same thin intake"*.
