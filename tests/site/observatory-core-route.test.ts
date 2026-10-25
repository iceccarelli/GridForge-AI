import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetContextCache } from "@/lib/observatory/sources";
import { EIA_KEY, H, T0, awattar, eiaRow, grid, hourly, jsonResponse, routedFetch, type Routes } from "./observatory-core-harness";

const HOURS_10 = Date.UTC(2026, 9, 25, 10, 0, 0);

function install(routes: Routes) {
  const r = routedFetch(routes);
  vi.stubGlobal("fetch", r.fn);
  return r;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  resetContextCache();
  vi.stubEnv("EIA_API_KEY", "");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  resetContextCache();
});

describe("GET /api/observatory/context", () => {
  it("returns exactly a LiveContext, status 200, with CDN-friendly headers", async () => {
    install({ market: awattar(hourly(HOURS_10 - 2 * H, 6)), grid: grid(Math.floor(T0 / 1000) - 600) });
    const { GET } = await import("@/app/api/observatory/context/route");
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=0, s-maxage=300");
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(["dayAheadPrice", "generatedAt", "generationMix", "queue", "referenceRegion", "usDemand"]);
    expect(body.generatedAt).toBe(new Date(T0).toISOString());
    expect(body.dayAheadPrice.value.eurPerMWh).toBe(52);
    expect(body.dayAheadPrice.provenance.basis).toBe("day_ahead_auction");
    expect(body.generationMix.freshness).toBe("fresh");
    expect(body.queue.provenance.basis).toBe("published_report");
    expect(body.usDemand.freshness).toBe("not_applicable");
    for (const k of ["dayAheadPrice", "generationMix", "queue", "usDemand"]) {
      expect(Object.keys(body[k]).sort()).toEqual(["freshness", "provenance", "value"]);
      expect(typeof body[k].provenance.source).toBe("string");
      expect(["fresh", "stale", "unavailable", "not_applicable"]).toContain(body[k].freshness);
    }
  });

  it("serves repeated requests from the 5-minute cache: upstream is hit once per feed", async () => {
    const r = install({ market: awattar(hourly(HOURS_10 - 2 * H, 6)), grid: grid(Math.floor(T0 / 1000)) });
    const { GET } = await import("@/app/api/observatory/context/route");
    for (let i = 0; i < 5; i++) await GET();
    expect(r.count("awattar")).toBe(1);
    expect(r.count("energy-charts")).toBe(1);
  });

  it("an outage of both live feeds is still 200 with honest nulls, and is not pinned in the CDN for five minutes", async () => {
    install({ market: () => jsonResponse({}, 502), grid: () => jsonResponse({}, 502) });
    const { GET } = await import("@/app/api/observatory/context/route");
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=0, s-maxage=30");
    const body = await res.json();
    expect(body.dayAheadPrice).toMatchObject({ value: null, freshness: "unavailable" });
    expect(body.generationMix).toMatchObject({ value: null, freshness: "unavailable" });
  });

  it("with the EIA key configured the response carries the overlay but never the key", async () => {
    vi.stubEnv("EIA_API_KEY", EIA_KEY);
    install({ market: awattar(hourly(HOURS_10 - 2 * H, 6)), grid: grid(Math.floor(T0 / 1000)), eia: eiaRow("2026-10-25T09", 400000) });
    const { GET } = await import("@/app/api/observatory/context/route");
    const res = await GET();
    const text = await res.text();
    expect(text).not.toContain(EIA_KEY);
    expect(JSON.parse(text).usDemand.value).toEqual({ mw: 400000, period: "2026-10-25T09" });
  });

  it("is a dynamic, unguarded read-only route like /api/market (no provider credential is spent)", async () => {
    const mod = await import("@/app/api/observatory/context/route");
    expect(mod.dynamic).toBe("force-dynamic");
    const src = (await import("node:fs")).readFileSync("app/api/observatory/context/route.ts", "utf8");
    expect(src).not.toMatch(/engineFetch|anthropicFetch|ANTHROPIC_API_KEY|GRIDFORGE_API_KEY/);
  });
});
