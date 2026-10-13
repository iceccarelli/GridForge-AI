import { describe, expect, it, vi, beforeEach } from "vitest";
import { engineUnavailableMessage } from "@/app/api/qualify/unavailable-message";

describe("engineUnavailableMessage", () => {
  it("never claims saved when persistence failed", () => {
    const m = engineUnavailableMessage(false, true);
    expect(m).toMatch(/NOT saved/);
    expect(m).not.toMatch(/come back/);
  });
  it("promises follow-up only with contact details", () => {
    expect(engineUnavailableMessage(true, true)).toMatch(/come back to you/);
    expect(engineUnavailableMessage(true, false)).not.toMatch(/come back/);
    expect(engineUnavailableMessage(true, false)).toMatch(/no contact details/);
  });
});

describe("POST /api/qualify with engine and store down", () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.GRIDFORGE_API_URL;
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  it("says not saved", async () => {
    const { POST } = await import("@/app/api/qualify/route");
    const res = await POST(
      new Request("http://x/api/qualify", {
        method: "POST",
        body: JSON.stringify({
          contractedMW: 40, currentPeakMW: 20, currentItLoadMW: 15, buswayAmpacityA: 4000, tapoffMaxA: 800, plantSupplyC: 25, positionsAvailable: 100,
        }),
      })
    );
    const body = await res.json();
    expect([502, 503]).toContain(res.status);
    expect(body.saved).toBe(false);
    expect(body.error).toMatch(/NOT saved/);
  });
});

describe("sitemap and layout", () => {
  it("lists /power/deploy", async () => {
    const sm = (await import("@/app/sitemap")).default;
    const urls = (await sm()).map((e) => e.url);
    expect(urls.some((u) => u.endsWith("/power/deploy"))).toBe(true);
  });
  it("layout metadata takes price and turnaround from the catalogue, not literals", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(require("node:path").resolve(__dirname, "../../app/layout.tsx"), "utf8");
    expect(src).toContain("PRODUCTS.density_screen");
    expect(src).not.toMatch(/EUR 4,500|4,500/);
  });
});
