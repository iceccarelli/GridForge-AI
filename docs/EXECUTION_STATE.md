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
Those items were closed by PR #73 and the work logged below: public surfaces follow the deployed engine, subscription refund/dispute holds and the past_due grace exist,
`checkout.session.completed` now fails closed on `payment_status`, JSON-LD and the reference pages are corrected. What remains is listed in the latest entry.

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

## Log: 2026-10-24 (second pass), branch `claude/lucid-cannon-4dzp8k`, based on origin/main c62c03d (PR #73 merged; main CI #245 green)
Built (all local/test infrastructure; nothing applied to production):
- Checkout funnel (migration 0042): closed events `checkout_attempted` / `checkout_session_created` (Stripe returned a URL, NOT a payment) / `checkout_failed` with one of eight fixed
  reasons; props are only the catalogue `kind` and `reason`; recording is best-effort and bounded (<= 600 ms per event) and cannot change a checkout. The admin funnel report has a checkout
  section with measured counts, derived rates (n/a when the denominator is 0) and an explicit "requests, not unique buyers" note. `/api/checkout` now has a request limit (60/hour per caller,
  fails closed), prototype keys are not products (400), malformed email / over-long company or service is refused as the buyer's input, and a Stripe session without a URL is a 502 failure.
- Qualifier -> Density Screen -> paid webhook -> intake is proved end to end in `npm run verify:local` (170 assertions, real engine, production build): one deliverable per payment, linked to the
  validated qualification, intake seeded from it, duplicate/concurrent/unpaid/refused/failed paths asserted. `checkoutIsPaid` fails closed (only `paid` / `no_payment_required`; an absent
  `payment_status` answers 500 for redelivery); every checkout test fixture states `payment_status` through one builder, with a guard test. `tests/e2e/browser-journeys.mjs` is MANUAL (no CI job).
- Billing (migration 0043): a pause starts when the paid period ends (not when it is set); stacked refund/dispute/pause holds no longer lose each other; disputes are decided from Stripe's
  current dispute state in any event order; a refund or dispute of a PAYG settlement invoice is recorded append-only (`payg_settlement_reversals`), never edits the ledger or settlement, and a
  full refund or a dispute suspends further PAYG use reversibly (operator release row / dispute won / a later paid settlement lifts it). Stripe calls on these paths are bounded to 8 s.
- CI: the real-database job now runs the 0041, 0042 and 0043 migration tests (fail, never skip).
Tests actually run on the final tree (sequential, quiet machine): vitest 2068 passed / 191 skipped; `tsc`, `next lint`, `next build` clean; `verify:local` 170/170; python (no DB) 1796 passed / 371 skipped;
all migration suites on a throwaway PostgreSQL 16 with `GRIDFORGE_REQUIRE_DB=1`: 396 passed, 0 skipped. Not run here: the `*.realdb.test.ts` files (need PostgREST; CI runs them), anything against live Stripe/Vercel/Fly.
Owner decision (narrow): a FULL refund of a PAYG settlement suspends further PAYG use automatically (conservative, reversible); a goodwill refund therefore needs an operator release. To flag only, change
`wantsHold` in `reverseSettlement` (lib/payg-refunds.ts) so only disputes suspend. Undelivered operator mail answers 500 for Stripe retry when mail is configured, and 200 with a logged error when mail is not configured at all.
Operator steps that remain: apply 0041, 0042 and 0043 through the gated process (the code degrades safely without them; the funnel report says "unavailable" without 0042); enable charge.refunded,
charge.dispute.created, charge.dispute.updated, charge.dispute.closed on the Stripe endpoint; redeploy the engine (FLY_API_TOKEN + the deploy-engine workflow) so suspensions can revoke keys at the engine;
set GRIDFORGE_KEY_SECRET (same value on Vercel and Fly) and GRIDFORGE_ADMIN_KEY on Vercel; production Stripe is on TEST keys until the owner switches them.
Known limits: access changes from the daily job can lag up to ~24 h; Intelligence entitlement does not re-check Stripe on a lost resume event (the daily job clears it); the 8 s Stripe bound does not cover
the settlement invoice calls in lib/payg-billing.ts.

## Observatory first milestone (branch claude/observatory-first-milestone)
- /observatory: engine-modelled synthetic halls (public/observatory/scenarios.json, generated by scripts/build-observatory.py from the repo's own engine; CI byte-diff; contentSha256 verified by the loader), power path, rack rows, constraints, alternatives, a context panel whose every figure carries source, time and basis (rendered per request so retrieval times are real). 2D SVG always; three.js (0.186, no React peer) loaded only after feature detection; reduced motion renders on demand.
- /observatory/presenter: noindex, no site shell, no link, no API call; a pure function of `?t=` (`freeze=1` for frame-exact capture). A real stepped recording of the 3:52 journey was made with observatory-broadcast (h264 1280x720 15 fps, silent AAC, mov_text captions, manifest with frame hash); it is not committed (30 MB).
- observatory-broadcast/: scene -> capture/encode -> publish, supervisor, fallback slate, approval gate, URL guard. NOT connected to any platform: no YouTube/Kick/RTMP verifier exists, none of them can report "live", and no real connection was made. Operator steps and the argv exposure of the ingest URL are in its README.
- Independent security, honesty and accessibility reviews were run; their findings are fixed with regression tests except those listed in the README (argv exposure, residual lock-break window, all redirects refused).
