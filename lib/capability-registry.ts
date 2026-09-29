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

import { PRODUCTS, INTELLIGENCE_PLANS, type ProductId, type IntelligencePlanId } from "@/lib/products";

export type CapabilityStatus =
  | "commercial"       // priced, sellable, fulfillable, in production
  | "metered_only"      // consumable through API unit metering, no dedicated one-off SKU
  | "free"              // deliberately free — a qualifier/demo/screening tool
  | "internal_only";    // real engine capability with no customer-facing commercial path yet

export interface Capability {
  capability_id: string;
  family: "engagement" | "recurring" | "api" | "intelligence" | "btm" | "free_tier";
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
  status: CapabilityStatus;
  production_status: "live" | "not_deployed";
  notes?: string;
}

export const CAPABILITY_REGISTRY: Capability[] = [
  {
    capability_id: "qualify",
    family: "free_tier",
    name: "Free Qualifier",
    description: "One-page free screening: rough headroom for a target platform, no engagement.",
    engine_capability: "gridforge/reporting/qualify.py",
    rest_endpoint: "/v1/qualify",
    mcp_tool: "gridforge_qualify",
    cli_command: null,
    web_route: "/qualify",
    workspace_action: null,
    database_record: "qualifications",
    entitlement: "none required — free over REST, MCP and web by design",
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
    database_record: "deliverables",
    entitlement: "Stripe checkout (deposit) -> deliverables row -> human-released document",
    stripe_product_or_price: "checkout.session, metadata.kind=envelope_study_deposit",
    deliverable: "Envelope Study (HTML + Markdown) + model_pack.json",
    status: "commercial",
    production_status: "live",
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
    database_record: "deliverables",
    entitlement: "Stripe checkout (deposit) -> a human runs the CLI, not the webhook (bespoke engagement)",
    stripe_product_or_price: "checkout.session, metadata.kind=portfolio_screen_deposit",
    deliverable: "Portfolio Screen document + one model_pack.json per hall",
    status: "commercial",
    production_status: "live",
    notes: "producesDeliverable:false in lib/products.ts on purpose — a deposit against a bespoke " +
      "engagement, not a self-serve intake->generate->release flow.",
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
  },
  {
    capability_id: "hall_watch",
    family: "recurring",
    name: "Hall Watch",
    description: "Quarterly re-solve of a hall's model with a change note on what moved.",
    product_id: "hall_watch",
    engine_capability: "gridforge/reporting/readiness.py (re-solved on cron)",
    rest_endpoint: "/v1/power/assess",
    mcp_tool: "gridforge_power_assess",
    cli_command: "gridforge power-assess",
    web_route: "/pricing",
    workspace_action: "commercial-action:hall_watch",
    database_record: "watches",
    entitlement: "Stripe subscription -> watches row -> app/api/cron/watches quarterly re-solve",
    stripe_product_or_price: "subscription, metadata.kind=hall_watch",
    deliverable: "Quarterly change note + on-demand re-run",
    status: "commercial",
    production_status: "live",
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
    production_status: "live",
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
    production_status: "live",
  },
  {
    capability_id: "api_platform",
    family: "api",
    name: "API — Platform",
    description: "Metered engine access, 10,000 units/month, embeddable redistribution terms.",
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
    production_status: "live",
  },
  {
    capability_id: "intelligence_developer",
    family: "intelligence",
    name: "GridForge Intelligence — Developer",
    description: "Single-seat access to the live intelligence dashboard.",
    intelligence_plan_id: "developer",
    engine_capability: "n/a — reads calibration/usage state, not a new engine capability",
    rest_endpoint: null,
    mcp_tool: null,
    cli_command: null,
    web_route: "/intelligence",
    workspace_action: null,
    database_record: "subscriptions",
    entitlement: "Stripe subscription -> subscriptions row -> /account gated view",
    stripe_product_or_price: "subscription, metadata.kind=intelligence_subscription, metadata.plan=developer",
    deliverable: "Live dashboard access",
    status: "commercial",
    production_status: "live",
  },
  {
    capability_id: "intelligence_team",
    family: "intelligence",
    name: "GridForge Intelligence — Team",
    description: "5-seat access to the live intelligence dashboard.",
    intelligence_plan_id: "team",
    engine_capability: "n/a",
    rest_endpoint: null,
    mcp_tool: null,
    cli_command: null,
    web_route: "/intelligence",
    workspace_action: null,
    database_record: "subscriptions",
    entitlement: "Stripe subscription -> subscriptions row -> /account gated view",
    stripe_product_or_price: "subscription, metadata.kind=intelligence_subscription, metadata.plan=team",
    deliverable: "Live dashboard access",
    status: "commercial",
    production_status: "live",
  },
  {
    capability_id: "intelligence_enterprise",
    family: "intelligence",
    name: "GridForge Intelligence — Enterprise",
    description: "Unlimited-seat access to the live intelligence dashboard.",
    intelligence_plan_id: "enterprise",
    engine_capability: "n/a",
    rest_endpoint: null,
    mcp_tool: null,
    cli_command: null,
    web_route: "/intelligence",
    workspace_action: null,
    database_record: "subscriptions",
    entitlement: "Stripe subscription -> subscriptions row -> /account gated view",
    stripe_product_or_price: "subscription, metadata.kind=intelligence_subscription, metadata.plan=enterprise",
    deliverable: "Live dashboard access",
    status: "commercial",
    production_status: "live",
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
      "because there is no Stripe product for a self-serve web purchase of this capability yet.",
    stripe_product_or_price: "none",
    deliverable: "power_deployment_cases row (case_token) + JSON assessment",
    status: "metered_only",
    production_status: "live",
    notes:
      "Real gap: priced and sellable through the API today, but not through a direct one-off " +
      "web checkout the way density_screen/procurement_spec are. Before adding a one-off SKU, " +
      "the pricing basis must come from somewhere real (e.g. parity with envelope_study_deposit " +
      "or procurement_spec, both human-reviewed engagements this is not) rather than an invented " +
      "figure. Not yet resolved — see docs/07_DELIVERY_RUNBOOK.md.",
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
    notes: "Same open gap as btm_deploy_assess: no dedicated one-off web SKU yet.",
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
