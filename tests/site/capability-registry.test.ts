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
import { describe, expect, it } from "vitest";
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
