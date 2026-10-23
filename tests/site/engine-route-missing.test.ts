import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { engineServes, resetEngineCapabilityCache } from "@/lib/engine-capabilities";
import { GET as llms } from "@/app/llms.txt/route";
import { runCompare } from "@/lib/ttp-compare-server";
import { compareRequestSchema } from "@/lib/ttp-compare";

const HALL = {
  siteName: "Synthetic Hall", hallId: "H1", metro: "Dublin", firmCapacityMVA: 15, contractedMW: 12, currentPeakMW: 7.4,
  currentItLoadMW: 4.9, buswayAmpacityA: 400, tapoffMaxA: 63, floorLoadingKPa: 12, positionsAvailable: 180,
  plantCapacityKW: 6000, plantSupplyC: 6, platform: "gb300_nvl72",
};

const OLD_ENGINE_404 = { error: "not found", endpoints: ["/v1/qualify", "/v1/screen"] };
const real = globalThis.fetch;

function engine(routes: string[] | "down") {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/v1/version")) {
      if (routes === "down") throw new Error("unreachable");
      return new Response(JSON.stringify({ endpoints: routes }), { status: 200 });
    }
    if (url.includes("gridforge-engine") || url.includes("engine.test")) return new Response(JSON.stringify(OLD_ENGINE_404), { status: 404 });
    return real(input);
  }) as unknown as typeof fetch;
}

beforeEach(() => resetEngineCapabilityCache());
afterEach(() => { globalThis.fetch = real; vi.unstubAllEnvs(); });

describe("an engine release that predates the site", () => {
  it("engineServes is true only when the deployed engine lists the route, and false when it cannot be read", async () => {
    engine(["/v1/qualify"]);
    expect(await engineServes("/v1/qualify")).toBe(true);
    expect(await engineServes("/v1/compare")).toBe(false);
    resetEngineCapabilityCache();
    engine("down");
    expect(await engineServes("/v1/qualify")).toBe(false);
  });

  it("llms.txt advertises /v1/compare only while the engine serves it", async () => {
    engine(["/v1/qualify"]);
    expect(await (await llms()).text()).not.toContain("/v1/compare");
    resetEngineCapabilityCache();
    engine(["/v1/qualify", "/v1/compare"]);
    expect(await (await llms()).text()).toContain("/v1/compare");
  });

  it("the comparison reports 503 'not deployed', not a generic outage, and says nothing was charged", async () => {
    vi.stubEnv("GRIDFORGE_API_URL", "https://engine.test");
    vi.stubEnv("GRIDFORGE_API_KEY", "k");
    engine(["/v1/qualify"]);
    const out = await runCompare(compareRequestSchema.parse({ hall: HALL, btm_options: [] }));
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.status).toBe(503);
      expect(out.error).toMatch(/not available yet/);
      expect(out.error).toMatch(/charged/);
    }
  });
});
