# Execution state (factual handoff)

Updated: 2026-10-21. Branch `claude/trusting-ramanujan-ytb6t2`, based on `origin/main` ea719e1 (PR #67 merged).
Rule for this file: record what was built and what was actually run. An intention is not an entry.

## What exists now, beyond PR #67
- Free developer allowance and PAYG on the engine: signed `trial` / `payg` keys whose quota is the cap, an append-only
  JSONL ledger, `/v1/estimate`, operator `/v1/admin/ledger` and `/v1/admin/economics`, idempotency that survives restarts
  (REST and MCP), batch-safe refunds, a 150-character idempotency-key bound, strict cost-file validation.
- Website billing: free accounts, usage API, PAYG enable (Stripe setup mode), cap change by key rotation, card replacement,
  billing portal route, daily ingest + settlement + alerts + reminders cron, payment-failure notice, funnel and economics
  admin views. Migrations 0028, 0030-0037 (0029 intentionally unused; apply in filename order).
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

## Tests actually run on the final tree (local, 2026-10-21)
- `python3 -m pytest` with a local PostgreSQL 16: 1842 passed, 1 skipped, then 3 guard tests fixed (see commit e0d001a).
- `npx vitest run`: 1497 passed, 169 skipped (the skips are the real-database files when no stack is up).
- Real PostgreSQL 16 + PostgREST 12.2.3 via `scripts/realdb-up.sh`, all 8 `*.realdb.test.ts`: 129 passed, 24 skipped.
- `npm run lint`, `npm run build`: clean. `npm run verify:local`: 105/105. Browser journeys: 36 renders, 8 journeys.
- Not run: anything against live Stripe, live Supabase, Vercel crons, Resend, or the deployed engine. Stripe is a fake client
  in every test. `docs/10_PAYG_LAUNCH_CHECKLIST.md` lists what the owner must verify in test mode.

## Known failures and blockers
- The deployed engine (gridforge-engine.fly.dev) is older than this repository: `python3 scripts/check-engine-drift.py`
  reported /v1/compare, /v1/power/*, /v1/revoke missing. Needs a redeploy with Fly credentials (not done).
- Vercel deployment details and Stripe were not reachable from this environment.
- Real-database concurrency tests (provider-spend, ttp-quotation) failed under CPU load from parallel agents and passed on
  a quiet machine; treat a single failure there under load as a timing artefact only after re-running quietly.

## Next tasks, in order
1. Deploy the engine, apply migrations to a staging database, run the Stripe test-mode script in the checklist.
2. Confirm Vercel ran each cron; confirm the Stripe Billing Portal is configured; set `FUNNEL_REF_KEY`.
3. Decide the transformer replacement lead-time default (160 weeks, E0, banded): it is labelled everywhere it sets a date.
4. Collect real paid-demand evidence (the funnel panel measures it from now; there is none before this ships).
