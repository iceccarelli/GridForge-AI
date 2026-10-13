/**
 * Hall Watch: the scheduled run and the client-triggered re-solve.
 *
 * Defects held here: ?key= secret in the URL compared with !==; recordNote()
 * and updateWatch() results ignored (state advanced and clients emailed for notes
 * that were never stored); a failing engine starving later watches; overlapping
 * invocations double-notifying; and a failed engine call on POST saving the new
 * intake without last_state, so the next change was misattributed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { siteUrl } from "@/lib/site";
import { PostgrestFake } from "./postgrest-fake";

const sent: { to: string }[] = [];
vi.mock("@/lib/mail", async (orig) => ({
  ...(await orig<typeof import("@/lib/mail")>()),
  sendMail: async (m: { to: string }) => { sent.push(m); return { sent: true, id: "m1" }; },
}));
// The PostgREST fake has no `or=` operator, which dueWatches() uses; list the
// due rows from the fake directly and keep every other function real.
let dueOverride: (() => unknown[]) | null = null;
vi.mock("@/lib/watches", async (orig) => {
  const real = await orig<typeof import("@/lib/watches")>();
  return { ...real, dueWatches: async () => (dueOverride ? dueOverride() : real.dueWatches()) };
});

const ENGINE = "http://engine.test";
let db: PostgrestFake;
let restore: () => void;
let engine: "ok" | "down";
let engineCalls: number;

function installEngine() {
  const pg = globalThis.fetch;
  globalThis.fetch = (async (i: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof i === "string" ? i : i instanceof URL ? i.href : i.url;
    if (!url.startsWith(ENGINE)) return pg(i as RequestInfo, init);
    engineCalls++;
    if (engine === "down" && !String(init?.body).includes("\"G\"")) return new Response(JSON.stringify({ error: "boom" }), { status: 502 });
    return new Response(
      JSON.stringify({ headline: "Racks moved", material: true, racks_delta: 4, weeks_delta: 2,
        binding_moved: false, after: { racks: 44 }, document: "<p>n</p>" }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;
  return () => { globalThis.fetch = pg; };
}

const past = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
function seedWatch(token: string, over: Record<string, unknown> = {}) {
  db.seed("watches", [
    { id: `id-${token}`, token, status: "active", cadence: "quarterly", email: `${token}@hall.example`,
      intake: { siteName: "H" }, last_state: { racks: 40 }, next_run_at: past(10), ...over },
  ]);
}
const watch = (t: string) => db.rows("watches").find((r: any) => r.token === t) as any;
const cron = (headers: Record<string, string> = {}, qs = "") =>
  new Request(siteUrl(`/api/cron/watches${qs}`), { headers });
const auth = { authorization: "Bearer cron-secret-value" };
async function GET(req: Request) { return (await import("@/app/api/cron/watches/route")).GET(req); }

let restoreEngine: () => void;
beforeEach(() => {
  process.env.SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_test";
  process.env.GRIDFORGE_API_URL = ENGINE;
  process.env.GRIDFORGE_API_KEY = "k";
  process.env.CRON_SECRET = "cron-secret-value";
  sent.length = 0; engine = "ok"; engineCalls = 0;
  db = new PostgrestFake(["watches", "watch_notes"]);
  restore = db.install();
  restoreEngine = installEngine();
  dueOverride = () => db.rows("watches").filter((r: any) => r.status === "active").sort((a: any, b: any) => String(a.next_run_at).localeCompare(String(b.next_run_at))).map((r: any) => ({ ...r }));
});
afterEach(() => { restoreEngine(); restore(); dueOverride = null; });

describe("authorisation", () => {
  it("does not accept the secret in the URL", async () => {
    seedWatch("a");
    const res = await GET(cron({}, "?key=cron-secret-value"));
    expect(res.status).toBe(401);
    expect(engineCalls).toBe(0);
  });
  it("rejects a wrong or missing bearer, and everyone when no secret is set", async () => {
    expect((await GET(cron({ authorization: "Bearer nope" }))).status).toBe(401);
    expect((await GET(cron())).status).toBe(401);
    delete process.env.CRON_SECRET;
    expect((await GET(cron({ authorization: "Bearer " }))).status).toBe(401);
  });
  it("accepts the bearer secret", async () => {
    expect((await GET(cron(auth))).status).toBe(200);
  });
});

describe("a scheduled run", () => {
  it("stores the note, advances state, and emails a material change", async () => {
    seedWatch("a");
    await GET(cron(auth));
    expect(db.rows("watch_notes")).toHaveLength(1);
    expect(watch("a").last_state).toEqual({ racks: 44 });
    expect(sent).toHaveLength(1);
  });

  it("does not advance state or email when the note cannot be stored", async () => {
    seedWatch("a");
    db.dropTable("watch_notes");
    const res = await GET(cron(auth));
    const body = await res.json();
    expect(body.results[0].status).toBe("note_not_stored");
    expect(watch("a").last_state).toEqual({ racks: 40 });
    expect(sent).toHaveLength(0);
    // and it is pushed back so it does not stay at the head of the queue
    expect(new Date(watch("a").next_run_at).getTime()).toBeGreaterThan(Date.now() + 60 * 60_000);
  });

  it("backs a failing watch off so it cannot starve the ones behind it", async () => {
    seedWatch("bad", { next_run_at: past(100), intake: { siteName: "BAD" } });
    seedWatch("good", { next_run_at: past(5), intake: { siteName: "G" } });
    engine = "down";
    await GET(cron(auth));
    expect(new Date(watch("bad").next_run_at).getTime()).toBeGreaterThan(Date.now() + 60 * 60_000);
    // the healthy watch behind it was still served in the same run...
    expect(watch("good").last_state).toEqual({ racks: 44 });
    // ...and the failed one is no longer due, so it cannot head the queue next time
    const dueNow = (dueOverride!() as any[]).filter((r) => new Date(r.next_run_at).getTime() <= Date.now());
    expect(dueNow).toHaveLength(0);
  });

  it("two overlapping invocations process a watch once", async () => {
    seedWatch("a");
    const [r1, r2] = await Promise.all([GET(cron(auth)), GET(cron(auth))]);
    const all = [...(await r1.json()).results, ...(await r2.json()).results];
    expect(all.filter((r: any) => r.status === "changed")).toHaveLength(1);
    expect(all.some((r: any) => r.status === "skipped_claimed_elsewhere")).toBe(true);
    expect(db.rows("watch_notes")).toHaveLength(1);
    expect(sent).toHaveLength(1);
  });
});

describe("client re-solve (POST /api/watch/[token])", () => {
  const INTAKE = {
    siteName: "North Hall", hallId: "H1", metro: "Dublin", firmCapacityMVA: 15, contractedMW: 12,
    currentPeakMW: 7.4, currentItLoadMW: 4.9, buswayAmpacityA: 400, tapoffMaxA: 63, floorLoadingKPa: 12,
    positionsAvailable: 180, plantCapacityKW: 6000, plantSupplyC: 6, platform: "gb300_nvl72",
  };
  const post = () => new Request(siteUrl("/x"), { method: "POST", body: JSON.stringify(INTAKE) });
  const ctx = { params: Promise.resolve({ token: "a" }) };

  it("saves neither intake nor state when the engine fails", async () => {
    seedWatch("a");
    engine = "down";
    const { POST } = await import("@/app/api/watch/[token]/route");
    const res = await POST(post(), ctx);
    expect(res.status).toBe(502);
    expect(watch("a").intake).toEqual({ siteName: "H" });
    expect(watch("a").last_state).toEqual({ racks: 40 });
  });

  it("saves intake and state together on success", async () => {
    seedWatch("a");
    const { POST } = await import("@/app/api/watch/[token]/route");
    const res = await POST(post(), ctx);
    expect(res.status, await res.clone().text()).toBe(200);
    expect(watch("a").last_state).toEqual({ racks: 44 });
    expect(watch("a").site_name).toBe("North Hall");
    expect(watch("a").intake).not.toEqual({ siteName: "H" });
  });

  it("changes nothing when the note cannot be stored", async () => {
    seedWatch("a");
    db.dropTable("watch_notes");
    const { POST } = await import("@/app/api/watch/[token]/route");
    expect((await POST(post(), ctx)).status).toBeGreaterThanOrEqual(500);
    expect(watch("a").last_state).toEqual({ racks: 40 });
  });
});
