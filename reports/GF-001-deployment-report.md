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

# 2. Engine (unchanged by this mission; skip if already deployed)
bash scripts/deploy-engine.sh

# 3. Site — Vercel picks up the branch on merge. Confirm these are set:
#      SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
#      STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET
#      GRIDFORGE_API_URL, GRIDFORGE_API_KEY
#      NEXT_PUBLIC_SITE_URL=https://timetopower.ai

# 4. Prove it, in Stripe test mode, against the hosted project:
#      subscribe → /account shows the plan → save a scenario → cancel in Stripe
#      → /account drops to the free view
```

Verify locally first, exactly as this session did:

```bash
python3 -m pytest tests -q        # 393 passed
npm ci && npx tsc --noEmit && npm test && npm run build
```

## NEXT ACTION

Apply `0009_subscriptions.sql` and `0010_scenarios.sql` to the hosted Supabase
project, then run step 4 above. That closes the one link this session could not.
