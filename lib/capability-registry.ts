// The canonical map of every commercially meaningful capability the company
// has, across every layer that could expose it.
//
// Before this file, "what can we actually sell, and is it actually wired up"
// had no single answer. lib/products.ts is the source of truth for PRICE (and
// stays that way — this file does not duplicate a euro figure anywhere; it
// references PRODUCTS and INTELLIGENCE_PLANS by id). What this file adds is
// the cross-layer view PRODUCTS was never meant to hold: which REST endpoint,
// which MCP tool, which CLI command, which web route, which database table
// and which entitlement mechanism actually implement a given capability —
// and, just as importantly, which of those are honestly absent.
//
// This is what makes it possible to answer, in one place rather than by
// grepping five files: priced but not buyable anywhere, buyable but not
// fulfillable, implemented in the engine but invisible on the website,
// promised on the website but not implemented. scripts/capability-audit.mjs
// prints that report from this data. Keep this file in sync with reality by
// updating it in the same commit as the code it describes — it is a map of
// the territory, not a wishlist for one.
//
// scripts/capability-audit.mjs reads this file as text and checks every layer an entry names against the code (ROUTES and GET_ROUTES in
// gridforge/api/server.py, TOOLS in gridforge/api/tools.py, the subcommands of gridforge/cli.py, the pages under app/, the Stripe
// kinds in lib/products.ts and the webhook, the tables in supabase/migrations, the files engine_capability cites, the deployed-engine
// snapshot) and, the other way round, that every engine route and MCP tool is named here. tests/site/capability-registry-fields.test.ts
// runs it, so a wrong field fails the build.
//
// production_status is a MACHINE-PROVEN claim, not a hope (the audit fails on a breach of any line):
//   live          the entry has a CONCRETE rest_endpoint (not null, no wildcard) and lib/engine-deployed.json lists it. Nothing else can be live.
//   unverified    implemented and exercised by this repository's tests, but its production state cannot be proven from the repository: a
//                 Stripe, database, cron, mail or key-secret path, a feature that lives only in the website build, a wildcard /v1/* plan.
//                 It says nobody has looked; it claims neither that the thing works in production nor that it does not. The website may
//                 still offer it, and its note must say so plainly.
//   not_deployed  a concrete rest_endpoint that the snapshot does NOT list and that nothing else proves live. A route that is in the
//                 snapshot can never be not_deployed (the entry is stale).

import { PRODUCTS, INTELLIGENCE_PLANS, type ProductId, type IntelligencePlanId } from "@/lib/products";

export type CapabilityStatus =
  | "commercial"       // priced, sellable, fulfillable, in production
  | "metered_only"      // consumable through API unit metering, no dedicated one-off SKU
  | "free"              // deliberately free — a qualifier/demo/screening tool
  | "internal_only";    // real engine capability with no customer-facing commercial path yet

export interface Capability {
  capability_id: string;
  family: "engagement" | "recurring" | "api" | "intelligence" | "btm" | "free_tier" | "project";
  name: string;
  description: string;
  /** lib/products.ts ProductId this capability is sold under, if any. Price lives there, not here. */
  product_id?: ProductId;
  intelligence_plan_id?: IntelligencePlanId;
  engine_capability: string; // the Python module/function that actually computes this
  rest_endpoint: string | null;
  mcp_tool: string | null;
  cli_command: string | null;
  web_route: string | null;
  workspace_action: string | null;
  database_record: string | null; // Supabase table, or null if nothing is persisted
  entitlement: string; // how access is actually gated today, stated plainly
  stripe_product_or_price: string | null; // "none" is a valid, honest answer
  deliverable: string | null;
  /**
   * For a "commercial" entry that has no product_id or intelligence_plan_id of its own because it is a mechanism included in priced
   * things (a fulfilment path, a seat count): the ProductIds / IntelligencePlanIds it is included in. The audit requires every
   * commercial entry to say what it is sold under, and every id here to exist in lib/products.ts.
   */
  included_in?: (ProductId | IntelligencePlanId)[];
  status: CapabilityStatus;
  /**
   * What this repository can PROVE about production; scripts/capability-audit.mjs enforces all three lines.
   *
   * "live": `rest_endpoint` is concrete (not null, no wildcard) and lib/engine-deployed.json, the committed snapshot of what the
   * deployed engine served when last read, lists it. Nothing else can be live: an entry that lives in the website build, the database,
   * Stripe or a cron has no machine proof here however well its tests pass.
   *
   * "unverified": implemented and exercised by this repository's tests, production state not provable from it (Stripe, database, cron,
   * mail, key-secret and site-only paths, wildcard /v1/* plans, and a route the live engine serves but a stale snapshot does not list).
   * It claims neither that it works nor that it does not; it says nobody has looked. The website may still offer it, and `notes` must
   * say "production state is unverified".
   *
   * "not_deployed": a concrete `rest_endpoint` the snapshot does not list and nothing else proves live. If the snapshot lists the
   * route the entry is stale and the audit fails.
   */
  production_status: "live" | "not_deployed" | "unverified";
  notes?: string;
}

export const CAPABILITY_REGISTRY: Capability[] = [
  {
    capability_id: "qualify",
    family: "free_tier",
    name: "Free Qualifier",
    description: "One-page free screening: rough headroom for a target platform, no engagement.",
    engine_capability: "gridforge/api/payloads.py:qualify_payload (via gridforge/api/server.py handle_qualify)",
    rest_endpoint: "/v1/qualify",
    mcp_tool: "gridforge_qualify",
    cli_command: null,
    web_route: "/qualify",
    workspace_action: null,
    database_record: "qualifications",
    entitlement: "none required — free over REST, MCP and web by design. The web route (POST /api/qualify) is still limited per caller and counted at the provider gate (lib/rate-limit.ts); it answers 429 over its limit and 503, calling nothing, if the guard cannot decide",
    stripe_product_or_price: null,
    deliverable: "On-page result + optional lead capture",
    status: "free",
    production_status: "live",
  },
  {
    capability_id: "density_screen",
    family: "engagement",
    name: "Density Screen",
    description: "Five-day screening opinion on one hall's deployable capacity.",
    product_id: "density_screen",
    engine_capability: "gridforge/reporting/screen.py",
    rest_endpoint: "/v1/screen",
    mcp_tool: "gridforge_screen",
    cli_command: "gridforge screen",
    web_route: "/pricing",
    workspace_action: "commercial-action:density_screen",
    database_record: "deliverables",
    entitlement: "Stripe checkout -> deliverables row (status awaiting_intake) -> human-released document",
    stripe_product_or_price: "checkout.session, metadata.kind=density_screen",
    deliverable: "Density Screen document (HTML + Markdown)",
    status: "commercial",
    production_status: "live",
  },
  {
    capability_id: "envelope_study",
    family: "engagement",
    name: "Capacity & Density Envelope Study",
    description: "Full constraint ladder, architecture comparison, time to power, economics.",
    product_id: "envelope_study_deposit",
    engine_capability: "gridforge/reporting/study.py",
    rest_endpoint: "/v1/study",
    mcp_tool: "gridforge_study",
    cli_command: "gridforge study",
    web_route: "/pricing",
    workspace_action: "commercial-action:envelope_study_deposit",
    database_record: "engagement_deposits (the payment lands here first, 0019), then deliverables (the engagement opened from a scoped deposit)",
    entitlement:
      "Stripe checkout (deposit) -> engagement_deposits row (paid) -> a named person contacts and scopes it -> POST " +
      "/api/admin/deposits/[id]/open-intake creates one deliverables row and emails the buyer's intake link -> /v1/study -> " +
      "named engineer's review -> release (marks the deposit delivered). See engagement_deposit_flow.",
    stripe_product_or_price: "checkout.session, metadata.kind=envelope_study_deposit",
    deliverable: "Envelope Study (HTML + Markdown) + model_pack.json",
    status: "commercial",
    production_status: "live",
    notes:
      "production_status describes the engine route only (/v1/study is in lib/engine-deployed.json). The deposit-to-delivery path " +
      "has run against PostgreSQL and the real engine in CI, not against a real payment (docs/EXECUTION_STATE.md, 2026-11-02).",
  },
  {
    capability_id: "portfolio_screen",
    family: "engagement",
    name: "Portfolio Screen",
    description: "5-15 halls ranked by deployable compute, time to power and capex per rack.",
    product_id: "portfolio_screen_deposit",
    engine_capability: "gridforge/reporting/portfolio.py",
    rest_endpoint: "/v1/portfolio",
    mcp_tool: "gridforge_portfolio",
    cli_command: "gridforge portfolio",
    web_route: "/pricing",
    workspace_action: "commercial-action:portfolio_screen_deposit",
    database_record: "engagement_deposits (the payment lands here first, 0019), then deliverables (the engagement opened from a scoped deposit)",
    entitlement:
      "Stripe checkout (deposit) -> engagement_deposits row (paid) -> a named person contacts and scopes it -> POST " +
      "/api/admin/deposits/[id]/open-intake creates one deliverables row and emails the buyer's intake link -> the buyer's hall list " +
      "(2 to 15 halls) -> /v1/portfolio -> named engineer's review -> release (marks the deposit delivered). See engagement_deposit_flow.",
    stripe_product_or_price: "checkout.session, metadata.kind=portfolio_screen_deposit",
    deliverable: "Portfolio Screen document + one model_pack.json per hall",
    status: "commercial",
    production_status: "live",
    notes:
      "producesDeliverable:false in lib/products.ts on purpose: the webhook opens no engagement at payment, because the scope and fee " +
      "are agreed with a person first. Once scoped, the operator opens the intake and the rest runs through the site, not the CLI " +
      "(docs/EXECUTION_STATE.md, 2026-11-02, 'the two deposit products run end to end'); `gridforge portfolio` remains the same engine " +
      "call for an operator working offline. production_status describes the engine route only; the path has run against PostgreSQL and " +
      "the real engine in CI, not against a real payment.",
  },
  {
    capability_id: "procurement_spec",
    family: "engagement",
    name: "Procurement Specification",
    description: "Tender-ready technical specification for one relief, plus bid comparison.",
    product_id: "procurement_spec",
    engine_capability: "gridforge/reporting/spec.py",
    rest_endpoint: "/v1/spec",
    mcp_tool: "gridforge_spec",
    cli_command: "gridforge spec",
    web_route: "/pricing",
    workspace_action: "commercial-action:procurement_spec",
    database_record: "deliverables",
    entitlement: "Stripe checkout -> deliverables row -> human-released document",
    stripe_product_or_price: "checkout.session, metadata.kind=procurement_spec",
    deliverable: "Technical specification + response schedule + bid comparison",
    status: "commercial",
    production_status: "live",
    notes:
      "The buyer may choose the relief the specification is written for (intake `constraint`, validated against the engine's 13 constraint ids and the relief list for the hall; recorded in _gridforge.spec_request; a resubmission replaces it). Absent means the engine chooses.",
  },
  {
    capability_id: "procurement_bids",
    family: "engagement",
    name: "Bid comparison (third deliverable of the Procurement Specification)",
    description:
      "Completed supplier response schedules compared against the capacity model in racks, weeks and euros, judged against the " +
      "relief the specification was written for -- not against whatever binds the hall when the quotes come back.",
    product_id: "procurement_spec",
    engine_capability: "gridforge/procurement/evaluate.py:rank_bids (via gridforge/api/server.py handle_bids)",
    rest_endpoint: "/v1/bids",
    mcp_tool: "gridforge_bids",
    cli_command: "gridforge bids",
    web_route: "/deliverable/[token]",
    workspace_action: null,
    database_record: "deliverables (the comparison is stored with the engagement as a working file)",
    entitlement:
      "Web: the holder of a RELEASED Procurement Specification's own document token (POST /api/deliverable/[token]/bids; 409 for any " +
      "other kind or an unreleased document; a refunded or disputed purchase is withheld). REST/MCP: API key + unit metering (2 units).",
    stripe_product_or_price: "checkout.session, metadata.kind=procurement_spec",
    deliverable: "Ranked bid comparison, leading compliant supplier (or none) and the energisation-date effect of each response",
    status: "commercial",
    production_status: "live",
    notes:
      "Part of the procurement_spec purchase, not a separate SKU: its catalogue entry in lib/products.ts promises 'a bid comparison " +
      "against the capacity model'. The same engine route also validates supplier quotation lines for cost_evidence_runs.",
  },
  {
    capability_id: "hall_watch",
    family: "recurring",
    name: "Hall Watch",
    description: "Quarterly re-solve of a hall's model with a change note on what moved.",
    product_id: "hall_watch",
    engine_capability: "gridforge/reporting/change_note.py (re-solved on cron through POST /v1/diff, lib/watches.ts)",
    rest_endpoint: "/v1/diff",
    mcp_tool: "gridforge_diff",
    cli_command: "gridforge diff",
    web_route: "/watch/[token]",
    workspace_action: "commercial-action:hall_watch",
    database_record: "watches",
    entitlement: "Stripe subscription -> watches row -> app/api/cron/watches quarterly re-solve",
    stripe_product_or_price: "subscription, metadata.kind=hall_watch",
    deliverable: "Quarterly change note + on-demand re-run",
    status: "commercial",
    production_status: "live",
    notes:
      "It is bought from /pricing, but the surface the subscriber uses is /watch/[token] (app/watch/[token]/page.tsx): update the hall's " +
      "inputs, read the change notes. production_status describes the engine route (/v1/diff) only.",
  },
  {
    capability_id: "api_triage",
    family: "api",
    name: "API — Triage",
    description: "Metered engine access, 600 units/month.",
    product_id: "api_triage",
    engine_capability: "every /v1/* route, metered by gridforge/api/metering.py",
    rest_endpoint: "/v1/*",
    mcp_tool: "all gridforge_* tools",
    cli_command: null,
    web_route: "/developers",
    workspace_action: null,
    database_record: "api_accounts",
    entitlement: "Stripe subscription -> signed API key (gridforge/api/keys.py), 600 units/month",
    stripe_product_or_price: "subscription, metadata.kind=api_triage",
    deliverable: "Signed API key + MCP endpoint",
    status: "commercial",
    production_status: "unverified",
    notes:
      "The site offers it (/developers) and its tests pass, but its production state is unverified: rest_endpoint is the /v1/* wildcard, so no single route in lib/engine-deployed.json proves it, and the Stripe subscription, the signed key and the engine's key secret cannot be read from this repository. Production state is unverified, not known to be broken.",
  },
  {
    capability_id: "api_scale",
    family: "api",
    name: "API — Scale",
    description: "Metered engine access, 2,500 units/month.",
    product_id: "api_scale",
    engine_capability: "every /v1/* route, metered by gridforge/api/metering.py",
    rest_endpoint: "/v1/*",
    mcp_tool: "all gridforge_* tools",
    cli_command: null,
    web_route: "/developers",
    workspace_action: null,
    database_record: "api_accounts",
    entitlement: "Stripe subscription -> signed API key, 2,500 units/month",
    stripe_product_or_price: "subscription, metadata.kind=api_scale",
    deliverable: "Signed API key + MCP endpoint",
    status: "commercial",
    production_status: "unverified",
    notes:
      "The site offers it (/developers) and its tests pass, but its production state is unverified: rest_endpoint is the /v1/* wildcard, so no single route in lib/engine-deployed.json proves it, and the Stripe subscription, the signed key and the engine's key secret cannot be read from this repository. Production state is unverified, not known to be broken.",
  },
  {
    capability_id: "api_platform",
    family: "api",
    name: "API — Platform",
    description: "Metered engine access, 10,000 units/month.",
    product_id: "api_platform",
    engine_capability: "every /v1/* route, metered by gridforge/api/metering.py",
    rest_endpoint: "/v1/*",
    mcp_tool: "all gridforge_* tools",
    cli_command: null,
    web_route: "/developers",
    workspace_action: null,
    database_record: "api_accounts",
    entitlement: "Stripe subscription -> signed API key, 10,000 units/month",
    stripe_product_or_price: "subscription, metadata.kind=api_platform",
    deliverable: "Signed API key + MCP endpoint",
    status: "commercial",
    production_status: "unverified",
    notes:
      "The site offers it (/developers) and its tests pass, but its production state is unverified: rest_endpoint is the /v1/* wildcard, so no single route in lib/engine-deployed.json proves it, and the Stripe subscription, the signed key and the engine's key secret cannot be read from this repository. Production state is unverified, not known to be broken.",
  },
  {
    capability_id: "intelligence_developer",
    family: "intelligence",
    name: "GridForge Intelligence — Developer",
    description: "Access to the live intelligence dashboard for one seat: the billing owner.",
    intelligence_plan_id: "developer",
    engine_capability: "n/a — reads calibration/usage state, not a new engine capability",
    rest_endpoint: null,
    mcp_tool: null,
    cli_command: null,
    web_route: "/intelligence",
    workspace_action: null,
    database_record: "subscriptions",
    entitlement: "Stripe subscription -> subscriptions row (billing owner) or a subscription_members seat -> /account gated view and subscriber-only routes",
    stripe_product_or_price: "subscription, metadata.kind=intelligence_subscription, metadata.plan=developer",
    deliverable: "Live dashboard access",
    status: "commercial",
    production_status: "unverified",
    notes:
      "The site offers it (/intelligence, Stripe checkout) and its tests pass, but its production state is unverified: it has no engine route, so nothing in lib/engine-deployed.json can prove it, and the Stripe subscription, the subscriptions table and the webhook cannot be read from this repository. Production state is unverified, not known to be broken.",
  },
  {
    capability_id: "intelligence_team",
    family: "intelligence",
    name: "GridForge Intelligence — Team",
    description: "Access to the live intelligence dashboard for up to five seats including the billing owner, who invites and removes members.",
    intelligence_plan_id: "team",
    engine_capability: "n/a",
    rest_endpoint: null,
    mcp_tool: null,
    cli_command: null,
    web_route: "/intelligence",
    workspace_action: null,
    database_record: "subscriptions",
    entitlement: "Stripe subscription -> subscriptions row (billing owner) or a subscription_members seat -> /account gated view and subscriber-only routes",
    stripe_product_or_price: "subscription, metadata.kind=intelligence_subscription, metadata.plan=team",
    deliverable: "Live dashboard access",
    status: "commercial",
    production_status: "unverified",
    notes:
      "The site offers it (/intelligence, Stripe checkout) and its tests pass, but its production state is unverified: it has no engine route, so nothing in lib/engine-deployed.json can prove it, and the Stripe subscription, the subscriptions table and the webhook cannot be read from this repository. Production state is unverified, not known to be broken.",
  },
  {
    capability_id: "intelligence_enterprise",
    family: "intelligence",
    name: "GridForge Intelligence — Enterprise",
    description: "Access to the live intelligence dashboard for any number of seats; the billing owner invites and removes members.",
    intelligence_plan_id: "enterprise",
    engine_capability: "n/a",
    rest_endpoint: null,
    mcp_tool: null,
    cli_command: null,
    web_route: "/intelligence",
    workspace_action: null,
    database_record: "subscriptions",
    entitlement: "Stripe subscription -> subscriptions row (billing owner) or a subscription_members seat -> /account gated view and subscriber-only routes",
    stripe_product_or_price: "subscription, metadata.kind=intelligence_subscription, metadata.plan=enterprise",
    deliverable: "Live dashboard access",
    status: "commercial",
    production_status: "unverified",
    notes:
      "The site offers it (/intelligence, Stripe checkout) and its tests pass, but its production state is unverified: it has no engine route, so nothing in lib/engine-deployed.json can prove it, and the Stripe subscription, the subscriptions table and the webhook cannot be read from this repository. Production state is unverified, not known to be broken.",
  },
  {
    capability_id: "ttp_compare",
    family: "free_tier",
    name: "Time-to-Power Scenario Comparison",
    description:
      "One hall's cooling and supply scenarios side by side: racks as found and after relief, the binding " +
      "constraint, the date to full capacity with its band and evidence class, capital and what is unpriced. " +
      "A scenario with an unknown lead time gets no date; nothing is ranked on a figure it does not have.",
    engine_capability: "gridforge/api/compare_payload.py:compare_payload",
    rest_endpoint: "/v1/compare",
    mcp_tool: "gridforge_compare",
    cli_command: "gridforge compare",
    web_route: "/power/compare",
    workspace_action: null,
    database_record: "project_comparisons (only when the visitor saves it to a project; otherwise nothing is stored)",
    entitlement:
      "REST/MCP: gated by API key + unit metering (1 unit, the same single solve as /v1/screen). Web " +
      "(/power/compare): no entitlement gate and no checkout -- there is no product to buy; the site calls the " +
      "engine with its own platform key, so POST /api/power/compare and POST /api/power/compare/save call " +
      "guardRequest (lib/rate-limit.ts) first, and every engine call is counted at the provider gate. That guard fails closed: it answers 503 until migration 0024 is " +
      "applied to the database the deployment uses.",
    stripe_product_or_price: "none",
    deliverable: "JSON comparison (gridforge/ttp-compare/1) with request digest and engine provenance",
    status: "free",
    production_status: "live",
    notes:
      "Saving a comparison to a project re-asks the engine on the server and stores its answer verbatim " +
      "(0025_project_comparisons_and_shares.sql); the browser never supplies a result. The free web route and an " +
      "unsaved comparison use the library cost basis only, and each scenario says so in its cost basis. Accepted " +
      "supplier cost evidence (0022) is applied to /v1/compare only for the request in hand, and on the web only when " +
      "the holder of a project's token saves a comparison with use_accepted_quotations: the server reads that " +
      "project's own accepted lines, the engine reports which it applied and which steps they repriced, and the saved " +
      "row names them (0026_comparison_quotation_evidence.sql). A caller can never name a line or an amount.",
  },
  {
    capability_id: "project_buyer_page",
    family: "project",
    name: "Shared project page (buyer link)",
    description:
      "A read-only page for a project's latest saved Time-to-Power comparison: the decision, the inputs it rests on, " +
      "the evidence class behind each date, how the capital figure was priced, what is missing, and the next " +
      "engagement to commission. Opened by a revocable link; no account.",
    engine_capability: "none -- a read model over the stored /v1/compare result; nothing is recomputed",
    rest_endpoint: null,
    mcp_tool: null,
    cli_command: null,
    web_route: "/p/[shareToken]",
    workspace_action: "ProjectPanel: Create buyer link / Replace / Revoke (/api/projects/[token]/share)",
    database_record: "project_comparisons, project_shares (hash of the link only), project_events (append-only)",
    entitlement:
      "none -- a bearer link, weaker than the project token: it reads the decision and can start a checkout that " +
      "attaches to the project, nothing else. Only the SHA-256 of the link is stored, one link is active per " +
      "project, and it is revoked or replaced by the project token holder. Checkout: POST /api/checkout with " +
      "project_share_token, the same prices and the same webhook attachment as project_token.",
    stripe_product_or_price: "none",
    deliverable: "A private, noindexed web page; not a document and not sold",
    status: "free",
    production_status: "unverified",
    notes:
      "The site offers it (the project panel's Create buyer link) and its tests pass, but its production state is unverified. It was marked " +
      "not_deployed while nobody had looked; that claimed an absence nobody had seen, and the audit's rule is that not_deployed needs a " +
      "concrete engine route the snapshot lacks, which this page does not have. Prices, turnaround, credits and the order of the next step are read from lib/products.ts through " +
      "lib/buyer-path.ts; no figure on the page is typed there. Verified in this repository: the page, its " +
      "routes and their tests exist, and docs/EXECUTION_STATE.md records the production database as migrated through 0045, which " +
      "includes 0024 (the guard) and 0025 (the tables). NOT verified: that the deployed website build serves /p/[shareToken], or that " +
      "any buyer link has ever been created in production. A read-only probe reported on 2026-11-06 (by the coordinator; not repeated here) got a route-level not-found for /p/abc, as for /intake/abc and /api-access/abc, which is consistent with the route being deployed and proves nothing about a real link. When the " +
      "latest comparison was saved on accepted quotations (0026) the page lists them without supplier names, prices or " +
      "references, says which capital lines are quoted and which are library estimates, and says when the quotations " +
      "have since been replaced, withdrawn or expired.",
  },
  {
    capability_id: "btm_deploy_assess",
    family: "btm",
    name: "BTM Power Deployment Assessment",
    description:
      "Compares real hybrid architectures (grid/generation/BESS) against one load profile " +
      "under a deterministic contingency test, with readiness gates and objective-driven ranking.",
    engine_capability: "gridforge/reporting/btm_assessment.py:assess_deployment",
    rest_endpoint: "/v1/power/deploy/assess",
    mcp_tool: "gridforge_power_deploy_assess",
    cli_command: "gridforge power-deploy-assess",
    web_route: "/power/deploy",
    workspace_action: null,
    database_record: "power_deployment_cases",
    entitlement:
      "REST/MCP: gated by API key + unit metering (5 units, same basis as /v1/study) for " +
      "api_triage/api_scale/api_platform subscribers. Web (/power/deploy): NO entitlement gate " +
      "— free and self-serve, by deliberate decision (see app/api/power/deploy/cases/route.ts) " +
      "because there is no Stripe product for a self-serve web purchase of this capability yet. Not " +
      "unmetered: each case request is limited per caller (deploy_case, lib/rate-limit.ts), its engine call is " +
      "counted against the public metered-engine budget, and the body is refused above the engine's own 512 KiB " +
      "ceiling; it answers 429 over a limit and 503, calling nothing, if the guard cannot decide.",
    stripe_product_or_price: "none",
    deliverable: "power_deployment_cases row (case_token) + JSON assessment",
    status: "metered_only",
    production_status: "live",
    notes:
      "Deployed: the engine on Fly serves /v1/power/deploy/assess (lib/engine-deployed.json, snapshot 2026-11-05). If the " +
      "engine is ever older than this repository again, the web page shows 'not available yet' and the API answers 503 " +
      "with nothing charged. Real gap: priced and sellable through the API today, but not through a direct one-off " +
      "web checkout the way density_screen/procurement_spec are. Before adding a one-off SKU, " +
      "the pricing basis must come from somewhere real (e.g. parity with envelope_study_deposit " +
      "or procurement_spec, both human-reviewed engagements this is not) rather than an invented " +
      "figure. Not yet resolved (the runbook that once discussed it, docs/07_DELIVERY_RUNBOOK.md, was deleted on 2026-10-13 and is not in the " +
      "repository; the request shape is the tool schema served at /v1/tools). Partially mitigated: the case " +
      "page (/power/deploy/[token]) now names the real API tiers as the path to automated/at-scale " +
      "access, rather than leaving the free self-serve tool as a dead end with no commercial next step.",
  },
  {
    capability_id: "btm_deploy_spec",
    family: "btm",
    name: "BTM Equipment Specification",
    description: "Tender-ready equipment spec derived from a selected BTM architecture.",
    engine_capability: "gridforge/reporting/btm_spec.py:build_equipment_spec",
    rest_endpoint: "/v1/power/deploy/spec",
    mcp_tool: "gridforge_power_deploy_spec",
    cli_command: "gridforge power-deploy-spec",
    web_route: "/power/deploy/[token]",
    workspace_action: null,
    database_record: "power_deployment_cases",
    entitlement:
      "REST/MCP: gated by API key + unit metering (3 units, same basis as /v1/spec). Web: no " +
      "entitlement gate, same as btm_deploy_assess.",
    stripe_product_or_price: "none",
    deliverable: "Equipment spec document (HTML/Markdown/JSON) + response template",
    status: "metered_only",
    production_status: "live",
    notes:
      "Deployed: the engine on Fly serves /v1/power/deploy/spec (lib/engine-deployed.json, snapshot 2026-11-05). " +
      "Same open gap as btm_deploy_assess: no dedicated one-off web SKU yet.",
  },
  {
    capability_id: "project_record",
    family: "project",
    name: "Verified Power Record (project)",
    description:
      "One canonical project joining a BTM case, its RFQ package, supplier responses, the " +
      "comparison, the human supplier selection and an evidence inventory, with an append-only " +
      "history. A join layer: the case, the engine results and the prices stay where they live.",
    engine_capability: "none — a persistence layer; every figure is read from power_deployment_cases.result",
    rest_endpoint: null,
    mcp_tool: null,
    cli_command: null,
    web_route: "/workspace",
    workspace_action: "ProjectPanel (?project=<token>) incl. evidence upload",
    database_record:
      "projects, project_links, project_evidence, project_events (append-only, trigger-enforced)",
    entitlement:
      "none — bearer project_token (same magic-link model as case_token); attaching a case also " +
      "needs that case's own token and, when registered, its email. Fails closed (503) without Supabase.",
    stripe_product_or_price: "none",
    deliverable: "A persistent project record; not a document and not sold",
    status: "free",
    production_status: "unverified",
    notes:
      "Evidence files are attached from the project panel (stored unverified); observations and supplier delivery records are reviewed at /admin/reviews (admin cookie). No screen verifies evidence files yet, so a review can currently only reject. " +
      "Unpriced by design: a workflow and data layer, not a product. No checkout, SKU or " +
      "entitlement exists for it. Calibration: project_links reserves a typed slot " +
      "(calibration_observation + prediction_ref) but nothing writes one and the calibration " +
      "ledger is untouched. Evidence uploads are stored unverified and unclassified; contents " +
      "are never parsed. Paid products (density_screen, envelope_study_deposit, procurement_spec, " +
      "hall_watch) commissioned from a project attach to it through the existing checkout and webhook " +
      "(0016_project_purchases.sql); no price or SKU is added. Measured outcomes against a stored prediction (btm.firm_MW) are recorded " +
      "as immutable submissions and reviewed by an admin (0017_project_observations.sql); nothing is added to the " +
      "calibration ledger. Needs migration 0015_projects.sql applied and the private " +
      "'project-evidence' storage bucket (created by the migration where Storage is installed). The site offers it (/workspace, the project panel) and its tests pass, but its production " +
      "state is unverified: it has no engine route to find in lib/engine-deployed.json, and the database, the storage bucket and the deployed build cannot be read " +
      "from this repository.",
  },
  {
    capability_id: "btm_rfq_loop",
    family: "btm",
    name: "BTM RFQ package, supplier responses and selection",
    description:
      "From an attached BTM case: generate the RFQ package for an rfq_ready architecture, take " +
      "supplier responses, compare them with the existing procurement ranking, and record a " +
      "person's supplier selection.",
    engine_capability:
      "gridforge/reporting/btm_spec.py:build_equipment_spec + gridforge/procurement/evaluate.py:rank_bids",
    rest_endpoint: "/v1/power/deploy/bids",
    mcp_tool: "gridforge_power_deploy_bids",
    cli_command: null,
    web_route: "/power/deploy/[token]",
    workspace_action: null,
    database_record: "procurement_packages, procurement_responses, procurement_comparisons",
    entitlement:
      "REST/MCP /v1/power/deploy/bids: API key + unit metering (2 units, same basis as /v1/bids). " +
      "Web: project_token + attached case; no payment gate, same as btm_deploy_assess.",
    stripe_product_or_price: "none",
    deliverable: "RFQ specification (HTML/Markdown), response schedule, persisted comparison, selection event",
    status: "metered_only",
    production_status: "live",
    notes:
      "Deployed: the engine on Fly serves /v1/power/deploy/bids and /v1/power/deploy/spec (lib/engine-deployed.json, " +
      "snapshot 2026-11-05). " +
      "No BTM price, SKU or checkout exists and none is implied. Supplier responses are validated " +
      "by the engine and stored as submitted; selection is a human decision and never rewrites the " +
      "ranking. Installation method and evidence quality remain engineer-scored.",
  },
  {
    capability_id: "study_deck",
    family: "engagement",
    name: "Study walkthrough deck",
    description: "The client-session walkthrough deck generated with an Envelope Study delivery.",
    engine_capability: "gridforge/reporting/deck.py (POST /v1/deck, called from lib/deliverables.ts after the study)",
    rest_endpoint: "/v1/deck",
    mcp_tool: null,
    cli_command: "gridforge deck",
    web_route: "/deliverable/[token]",
    workspace_action: null,
    database_record: "deliverables (deck_html)",
    entitlement:
      "Web: part of an Envelope Study delivery, behind the same released-only gate as the study (GET /api/deliverable/[token]?format=deck). " +
      "REST: API key + unit metering (3 units).",
    stripe_product_or_price: "none",
    deliverable: "Walkthrough deck (HTML) for the 90-minute session with the client's engineers",
    status: "metered_only",
    production_status: "live",
    notes:
      "There is deliberately NO MCP tool: /v1/deck has a unit weight and a route but is a human walkthrough, not an agent tool " +
      "(gridforge/api/tools.py rate_card()). A failed deck never fails the study document. It is generated only for the 'study' " +
      "endpoint, never for a Screen or a Specification. No separate price: it is part of the Study engagement.",
  },
  {
    capability_id: "proposal",
    family: "engagement",
    name: "Priced proposal",
    description: "A priced proposal that opens with a real finding from the engine's solve of the hall, for a named engagement.",
    engine_capability: "gridforge/reporting/proposal.py (POST /v1/proposal)",
    rest_endpoint: "/v1/proposal",
    mcp_tool: "gridforge_proposal",
    cli_command: "gridforge proposal",
    web_route: "/developers",
    workspace_action: null,
    database_record: "deliverables (only when the operator route app/api/admin/proposal stores it)",
    entitlement:
      "REST/MCP: API key + unit metering (2 units). Operator: POST /api/admin/proposal (admin cookie) turns a qualified hall into a " +
      "proposal stored as a deliverable with its own link. There is no customer self-serve proposal page.",
    stripe_product_or_price: "none",
    deliverable: "Proposal document (HTML or Markdown) and the engagement's catalogue price",
    status: "metered_only",
    production_status: "live",
    notes:
      "web_route is /developers because that page lists it in the rate card and tool catalogue; nothing there generates a proposal. " +
      "The price it quotes is read from the catalogue, not set by this capability.",
  },
  {
    capability_id: "power_assess",
    family: "api",
    name: "Power Readiness Case",
    description:
      "Current capacity against a rack target, the binding constraint, the priced and dated headroom ladder, the critical-path " +
      "dependencies behind the earliest credible energisation date, the calibration state and one next action.",
    engine_capability: "gridforge/reporting/readiness.py (composition over envelope, relief steps and time to power)",
    rest_endpoint: "/v1/power/assess",
    mcp_tool: "gridforge_power_assess",
    cli_command: "gridforge power-assess",
    web_route: "/developers",
    workspace_action: null,
    database_record: null,
    entitlement: "REST/MCP: API key + unit metering (5 units, the same basis as /v1/study). No web purchase and no web tool.",
    stripe_product_or_price: "none",
    deliverable: "JSON readiness case (current capacity, ladder, dependencies, evidence, next action)",
    status: "metered_only",
    production_status: "live",
    notes:
      "Distinct from btm_deploy_assess (/v1/power/deploy/assess), which takes a load profile and generation/storage units rather than a " +
      "hall intake. Visible on the site only as a rate-card and tool-catalogue row at /developers.",
  },
  {
    capability_id: "estimate",
    family: "free_tier",
    name: "Cost estimate (what a call will cost)",
    description: "Public, free and never metered: the unit weight and pay-as-you-go price of an operation before it is run.",
    engine_capability: "gridforge/api/server.py (GET /v1/estimate) over UNIT_COST in gridforge/api/metering.py",
    rest_endpoint: "/v1/estimate",
    mcp_tool: "gridforge_estimate",
    cli_command: null,
    web_route: "/developers",
    workspace_action: null,
    database_record: null,
    entitlement:
      "none required. Public tier, 0 units, never counted against an allowance or quota; the website's own use of it is still " +
      "counted at the provider gate (FREE_ENGINE_PATHS in lib/rate-limit.ts).",
    stripe_product_or_price: "none",
    deliverable: "JSON estimate; the site shows it beside its own computed figure (components/CostEstimator.tsx)",
    status: "free",
    production_status: "live",
    notes: "No CLI command. The pay-as-you-go price it reports is PAYG in lib/products.ts, not a figure typed here.",
  },
  {
    capability_id: "payg_metering",
    family: "api",
    name: "Pay-as-you-go metering and free developer allowance",
    description:
      "One general scheme for every billable engine route: a monthly free allowance with no card, then metered units invoiced in " +
      "arrears inside a cap the customer sets. The unit price, allowance, cap bounds and minimum invoice are PAYG in lib/products.ts " +
      "(mirrored by gridforge/commercial.py); none is typed here.",
    engine_capability: "gridforge/api/metering.py (UNIT_COST, append-only usage ledger, key quota = the cap)",
    rest_endpoint: "/v1/*",
    mcp_tool: "all gridforge_* tools",
    cli_command: null,
    web_route: "/developers",
    workspace_action: "/api-access/[token]: enable pay-as-you-go, change the cap, replace the card",
    database_record: "api_accounts, usage_events, usage_settlements, usage_alerts (0028, 0030-0040)",
    entitlement:
      "Free allowance: POST /api/free-account -> a trial-scope key minted from the emailed portal link. Pay-as-you-go: POST " +
      "/api/payg/enable -> Stripe Checkout in setup mode (saves a card, charges nothing) -> the signed webhook turns the account into " +
      "api_payg with the chosen cap. Usage is invoiced in arrears by app/api/cron/payg; over the cap the engine answers 402.",
    stripe_product_or_price: "setup-mode checkout.session, metadata.kind=api_payg_enable; month-end invoices, metadata.kind=payg_settlement",
    deliverable: "A signed API key (trial or payg scope) and a monthly invoice for the net units used",
    status: "metered_only",
    production_status: "unverified",
    notes:
      "The site offers it (/developers, /api-access/[token]) and its tests pass, but its production state is unverified. 'PAYG' is not in PRODUCTS (it is one scheme, not a product), so productsMissingFromRegistry() cannot see it; this entry is its only " +
      "registry trace. The engine side is recorded as redeployed with metering published (docs/EXECUTION_STATE.md, 2026-10-27, a dated record, not a probe). " +
      "Never exercised against live Stripe, the Vercel cron or the mail provider from this repository (docs/EXECUTION_STATE.md: 'Not " +
      "run: anything against live Stripe, Vercel crons, Resend'), so production state is unverified, not live; its rest_endpoint is the /v1/* wildcard, which no snapshot route can prove.",
  },
  {
    capability_id: "cost_evidence_runs",
    family: "engagement",
    name: "Cost-evidence quotation runs",
    description:
      "A supplier's quotation becomes cost evidence only by a named person's acceptance; the Study is then re-made with the accepted " +
      "lines for that one request, as a durable, versioned, integrity-checked run that owns its exact document.",
    engine_capability:
      "cost_evidence overlay on /v1/study (gridforge/costs.py cost_overlay, gridforge/api/server.py _invoke); lines validated by /v1/bids (evidence_only)",
    rest_endpoint: null,
    mcp_tool: null,
    cli_command: "gridforge study",
    web_route: "/deliverable/[token]",
    workspace_action: null,
    database_record: "cost_evidence, cost_evidence_reviews, cost_evidence_retirements, cost_evidence_runs (0022, 0023)",
    entitlement:
      "Holder of a Procurement Specification's own document token submits quotes (POST /api/deliverable/[token]/quotes) and starts a run " +
      "(POST .../evidence-run); an administrator accepts or rejects each line (app/api/admin/cost-evidence/[id]/review). Receipt gives a " +
      "line no authority; only acceptance does. A refunded or disputed purchase is withheld.",
    stripe_product_or_price: "none",
    deliverable: "A re-made Study document per run, retrievable and verified against its recorded digest (GET .../evidence-run/[runId]/artifact)",
    status: "free",
    production_status: "unverified",
    notes:
      "The site offers it (the quotes and evidence-run panel on /deliverable/[token]) and its tests pass, but its production state is unverified. rest_endpoint is null because the capability is the site's quotation workflow, not an engine route: the engine side is only the optional cost_evidence field of /v1/study (and the evidence_only mode of /v1/bids), both covered by their own entries. Not a SKU and not priced: it is an operator-reviewed refinement of an engagement already bought. REST only through the cost_evidence " +
      "request field, which the /v1/study tool schema does not expose, so there is no MCP tool; the CLI takes it as `study --cost-evidence FILE`. " +
      "See docs/09_COST_EVIDENCE_RUNS.md for identity, writing and retrieval. Needs migrations 0022 and 0023 (recorded as applied) and the " +
      "private artifact bucket; whether a real run has been made in production is not recorded.",
  },
  {
    capability_id: "calibration_capture",
    family: "project",
    name: "Calibration capture and public residuals",
    description:
      "A measured outcome recorded against a stored prediction, reviewed by a second person, exported only when every gate clears, and " +
      "imported into the calibration ledger by a person; plus a public read of aggregate residual statistics over approved records.",
    engine_capability:
      "gridforge/calibration/residuals.py:public_report over gridforge/calibration/store.py:approved_records, and lib/project-observations.ts",
    rest_endpoint: "/v1/calibration/residuals",
    mcp_tool: null,
    cli_command: "gridforge calibration report",
    web_route: "/workspace",
    workspace_action: "ProjectPanel: record a measured outcome (POST /api/projects/[token]/observations)",
    database_record: "project_observations, project_observation_reviews (0017, 0038), calibration_ledger_rows view",
    entitlement:
      "Submission: the holder of the project token. Review: an administrator who is not the submitter (app/api/admin/observations/[id]/review). " +
      "Export: GET /api/admin/calibration-export (admin), then `gridforge calibrate import`, which re-checks every row. /v1/calibration/residuals: public, read-only, 0 units.",
    stripe_product_or_price: "none",
    deliverable: "Aggregate residual statistics (n_records, per-subsystem); an export file for `gridforge calibrate import`",
    status: "free",
    production_status: "unverified",
    notes:
      "The site offers the capture (the project panel) and its tests pass, but its production state is unverified. Not not_deployed: a " +
      "read-only GET of /v1/calibration/residuals on the live engine returned 200 on 2026-11-06 and the live /v1/version listed 24 endpoints (observed " +
      "by the coordinator; not repeated here). The committed snapshot, lib/engine-deployed.json (dated 2026-11-05), lists 23 and is stale; " +
      "it is not edited here and the owner refreshes it. Once it lists the route this entry may become live. Nothing here writes the ledger " +
      "by itself: with no verified observation the export is empty and the answer is 'uncalibrated'. The site-side capture needs 0017 and 0038 " +
      "(recorded as applied); no real observation is recorded as having passed review.",
  },
  {
    capability_id: "intelligence_team_seats",
    family: "intelligence",
    name: "Intelligence team seats",
    description:
      "The billing owner invites and removes members; an accepted invitation gives that person the plan's access. Seats are Developer 1, " +
      "Team 5, Enterprise unlimited, counting the owner (INTELLIGENCE_PLANS[plan].seats in lib/products.ts).",
    engine_capability: "n/a -- lib/team.ts over the database functions gf_invite_member / gf_accept_invitation (0027)",
    rest_endpoint: null,
    mcp_tool: null,
    cli_command: null,
    web_route: "/account",
    workspace_action: "components/TeamPanel.tsx; invitations are accepted at /account/invite/[token]",
    database_record: "subscription_members, subscription_invitations (0027)",
    entitlement:
      "The caller is the verified Supabase identity; the plan comes from that identity's own subscriptions row, never from the request. " +
      "The seat limit is enforced in the database under a row lock on the owner's subscription, so two people racing for the last seat " +
      "cannot both get it. Removing or revoking frees the seat.",
    stripe_product_or_price: "none",
    deliverable: "Shared access to the Intelligence dashboard for the invited people",
    included_in: ["team", "enterprise"],
    status: "commercial",
    production_status: "unverified",
    notes:
      "Included in the three Intelligence plans, not a separate SKU and not an add-on: there is nothing to buy to get more seats than the " +
      "plan has. Tests pin the seat numbers against 0027 (tests/test_team_seats_migration.py). Migration 0027 is recorded as applied; no " +
      "invitation sent by the production deployment is recorded. The site offers it (/account) and its production state is unverified: it has no engine route to find in the snapshot.",
  },
  {
    capability_id: "engagement_deposit_flow",
    family: "engagement",
    name: "Engagement deposit hand-off",
    description:
      "How the Envelope Study and Portfolio Screen deposits reach delivery: paid -> contacted -> scoped (scope note, fee inside the " +
      "published band, committed date) -> intake opened -> generated -> engineer's review -> released -> delivered.",
    engine_capability: "lib/deposits.ts over gridforge/reporting/study.py (/v1/study) and gridforge/reporting/portfolio.py (/v1/portfolio)",
    rest_endpoint: null,
    mcp_tool: null,
    cli_command: null,
    web_route: "/intake/[token]",
    workspace_action: "operator: /admin/pipeline; POST /api/admin/deposits/[id] (one step at a time) and POST /api/admin/deposits/[id]/open-intake",
    database_record: "engagement_deposits (0019, 0030), then deliverables (one per deposit, deliverables_one_per_session)",
    entitlement:
      "The buyer holds only a private intake link, emailed through the durable outbox once a named person has scoped the deposit. " +
      "Every step after payment is an authenticated operator action; steps are never skipped or reversed. A refunded or disputed deposit " +
      "holds the engagement opened from it (0045).",
    stripe_product_or_price: "checkout.session, metadata.kind=envelope_study_deposit and metadata.kind=portfolio_screen_deposit",
    deliverable: "The Study or Portfolio document, board summary and model packs, released by a named engineer",
    included_in: ["envelope_study_deposit", "portfolio_screen_deposit"],
    status: "commercial",
    production_status: "unverified",
    notes:
      "Priced under envelope_study_deposit and portfolio_screen_deposit; this entry maps the fulfilment path, not a third product. " +
      "docs/EXECUTION_STATE.md (2026-11-02) records it proven end to end against real PostgreSQL + PostgREST + the real engine in CI. " +
      "Not proven: a real Stripe payment delivering, the mail provider delivering, Supabase itself. The site sells both deposits and its production state is unverified.",
  },
];

export function capabilityById(id: string): Capability | undefined {
  return CAPABILITY_REGISTRY.find((c) => c.capability_id === id);
}

/** Every capability tied to a lib/products.ts entry that does NOT exist in PRODUCTS -- a
 * dangling reference the registry itself would otherwise let drift silently. */
export function danglingProductReferences(): string[] {
  return CAPABILITY_REGISTRY.filter((c) => c.product_id && !(c.product_id in PRODUCTS)).map(
    (c) => c.capability_id
  );
}

export function danglingIntelligenceReferences(): string[] {
  return CAPABILITY_REGISTRY.filter(
    (c) => c.intelligence_plan_id && !(c.intelligence_plan_id in INTELLIGENCE_PLANS)
  ).map((c) => c.capability_id);
}

/** Every ProductId in the price catalogue with no registry entry at all -- priced somewhere,
 * mapped nowhere. */
export function productsMissingFromRegistry(): ProductId[] {
  const covered = new Set(
    CAPABILITY_REGISTRY.map((c) => c.product_id).filter((x): x is ProductId => !!x)
  );
  return (Object.keys(PRODUCTS) as ProductId[]).filter((id) => !covered.has(id));
}

export function intelligencePlansMissingFromRegistry(): IntelligencePlanId[] {
  const covered = new Set(
    CAPABILITY_REGISTRY.map((c) => c.intelligence_plan_id).filter(
      (x): x is IntelligencePlanId => !!x
    )
  );
  return (Object.keys(INTELLIGENCE_PLANS) as IntelligencePlanId[]).filter(
    (id) => !covered.has(id)
  );
}

/** Capabilities that are commercially priced somewhere (product/plan/metering) but have no
 * web route at all -- sellable in principle, invisible on the site. */
export function priceableButNotOnWeb(): Capability[] {
  return CAPABILITY_REGISTRY.filter(
    (c) => c.status !== "free" && c.status !== "internal_only" && !c.web_route
  );
}

/** Capabilities with a REST/MCP/CLI surface but genuinely no commercial path at all -- an
 * engine capability the company cannot currently charge for through any channel. */
export function unmonetized(): Capability[] {
  return CAPABILITY_REGISTRY.filter((c) => c.status === "internal_only");
}
