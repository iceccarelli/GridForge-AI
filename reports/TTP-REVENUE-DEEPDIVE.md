# Time to Power Revenue Deep Dive — 2026-10-01

## Tip

- Repository: `iceccarelli/GridForge-AI`
- Branch base: `origin/main`
- Verified tip SHA: `90720d36b38dc99a62380dab1e571bd3b89255d8`
- Production domain: `https://timetopower.ai`
- Engine app: `gridforge-engine` (Fly configuration in `fly.toml`)
- Working branch: `feat/ttp-money-engine-20261001`
- Catalogue source: `lib/products.ts`
- Checkout: `app/api/checkout/route.ts`
- Webhook: `app/api/stripe/webhook/route.ts`

This report is derived from the code at the tip above plus current market-source verification. Live production rows are marked HUMAN_ONLY where this execution environment could not establish network access to the production domain or Vercel project scope. No live Stripe session has been claimed from source code alone.

## Phase 0 — architecture map

### A. Commercial / money path

| Layer | Actual implementation |
|---|---|
| Catalogue | `lib/products.ts`: Density Screen, study deposit, portfolio deposit, Procurement Specification, Hall Watch, API tiers, Intelligence plans |
| Checkout client | `lib/checkout.ts`, `lib/ui.ts` |
| Checkout server | `app/api/checkout/route.ts` — Stripe Checkout `price_data.unit_amount` comes from catalogue |
| Post-payment | `app/api/stripe/webhook/route.ts` |
| Deliverables | `lib/deliverables.ts` |
| Intake | `lib/engagement-intake.ts`, `app/api/intake/[token]/route.ts` |
| Paid fulfilment | catalogue `endpoint` -> engine `/v1/screen`, `/v1/study`, `/v1/spec` |
| Human release | `app/api/admin/deliverables/route.ts`, customer surface `/deliverable/[token]` |
| API entitlement | `lib/api-access.ts` -> signed engine key |
| Subscriptions | `lib/subscribers.ts`, `lib/subscriptions.ts` |
| Hall Watch | `lib/watches.ts`, cron route under `app/api/cron/watches` |
| Capability map | `lib/capability-registry.ts` |
| Stripe health | `lib/stripe-health.ts`, admin health route/tests |

### B. Engine bridge / AI

| Layer | Actual implementation |
|---|---|
| Website qualifier | `lib/qualify.ts` -> `GRIDFORGE_API_URL/v1/qualify` |
| AI orchestration | `lib/ai/agent.ts` |
| Tool registry | `lib/ai/tools.ts` mirrors `gridforge/api/tools.py` |
| Tool execution | `lib/ai/tools.ts::callEngineTool` -> real engine HTTP |
| Paid AI gate | `lib/ai/entitlements.ts`, HTTP 402 for entitlement/quota problems |
| MCP | engine `POST /mcp`, defined in `gridforge/api/tools.py` |
| REST discovery | engine `GET /v1/tools` |
| Tool set | qualify, screen, study, portfolio, diff, spec, bids, proposal, power assess, BTM deploy assess/spec and related capabilities |

The AI surface is not a prose-only wrapper: `gridforge_qualify` executes the real engine, and a successful qualifying constraint is translated into a catalogue-backed Density Screen commercial action.

### C. Physics / reporting

- Scenario solve and envelope: `gridforge/scenario/*`, `gridforge/envelope/*`, `gridforge/serialize.py`
- Screening: `gridforge/reporting/screen.py`
- Study: `gridforge/reporting/study.py`
- Procurement: `gridforge/reporting/spec.py`
- BTM assessment: `gridforge/reporting/btm_assessment.py`
- BTM equipment specification: `gridforge/reporting/btm_spec.py`
- Power readiness: `gridforge/reporting/readiness.py`
- Cost library: `gridforge/costs.py`
- Calibration: `gridforge/calibration.py`
- Evidence / quantities: `gridforge/common.py`, `gridforge/validation.py`
- The engine explicitly runs report gates before rendered output leaves the engine.

### D. BTM

Customer surface:

- `/power/deploy`
- `/api/power/deploy/cases`
- `/api/power/deploy/cases/[token]`
- `lib/power-deploy.ts`
- `gridforge/reporting/btm_assessment.py`
- `gridforge/power/btm.py`

The web path calls `/v1/power/deploy/assess` and persists case revisions when Supabase is available. The web path currently has no Stripe entitlement gate. The capability registry labels it `metered_only` because REST/MCP access is monetized through API plans while the web form remains free.

### E. Metering / subscriptions

- `gridforge/api/metering.py`: units, per-endpoint rates, quota enforcement, optional durable usage file.
- `gridforge/api/tiers.py`: public/private redaction.
- Paid engine calls return 402 when entitlement/quota is the problem; 429 remains the rate-limit semantic.
- `GRIDFORGE_USAGE_FILE` must be backed by a writable Fly volume for durable metering.
- API subscriptions are opened by Stripe webhook -> `api_accounts` -> signed key.
- Renewals/cancellations/payment failure are handled in the same webhook for API, Hall Watch, and Intelligence.

### F. Navigation / IA

- `lib/nav.ts`
- `components/SectionNav*`
- global CTA wiring via `lib/ui.ts`, `components/StickyMobileCTA.tsx`
- `app/page.tsx`, `app/qualify/page.tsx`, `app/pricing/page.tsx`, `app/workspace/page.tsx)
- The workspace AI commercial action resolves back to the same catalogue product.

### G. Capability registry / health

`lib/capability-registry.ts` is materially useful: it records the engine capability, REST endpoint, MCP tool, CLI command, web route, persistence, entitlement, status, and production status. It explicitly exposes BTM web as free today and marks its Stripe product as `none`.

`lib/stripe-health.ts` validates the live Stripe account's configured webhook endpoint and required event subscriptions, but this environment could not access the connected Vercel/Stripe account scope, so no live health verdict is claimed.

### H. Money-path tests

The tip contains targeted tests for:

- `tests/site/checkout.test.ts`
- `tests/site/checkout-origin.test.ts`
- `tests/site/webhook.test.ts`
- `tests/site/stripe-health.test.ts`
- `tests/site/catalogue-parity.test.ts`
- `tests/site/sell-surface.test.ts`
- `tests/site/power-deploy.test.ts`
- `tests/site/power-deploy-routes.test.ts`
- `tests/site/ai-core.test.ts`
- `tests/site/chat-agent.test.ts`
- `tests/site/workspace-session.test.ts`
- `tests/site/capability-registry.test.ts`
- Python catalogue parity and engine/API/reporting tests under `tests/`

Most important regression gap found: the checkout route validates a caller-supplied `product`, but an invalid `product` (or an alias such as `productId`/ `sku`) currently falls through to the legacy €5,000 engagement-reservation deposit. That creates the wrong sell if a caller intended a catalogue product. The existing test actually codifies that fallback, so the defect can pass CI.

### I. Deploy / environment

Exact environment names read by the tip include:

`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `RESEND_API_KEY`, `RESEND_FROM`, `LEAD_FROM_EMAIL`, `LEAD_TO_EMAIL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `GRIDFORGE_API_URL`, `GRIDFORGE_API_KEY`, `GRIDFORGE_ADMIN_KEY`, `GRIDFORGE_KEY_SECRET`, `NEXT_PUBLIC_SITE_URL`, `SITE_URL`, `ADMIN_PASSWORD`, `CRON_SECRET`, `SLACK_WEBHOOK_URL`, `EIA_API_KEY`, `NEXT_PUBLIC_FORMSPREE_ID`, `FORMSPREE_FORWARD_ID`.

Fly runtime settings in `fly.toml` include `GRIDFORGE_RATE_LIMIT`, `GRIDFORGE_ALLOWED_ORIGINS`, `GRIDFORGE_USAGE_FILE=/data/usage.json`, with a `gridforge_data` volume.

## Live truth table

The production domain and the Vercel project could not be reached from this execution environment. The GitHub tip has a successful Vercel status for the current main commit, but that is build/deployment status, not live application behavior. The following rows are therefore intentionally marked HUMAN_ONLY unless the source itself proves a route-level fact.

| Probe | Status | Source expectation |
|---|---|---|
| GET / | HUMAN_ONLY | route exists |
| GET /qualify | HUMAN_ONLY | route exists |
| GET /pricing | HUMAN_ONLY | route exists |
| GET /workspace | HUMAN_ONLY | route exists; noindex |
| GET /dashboard | HUMAN_ONLY | auth-gated |
| GET /settings | 404 | no `app/settings` route exists at tip |
| GET /account | HUMAN_ONLY | auth-gated account surface |
| GET /developers | HUMAN_ONLY | route exists; public API catalogue |
| GET /intelligence | HUMAN_ONLY | route exists; subscription-gated content |
| GET /power/deploy | HUMAN_ONLY | free web BTM surface |
| GET /commissioned | HUMAN_ONLY | payment handoff surface |
| GET /admin | HUMAN_ONLY | password/admin gated |
| POST /api/chat | HUMAN_ONLY | real AI->engine tool path in source |
| POST /api/checkout density_screen | HUMAN_ONLY | real Stripe call in source; live/test mode not established here |
| POST /api/checkout malformed product | LIVE_BROKEN in source contract | currently falls through to legacy deposit; fixed in this cycle |
| POST /api/checkout other catalogue products | HUMAN_ONLY | route accepts catalogue ProductIds |
| Stripe webhook | HUMAN_ONLY | signature + event handlers exist; Dashboard registration not independently verified |
| Engine /health, /v1/version | HUMAN_ONLY | route exists in engine source |
| Engine /v1/qualify | HUMAN_ONLY | public real solver |
| Engine /v1/screen | HUMAN_ONLY | paid real solver |
| Engine /v1/power/deploy/assess | HUMAN_ONLY | paid REST/MCP real BTM solver |
| Engine telemetry asset source | STUB / NOT WIRED | `TelemetrySource` is a dormant port |
| GridOS economics | STUB / OPTIONAL | adapter exists but package is not part of core zero-dependency engine |

## Business truth from code

### What a stranger can buy today

The strongest self-serve path is:

1. free qualifier / workspace
2. real engine identifies the binding constraint
3. catalogue-backed Density Screen CTA
4. Stripe Checkout
5. `checkout.session.completed`
6. deliverable row + intake token
7. customer intake
8. real `/v1/screen` generation
9. human review and release

The catalogue currently contains these real commercial products: Density Screen (€4,500), Capacity & Density Envelope Study deposit (€9,000 against the engine's stated band), Portfolio Screen deposit (€15,000 against its catalogue/engine band), Procurement Specification (€18,000), Hall Watch (€6,000 per quarter), three API subscriptions (€900/€2,900/€7,500 per month), plus the separate Intelligence plan family in `lib/products.ts`.

No new price or ProductId is proposed by this report.

### What is received after payment

- Fixed-fee deliverables: intake link, then generated document, then reviewed release.
- API plans: signed API access record/key path.
- Hall Watch: persisted watch row plus scheduled re-solves.
- Intelligence: subscription entitlement row and account-gated dashboard.
- A failed fulfilment returns 500 so Stripe redelivers rather than treating an orphaned payment as successfully delivered.

### Where the product is still a shell

1. `/settings` is a source-level 404.
2. BTM web assessment is real computation and persistence, but is free on the web and has no catalogue-backed one-off checkout product.
3. Live telemetry connectors are not implemented; `TelemetrySource` is explicitly dormant.
4. GridOS is an optional adapter, not a production-required capability.
5. The live status of Stripe mode, webhook registration, Resend, Supabase, and engine deployment cannot be proved from this execution scope.
6. Portfolio Screen and some other bespoke engagements remain human-run after payment rather than an automatic fulfilment pipeline.

### Where the product can mis-sell

The primary concrete code defect is checkout fallback. The route accepts:
`{product: "density_screen"}` correctly, but an invalid/alias selector can become `engagement_deposit` instead of failing. That can charge a real but different product.

That is more dangerous than a 404 because it turns an integration error into a real transaction for the wrong commercial object.

### Scarce compounding asset

The compounding asset is not a prettier UI and not generic calculation code. It is the customer-specific, vendor-neutral decision record:

- the named binding constraint for the actual hall;
- a time-to-power critical path;
- a costed relief ladder with evidence classes/provenance;
- customer-supplied and later observed data that raises evidence classes;
- site-specific supplier responses tied back to rack count and energisation date.

Every paid hall can add observations, real quotations, and change history. That is the dataset that is not available from a free calculator.

## Market reverse-engineering — current bar

### Schneider

Schneider's TradeOff Tools are free interactive, science-based calculators covering data-center power sizing, capital cost, PUE/efficiency, cooling, UPS, and other planning questions. Its power sizing tool lets a user configure server/storage/design attributes and explore scenarios; its capital-cost tool covers liquid cooling and high-density power distribution. Source: Schneider Electric TradeOff Tools and power sizing pages.

Schneider's EcoStruxure IT Advisor is materially beyond a calculator: it advertises a live data-center digital twin combining asset, power, cooling and environmental data, plus capacity planning and predictive impact analysis.

Implication: Time to Power must not charge for generic calculator output. The paid wedge is site-specific constraint binding + time-to-power + relief ladder + evidence/provenance, with live ingest where actually available.

### Siemens

SENTRON Powercenter 3000 monitors low-voltage power and condition data, stores/export data, supports Modbus TCP/RTU integration and cloud MQTT, and Siemens positions Powermanager as an EMS/EPMS for data centers. Siemens also markets integrated BMS/EPMS/SCADA/DCIM and digital-twin simulation for AI data-center infrastructure.

Implication: Siemens already owns operational telemetry/controls. Time to Power should compete as an independent decision layer or consume Siemens data, not attempt to become a replacement EPMS.

### GE Vernova

GE Vernova FLEXIQ provides plant-control/SCADA functions, active/reactive power control, scheduled dispatch, grid services, remote monitoring and historical plant views.

Implication: do not build another asset-control product. Win upstream of the controls decision, or ingest actual asset state when a buyer has it.

### OpenEMS

OpenEMS is open-source energy-management software for monitoring/control/integration of storage, renewables and other devices, with an edge stack that communicates with devices and executes control algorithms.

Implication: telemetry/control alone is not scarce. The commercial layer must turn site evidence into a purchase-grade constraint/relief decision.

### OpenInfra

OpenInfra is an open co-simulation framework for datacenters, power plants and cooling systems. Its README states it can manage UPS state/power limits, simulate battery charge/discharge and control rack loads.

Implication: another simulator is not enough. The paid value must be the actual site decision, evidence, schedule and procurement path.

### DCGen

DCGen is an open-source datacenter configuration generator covering IT, cooling and power-distribution configurations, including AI training/inference, rack/row/pod architecture, redundancy, safety margin and simulation-ready JSON.

Implication: design generation is commodity/free. Time to Power needs to answer what binds at an existing site and what action changes the energisation date.

### datacenter-mcp-server

The examined `Hempstead/datacenter-mcp-server` fork describes eight MCP calculation tools for cooling load, power redundancy, tier classification, commissioning, rack density, GPU cooling, UPS/battery sizing and reference lookup. It is MIT-licensed and intended for direct agent use.

Implication: a tool registry by itself is not the moat. Time to Power must return the decision object that a free calculator cannot: constraint + schedule + evidence + commercial next action.

### Vertiv

Vertiv publishes an AI Reference Design Selector, retrofit designs and interactive UPS runtime tools. It also markets a Transition Design service explicitly including site assessment, modelling and solution design for AI retrofits.

Implication: vendor reference designs are strong free/lead-generation alternatives, and paid vendor services already exist. Time to Power must stay vendor-neutral and explicitly bind answers to the customer's actual site conditions rather than vendor reference conditions.

## SCARCE VALUE

The three defensible paid things are:

1. **Site-specific binding constraint**: which physical limit actually wins at this hall after all relevant constraints are solved together.
2. **Energisation path**: which relief changes the date, by how much, and what dependency currently makes that date credible or not.
3. **Evidence-backed commercial decision record**: provenance, evidence class, customer measurements, supplier responses and later observed outcomes tied to the same model.

A generic calculator can compute components. A controls vendor can operate assets. An open simulator can explore scenarios. The scarce combination is the customer-specific, auditable decision trail that tells the buyer what to do next and can be re-solved when evidence changes.

## MONEY RANKING

This is a commercial-leverage ranking, not a prediction of sales volume.

| Rank | Slice | Customer | Existing leverage | Real APIs | Cash mechanism | Kill criterion |
|---|---|---|---|---|---|---|
| 1 | Density Screen money-path hardening | Human buyer with an existing AI-density hall | `/workspace`, `lib/ai/*`, `lib/products.ts`, checkout, webhook, intake, `/v1/screen` | Stripe, engine `/v1/qualify` + `/v1/screen` | existing `density_screen` | any selector can silently create the wrong Product/price, or paid screen cannot be fulfilled |
| 2 | BTM -> existing paid engagement handoff | Asset/site owner with a BTM constraint | `/power/deploy`, `btm_assessment.py`, procurement/spec routes | `/v1/power/deploy/assess`, later `/v1/spec` | only existing catalogue products; no new price | assessment ends at a free result with no honest existing purchase path |
| 3 | Real telemetry ingest connector | Site operator / asset owner | dormant `TelemetrySource`, BTM and envelope models | one real vendor/EMS/DCIM connector | API plan or existing engagement depending buyer path | connector only returns fixtures or cannot carry source evidence into solver |
| 4 | Agent-native commercial parity | Portfolio software / AI agent | `gridforge/api/tools.py`, MCP, signed keys, metering | REST + MCP | existing `api_triage/scale/platform` | agent gets generic calculation but not evidence/schedule/commercialAction |
| 5 | Cost-library calibration loop | Engineering buyer | `gridforge/costs.py`, bids/spec | supplier responses via existing bids/spec flow | existing Procurement Specification / Study | paid work does not add firm/budgetary quote evidence to the library |
| 6 | Hall Watch conversion | Existing screened hall | watch + readiness + cron | engine `/v1/power/assess` | existing `hall_watch` | renewal sends no new site-specific delta |
| 7 | Portfolio screening automation | Fund / colo portfolio team | portfolio engine + API plans | `/v1/portfolio` | existing API subscriptions + portfolio deposit | output is only ranked numbers and not tied to the buyer's capital/energisation decision |

## Phase 1 — slice executed this cycle

### #1 selected

**Checkout money-path hardening.**

Reason: the Density Screen path already exists end-to-end and uses an existing catalogue ProductId. The remaining concrete defect is more serious than UI polish: malformed product selectors can silently enter a different existing charge path. The safest revenue move is to make an incorrect integration fail before Stripe creates any session.

### Change

`app/api/checkout/route.ts` now rejects an explicit but invalid `product`, and rejects legacy selector aliases such as `productId`, `sku`, `product_id`, `priceId`, or `price_id` instead of interpreting them as an engagement reservation.

The legacy reservation remains available only when no product selector is supplied, preserving the pre-existing reservation flow without allowing a malformed catalogue purchase request to fall through to it.

Tests are changed accordingly in `tests/site/checkout.test.ts`.

No ProductId, euro amount, Stripe secret, or price was added or changed.

## Do-not-build this cycle

- new BTM one-off SKU or euro amount without catalogue evidence
- hardware CapEx delivery claims
- second Stripe stack
- generic chat wrapper
- admin dashboard cosmetics
- fake customer/uptime/savings proof
- live telemetry without a real connector
- additional market-research museum pages
- RFQ theatre before a paid engagement requires it

## Human blockers

These cannot be proven from this execution scope:

- Vercel production `STRIPE_SECRET_KEY`
- Vercel production `STRIPE_WEBHOOK_SECRET`
- Stripe Dashboard webhook at `https://timetopower.ai/api/stripe/webhook`
- webhook subscription for `checkout.session.completed`, `invoice.paid`, `customer.subscription.deleted`, `invoice.payment_failed`
- Vercel production `RESEND_API_KEY` + `RESEND_FROM`
- Vercel production `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`
- Vercel production `GRIDFORGE_API_URL` + `GRIDFORGE_API_KEY`
- Fly `GRIDFORGE_API_KEYS` / `GRIDFORGE_KEY_SECRET` / durable `GRIDFORGE_USAGE_FILE`
- first real buyer completing the Density Screen purchase and human release

## Post-change verification boundary

This session could verify repository state and GitHub checks but could not establish production HTTP behavior because timetopower.ai egress/DNS access is blocked and the connected Vercel scope returns 403. Any production Stripe prefix (`cs_live_` vs `cs_test_`) therefore remains HUMAN until someone with the live account runs the checkout smoke.

## Next EUR move

Make the first real Density Screen sale, then use that paid hall as the seed for the calibration/cost library: every customer measurement, real supplier quote, and observed outcome should tighten the next screen while the catalogue stays unchanged.

