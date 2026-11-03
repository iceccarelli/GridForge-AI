# Execution state (factual handoff)

Updated: 2026-11-03 (see the first entry below; the rest is dated where it was written).
Rule for this file: record what was built and what was actually run. An intention is not an entry.

## 2026-11-03 (milestone): buyer journeys, server-rendered homepage, market-figure audit, diagrams
- **Homepage is a Server Component.** `components/HomeClient.tsx` (one 610-line client component) is replaced by `app/page.tsx` assembling `components/home/*`. Client code remains only where the browser is needed: the checkout button, the section navigation, the allowance form, and `LazyIsland`, which mounts the live market view, the comparator, the free-check insights and the time-to-power planner when scrolled near (heights reserved). The FAQ is native `<details>`. `ScopingAgent` in the layout is now the launcher only; the conversation (`ScopingAgentPanel`) is a separate chunk requested on hover, focus or press, and is a labelled dialog that takes focus, closes on Escape and returns focus. `lib/cta.ts` holds the CTA label outside any client module.
- **Lab measurement (production build output, one machine, not real-user data):** `/` route JS 16.4 kB -> 5.55 kB, first-load JS 159 kB -> 136 kB. In a Chromium run of the production build on a 375 px and a 1440 px viewport: no horizontal overflow; layout shift 0 to 0.0001 while scrolling the whole page; no request to the chat endpoint, the chat chunk or the market feeds before the reader scrolls or presses; LCP 130-150 ms on localhost (meaningless as a field number). INP and field LCP/CLS at the 75th percentile are NOT measured; they need real-user data.
- **Seven buyer pages** (`/for`, `/for/<slug>`; `lib/audiences.ts`): written from each buyer's decision, with the constraints most likely to decide it, a route through the catalogue (prices and turnaround read from `lib/products.ts` through `lib/audience-links.ts`), what to ask us, and what the result is not. A test fails if two buyers' text overlaps, a route starts expensive, a price is typed, or a constraint slug does not exist. Own share cards, sitemap, lastmod and llms.txt entries.
- **Market figures audited** (`lib/market-evidence.ts`, shown on `/evidence#market-figures`): the check of 2026-11-03 read JLL's page (primary) and found CBRE, Uptime and Mainova only through press coverage (labelled so). Withdrawn because no source was found or the wording contradicted one: "160+ weeks, up from 120 in 2024 (Data Center Knowledge)", "fewer than 4% of facilities host 100 kW+", "Amsterdam queue ~10 years", "Frankfurt before 2030" (the utility says mid-2030s), and the precise "82%" (reported as "more than 80%"). `docs/04_MARKET_EVIDENCE.md`, which `lib/site.ts` cited, never existed; the register replaces the citation. **Still open, deliberately not changed here because they are engine assumptions or generated reference text:** `gridforge/power/constraints.py` (assumption label "120 weeks in 2024, 160+ weeks in 2026"), `gridforge/reference/catalogue.py` and `public/reference/constraints*.json` (transformer relief risk "120-160+ weeks"; "82%" in the cooling-architecture sources), `docs/02_ENGINEERING_REFERENCE.md`. They need an owner decision and an engine redeploy.
- **Diagrams** (`components/diagrams/*`, server-rendered, no script): the grid-to-compute chain linking the thirteen public constraints, a synthetic-hall chart of racks placed against rack power (the closed-form `I = P / (sqrt(3) V pf)`, data also given as a table), and the evidence boundary (measured/observed/modelled/assumed over the engine's eight classes; a test fails if a class is unbanded).
- **Accessibility fixes found by axe in a real browser:** the `faint` text colour (3.3:1) is now 5.4:1 on the page background; a definition list in the wrong order; inline links distinguished only by colour; a scrollable table region that could not take focus. Not done: a full manual keyboard and screen-reader pass, and WCAG 2.2 target-size is not fully clean on pages outside this change.
- **Repository identity:** root `README.md`, package keywords, PyPI readme. The GitHub repository description and topics still advertise equipment and need the owner (no tool here edits them).
- Not done: Next.js 16 upgrade evaluation, the dependency vulnerability audit, a measured Framer Motion/recharts/three removal beyond the homepage, the developer-documentation drift generator, and any real-user measurement.

## 2026-11-03: share cards, one business entity, question-and-answer markup, portfolio browser journey
- **Share images**: every indexable page now carries exactly one `og:image` and `twitter:image` (1200x630 PNG). Constraint, platform and product pages render their own card from their page data (`lib/share-content.ts`, file-convention `opengraph-image`/`twitter-image`); the static pages use a registry (`lib/page-cards.ts`, served by `app/cards/[file]` which answers only registered names). Cause of the earlier gap: a page's `openGraph` replaces the root layout's, so five pages had no image; `OG_BASE` now carries only type, site name and locale.
- **One entity**: a single Organization node with a stable `@id` (full on `/` and `/about`, a reference everywhere else), WebSite, logo and founder nodes (`lib/entity.ts`); `/about`, `/contact.vcf` (name, URL, email only), `/.well-known/security.txt`, web manifest, PNG icons, `favicon.ico`, apple-touch icon, theme colour. No address, phone, social account or rating is stated because none is recorded; `SITE.social` stays empty.
- **Question-and-answer markup**: constraint and platform pages show the questions on the page and emit FAQPage JSON-LD from the same array (`lib/qa.ts`); answers use only reference fields, lead times are called indicative.
- **Checks**: `scripts/check-share-cards.mjs` runs against the built site in the site CI job (144 tag checks across 16 pages, run here). Unit tests cover cards, entity and Q&A; the full `tests/site` run passed (2916).
- **Portfolio hall-list form** has a browser journey (`tests/e2e/portfolio-journey.mjs`; 375 and 1280 px, template, local refusals, duplicate hall refused by the server, five-hall CSV, per-hall packs, 409 on resubmit). It passed here. It is manual: Playwright is not a project dependency, so CI does not run it.
- Not proven: how any third-party scraper or preview (Google, Facebook, WhatsApp, LinkedIn) renders these cards; that needs the live URL after deploy.

## 2026-11-02 (review): independent recomputation of the engine; five defects fixed, five questions left open
Three read-only reviewers recomputed the electrical, thermal and schedule/economics logic from first principles on the reference hall and variants, and a seeded metamorphic sweep (80 halls, 14 properties, `tests/test_metamorphic_properties.py`) checked how answers must move. Fixed, each with a test that fails when the fix is reverted (`tests/test_engine_review_fixes.py`, 35 tests):
- the free qualifier refused any hall with more than 400 free positions over a total nobody gave (found by the sweep);
- a rack's feed current was tested at 400 V three-phase whatever the hall's busway (a 208 V hall passed a 250 A tap-off); the procurement specification now states the same scaled rating;
- a transformer lead time the client supplied kept the library's fixed 80-210 range, so the printed date could sit outside its own range;
- "capex per rack" divided by every deployable rack including those needing no works; it is now per rack the works ADD (no works needed = zero; spend without a rack added = undefined);
- busway capacity is pooled across runs and now says so; `lv.rack_feed_topology = single_run` counts whole racks run by run (reference hall: 12 racks pooled, 8 single-run);
- the published CDU explanation had the direction backwards (duty falls as the approach narrows, not widens).
Left open on purpose (each changes customer-visible numbers and needs an owner or lab decision, not a unilateral edit): (1) `hydraulic_flow` compares the plant's pump flow with the rack's loop flow and does not subtract the existing hall's flow; (2) `plant_capacity` subtracts only IT load (no fan/UPS/pump heat, no plant redundancy); (3) `tcs_supply_achievable` credits a trim chiller at the legacy plant's supply temperature without modelling its capacity; (4) rack peak power (155 kW for GB300) is used in no thermal constraint; (5) a supplied lead time is always E0, so a quotation can never lift a date above "assumed lead time, not a date".
The reference hall's rack counts did not move; its supplied transformer lead time now prints `160 [104-216]` instead of `160 [80-210]`. The engine changed, so it needs a redeploy for the live engine to carry these.

## 2026-11-02 (later): the two deposit products run end to end
- **Envelope Study and Portfolio Screen** are no longer a manual hand-off after payment. Once a deposit is `scoped` (scope note, fee inside the published band, committed date), the operator presses **Open intake** (`POST /api/admin/deposits/[id]/open-intake`): one engagement is created for the deposit (the database's `deliverables_one_per_session` makes it one even for simultaneous requests), and the buyer's private intake link is emailed through the durable outbox. The Study then takes the full single-hall intake and `/v1/study` produces the study, the one-page board summary and the working files. The Portfolio takes a hall list (2 to 15 halls; pasted rows or a CSV; the form shows what it understood; each hall is held to the Density Screen's bar and its blanks are named hall by hall) and `/v1/portfolio` returns the ranking document in both formats and one model pack per hall from one solve. Both go draft -> a named engineer's review -> release, and releasing marks the deposit **delivered**, referencing the engagement by id (never the token).
- A refunded or disputed deposit now holds the engagement opened from it (same precedence as every other one-time purchase; a dispute won lifts exactly its own hold).
- Engine change (`/v1/portfolio` takes `format` md|html and `client`, returns `document` and `model_packs`; the tool schema documents both): **the engine must be redeployed for the Portfolio Screen to generate**. Before that, a portfolio submission is saved and held as `engine_unavailable` with the operator told (the site refuses a portfolio answer that carries no document or packs); the Envelope Study needs no engine change.
- Proven on real PostgreSQL + PostgREST + the real engine (`tests/site/deposit-study.realdb.test.ts`, 6 tests, now in the real-database CI job): not openable before scoping, admin-only, three simultaneous opens give one engagement and one email, the full study journey to release and an automatically delivered deposit, the five-hall portfolio journey (pack per hall, unique pack names per site, release, delivered, packs downloadable as JSON). Not proven: Stripe delivering, Resend delivering, Supabase itself.
- Pack names: the engine names a pack after the site and hall ids; a portfolio hall's site id is now derived from its site name, because otherwise every site is `SITE-1` and two halls both called H1 would have shared a name.

## 2026-11-02: migrations 0044 and 0045 applied, engine redeployed from main
- **0044 (intake evidence) and 0045 (one-time purchase holds)** were applied to production by the owner from a Codespace through `export-prod-data.py` -> `apply-migration.py` (all four gates; backup 0.1 h old with counts equal to live; the first 0045 attempt was REFUSED because the export predated 0044's tables, and passed after a fresh export). The remote history now ends `gf_0043_billing_pause_and_settlement_reversals`, `gf_0044_intake_evidence`, `gf_0045_one_time_purchase_holds` (0044 read back through the Supabase connector; the security advisor shows no `anon`/`authenticated` EXECUTE on `gf_intake_evidence_open`). Row counts unchanged. Not exercised against real payments: the one-time refund/dispute hold has only run against the test database, and the evidence panel has not been used by a buyer.
- **Engine redeployed** from `main` (`scripts/deploy-engine.sh` on a Codespace, Fly account of the owner). `check-engine-drift.py`: no drift, code digest `aada5713e8ad` on both sides, 23 endpoints. A malformed message to `/mcp` now answers 400 (was a silent 202), checked live. `lib/engine-deployed.json` snapshot date moved to this day; the endpoint list is unchanged.
- **Stale after the above and removed**: the fallbacks that dropped `billing_hold` on a 400 in `creditsToward`, `fetchDeliverables` and the one-time hold handler. A failed read there is now an error (Stripe redelivers; credits fail closed), because with 0045 live a 400 is no longer an expected condition. The "evidence not available" (503) path for a missing 0044 was KEPT on purpose: it degrades only for a database without the tables, and a real store fault already fails the submission.
- Merged this day (company repo): #111 trigger privileges, #112, #113/#114 battery credit, #115 generator N+1, #117 `/mcp` -32600 and hermetic tests, #118 a day-of-month time bomb in the PAYG economics test, #119/#120 product pages, #121 `/products` index and structured data, #122 completeness counts only scalar-field gaps (reference hall 0.774 -> 0.839, no headline figure moved), #125 platform pages and `/openapi.json`.
- Time-dependent tests fixed: bid fixtures expiring on 2026-12-31 and 2027-12-31 now run under a pinned `GRIDFORGE_REPORT_DATE` (they would have failed from 2027-01-01 and 2028-01-01); the sitemap date test no longer races midnight UTC.
- Generation start-up is built as a per-unit `operating_mode` (`continuous` | `standby`, declared by the customer; undeclared changes nothing and the result says so) on the BTM deployment assessment, with `startup_time_min` declarable; the engine was redeployed with it (code digest `841bbb4d504e`, no drift, 2026-11-02), and the ApiPlan docstring that contradicted the scope-out was corrected in the same change. Lab-side oracles for the changes above are requested in iceccarelli/gridforge-stress-test#38.

## 2026-10-28: YouTube verifier in the broadcast tool
`observatory-broadcast` can now reach state `live` for the youtube adapter, but only on YouTube's own answer: with `OBS_YOUTUBE_OAUTH_*` set it makes read-only Data API calls (scope `youtube.readonly`) and confirms ONE active broadcast that is `live`, a stream that is `active` and healthy, and a privacy equal to `--visibility`; every other case fails closed with the reason. New commands `obs youtube-auth` (device sign-in, token stored 0600, never printed) and `obs youtube-check`. Without credentials nothing changes. Tested against a fake Google/YouTube (26 tests; four decision rules mutation-checked); NOT yet run against the real YouTube API, because no OAuth client exists yet. The owner streamed the 60 s recording to YouTube from a Codespace on 2026-10-28 and saw LIVE / "Excellent" in Studio; that was observed in Studio, not by this tool.

## 2026-10-27: migrations 0041, 0042 and 0043 applied to production
Each went through `export-prod-data.py` -> `verify-backup-restore.py` (RESTORE VERIFIED, the other pending migrations rehearsed on the restored rows, no existing row changed) -> `apply-migration.py` (4 gates, backup 0.1 h old with counts equal to live), run by the owner from a Codespace on `main`. The remote history now ends `gf_0041_billing_holds`, `gf_0042_checkout_funnel`, `gf_0043_billing_pause_and_settlement_reversals` (read back through the Supabase connector); `billing_audit` and `payg_settlement_reversals` exist. Row counts unchanged. Production smoke 6/6 and no Vercel runtime errors afterwards.
The "Operator steps that remain: apply 0041/0042/0043" lines further down are therefore done; the other steps in those lists (Stripe webhook events, key-secret parity, admin key, Stripe live keys) are not verified here.
Also: the restore verifier loaded rows with every trigger live and refused a good backup (a released deliverable with no reviewer name, which 0040's guard leaves alone). It now disables the table's user triggers for the scratch load only (PR #84); foreign keys and constraints still apply.

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
- Resolved 2026-10-27: the engine was redeployed from main (scripts/deploy-engine.sh); `python3 scripts/check-engine-drift.py` reports no difference
  and lib/engine-deployed.json lists the 23 endpoints it serves (/v1/compare, /v1/estimate, /v1/power/*, /v1/revoke included). The registry entries ttp_compare,
  btm_deploy_assess, btm_deploy_spec and btm_rfq_loop are "live". Not verified by this change: the site's own platform key (GRIDFORGE_API_KEY) in Vercel production.
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
Operator steps that remained at the time (0041-0043 are applied, see above): apply 0041, 0042 and 0043 through the gated process (the code degrades safely without them; the funnel report says "unavailable" without 0042); enable charge.refunded,
charge.dispute.created, charge.dispute.updated, charge.dispute.closed on the Stripe endpoint; redeploy the engine (FLY_API_TOKEN + the deploy-engine workflow) so suspensions can revoke keys at the engine;
set GRIDFORGE_KEY_SECRET (same value on Vercel and Fly) and GRIDFORGE_ADMIN_KEY on Vercel; production Stripe is on TEST keys until the owner switches them.
Known limits: access changes from the daily job can lag up to ~24 h; Intelligence entitlement does not re-check Stripe on a lost resume event (the daily job clears it); the 8 s Stripe bound does not cover
the settlement invoice calls in lib/payg-billing.ts.

## Observatory first milestone (branch claude/observatory-first-milestone)
- /observatory: engine-modelled synthetic halls (public/observatory/scenarios.json, generated by scripts/build-observatory.py from the repo's own engine; CI byte-diff; contentSha256 verified by the loader), power path, rack rows, constraints, alternatives, a context panel whose every figure carries source, time and basis (rendered per request so retrieval times are real). 2D SVG always; three.js (0.186, no React peer) loaded only after feature detection; reduced motion renders on demand.
- /observatory/presenter: noindex, no site shell, no link, no API call; a pure function of `?t=` (`freeze=1` for frame-exact capture). A real stepped recording of the 3:52 journey was made with observatory-broadcast (h264 1280x720 15 fps, silent AAC, mov_text captions, manifest with frame hash); it is not committed (30 MB).
- observatory-broadcast/: scene -> capture/encode -> publish, supervisor, fallback slate, approval gate, URL guard. NOT connected to any platform: no YouTube/Kick/RTMP verifier exists, none of them can report "live", and no real connection was made. Operator steps and the argv exposure of the ingest URL are in its README.
- Independent security, honesty and accessibility reviews were run; their findings are fixed with regression tests except those listed in the README (argv exposure, residual lock-break window, all redirects refused).

the settlement invoice calls in lib/payg-billing.ts. [Both addressed in the 2026-10-25 entry below.]

## Log: 2026-10-25, worktree branch off origin/main 814dce6 (billing resilience: lost resume event, Stripe timeouts on PAYG settlement)
Built (local/test infrastructure only; nothing pushed, no migration, no live Stripe):
- Lost or late resume event (`lib/pause-reconcile.ts`, one rule for `lookupEntitlement` + seats, the Hall Watch POST route and `mintChecked`): a pause schedule whose instant has passed and that has no separate hold asks Stripe ONCE
  (injectable client, bounded). Billing running again -> the stale schedule is cleared by a conditional write (schedule instant + pause/resume clock + no hold + not ended), one `pause_schedule_dropped` audit row, access granted.
  Still paused/unpaid/canceled, timeout, 5xx, no subscription, no client -> denied, schedule untouched. A hold (refund/dispute/...) or an ended row is denied without a Stripe call. Denials from Stripe are remembered 45 s per process
  (a customer's own key mint ignores the memory); concurrent checks share one call. `billingStopped`/`isPaused` moved to `lib/billing-pause-due.ts` and `recordBillingAudit` to `lib/billing-audit.ts` (re-exported; no behaviour change).
- Stripe timeouts on the PAYG paths (`lib/stripe-timeout.ts` `boundStripe`): `paygStripe()` returns a client with EVERY method bounded (8 s, `STRIPE_CALL_TIMEOUT_MS`), `settleClosedMonths`, `handlePaygEnable` and `handlePaygCardUpdate` bound whatever client they
  get. A timeout carries code `stripe_call_timeout` and is "cannot say": the settlement stays `pending` (never invoiced/paid/failed on a guess), the ledger is untouched, the next run re-reads the invoice/item by its settlement_key metadata
  (idempotency keys `payg:{account}:{month}`, `:item`, `:finalize` on every create) before creating anything. The replaced-card record now moves only after the invoice was pointed at the card. Counted in the cron JSON
  (`settle.timedOut`, `settle.deferred`), mailed once per settlement per day. The invoicing pass has a 120 s budget (`PAYG_SETTLE_BUDGET_MS`), skips an account's later months after its timeout, stops after 3 timeouts in a row, and
  orders rows that already failed behind fresh ones. Webhook handlers answer "retry" on a timeout.
Tests: `tests/site/pause-reconcile.test.ts` (23), `tests/site/payg-timeouts.test.ts` (35); MockStripe gained `hang`/`hangWhen` ("before": never reaches Stripe, "after": takes effect, answer lost). Revert-checked: without the fixes 12 and 33 of them fail.
Not covered: the daily pause pass (`applyDuePauses`) has the per-call bound but no run budget; `app/api/checkout`, `app/api/subscribe` and `stripe-health` build their own Stripe client with the SDK's default timeout (not PAYG paths); `invoices.list` reads the
customer's newest 100 invoices when looking for an earlier attempt.
Review round (same day): reconcile now audits "started" BEFORE the clear and closes after it (keys carry the schedule instant and the pause clock), moves the pause clock in the clearing write (a stale older pause event cannot
re-create the schedule), treats a lost compare-and-set race against another clear as allowed, never remembers a store fault, grants only for an allowlisted status (active/trialing/past_due) of the same subscription, and
reads Stripe with a 2.5 s bound on the request path. /api/scenarios and /api/siting-analysis refuse unverified sessions (403) before any entitlement lookup. SDK timeout = bound + 1 s, no SDK retries; the SDK's own timeout error counts as a
timeout. Settlement: breaker resets only after a Stripe answer, budget (90 s) also checked between Stripe steps, rows ordered by last touch, a void/uncollectible invoice is never marked invoiced (pending + operator mail), a
StripeIdempotencyError is answered by re-listing by settlement_key (never a second invoice). Daily pause pass: 60 s budget and a 3-failures-in-a-row breaker (`pauses.unreached`).
OWNER DECISION (documented, not changed): "billing running at Stripe" is treated as entitled, not "current period paid": a subscription paused across a renewal and resumed has access from the resume until its next invoice settles,
as the daily job already does.
Third look (independent read-only review of the delta): same-subscription check now requires the answer to name the subscription asked about; finalise-key stability and the card-replaced repoint are pinned by tests; the void/uncollectible operator mail states the real (manual, database-side) resolution. Known and left: no automated path resolves a settlement whose invoice was voided outside the system. Closed since: the webhook pause writer is conditional on the schedule, pause clock and hold it read (lost race: one re-read and re-evaluation, raced twice: 500 so Stripe redelivers; `tests/site/billing-pause-race.test.ts`), and the daily pass (after its notices, bounded by the remaining budget) answers an unclosed `pause_schedule_drop_started` whose subject has no schedule, no hold and is not ended with a DIFFERENT row, `pause_schedule_drop_unconfirmed` (claims only "found clear", never "dropped": it cannot know who cleared it; `billing_audit.action` is unconstrained so no migration). Checked once against real PostgreSQL 16 + PostgREST 12.2.3 (the CAS filter matches exactly the row as read; a stale clock, a hold, a cleared schedule match nothing). Still no conditional write after an earlier read, all fail closed and left deliberately: `extendScheduledPause` (a maximum, order-independent; an `ifFrom` could lose a legitimate extension another writer moved), `reassertPause` (re-reads Stripe and the rows itself and is retried whole on failure), `promote` (re-asks Stripe after the hold and undoes it if billing resumed).
Engine redeploy (2026-10-27): the owner redeployed gridforge-engine from main with scripts/deploy-engine.sh. Its post-deploy checks all passed (one machine mounting gridforge_data, durable counter and ledger, payg published, secrets untouched) and `check-engine-drift.py` reports zero differences (23 endpoints; 16 before). Fly showing the app "Suspended" is the machine idling by design (`auto_stop_machines = "suspend"`, `min_machines_running = 0`); it wakes on the next request and nothing needs restarting. deploy-engine.sh now refuses (exit 4) unless the files the image is built from are identical to origin/main, committed and clean (the drift check compares against the checkout, so a stale branch would otherwise report no drift); GRIDFORGE_DEPLOY_ANY_REF=1 overrides it loudly and the workflow never sets it. Not checked by the deploy: revocation persistence (needs GRIDFORGE_ADMIN_KEY exported, never printed).
