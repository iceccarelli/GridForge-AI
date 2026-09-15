# GF-001 — Deployment Report

## STATUS

**PARTIAL** — and deliberately so. The branch is deployable and every gate is
green, but one step in this report **must be performed by a human against the
hosted Supabase project** before the GridForge Intelligence subscription fulfils.
That step is a production schema change, which is exactly the kind of decision the
mission says to stop at and report rather than perform unilaterally.

Everything else was verified running.

---

## WHAT WAS TESTED

A full local deployment of the real stack, on the production build:

| Component | How it was started | Verified |
|---|---|---|
| Capacity engine | `python -m gridforge serve --port 8080` | `/health` → `{"ok":true,"service":"gridforge","version":"0.9.0"}`; `/v1/version` lists 16 endpoints; `/v1/qualify` answered live |
| Website | `npm run build && npx next start -p 3000` | 44 routes compiled; site root 200 |
| Data layer | local PostgREST stand-in built **from `supabase/migrations/*.sql`** | Created exactly the tables those files declare, and 404'd on any other |

The site was pointed at both over real HTTP (`GRIDFORGE_API_URL`, `SUPABASE_URL`)
and driven through the free funnel and the full purchase→cancellation cycle.

---

## WHAT ACTUALLY WORKS

- **Production build is clean.** `npm run build` compiles; `/q/[token]` is present
  and `/infrastructure` is gone, matching what patch 0024 claimed.
- **The engine deploys unchanged.** `fly.toml` / `scripts/deploy-engine.sh` were
  not touched by this mission. The engine still has no dependencies, no database,
  and starts in under a second.
- **CI now gates the site layer.** The `site` job runs `npm ci` → `tsc --noEmit` →
  `next lint` → **`npm test`** → `npm run build`. The new step sits *before* the
  build, so a broken route handler fails the job rather than shipping.
- **No new runtime dependency.** `vitest` is a devDependency. The Python engine's
  zero-dependency guarantee is untouched — `pyproject.toml` is unchanged.
- **No secret was added, read, or committed.** All local testing used placeholder
  values in a scratchpad file outside the repository.

---

## WHAT DOES NOT WORK

**The two new migrations have not been applied to the hosted Supabase project.**

Until they are, `subscriptions` and `scenarios` do not exist in production, and the
GridForge Intelligence subscription does not fulfil. What this branch changes is
that the failure is now **loud** instead of silent:

| Surface | Before this branch | After, with migrations un-applied | After, with migrations applied |
|---|---|---|---|
| Stripe webhook | `200` + welcome email, nothing stored | `500` — Stripe redelivers; the write is idempotent so nothing double-issues | `200`, row written |
| `/api/subscription-status` | `200 {active:false}` — told a paying customer they had not subscribed | `503` — names the fault as ours; `/account` shows "we could not check your subscription" | `200 {active:true, plan}` |
| `/api/scenarios` | `200 {ok:true, scenarios:[]}` on a save that never happened | `503` | full save / list / delete |

That is an improvement, not a fix. The fix is the migration.

Not exercised, and named rather than implied: Stripe's live API, Resend email,
Anthropic model calls.

---

## MOCKS / PLACEHOLDERS REMAINING

None in shipped code. One declared test double in the test tree
(`tests/site/postgrest-fake.ts`), used by `npm test` and by the local end-to-end
run, which exists to reproduce a missing table honestly.

---

## KNOWN RISKS

- **Deploying the code before the migrations** puts the Intelligence surface into
  its loud-failure state: customers can still reach checkout, and Stripe will
  retry the webhook and eventually mark the event failed in the dashboard. If the
  gap between deploy and migration will be more than minutes, take the
  `/intelligence` plan buttons down first.
- **Order matters the other way round too, but harmlessly**: the migrations are
  `create table if not exists` and additive, so applying them *before* the code
  deploy is safe and is the recommended order.
- `subscriptions_one_active_per_email` is a partial unique index. If the table is
  ever populated by hand with two active rows for one email, the index creation
  will fail. It is a new table, so this cannot arise on first application.

---

## COMMERCIAL WORKFLOW

Verified end to end locally against the production build — purchase → entitlement →
paid surface → cross-tenant isolation → retry grace → cancellation → surface closes.
The one unverified link is Stripe's own Checkout Session creation, which needs live
keys.

---

## DEPLOYMENT — the exact order

```bash
# 1. Schema first. Additive and idempotent; safe to run before the code deploy.
#    Supabase → SQL Editor → Run, in this order:
#      supabase/migrations/0008_qualification_token.sql   # arrived with patch 0024
#      supabase/migrations/0009_subscriptions.sql         # new in GF-001
#      supabase/migrations/0010_scenarios.sql             # new in GF-001
#      supabase/migrations/0011_one_fulfilment_per_payment.sql   # new in GF-001

# 2. Engine (unchanged by this mission; skip if already deployed)
bash scripts/deploy-engine.sh

# 3. Site — Vercel picks up the branch on merge. Confirm these are set:
#      SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
#      STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET
#      GRIDFORGE_API_URL, GRIDFORGE_API_KEY
#      NEXT_PUBLIC_SITE_URL=https://timetopower.ai

# 4. Prove it — see VERIFICATION CRITERIA below, which is now a command rather
#    than a checklist somebody has to remember.
```

Verify locally first, exactly as this session did:

```bash
python3 -m pytest tests -q        # 397 passed
npm ci && npm test                # 102 passed
npx tsc --noEmit && npx next lint && npm run build
```

## VERIFICATION CRITERIA — now executable

The blocker used to be a paragraph asking a human to remember a checklist. It is a
command:

```bash
# 1. READ ONLY. Must pass before any deploy touching a paid surface.
SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… \
  node scripts/verify-entitlement.mjs --schema
```

Exits non-zero and names the missing table. Verified both ways in this session:
**14/14 against a database with the migrations, and a fail naming the exact missing table without** — failing on exactly
`subscriptions` and `scenarios`.

```bash
# 2. The whole cycle, through the LIVE webhook with a correctly signed event.
SITE_URL=https://timetopower.ai \
SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… STRIPE_WEBHOOK_SECRET=whsec_… \
  node scripts/verify-entitlement.mjs --full --yes-write-to-this-database
```

29 criteria: not-a-subscriber → forged webhook refused → purchase recorded →
entitlement live on the right plan → redelivery does not double-issue → exactly one
active row → the subscription id cancellation needs was stored → paid surface
accepts a write and reads it back → failed payment does not lock out → cancellation
withdraws → paid surface closes. It writes under a marked `gf-verify+…@` address
and deletes those rows in a `finally` block. **Verified locally: 29/29, cleanup
confirmed.**

The second flag is required because it writes to whatever database you point it at.
Read the URL it prints before you pass it.

## COMMERCIAL PASS CRITERION

GF-001 is commercially complete when, and only when, `--full` reports 29/29 against
`https://timetopower.ai` and the hosted Supabase project. Until then this mission is
PARTIAL, whatever CI says.

## NEXT ACTION

1. Apply `0009_subscriptions.sql`, `0010_scenarios.sql` and `0011_one_fulfilment_per_payment.sql` to the hosted project.
2. `node scripts/verify-entitlement.mjs --schema` → expect 14/14.
3. Deploy the branch.
4. `node scripts/verify-entitlement.mjs --full --yes-write-to-this-database` →
   expect 29/29.
5. One real purchase in Stripe **test mode** through `/intelligence`, to exercise
   Checkout Session creation — the one link no script here can stand in for.


## A note on `0011`

`0011_one_fulfilment_per_payment.sql` creates three **partial unique indexes** on
tables that may already hold rows. If one fails to create, it has found something
worth knowing: two fulfilments already exist for a single payment. Nothing is
damaged — the migration stops — and the duplicates want resolving before it is
re-run. That is the intended behaviour and it is why the index is worth having.
