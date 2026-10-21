---
name: gridforge-product-completion
description: Execution rules for finishing and commercially validating the existing GridForge products (free qualifier, pay-as-you-go engine metering, API plans, engagements, Hall Watch, Intelligence). Use when changing pricing, metering, billing, entitlements, checkout, webhooks, migrations, catalogue copy or deployment config in iceccarelli/GridForge-AI.
---

# GridForge product completion

## Boundary
Only `iceccarelli/GridForge-AI`, its Time-to-Power site, the configured engine (`GRIDFORGE_API_URL`, currently `https://gridforge-engine.fly.dev`) and the deployment files in this repo. Never touch other projects. Never run production migrations, live charges, refunds, customer email tests, force pushes or a production deploy without explicit authorisation. Stripe work uses test mode / injected fakes; a mock never proves a live service.

## One source of truth
- Prices, plans, PAYG scheme: `gridforge/commercial.py` <-> `lib/products.ts` (`PAYG`, `PRODUCTS`, `INTELLIGENCE_PLANS`). `tests/test_catalogue_parity.py` parses the TypeScript; add a parity test for any new commercial fact. Never hand-type a price table in a component.
- Per-endpoint unit weights: `gridforge/api/metering.py` `UNIT_COST`; published at `/v1/version`, `/v1/tools` and `public/reference/tools.json`.
- Seat limits: `lib/team.ts`, migration 0027 `gf_plan_seats`, `INTELLIGENCE_PLANS.seats`.

## Free / PAYG invariants
1. `/v1/qualify` and MCP `gridforge_qualify` are free, need no key, never touch an allowance or the ledger.
2. Over quota is 402, never 429. A 402 names the real next step.
3. PAYG is explicit opt-in (card saved via Stripe `setup` mode, nothing charged at enable). Free-allowance accounts are never invoiced.
4. The customer's cap is the signed key's unit quota; `trial` and `payg` keys with quota 0 are refused.
5. Charge = net ledger units (charges minus refunds of calls that produced no answer) x `PAYG.unit_price_cents`, invoiced in arrears, idempotency key `payg:{account}:{YYYY-MM}`; months under `min_invoice_cents` carry forward.
6. Failed/rejected/unauthorised requests are refunded by a compensating ledger event. A retry with the same `Idempotency-Key` is never charged twice, across restarts.
7. payg/trial keys fail closed (503) when the ledger cannot be written.
8. Rate limits (429), provider-spend guard (`lib/rate-limit.ts`) and billing units are three different controls; keep all consistent.

## Physics and evidence
Evidence classes E0..E7; arithmetic carries the weakest input class. Missing cost / lead time / availability is never zero and never yields a date. The calibration ledger is empty: every study, `/v1/calibration` and every API response says so. LLM output never changes an engine number. A fixture is not calibration.

## Migrations
Additive only; next number after the highest in `supabase/migrations`; mirror in `supabase/schema.sql`; RLS on, no policies; privileges per 0020; a Python migration test per migration; real-DB variants under `tests/site/*.realdb.test.ts` (skipped without local Postgres — say so). Never rewrite append-only commercial records.

## Ownership when working in parallel
Lead: catalogue constants, integration, git. Engine billing: `gridforge/api/*`. Website billing: `lib/payg-*`, `app/api/{payg,usage,free-account,cron/payg}`, webhook PAYG branches, migrations. Delivery: deliverables/deposits/watches/supplier evidence. UI: pages/components. Physics: `tests/test_physics_*.py` and physics modules. QA reviews, never self-approves.

## Tests to run
`npm run typecheck && npm run lint && npm run test && npm run build`, `npm run verify:local`, `python3 -m pytest -q -p no:cacheprovider`. Baseline on a249c28: pytest 899 passed / 165 skipped; vitest 956 passed / 147 skipped. Never delete, skip or weaken a test to get green.

## Deployment truth
The engine on Fly is a single machine with one volume (usage, ledger, revocations are local state): never scale to 2 machines without shared storage. Before trusting the live engine run `python3 scripts/check-engine-drift.py` (read-only): the repo's `ROUTES` must be served by the deployed engine.

## Handoff notes
Keep a short factual log at the bottom of `docs/EXECUTION_STATE.md` (branch, commit, behaviour implemented, tests actually run, failures, next task). Never record an intention as done.
