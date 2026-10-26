/**
 * The provider-spend gate against REAL PostgreSQL through REAL PostgREST: the counter's atomicity under concurrency, across
 * "instances" (independent module copies, as separate serverless processes would be), across callers and through a real
 * chat request's fan-out. Nothing about the counter is simulated here; the providers are local stand-ins that count what
 * they were really asked to do.
 *
 * Skipped unless GF_PGRST_URL and GF_PGRST_JWT are set (scripts/realdb-up.sh) -- a skip is a gap in what was checked.
 */
import http from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { siteUrl } from "@/lib/site";

const PGRST = process.env.GF_PGRST_URL ?? "";
const JWT = process.env.GF_PGRST_JWT ?? "";
const enabled = !!PGRST && !!JWT;
const required = process.env.GF_REQUIRE_REALDB === "1";

describe("real-database prerequisites (provider spend)", () => {
  it.runIf(required)("are present when the real database is required", () => {
    expect(PGRST).not.toBe("");
    expect(JWT).not.toBe("");
  });
  it.runIf(required && enabled)("migration 0024 is applied", async () => {
    const r = await fetch(`${PGRST}/rate_limit_windows?limit=1`, { headers: { Authorization: `Bearer ${JWT}` } });
    expect(r.status).toBe(200);
  });
});

let gateway: http.Server | null = null;
let gatewayMode: "ok" | "no-function" | "down" = "ok";
let providerCalls: { provider: "engine" | "anthropic"; path: string }[] = [];
const realFetch = globalThis.fetch;
const ENGINE = "http://engine.test";
const HOUR_MS = 3_600_000;
/** How close to the end of an hour a test may start before it waits for the next window (the slowest test here takes about 4 s on a loaded runner). */
const WINDOW_GUARD_MS = 30_000;
/**
 * The tests that fire hundreds of concurrent calls through the gateway and PostgREST take 1-3 s on an idle machine (the CI run
 * that failed measured 1.0-1.9 s) and 5 s or more when the machine is busy, against vitest's default 5 s limit. A timeout does not stop the work it interrupts: the abandoned
 * calls keep running and are counted by (and pollute) the NEXT test, so one slow runner used to fail several tests.
 */
const SLOW_TEST_MS = 60_000;

async function startGateway(): Promise<string> {
  gateway = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const url = req.url ?? "";
    if (!url.startsWith("/rest/v1/")) { res.writeHead(404).end("{}"); return; }
    if (gatewayMode === "down") { res.writeHead(502).end("{}"); return; }
    if (gatewayMode === "no-function" && url.includes("/rpc/gf_rate_limit_hit")) {
      res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ code: "PGRST202", message: "Could not find the function public.gf_rate_limit_hit" }));
      return;
    }
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string" && k !== "host" && k !== "content-length") headers[k] = v;
    const r = await realFetch(PGRST + url.slice("/rest/v1".length), { method: req.method, headers, body: ["GET", "HEAD"].includes(req.method ?? "") ? undefined : Buffer.concat(chunks) });
    res.writeHead(r.status, { "content-type": r.headers.get("content-type") ?? "application/json" });
    res.end(Buffer.from(await r.arrayBuffer()));
  });
  await new Promise<void>((r) => gateway!.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(gateway!.address() as { port: number }).port}`;
}

const sql = (path: string) => realFetch(PGRST + path, { headers: { Authorization: `Bearer ${JWT}` } });
const rows = async (q: string) => (await (await sql(`/rate_limit_windows?select=*&${q}`)).json()) as { bucket: string; subject: string; hits: number }[];
const hitsOf = async (bucket: string) => (await rows(`bucket=eq.${bucket}`)).reduce((n, r) => n + r.hits, 0);

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
let anthropicScript: (n: number) => unknown;

beforeAll(async () => {
  if (!enabled) return;
  process.env.SUPABASE_URL = await startGateway();
  process.env.SUPABASE_SERVICE_ROLE_KEY = JWT;
  process.env.GRIDFORGE_API_URL = ENGINE;
  process.env.GRIDFORGE_API_KEY = "engine-key";
  process.env.ANTHROPIC_API_KEY = "sk-ant-never-called";
  delete process.env.RESEND_API_KEY;
  globalThis.fetch = (async (i: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof i === "string" ? i : i instanceof URL ? i.href : i.url;
    if (url.startsWith(ENGINE)) {
      providerCalls.push({ provider: "engine", path: new URL(url).pathname });
      return json(200, { platform: { id: "p", name: "GB300" }, as_found: { racks: 1, binding_constraint: "Rack feed" }, after_relief: { racks: 2 }, intake: { completeness: 1 } });
    }
    if (url.includes("api.anthropic.com/v1/messages")) {
      providerCalls.push({ provider: "anthropic", path: "/v1/messages" });
      return json(200, anthropicScript(providerCalls.filter((c) => c.provider === "anthropic").length - 1));
    }
    return realFetch(i as RequestInfo, init);
  }) as typeof fetch;
});
afterAll(() => { globalThis.fetch = realFetch; gateway?.close(); });
beforeEach(() => { providerCalls = []; gatewayMode = "ok"; anthropicScript = () => ({ id: "m", type: "message", role: "assistant", model: "x", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }); });

/**
 * A caller address that no other call in this process, and no earlier run on the same database, has used. The per-caller
 * counters are keyed by the pseudonym of the address for the whole hour and the beforeEach below does NOT clear them (only the
 * shared ceilings), so a repeated address starts with its allowance already spent. The first version drew
 * 198.51.100.<1..200> at random: two draws landing on the same octet (about 1 in 200 per pair, within one run, and far more
 * often against the leftovers of earlier runs on a shared database) gave the later caller 0 of its 240, and the "many callers"
 * test then saw 480 (two callers x 240) instead of 600. Here: an IPv6 address in the documentation prefix 2001:db8::/32 with
 * a random /64 (the limiter keys IPv6 on its /64), 32 random bits, and an in-process set that makes a repeat impossible.
 */
const usedAddresses = new Set<string>();
function fresh(): string {
  for (;;) {
    const group = () => Math.floor(Math.random() * 0x10000).toString(16);
    const ip = `2001:db8:${group()}:${group()}::1`;
    if (!usedAddresses.has(ip)) {
      usedAddresses.add(ip);
      return ip;
    }
  }
}
const reqFrom = (ip: string) => new Request(siteUrl("/api/x"), { method: "POST", headers: { "x-forwarded-for": ip } });

async function spend(mod: typeof import("@/lib/rate-limit"), ip: string, n: number, path = "/v1/compare"): Promise<number> {
  const g = await mod.guardRequest(new Request(siteUrl("/api/x"), { method: "POST", headers: { "x-forwarded-for": ip } }), "ttp_compare");
  if (g.denied) return 0;
  let reached = 0;
  await g.run(async () => {
    const answers = await Promise.all(Array.from({ length: n }, () => mod.engineFetch(`${ENGINE}${path}`, { method: "POST" })));
    reached = answers.filter((r) => r.status === 200).length;
  });
  return reached;
}

describe.skipIf(!enabled)("the provider gate on real PostgreSQL", () => {
  // Shared ceilings are keyed by bucket only, so earlier tests or runs in the same hour would otherwise already have spent them.
  // This is a throwaway database; start every test from empty ceilings so the arithmetic is exact.
  beforeEach(async () => {
    // The counter's windows are wall-clock aligned (gf_rate_limit_hit floors the DATABASE clock to the hour) and cannot be
    // injected. A test that starts in the last seconds of an hour would have its attempts split over two windows, and the
    // second window begins with a fresh allowance, so more than `limit` calls would reach the provider. Start after the
    // boundary instead: a wait of at most WINDOW_GUARD_MS + 1 s, only in that rare case.
    const intoHour = Date.now() % HOUR_MS;
    if (intoHour > HOUR_MS - WINDOW_GUARD_MS) await new Promise((r) => setTimeout(r, HOUR_MS - intoHour + 1000));
    const rl = await import("@/lib/rate-limit");
    for (const b of Object.values(rl.PROVIDER_BUDGETS)) {
      const r = await realFetch(`${PGRST}/rate_limit_windows?bucket=eq.${b.aggregate.bucket}`, { method: "DELETE", headers: { Authorization: `Bearer ${JWT}` } });
      expect(r.status).toBeLessThan(300);
    }
  }, WINDOW_GUARD_MS + 30_000);

  it("concurrent calls from one caller: exactly the budget reaches the provider, and every attempt is counted once", async () => {
    const rl = await import("@/lib/rate-limit");
    const ip = fresh();
    const budget = rl.PROVIDER_BUDGETS["engine:public:metered"];
    const reached = await spend(rl, ip, budget.caller.limit + 60);
    expect(reached).toBe(budget.caller.limit);
    expect(providerCalls).toHaveLength(budget.caller.limit);
    const who = rl.callerIdentity(reqFrom(ip));
    const mine = await rows(`bucket=eq.${budget.caller.bucket}&subject=eq.${who.ok ? who.subject : "x"}`);
    expect(mine.reduce((n, r) => n + r.hits, 0)).toBe(budget.caller.limit + 60);
  }, SLOW_TEST_MS);

  it("two independent instances (separate module copies, as separate serverless processes) share one threshold", async () => {
    vi.resetModules();
    const a = await import("@/lib/rate-limit");
    vi.resetModules();
    const b = await import("@/lib/rate-limit");
    expect(a).not.toBe(b);
    const ip = fresh();
    const limit = a.PROVIDER_BUDGETS["engine:public:metered"].caller.limit;
    const [ra, rb] = await Promise.all([spend(a, ip, 150), spend(b, ip, 150)]);
    // 300 attempts split across two instances: the database, not either process, decides.
    expect(ra + rb).toBe(limit);
    expect(providerCalls).toHaveLength(limit);
  }, SLOW_TEST_MS);

  it("many callers inside their own allowances still cannot pass the shared aggregate", async () => {
    const rl = await import("@/lib/rate-limit");
    const agg = rl.PROVIDER_BUDGETS["engine:public:metered"];
    expect(await hitsOf(agg.aggregate.bucket)).toBe(0);
    const callers = [fresh(), fresh(), fresh()]; // three distinct callers, none of which has spent anything yet
    expect(new Set(callers).size).toBe(3);
    const room = agg.aggregate.limit;
    const results = await Promise.all(callers.map((ip) => spend(rl, ip, agg.caller.limit)));
    const total = results.reduce((a, b) => a + b, 0);
    // Three callers each asked for their whole per-caller budget (3 x 240 = 720); the aggregate (600) is what stops them.
    expect(agg.caller.limit * 3).toBeGreaterThan(room);
    expect(total).toBe(room);
    expect(providerCalls).toHaveLength(total);
    expect(total).toBeLessThanOrEqual(agg.aggregate.limit);
  }, SLOW_TEST_MS);

  it("the counter stores only keyed pseudonyms", async () => {
    const all = await rows("limit=200");
    expect(all.length).toBeGreaterThan(0);
    for (const r of all) expect(r.subject).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(all)).not.toMatch(/198\.51\.100|2001:db8/);
  });

  it("a gateway that cannot find the function (migration 0024 not applied) or is down: 503 and no provider call", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const rl = await import("@/lib/rate-limit");
    for (const mode of ["no-function", "down"] as const) {
      gatewayMode = mode;
      const g = await rl.guardRequest(new Request(siteUrl("/api/x"), { method: "POST", headers: { "x-forwarded-for": fresh() } }), "qualify");
      expect(g.denied?.status).toBe(503);
    }
    expect(providerCalls).toHaveLength(0);
    vi.restoreAllMocks();
  });

  it("a real chat request's fan-out is counted call by call in the database: 6 model calls, 4 tool calls, 1 request", async () => {
    anthropicScript = (n) => ({
      id: "m", type: "message", role: "assistant", model: "x", stop_reason: "tool_use", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 },
      content: [{ type: "tool_use", id: `tu_${n}`, name: "gridforge_qualify", input: { contracted_MW: 12, current_site_peak_MW: 7.4, current_it_load_MW: 4.9, busway_ampacity_A: 400, tapoff_max_A: 63, plant_supply_C: 6, positions_available: 180 } }],
    });
    const ip = fresh();
    const rl = await import("@/lib/rate-limit");
    const who = rl.callerIdentity(reqFrom(ip));
    const subject = who.ok ? who.subject : "x";
    const { POST } = await import("@/app/api/chat/route");
    const res = await POST(new Request(siteUrl("/api/chat"), {
      method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip },
      body: JSON.stringify({ messages: [{ role: "user", content: "a" }, { role: "assistant", content: "b" }, { role: "user", content: "c" }] }),
    }));
    expect(res.status).toBe(200);
    const anth = providerCalls.filter((c) => c.provider === "anthropic").length;
    const eng = providerCalls.filter((c) => c.provider === "engine").length;
    expect([anth, eng]).toEqual([rl.CHAT_MAX_ANTHROPIC_CALLS, rl.CHAT_MAX_ENGINE_CALLS]);
    const mine = (bucket: string) => rows(`bucket=eq.${bucket}&subject=eq.${subject}`).then((r) => r.reduce((n, x) => n + x.hits, 0));
    expect(await mine("chat")).toBe(1);
    expect(await mine("anthropic_public_caller")).toBe(rl.CHAT_MAX_ANTHROPIC_CALLS);
    expect(await mine("engine_public_free_caller")).toBe(rl.CHAT_MAX_ENGINE_CALLS);
  }, SLOW_TEST_MS);
});
