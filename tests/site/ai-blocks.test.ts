/**
 * The qualify -> density-screen money path: a successful free qualify that
 * names a binding constraint must produce a structured constraint block and
 * a commercialAction pointed at the Density Screen (lib/products.ts), and
 * the client-side adapter (components/ai/adaptBlocks.ts) must turn the
 * server's AgentBlock contract (lib/ai/schemas.ts) into blocks the workspace
 * cards can actually render — not silently drop them.
 */
import { describe, expect, it } from "vitest";
import { constraintFromQualify, engagementOfferBlock, blockFromRefusal } from "@/lib/ai/responses";
import { PRODUCTS, eurFromCents } from "@/lib/products";
import { adaptServerBlocks } from "@/components/ai/adaptBlocks";

const QUALIFY_BODY = {
  platform: {
    id: "gb300_nvl72",
    name: "NVIDIA GB300 NVL72",
    rack_kW: { value: 132, low: 120, high: 140, unit: "kW", evidence: "E3", label: "Rack power draw", digest: "digest-abc" },
  },
  as_found: {
    racks: 12,
    it_load_kW: { value: 1580, low: null, high: null, unit: "kW", evidence: "E1", label: "IT load as found" },
    binding_constraint: "Rack feed / tap-off rating",
    domain: "electrical",
    basis: "Installed tap-off rating vs required per-rack current at platform density.",
  },
  after_relief: { racks: 30, architecture: "full_dlc", then_binds_on: null, sets_the_date: "plant" },
};

describe("constraintFromQualify: a real binding constraint becomes a real block", () => {
  it("names the constraint, domain and basis straight off the engine payload", () => {
    const blocks = constraintFromQualify("gridforge_qualify", QUALIFY_BODY);
    expect(blocks).toHaveLength(1);
    const [block] = blocks;
    expect(block.type).toBe("constraint");
    if (block.type !== "constraint") throw new Error("unreachable");
    expect(block.name).toBe("Rack feed / tap-off rating");
    expect(block.domain).toBe("electrical");
    expect(block.basis).toContain("tap-off");
    expect(block.binds).toBe(true);
    expect(block.sourceTool).toBe("gridforge_qualify");
    // Weakest evidence class among as_found's own quantities — never invented.
    expect(block.evidence).toBe("E1");
  });

  it("produces nothing off a payload with no named binding constraint", () => {
    expect(constraintFromQualify("gridforge_qualify", { as_found: { racks: 4 } })).toHaveLength(0);
    expect(constraintFromQualify("gridforge_qualify", {})).toHaveLength(0);
    expect(constraintFromQualify("gridforge_qualify", null)).toHaveLength(0);
  });
});

describe("engagementOfferBlock: the money line", () => {
  it("prices the Density Screen from lib/products.ts, never a number of its own", () => {
    const block = engagementOfferBlock("gridforge_qualify");
    expect(block.type).toBe("commercialAction");
    if (block.type !== "commercialAction") throw new Error("unreachable");
    expect(block.reason).toBe("engagement_offer");
    expect(block.label).toContain(eurFromCents(PRODUCTS.density_screen.amountCents));
    expect(block.label).toContain("Density Screen");
    expect(block.href).toBe("/pricing");
  });
});

describe("adaptServerBlocks: the server contract renders, it does not vanish", () => {
  it("turns a server metric block into a renderable generic metric block", () => {
    const [adapted] = adaptServerBlocks([
      {
        type: "metric",
        label: "Rack power draw",
        quantity: { value: 132, low: 120, high: 140, unit: "kW", evidence: "E3", digest: "digest-abc" },
        sourceTool: "gridforge_qualify",
      },
    ]);
    expect(adapted.type).toBe("metric");
    if (adapted.type !== "metric") throw new Error("unreachable");
    expect(adapted.metricKind).toBe("generic");
    if (adapted.metricKind !== "generic") throw new Error("unreachable");
    expect(adapted.quantity.value).toBe(132);
    expect(adapted.quantity.evidenceClass).toBe("E3");
    expect(adapted.quantity.provenance.digest).toBe("digest-abc");
  });

  it("turns a server constraint block into a renderable constraint block without inventing maxRacks", () => {
    const serverBlocks = constraintFromQualify("gridforge_qualify", QUALIFY_BODY);
    const [adapted] = adaptServerBlocks(serverBlocks);
    expect(adapted.type).toBe("constraint");
    if (adapted.type !== "constraint") throw new Error("unreachable");
    expect(adapted.name).toBe("Rack feed / tap-off rating");
    expect(adapted.domain).toBe("electrical");
    expect(adapted.binding).toBe(true);
    expect(adapted.maxRacks).toBeUndefined();
  });

  it("every commercialAction — engagement offer or 402 refusal alike — routes to density_screen", () => {
    const offer = engagementOfferBlock("gridforge_qualify");
    const refusalQuota = blockFromRefusal("gridforge_study", {
      ok: false,
      reason: "quota_exceeded",
      status: 402,
      detail: "over quota",
    });
    const refusalEntitlement = blockFromRefusal("gridforge_screen", {
      ok: false,
      reason: "rejected",
      status: 402,
      detail: "no entitlement",
    });

    for (const serverBlock of [offer, refusalQuota, refusalEntitlement]) {
      const [adapted] = adaptServerBlocks([serverBlock]);
      expect(adapted.type).toBe("commercialAction");
      if (adapted.type !== "commercialAction") throw new Error("unreachable");
      expect(adapted.productId).toBe("density_screen");
      // Never 429-shaped language, and every route is the one catalogue.
      expect(adapted.reason.length).toBeGreaterThan(0);
    }
  });

  it("drops a block it cannot validate rather than throwing", () => {
    const adapted = adaptServerBlocks([{ type: "metric", label: "broken", quantity: { value: "not-a-number" } }]);
    expect(adapted).toHaveLength(0);
  });
});
