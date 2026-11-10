/**
 * The engine sheds load with 503 + Retry-After + a JSON body (gridforge/api/server.py, SOLVE_GATE). The website must not turn that into a 502
 * "rejected" or show the engine's internal sentence to a visitor: it answers 503 with the Retry-After header and one short honest sentence.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENGINE_BUSY_MESSAGE, callEngine, retryAfterSeconds } from "@/lib/qualify";
import { siteUrl } from "@/lib/site";
import { resetMemoryLimiter } from "@/lib/rate-limit";

vi.mock("@/lib/funnel", async (orig) => ({ ...(await orig<typeof import("@/lib/funnel")>()), recordFunnelEvent: async () => true }));

const INPUT = {
  siteName: "North Hall", platform: "gb300_nvl72", contractedMW: 12, currentPeakMW: 7.4, currentItLoadMW: 4.9, buswayAmpacityA: 400,
  tapoffMaxA: 63, plantSupplyC: 6, positionsAvailable: 180,
};
const ENGINE_SENTENCE = "the engine is busy; nothing was run and nothing was charged";

let previous: typeof fetch;
beforeEach(() => {
  previous = globalThis.fetch;
  process.env.GRIDFORGE_API_URL = "http://engine.test";
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  resetMemoryLimiter();
});
afterEach(() => {
  globalThis.fetch = previous;
  delete process.env.GRIDFORGE_API_URL;
  vi.restoreAllMocks();
});

const engineAnswers = (status: number, headers: Record<string, string>, body: unknown) => {
  globalThis.fetch = (async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } })) as typeof fetch;
};

describe("Retry-After as seconds", () => {
  it("reads whole seconds, clamps to 1..60, and refuses everything else", () => {
    expect(retryAfterSeconds("2")).toBe(2);
    expect(retryAfterSeconds(" 30 ")).toBe(30);
    expect(retryAfterSeconds("0")).toBe(1);
    expect(retryAfterSeconds("3600")).toBe(60);
    for (const bad of [null, "", "soon", "-1", "1.5", "Wed, 21 Oct 2026 07:28:00 GMT"]) expect(retryAfterSeconds(bad)).toBeNull();
  });
});

describe("callEngine: a 503 with Retry-After is busy, not rejected", () => {
  it("is reported as busy with our sentence, never the engine's", async () => {
    engineAnswers(503, { "Retry-After": "2" }, { error: ENGINE_SENTENCE, retryable: true, retry_after_seconds: 2 });
    const out = await callEngine(INPUT as never);
    expect(out).toEqual({ ok: false, reason: "busy", detail: ENGINE_BUSY_MESSAGE, retryAfterSeconds: 2 });
    expect(JSON.stringify(out)).not.toContain("nothing was run");
  });
  it("a 503 WITHOUT Retry-After, and any other refusal, stay what they were", async () => {
    engineAnswers(503, {}, { error: "paid endpoints are not configured on this deployment" });
    expect(await callEngine(INPUT as never)).toMatchObject({ ok: false, reason: "rejected" });
    engineAnswers(422, { "Retry-After": "2" }, { error: "bad figure" });
    expect(await callEngine(INPUT as never)).toMatchObject({ ok: false, reason: "rejected", detail: "bad figure" });
  });
});

describe("POST /api/qualify when the engine is busy", () => {
  it("answers 503 with the engine's Retry-After and a short honest sentence, and shows none of the engine's text", async () => {
    engineAnswers(503, { "Retry-After": "2" }, { error: ENGINE_SENTENCE, retryable: true, retry_after_seconds: 2, fix: "retry after the Retry-After interval" });
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { POST } = await import("@/app/api/qualify/route");
    const res = await POST(new Request(siteUrl("/api/qualify"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(INPUT) }));
    const body = await res.json();
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("2");
    expect(body).toMatchObject({ ok: false, error: "The capacity engine is busy; try again in a few seconds.", reason: "busy", saved: false });
    expect(JSON.stringify(body)).not.toMatch(/nothing was run|charged|refused, not queued|retry_after_seconds":2,"fix/);
  });
});
