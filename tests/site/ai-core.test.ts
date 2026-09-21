/**
 * lib/ai/* — the honesty-kernel building blocks the chat agent is built on,
 * tested in isolation from the model and the network.
 */
import { describe, expect, it } from "vitest";
import { checkEntitlement } from "@/lib/ai/entitlements";
import { extractQuantities, weakestEvidence } from "@/lib/ai/provenance";
import { TOOLS, TOOLS_BY_NAME, requiredKeys, anthropicTools } from "@/lib/ai/tools";
import { blockFromRefusal, missingInputBlock, metricsFromEngineResponse } from "@/lib/ai/responses";
import { isOutOfScope } from "@/lib/ai/policy";

describe("the tool registry mirrors gridforge/api/tools.py", () => {
  it("names exactly the eight published engine tools", () => {
    expect(TOOLS.map((t) => t.name).sort()).toEqual(
      [
        "gridforge_bids",
        "gridforge_diff",
        "gridforge_portfolio",
        "gridforge_proposal",
        "gridforge_qualify",
        "gridforge_screen",
        "gridforge_spec",
        "gridforge_study",
      ].sort()
    );
  });

  it("only gridforge_qualify is free and public", () => {
    const publicFree = TOOLS.filter((t) => t.tier === "public" && t.units === 0);
    expect(publicFree.map((t) => t.name)).toEqual(["gridforge_qualify"]);
  });

  it("every other tool is client tier and metered", () => {
    for (const t of TOOLS) {
      if (t.name === "gridforge_qualify") continue;
      expect(t.tier).toBe("client");
      expect(t.units).toBeGreaterThan(0);
    }
  });

  it("endpoint paths match the engine's own route table", () => {
    expect(TOOLS_BY_NAME.gridforge_qualify.endpoint).toBe("/v1/qualify");
    expect(TOOLS_BY_NAME.gridforge_screen.endpoint).toBe("/v1/screen");
    expect(TOOLS_BY_NAME.gridforge_study.endpoint).toBe("/v1/study");
    expect(TOOLS_BY_NAME.gridforge_portfolio.endpoint).toBe("/v1/portfolio");
    expect(TOOLS_BY_NAME.gridforge_diff.endpoint).toBe("/v1/diff");
    expect(TOOLS_BY_NAME.gridforge_spec.endpoint).toBe("/v1/spec");
    expect(TOOLS_BY_NAME.gridforge_bids.endpoint).toBe("/v1/bids");
    expect(TOOLS_BY_NAME.gridforge_proposal.endpoint).toBe("/v1/proposal");
  });

  it("qualify's required inputs match the seven-number free read", () => {
    expect(requiredKeys(TOOLS_BY_NAME.gridforge_qualify).sort()).toEqual(
      ["busway_ampacity_A", "contracted_MW", "current_site_peak_MW", "tapoff_max_A"].sort()
    );
  });

  it("converts cleanly to Anthropic's tool-calling shape", () => {
    const converted = anthropicTools();
    expect(converted).toHaveLength(TOOLS.length);
    for (const t of converted) {
      expect(typeof t.name).toBe("string");
      expect((t.input_schema as { type: string }).type).toBe("object");
    }
  });
});

describe("entitlements: 402, never 429", () => {
  it("lets the free tool through with no key at all", async () => {
    const result = await checkEntitlement(TOOLS_BY_NAME.gridforge_qualify, {});
    expect(result.allowed).toBe(true);
  });

  it("refuses a paid tool with no key — status 402, not 429", async () => {
    const result = await checkEntitlement(TOOLS_BY_NAME.gridforge_screen, {});
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.status).toBe(402);
      expect(result.reason).toBe("entitlement_required");
    }
  });

  it("refuses a paid tool given a garbage token — still 402", async () => {
    const result = await checkEntitlement(TOOLS_BY_NAME.gridforge_study, {
      apiKeyToken: "not-a-real-key",
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.status).toBe(402);
  });

  it("blockFromRefusal never claims a rate limit for an entitlement failure", () => {
    const block = blockFromRefusal("gridforge_screen", {
      ok: false,
      reason: "rejected",
      status: 402,
      detail: "no entitlement",
    });
    expect(block.type).toBe("commercialAction");
    if (block.type === "commercialAction") {
      expect(block.reason).not.toBe("quota_exceeded");
      expect(block.href).toBe("/pricing");
    }
  });

  it("a quota refusal from the engine becomes a quota_exceeded commercialAction", () => {
    const block = blockFromRefusal("gridforge_study", {
      ok: false,
      reason: "quota_exceeded",
      status: 402,
      detail: "over quota",
    });
    expect(block.type).toBe("commercialAction");
    if (block.type === "commercialAction") expect(block.reason).toBe("quota_exceeded");
  });
});

describe("missing required input never becomes a guess", () => {
  it("produces a missingInput block naming the field", () => {
    const block = missingInputBlock("gridforge_qualify", "tapoff_max_A", "Required by gridforge_qualify.");
    expect(block.type).toBe("missingInput");
    if (block.type === "missingInput") {
      expect(block.field).toBe("tapoff_max_A");
      expect(block.tool).toBe("gridforge_qualify");
    }
  });
});

describe("provenance: evidence class and digest pass through unchanged", () => {
  const mockEngineResponse = {
    platform: {
      id: "gb300_nvl72",
      rack_kW: { value: 132, low: 120, high: 140, unit: "kW", evidence: "E3", label: "Rack power draw", digest: "abc123def456" },
    },
    as_found: {
      racks: 12,
      it_load_kW: { value: 1580, low: null, high: null, unit: "kW", evidence: "E1", label: "IT load as found" },
      binding_constraint: "Rack feed / tap-off rating",
    },
  };

  it("extracts every quantity-shaped leaf with its own evidence class", () => {
    const found = extractQuantities(mockEngineResponse);
    expect(found).toHaveLength(2);
    const rackKw = found.find((f) => f.path === "platform.rack_kW")!;
    expect(rackKw.quantity.evidence).toBe("E3");
    expect(rackKw.quantity.digest).toBe("abc123def456");
    const itLoad = found.find((f) => f.path === "as_found.it_load_kW")!;
    expect(itLoad.quantity.evidence).toBe("E1");
    // No digest in the source payload — must stay null, never synthesized.
    expect(itLoad.quantity.digest).toBeNull();
  });

  it("never invents a digest for a quantity that did not carry one", () => {
    const found = extractQuantities({ x: { value: 1, unit: "MW", evidence: "E0" } });
    expect(found[0].quantity.digest).toBeNull();
  });

  it("metricsFromEngineResponse carries evidence and digest into the block unchanged", () => {
    const blocks = metricsFromEngineResponse("gridforge_qualify", mockEngineResponse);
    const metric = blocks.find((b) => b.type === "metric" && b.label === "Rack power draw");
    expect(metric).toBeDefined();
    if (metric && metric.type === "metric") {
      expect(metric.quantity.evidence).toBe("E3");
      expect(metric.quantity.digest).toBe("abc123def456");
      expect(metric.sourceTool).toBe("gridforge_qualify");
    }
  });

  it("weakestEvidence reports the numerically lowest class present", () => {
    const found = extractQuantities(mockEngineResponse).map((f) => f.quantity);
    expect(weakestEvidence(found)).toBe("E1");
  });
});

describe("scope guard", () => {
  it("flags a microgrid ask as out of scope", () => {
    expect(isOutOfScope("Can you finance a microgrid for our site?")).toBe(true);
  });

  it("flags a financing ask as out of scope", () => {
    expect(isOutOfScope("Could GridForge finance the genset for us?")).toBe(true);
  });

  it("leaves an ordinary scoping question alone", () => {
    expect(isOutOfScope("We have 40 MW contracted in ERCOT, what binds first?")).toBe(false);
  });
});
