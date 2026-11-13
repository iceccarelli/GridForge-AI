/**
 * What a token holder is told when the engine fails, versus what is logged.
 *
 * POST /api/intake/[token] returned `detail: stored.error` and POST /api/watch/[token] returned `detail: out.error`, and those strings are
 * the engine client's own: "GRIDFORGE_API_KEY is not set", "connect ECONNREFUSED 10.0.3.7:8080", the engine's own error body. A buyer's
 * browser (or anyone holding the link) got a map of our configuration and network. The buyer now gets one fixed sentence; the text goes
 * to the server log (addresses and link tokens removed), where it was always going to be needed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { siteUrl } from "@/lib/site";
import { resetMemoryLimiter } from "@/lib/rate-limit";
import { PostgrestFake } from "./postgrest-fake";

const ENGINE = "http://10.0.3.7:8080";
const INTAKE = {
  siteName: "North Hall", hallId: "H1", metro: "Dublin", firmCapacityMVA: 15, contractedMW: 12, currentPeakMW: 7.4,
  currentItLoadMW: 4.9, buswayAmpacityA: 400, tapoffMaxA: 63, floorLoadingKPa: 12, positionsAvailable: 180,
  plantCapacityKW: 6000, plantSupplyC: 6, platform: "gb300_nvl72",
};
const INTERNAL = [/GRIDFORGE_API/i, /ECONNREFUSED/i, /10\.0\.3\.7/, /8080/, /engine (4|5)\d\d/i, /Traceback/i, /KeyError/];

let db: PostgrestFake;
let restore: () => void;
let engine: (url: string, init?: RequestInit) => Promise<Response>;
let logged: string[] = [];

beforeEach(() => {
  resetMemoryLimiter();
  process.env.SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_test";
  process.env.GRIDFORGE_API_URL = ENGINE;
  process.env.GRIDFORGE_API_KEY = "engine-key";
  delete process.env.RESEND_API_KEY;
  delete process.env.LEAD_TO_EMAIL;
  logged = [];
  db = new PostgrestFake(["deliverables", "watches", "watch_notes"]);
  restore = db.install();
  const below = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith(ENGINE)) return engine(url, init);
    return below(input as RequestInfo, init);
  }) as typeof fetch;
  for (const m of ["log", "info", "warn", "error"] as const) {
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { logged.push(a.map((x) => (x instanceof Error ? x.message : String(x))).join(" ")); });
  }
});
afterEach(() => {
  restore();
  vi.restoreAllMocks();
});

const ctx = (token: string) => ({ params: Promise.resolve({ token }) });
const post = (path: string, body: unknown) => new Request(siteUrl(path), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

function expectNoInternals(body: unknown) {
  const blob = JSON.stringify(body);
  for (const re of INTERNAL) expect(blob, `a response to a token holder carried internal text matching ${re}`).not.toMatch(re);
}

describe("POST /api/intake/[token] when the engine cannot produce the document", () => {
  const seed = () => db.seed("deliverables", [{ token: "engagement-token", kind: "density_screen", status: "awaiting_intake", company: "North Hall", stripe_session_id: "cs_1", email: "buyer@hall.example" }]);
  const run = async () => (await import("@/app/api/intake/[token]/route")).POST(post("/api/intake/engagement-token", INTAKE), ctx("engagement-token"));

  it("answers with a fixed sentence, not the connection error, and logs the cause", async () => {
    seed();
    engine = async () => { throw new Error("connect ECONNREFUSED 10.0.3.7:8080"); };
    const res = await run();
    expect(res.status).toBe(502);
    const body = await res.json();
    expectNoInternals(body);
    expect(body.ok).toBe(false);
    expect(body.detail).toBe("We could not generate this right now. It has been logged.");
    // Truthful: it IS in the server log, with its cause (the log is the place for it).
    expect(logged.some((l) => /ECONNREFUSED/.test(l))).toBe(true);
  });

  it("does not reveal that the server's key is unset", async () => {
    seed();
    delete process.env.GRIDFORGE_API_KEY;
    engine = async () => new Response("{}", { status: 200 });
    const res = await run();
    const body = await res.json();
    expect(res.status).toBe(502);
    expectNoInternals(body);
    expect(body.detail).toBe("We could not generate this right now. It has been logged.");
    expect(logged.some((l) => /GRIDFORGE_API_KEY/.test(l))).toBe(true);
  });

  it("does not forward the engine's own error body", async () => {
    seed();
    engine = async () => new Response(JSON.stringify({ error: "Traceback (most recent call): KeyError 'tapoffMaxA' in solver.py" }), { status: 500 });
    const res = await run();
    const body = await res.json();
    expectNoInternals(body);
    expect(logged.some((l) => /KeyError/.test(l))).toBe(true);
  });
});

describe("POST /api/watch/[token] when the model cannot be re-solved", () => {
  const seed = () =>
    db.seed("watches", [{ id: "w1", token: "watch-token", status: "active", cadence: "quarterly", email: "buyer@hall.example", company: "Hall Co", site_name: "North Hall", hall_id: "H1", intake: null, last_state: null }]);
  const run = async () => (await import("@/app/api/watch/[token]/route")).POST(post("/api/watch/watch-token", INTAKE), ctx("watch-token"));

  it("answers with a fixed sentence, not the connection error, and logs the cause", async () => {
    seed();
    engine = async () => { throw new Error("connect ECONNREFUSED 10.0.3.7:8080"); };
    const res = await run();
    expect(res.status).toBe(502);
    const body = await res.json();
    expectNoInternals(body);
    expect(body.ok).toBe(false);
    expect(body.detail).toBe("We could not generate this right now. It has been logged.");
    expect(logged.some((l) => /ECONNREFUSED/.test(l))).toBe(true);
  });

  it("does not forward the engine's own error body", async () => {
    seed();
    engine = async () => new Response(JSON.stringify({ error: "Traceback (most recent call): KeyError 'tapoffMaxA'" }), { status: 500 });
    const res = await run();
    const body = await res.json();
    expectNoInternals(body);
    expect(logged.some((l) => /KeyError/.test(l))).toBe(true);
  });
});

describe("POST /api/deliverable/[token]/bids when the engine fails for its own reasons", () => {
  it("a 5xx from the engine is a fixed sentence; a 422 about the buyer's own responses is still shown", async () => {
    db.seed("deliverables", [{
      token: "doc-token", intake_token: "intake-token", kind: "procurement_spec", status: "released", email: "buyer@hall.example", billing_hold: null,
      intake: { siteName: "North Hall", contractedMW: 12 }, released_at: "2026-11-01T00:00:00Z",
    }]);
    const { compareBids } = await import("@/lib/deliverables");
    engine = async () => new Response(JSON.stringify({ error: "Traceback KeyError at 10.0.3.7:8080 (GRIDFORGE_API_KEY)" }), { status: 500 });
    const row = db.rows("deliverables")[0] as never;
    const refused = await compareBids(row, [{ supplier: "A" }]);
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.status).toBe(502);
      expectNoInternals(refused);
    }
    engine = async () => new Response(JSON.stringify({ error: "Response 2: the transformer rating is missing." }), { status: 422 });
    const mine = await compareBids(row, [{ supplier: "A" }]);
    expect(mine.ok).toBe(false);
    if (!mine.ok) {
      expect(mine.status).toBe(422);
      expect(mine.error).toContain("the transformer rating is missing");
    }
  });
});
