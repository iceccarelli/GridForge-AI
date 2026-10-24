# Execution state (factual handoff)

Updated: 2026-10-22. Follow-up branch `claude/ci-green-and-integrity-0040`, based on `origin/main` 052166c (PR #68 and #69 merged).
Rule for this file: record what was built and what was actually run. An intention is not an entry.

## What exists now, beyond PR #67
- Free developer allowance and PAYG on the engine: signed `trial` / `payg` keys whose quota is the cap, an append-only
  JSONL ledger, `/v1/estimate`, operator `/v1/admin/ledger` and `/v1/admin/economics`, idempotency that survives restarts
  (REST and MCP), batch-safe refunds, a 150-character idempotency-key bound, strict cost-file validation.
- Website billing: free accounts, usage API, PAYG enable (Stripe setup mode), cap change by key rotation, card replacement,
  billing portal route, daily ingest + settlement + alerts + reminders cron, payment-failure notice, funnel and economics
  admin views. Migrations 0028, 0030-0040 (0029 intentionally unused; apply in filename order). **Production database: all applied through
  0040 on 2026-10-21/22, each through `scripts/export-prod-data.py` -> `verify-backup-restore.py` -> `apply-migration.py` (4 gates).**
  After 0040 the API roles hold no table or `gf_` function privilege, append-only tables have truncate guards, and row counts were unchanged.
  Caps are counted per (account, month, scope) on the engine and on the website.
- Delivery: stuck-generation recovery with a claim-stamp compare-and-set, deposit hand-off ledger with confirmed credits,
  deposit receipt email, release email through the outbox, release hash over every delivered file, required reviewer,
  operator digest, Hall Watch first-run fix and date labels, project limits.
- Physics/evidence: 346+ independent tests, sign-correct division, canonical binding order, evidence on gates, no invented
  BTM price or lead time, "assumed lead time, not a date" everywhere a date rests on an E0 lead time, schedule claim class,
  Procurement Specification section 2A (site conditions and assumed inputs).
- Security: mail relay guards, leads RLS, IPv6 /64 bucketing, admin throttle and session key, verified-identity tokens,
  MCP batch accounting, deadlock fix in revocation, founding-slot reservation, supersede-by-customer rule.
- Site: one formatter for any time-to-power figure (`lib/date-basis.ts`), PAYG rate card and estimator from the registry,
  usage portal, truthful privacy page, corrected plan promises.

## Tests actually run on the integrated head (local, 2026-10-22, sequential, quiet machine)
- `python3 -m pytest` with local PostgreSQL 16: 2086 passed, 1 skipped (before the last review-fix commit; the touched files were re-run: 37 + 156 passed).
- `npx vitest run`: 1621 passed, 191 skipped (the skips are the real-database files when no stack is up).
- Fresh real PostgreSQL + PostgREST stack (`scripts/realdb-up.sh`): all 10 `*.realdb.test.ts` pass, `payg-journey` 13 passed / 1 skipped against the
  real engine process; migration invariant pytest files for projects, calibration capture and integrity hardening: 47, 50, 57 passed.
- `npm run lint`, `tsc --noEmit`, `npm run build`: clean. `npm run verify:local`: 105/105. Browser journeys: 36 renders, 8 journeys.
- `verify-backup-restore.py` on the 2026-10-22 production export: RESTORE VERIFIED (pending 0040 applied cleanly, rows unchanged).
- `check-engine-drift.py`: the deployed engine is still stale (expected; see below).
- Not run: anything against live Stripe, Vercel crons, Resend, or the deployed engine. Stripe is a fake client in every test.

## Known failures and blockers
- The deployed engine (gridforge-engine.fly.dev) is older than this repository: `python3 scripts/check-engine-drift.py`
  reported /v1/compare, /v1/power/*, /v1/revoke missing. Needs a redeploy with Fly credentials (not done).
- Vercel deployment details and Stripe were not reachable from this environment (the Vercel connector needs team access granted by the owner).
- Stripe: Issue #4 stays open until the owner confirms in test mode that the webhook endpoint delivers the 5 required events
  (`REQUIRED_WEBHOOK_EVENTS` in `lib/stripe-health.ts`; 3 more are recommended) and the Billing Portal allows cancel, payment-method update and
  invoice history with plan switching and pause off. `/api/admin/stripe-health` reports both from the live account.
- Database drift to know about: production `leads`, `scenarios` and `subscriptions` carry columns the repo schema does not; platform default ACLs
  for `supabase_admin` still grant anon/authenticated on future tables (existing tables are clean, `rls_auto_enable` is a platform event trigger).
- Real-database concurrency tests (provider-spend, ttp-quotation) failed under CPU load from parallel agents and passed on
  a quiet machine; treat a single failure there under load as a timing artefact only after re-running quietly.

## Next tasks, in order
1. Deploy the engine, apply migrations to a staging database, run the Stripe test-mode script in the checklist.
2. Confirm Vercel ran each cron; confirm the Stripe Billing Portal is configured; set `FUNNEL_REF_KEY`.
3. Decide the transformer replacement lead-time default (160 weeks, E0, banded): it is labelled everywhere it sets a date.
4. Collect real paid-demand evidence (the funnel panel measures it from now; there is none before this ships).

## Log: 2026-10-23, branch `claude/lucid-cannon-4dzp8k`, based on origin/main 9d0c709 (CI green on that commit)
Confirmed against the live system before changing anything: `check-engine-drift.py` still reports 15 differences (the deployed engine lacks
`/v1/compare`, `/v1/estimate`, `/v1/power/*`, `/v1/revoke`, publishes no code digest and no `ledger_durable`); every sitemap `<lastmod>` was the build time.
Built:
- Sitemap `lastmod` is the date a page's content last changed (`scripts/page-lastmod.mjs`, manifest `lib/page-lastmod.json`, `--check` in the `site` CI job).
  Limit: sources are the page file and the data it renders, not the component tree.
- `lib/engine-capabilities.ts`: reads the deployed engine's `/v1/version`. `/llms.txt` advertises `/v1/compare` only while the engine lists it.
  `callEngine` turns the engine's own "not found" for a route into a 503 "not deployed yet, nothing charged" (compare names it plainly).
  New workflow `engine-drift.yml` (push to main, daily, manual) is red while the deployed engine differs from the repository.
- Release gate (`lib/payment-standing.ts`, `app/api/admin/deliverables`): asks Stripe at release time; a fully refunded or disputed payment (409) or one Stripe
  cannot report on (503) is not released unless the operator sends `acknowledge_payment_issue: true`, which is recorded as `review.payment_override`.
  Rows with no Stripe session, or no `STRIPE_SECRET_KEY`, are not checked (logged).
- Metadata: `noindex` layouts for /account, /dashboard, /admin/login; canonical + og for /power/*, /legal/*; `og:image` on every page that set its own openGraph;
  the layout's twitter block no longer hands every page the homepage title.
Tests actually run (local): vitest 1650 passed / 191 skipped; pytest 1756 passed / 332 skipped (no Python changed; real-DB skips); `tsc`, `next lint`, `next build` clean.
Not run: anything against live Stripe, the deployed engine's new routes, Vercel, Search Console.
Open, from this session's audits (not yet fixed):
- /pricing, /developers and `public/reference/tools.json` still list estimate / compare / `power_*` as callable while the deployed engine 404s them. Needs the redeploy (Fly credentials), or per-row "not yet deployed" marking.
- Refund or dispute on a SUBSCRIPTION charge does not touch `api_accounts` / `watches`; a `past_due` API plan keeps an already-minted key (up to 35 days). Product decision needed on revoke-vs-grace.
- `checkout.session.completed` does not check `payment_status` (safe only while checkout is card-only).
- Homepage JSON-LD: deposits marked `InStock`; Hall Watch price has no quarterly recurrence.
- Static `/reference/*.html` have no canonical/description.

## Log: 2026-10-24, branch `claude/lucid-cannon-4dzp8k`, based on origin/main ec9b986 (PR #72 merged; main CI green; production deploy READY on that commit)
Checked against production (read-only): `POST /api/keys` answers 503 "Key signing is not configured on this deployment"; API-plan checkout refuses to sell with
"No payment was taken" (honest); Density Screen checkout creates a `cs_test_` session, so **production Stripe is in test mode**. `GRIDFORGE_KEY_SECRET`,
`GRIDFORGE_ADMIN_KEY`, `RATE_LIMIT_HMAC_KEY`, `INTELLIGENCE_INVITE_SECRET`, `FUNNEL_REF_KEY`, `ADMIN_SESSION_SECRET` are not in the Vercel project's production
variables (shared team variables were not visible to the check). The Stripe webhook endpoint's real event list could not be read (Stripe connector needs the owner's sign-in).
Built (see the PR for the exact commits): public pricing/developers/llms/api-access/power pages follow `GET /v1/version` of the deployed engine (unserved operations are
labelled, never priced, never in a snippet); `lib/engine-deployed.json` snapshot + registry test; JSON-LD deposits carry no availability and Hall Watch carries its
quarterly billing; static reference HTML carry canonicals; manual `deploy-engine` workflow (credential preflight, one machine / one volume, post-deploy drift check);
`check-engine-drift.py --json / --write-snapshot / --summary-file`; Stripe billing holds (refund / dispute / pause suspend paid access, reversible, audited), explicit
7-day past-due grace for API keys, durable unconfirmed-revocation tracking, paid-only checkout fulfilment.
Operator steps that remain (nothing here can be done from the repository):
1. Apply `supabase/migrations/0041_billing_holds.sql` through the gated four-step process BEFORE relying on holds (the code degrades without it, see the migration header).
2. In Stripe, enable on the webhook endpoint: charge.refunded, charge.dispute.created, charge.dispute.closed, charge.dispute.updated (now REQUIRED; /api/admin/stripe-health reports them).
3. Add repository secret FLY_API_TOKEN (`fly tokens create deploy -a gridforge-engine`), run the `deploy-engine` workflow with DEPLOY, then `python3 scripts/check-engine-drift.py --write-snapshot lib/engine-deployed.json` and commit it.
4. Set GRIDFORGE_KEY_SECRET (same value on Vercel and Fly) and GRIDFORGE_ADMIN_KEY on Vercel; API plans sell only after /api/admin/api-readiness reports ready.
5. Switch Stripe to live keys only when ready to take real payments (production is on test keys today).
