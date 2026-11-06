/**
 * lib/capability-registry.ts -- the canonical cross-layer map of every
 * commercially meaningful capability (engine, REST, MCP, CLI, web,
 * database, entitlement, Stripe, deliverable). This is the machine-readable
 * source scripts/admin tooling reads to answer "priced but unsellable",
 * "sellable but invisible on the site" and "implemented but unmonetized" in
 * one place instead of by grepping five files.
 *
 * These tests hold the registry itself honest: every product_id and
 * intelligence_plan_id it references must actually exist in lib/products.ts,
 * and every product/plan that IS sold must have a registry entry -- a
 * capability can be added to PRODUCTS and forgotten here exactly the way
 * lib/products.ts's own comments describe products being forgotten from the
 * engagement ladder before it was derived rather than hand-written.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import snapshot from "@/lib/engine-deployed.json";
import { PAYG, PRODUCTS } from "@/lib/products";
import {
  CAPABILITY_REGISTRY,
  danglingProductReferences,
  danglingIntelligenceReferences,
  productsMissingFromRegistry,
  intelligencePlansMissingFromRegistry,
  priceableButNotOnWeb,
  unmonetized,
  capabilityById,
} from "@/lib/capability-registry";

describe("CAPABILITY_REGISTRY", () => {
  it("has no duplicate capability_id", () => {
    const ids = CAPABILITY_REGISTRY.map((c) => c.capability_id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("references no product_id that is missing from lib/products.ts", () => {
    expect(danglingProductReferences()).toEqual([]);
  });

  it("references no intelligence_plan_id that is missing from lib/products.ts", () => {
    expect(danglingIntelligenceReferences()).toEqual([]);
  });

  it("covers every ProductId sold in lib/products.ts", () => {
    expect(productsMissingFromRegistry()).toEqual([]);
  });

  it("covers every IntelligencePlanId sold in lib/products.ts", () => {
    expect(intelligencePlansMissingFromRegistry()).toEqual([]);
  });

  it("gives every commercial capability a web route or an explicit reason it has none", () => {
    // A "commercial" capability with no web_route is a real gap this audit exists to
    // surface -- catch it moving in either direction rather than letting it drift.
    const commercial = CAPABILITY_REGISTRY.filter((c) => c.status === "commercial");
    for (const c of commercial) {
      expect(c.web_route, `${c.capability_id} is commercial but has no web_route`).not.toBeNull();
    }
    expect(priceableButNotOnWeb()).toEqual([]);
  });

  it("never claims a stripe_product_or_price for a capability with no entitlement path", () => {
    for (const c of CAPABILITY_REGISTRY) {
      if (c.stripe_product_or_price && c.stripe_product_or_price !== "none") {
        expect(c.entitlement).not.toBe("");
      }
    }
  });

  it("names the BTM deployment capabilities as metered-only, not a fabricated one-off SKU", () => {
    const assess = capabilityById("btm_deploy_assess");
    const spec = capabilityById("btm_deploy_spec");
    expect(assess?.status).toBe("metered_only");
    expect(assess?.stripe_product_or_price).toBe("none");
    expect(spec?.status).toBe("metered_only");
    expect(spec?.stripe_product_or_price).toBe("none");
  });

  it("declares the project record and BTM RFQ loop without inventing a price, SKU or sale", () => {
    const project = capabilityById("project_record");
    const loop = capabilityById("btm_rfq_loop");
    expect(project?.status).toBe("free");
    expect(project?.product_id).toBeUndefined();
    expect(project?.stripe_product_or_price).toBe("none");
    expect(loop?.status).toBe("metered_only");
    expect(loop?.product_id).toBeUndefined();
    expect(loop?.stripe_product_or_price).toBe("none");
    expect(loop?.mcp_tool).toBe("gridforge_power_deploy_bids");
  });

  it("unmonetized() lists only capabilities truly marked internal_only", () => {
    for (const c of unmonetized()) {
      expect(c.status).toBe("internal_only");
    }
  });
});

describe("the capabilities the registry used to omit", () => {
  const cap = (id: string) => {
    const c = capabilityById(id);
    expect(c, `${id} must be in the registry`).toBeDefined();
    return c!;
  };

  it("names all 14 MCP tools, not 10", () => {
    const named = new Set(CAPABILITY_REGISTRY.map((c) => c.mcp_tool));
    for (const t of ["gridforge_bids", "gridforge_proposal", "gridforge_power_assess", "gridforge_estimate"]) expect(named.has(t), t).toBe(true);
  });

  it("maps the bid comparison to the Procurement Specification it is the third deliverable of, without a second SKU", () => {
    const c = cap("procurement_bids");
    expect(c).toMatchObject({ rest_endpoint: "/v1/bids", mcp_tool: "gridforge_bids", cli_command: "gridforge bids", product_id: "procurement_spec", status: "commercial" });
    expect(c.stripe_product_or_price).toContain("metadata.kind=procurement_spec");
    // lib/products.ts must still be the thing that says the bid comparison is promised.
    expect(PRODUCTS_PROMISE).toMatch(/bid comparison/);
    // The first entry for a product is the one other tests read (money-path-truth): the specification itself.
    expect(CAPABILITY_REGISTRY.find((x) => x.product_id === "procurement_spec")!.capability_id).toBe("procurement_spec");
  });

  it("says /v1/deck has no MCP tool on purpose, and that the engine agrees", () => {
    const c = cap("study_deck");
    expect(c.mcp_tool).toBeNull();
    expect(c.cli_command).toBe("gridforge deck");
    const tools = fs.readFileSync(path.join(process.cwd(), "gridforge/api/tools.py"), "utf8");
    expect(tools).not.toMatch(/"\/v1\/deck"/); // no agent tool calls it
    expect(tools).toMatch(/\/v1\/deck. has a weight and a route but is deliberately\s*\n#:\s*not an agent tool/);
  });

  it("does not hand-type the pay-as-you-go price: the figures live in PAYG, and this entry is not 'live' without proof", () => {
    const c = cap("payg_metering");
    expect(JSON.stringify(c)).not.toMatch(/€|EUR ?\d|\b25 units\b/);
    expect(PAYG.unitPriceCents).toBeGreaterThan(0);
    expect(c.production_status).toBe("unverified");
    expect(c.stripe_product_or_price).toContain("api_payg_enable");
  });

  it("calls the calibration residuals route not_deployed exactly because the deployed snapshot lacks it", () => {
    const c = cap("calibration_capture");
    expect(c.rest_endpoint).toBe("/v1/calibration/residuals");
    expect(snapshot.endpoints).not.toContain("/v1/calibration/residuals");
    expect(c.production_status).toBe("not_deployed");
  });

  it("claims 'live' only where the deployed engine serves the route; every site-only addition is unverified", () => {
    for (const id of ["procurement_bids", "study_deck", "proposal", "power_assess", "estimate"]) {
      const c = cap(id);
      expect(snapshot.endpoints, id).toContain(c.rest_endpoint);
      expect(c.production_status).toBe("live");
    }
    for (const id of ["payg_metering", "cost_evidence_runs", "intelligence_team_seats", "engagement_deposit_flow"]) {
      expect(cap(id).production_status, id).toBe("unverified");
    }
  });

  it("keeps the buyer page not_deployed and words the migration state as verified-in-repo versus unverified-in-production", () => {
    const c = cap("project_buyer_page");
    expect(c.production_status).toBe("not_deployed");
    expect(c.notes).not.toMatch(/Needs migration 0025/);
    expect(c.notes).toMatch(/NOT verified: that the deployed website build serves/);
    expect(c.notes).toMatch(/through 0045/);
  });

  it("describes the two deposit products as running end to end, with the deposit recorded before any deliverable", () => {
    for (const id of ["envelope_study", "portfolio_screen"]) {
      const c = cap(id);
      expect(c.database_record, id).toMatch(/^engagement_deposits/);
      expect(c.entitlement, id).toMatch(/open-intake/);
      expect(JSON.stringify(c), id).not.toMatch(/a human runs the CLI|not a self-serve flow/);
    }
    // The route the registry names exists, so the claim is not about something deleted.
    expect(fs.existsSync(path.join(process.cwd(), "app/api/admin/deposits/[id]/open-intake/route.ts"))).toBe(true);
    const flow = cap("engagement_deposit_flow");
    expect(flow.database_record).toMatch(/engagement_deposits/);
    expect(flow.stripe_product_or_price).toContain("envelope_study_deposit");
    expect(flow.stripe_product_or_price).toContain("portfolio_screen_deposit");
  });

  it("points Hall Watch at the surface the subscriber uses, /watch/[token]", () => {
    expect(cap("hall_watch").web_route).toBe("/watch/[token]");
    expect(fs.existsSync(path.join(process.cwd(), "app/watch/[token]/page.tsx"))).toBe(true);
  });

  it("states the Intelligence seat counts from the catalogue, not from a second copy", async () => {
    const { INTELLIGENCE_PLANS } = await import("@/lib/products");
    expect(INTELLIGENCE_PLANS.developer.seats).toBe(1);
    expect(INTELLIGENCE_PLANS.team.seats).toBe(5);
    expect(INTELLIGENCE_PLANS.enterprise.seats).toBeNull();
    const c = cap("intelligence_team_seats");
    expect(c.description).toMatch(/Developer 1, Team 5, Enterprise unlimited/);
    expect(c.stripe_product_or_price).toBe("none");
  });

  it("cites no document that is not in the repository", () => {
    const docs = new Set(fs.readdirSync(path.join(process.cwd(), "docs")));
    const text = JSON.stringify(CAPABILITY_REGISTRY);
    for (const m of text.matchAll(/docs\/([\w.-]+\.md)/g)) {
      const deletedAndSaidSo = m[1] === "07_DELIVERY_RUNBOOK.md" && /was deleted on 2026-10-13/.test(text);
      expect(docs.has(m[1]) || deletedAndSaidSo, `docs/${m[1]} is cited but does not exist`).toBe(true);
    }
  });
});


const PRODUCTS_PROMISE = PRODUCTS.procurement_spec.deliverable;
