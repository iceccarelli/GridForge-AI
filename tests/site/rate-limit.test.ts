/**
 * The request guard in front of the public engine proxies (lib/rate-limit.ts, migration 0025).
 *
 * Three layers, kept honest about what each proves:
 *   1. The decision logic, against an INJECTED limiter. This proves ordering, identity handling, response shapes and
 *      failure behaviour. It proves nothing about the production backend.
 *   2. The real route handlers and the REAL engine, with the in-memory PostgREST standing in for the database. The
 *      counter function there is a restatement; it is serialised by construction, so concurrency here proves the
 *      routes have no check-then-act gap, not that PostgreSQL is atomic.
 *   3. PostgreSQL's atomicity is proven where PostgreSQL is: tests/test_projects_migration.py (parallel psql sessions)
 *      and tests/site/verified-power-record.realdb.test.ts (parallel requests through the real routes).
 * Fixtures are SYNTHETIC; no real address is used (203.0.113.0/24 and 2001:db8::/32 are documentation ranges).
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { siteUrl } from "@/lib/site";
import { PgError, PostgrestFake } from "./postgrest-fake";
import {
  callerIdentity,
  canonicalAddress,
  enforceRateLimit,
  ipBucket,
  policyFor,
  type HitResult,
  type RateLimiter,
} from "@/lib/rate-limit";

const hasPython = spawnSync("python3", ["--version"]).status === 0;
const KEY = "rate-limit-test-key";
let engine: ChildProcess | null = null;
let ENGINE = "";
const realFetch = globalThis.fetch;

async function startEngine(): Promise<string> {
  const code = [
    "import os", `os.environ['GRIDFORGE_API_KEYS']='${KEY}'`, "os.environ['GRIDFORGE_RATE_LIMIT']='0'",
    "from gridforge.api.server import Handler, make_server", "Handler.limiter.per_minute=0",
    "h=make_server('127.0.0.1',0)", "print(h.server_address[1],flush=True)", "h.serve_forever()",
  ].join("\n");
  engine = spawn("python3", ["-c", code], { cwd: process.cwd(), stdio: ["ignore", "pipe", "inherit"] });
  return await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error("engine did not start")), 20_000);
    engine!.stdout!.once("data", (d) => { clearTimeout(t); res(`http://127.0.0.1:${String(d).trim()}`); });
  });
}
beforeAll(async () => { if (hasPython) ENGINE = await startEngine(); }, 30_000);
afterAll(() => engine?.kill());

const GUARD_ENV = [
  "VERCEL", "VERCEL_ENV", "GF_TRUSTED_IP_HEADER", "GF_RATE_LIMIT_KEY", "GF_RATE_LIMIT_DEV_BYPASS",
  "GF_RATE_LIMIT_COMPARE", "GF_RATE_LIMIT_COMPARE_ALL", "GF_RATE_LIMIT_DEPLOY", "GF_RATE_LIMIT_DEPLOY_ALL",
];
let db: PostgrestFake;
let restoreDb: () => void;
let engineCalls: number;
let order: string[];                       // the sequence of limiter decisions and engine calls, to prove ordering

beforeEach(() => {
  for (const k of GUARD_ENV) vi.stubEnv(k, undefined as unknown as string), delete process.env[k];
  process.env.SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_test";
  process.env.GRIDFORGE_API_URL = ENGINE;
  process.env.GRIDFORGE_API_KEY = KEY;
  engineCalls = 0;
  order = [];
  db = new PostgrestFake(["power_deployment_cases", "projects", "project_links", "project_events", "project_comparisons"]);
  db.uniqueKeys.set("projects", [["project_token"]]);
  const hit = db.rpcs.get("gf_rate_limit_hit")!;
  db.rpcs.set("gf_rate_limit_hit", (a, d) => { const r = hit(a, d) as { allowed: boolean }; order.push(`limit:${a.p_bucket.split(":")[0]}:${r.allowed ? "allow" : "deny"}`); return r; });
  const restore = db.install();
  const dbFetch = globalThis.fetch;
  globalThis.fetch = (async (i: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof i === "string" ? i : i instanceof URL ? i.href : i.url;
    if (ENGINE && url.startsWith(ENGINE)) { engineCalls += 1; order.push("engine"); return realFetch(i as RequestInfo, init); }
    return dbFetch(i as RequestInfo, init);
  }) as typeof fetch;
  restoreDb = () => { globalThis.fetch = dbFetch; restore(); };
});
afterEach(() => { restoreDb(); vi.unstubAllEnvs(); vi.restoreAllMocks(); for (const k of GUARD_ENV) delete process.env[k]; });

const IP_A = "203.0.113.7";
const IP_B = "203.0.113.8";
const req = (headers: Record<string, string> = {}) => new Request(siteUrl("/x"), { method: "POST", headers });
const logged = () => JSON.stringify([...(console.error as any).mock.calls, ...(console.warn as any).mock.calls, ...(console.log as any).mock.calls]);
const quiet = () => { vi.spyOn(console, "error").mockImplementation(() => {}); vi.spyOn(console, "warn").mockImplementation(() => {}); vi.spyOn(console, "log").mockImplementation(() => {}); };

const POLICY = { route: "compare" as const, caller: { limit: 3, windowSeconds: 60 }, all: { limit: 100, windowSeconds: 60 } };
function fakeLimiter(answer: (bucket: string, n: number) => HitResult) {
  const seen: { bucket: string; limit: number; windowSeconds: number }[] = [];
  const limiter: RateLimiter = { async hit(bucket, limit, windowSeconds) { seen.push({ bucket, limit, windowSeconds }); return answer(bucket, seen.length); } };
  return { limiter, seen };
}
const ALLOW: HitResult = { ok: true, allowed: true, remaining: 2, limit: 3, window_seconds: 60, retry_after_seconds: 30 };

describe("limits: defaults, overrides, and a garbage setting never disables the guard", () => {
  it("has finite, deliberate defaults", () => {
    expect(policyFor("compare")).toMatchObject({ caller: { limit: 20, windowSeconds: 600 }, all: { limit: 300, windowSeconds: 600 } });
    expect(policyFor("deploy")).toMatchObject({ caller: { limit: 10, windowSeconds: 600 }, all: { limit: 120, windowSeconds: 600 } });
  });
  it("takes '<hits>/<seconds>' overrides and falls back to the default on anything else (0, negative, text, empty)", () => {
    process.env.GF_RATE_LIMIT_COMPARE = "5/30";
    expect(policyFor("compare").caller).toEqual({ limit: 5, windowSeconds: 30 });
    for (const bad of ["0/600", "-1/600", "5/0", "unlimited", "", "5", "5/30/1", "1e9/60", "99999999/60", "5/86401", "5/31536000"]) {
      process.env.GF_RATE_LIMIT_COMPARE = bad;
      expect(policyFor("compare").caller, bad).toEqual({ limit: 20, windowSeconds: 600 });
    }
  });
});

describe("caller identity comes only from a source the deployment vouches for", () => {
  it("off Vercel with no trusted header named: a spoofed X-Forwarded-For / X-Real-IP is ignored; everyone shares one bucket", () => {
    expect(callerIdentity(req({ "x-forwarded-for": IP_A, "x-real-ip": IP_A, "x-vercel-forwarded-for": IP_A }))).toEqual({ kind: "shared" });
    expect(callerIdentity(req())).toEqual({ kind: "shared" });
  });
  it("on Vercel it reads the platform-written header, and a spoofed X-Forwarded-For cannot change the bucket", () => {
    vi.stubEnv("VERCEL", "1");
    const real = callerIdentity(req({ "x-vercel-forwarded-for": IP_A }));
    expect(real.kind).toBe("ip");
    expect(callerIdentity(req({ "x-vercel-forwarded-for": IP_A, "x-forwarded-for": IP_B }))).toEqual(real);   // forged XFF ignored
    expect(callerIdentity(req({ "x-vercel-forwarded-for": IP_B }))).not.toEqual(real);
    expect(callerIdentity(req({ "x-real-ip": IP_A }))).toEqual(real);                                           // documented equivalent
  });
  it("on Vercel a missing or unparseable address is not guessed at", () => {
    vi.stubEnv("VERCEL", "1");
    expect(callerIdentity(req())).toEqual({ kind: "missing" });
    expect(callerIdentity(req({ "x-vercel-forwarded-for": "   " }))).toEqual({ kind: "missing" });
    for (const bad of ["not-an-ip", "1.2.3.4.5", "999.1.1.1", "<script>", "203.0.113.7:8080", "unknown", "1.2.3.4; drop"]) {
      expect(callerIdentity(req({ "x-vercel-forwarded-for": bad })), bad).toEqual({ kind: "malformed" });
    }
  });
  it("accepts IPv6, bracketed IPv6, and takes the last address of a chain", () => {
    vi.stubEnv("VERCEL", "1");
    expect(callerIdentity(req({ "x-vercel-forwarded-for": "2001:db8::1" })).kind).toBe("ip");
    expect(callerIdentity(req({ "x-vercel-forwarded-for": "[2001:db8::1]" })).kind).toBe("ip");
    expect(callerIdentity(req({ "x-vercel-forwarded-for": `${IP_A}, ${IP_B}` }))).toEqual(callerIdentity(req({ "x-vercel-forwarded-for": IP_B })));
  });
  it("an operator behind their own proxy names the header it sets; only that header is read", () => {
    vi.stubEnv("GF_TRUSTED_IP_HEADER", "X-Edge-Client-IP");
    expect(callerIdentity(req({ "x-edge-client-ip": IP_A, "x-forwarded-for": IP_B })).kind).toBe("ip");
    expect(callerIdentity(req({ "x-forwarded-for": IP_B }))).toEqual({ kind: "missing" });
  });
  it("in a list the LAST element (the nearest trusted proxy's observation) counts; elements the client supplied are ignored", () => {
    vi.stubEnv("GF_TRUSTED_IP_HEADER", "x-forwarded-for");
    const real = callerIdentity(req({ "x-forwarded-for": IP_A }));
    // the client prepends a forged value; an appending proxy adds the real address last
    expect(callerIdentity(req({ "x-forwarded-for": `198.51.100.250, ${IP_A}` }))).toEqual(real);
    expect(callerIdentity(req({ "x-forwarded-for": `1.1.1.1, 2.2.2.2, ${IP_A}` }))).toEqual(real);
    expect(callerIdentity(req({ "x-forwarded-for": `${IP_A}, ${IP_B}` }))).not.toEqual(real);   // last wins, not first
    expect(callerIdentity(req({ "x-forwarded-for": `${IP_A}, garbage` }))).toEqual({ kind: "malformed" });
  });
  it("addresses are canonicalised: IPv4-mapped IPv6 is the IPv4 address, IPv6 case does not matter, IPv6 is counted per /64", () => {
    expect(canonicalAddress("203.0.113.7")).toBe("203.0.113.7");
    expect(canonicalAddress("::ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(canonicalAddress("::FFFF:203.0.113.7")).toBe("203.0.113.7");
    expect(canonicalAddress("::ffff:cb00:7107")).toBe("203.0.113.7");
    const a = canonicalAddress("2001:DB8:1:2:aaaa:bbbb:cccc:dddd");
    expect(a).toBe("v6/64:2001:0db8:0001:0002");
    expect(canonicalAddress("2001:db8:1:2::1")).toBe(a);                    // same /64, different host part and spelling
    expect(canonicalAddress("2001:db8:1:2:ffff:ffff:ffff:ffff")).toBe(a);
    expect(canonicalAddress("2001:db8:1:3::1")).not.toBe(a);                // a different /64
    expect(canonicalAddress("2001:db8::1")).toBe("v6/64:2001:0db8:0000:0000");
    expect(canonicalAddress("::1")).toBe("v6/64:0000:0000:0000:0000");
    expect(canonicalAddress("[2001:db8::1]")).toBe("v6/64:2001:0db8:0000:0000");
  });
  it("a zone id, an empty string and non-addresses are refused", () => {
    for (const bad of ["fe80::1%eth0", "", " ", "1.2.3", "1.2.3.4/24", "2001:db8::g", "::ffff:999.1.1.1", "0x7f.0.0.1", "localhost"]) {
      expect(canonicalAddress(bad), bad).toBeNull();
    }
  });
  it("two spellings of one client share a bucket, and two clients in one /64 share one too", () => {
    vi.stubEnv("VERCEL", "1");
    const id = (ip: string) => callerIdentity(req({ "x-vercel-forwarded-for": ip }));
    expect(id("::ffff:203.0.113.7")).toEqual(id("203.0.113.7"));
    expect(id("2001:db8:1:2::1")).toEqual(id("2001:DB8:1:2:ffff::9"));
    expect(id("2001:db8:1:2::1")).not.toEqual(id("2001:db8:1:3::1"));
  });
  it("stores a keyed pseudonym, never the address; a different key gives a different bucket (rotation resets windows)", () => {
    vi.stubEnv("GF_RATE_LIMIT_KEY", "key-one");
    const one = ipBucket(IP_A);
    expect(one).toMatch(/^[0-9a-f]{32}$/);
    expect(one).not.toContain("203");
    expect(ipBucket(IP_A)).toBe(one);
    expect(ipBucket(IP_B)).not.toBe(one);
    vi.stubEnv("GF_RATE_LIMIT_KEY", "key-two");
    expect(ipBucket(IP_A)).not.toBe(one);
  });
});

describe("the decision, against an injected limiter", () => {
  it("below the limit it admits, hits the caller's counter first then the route-wide one, and reports what is left", async () => {
    const { limiter, seen } = fakeLimiter(() => ALLOW);
    const v = await enforceRateLimit(req(), POLICY, limiter);
    expect(v).toMatchObject({ ok: true, bypassed: false, headers: { "RateLimit-Remaining": "2" } });
    expect(seen.map((s) => s.bucket)).toEqual(["compare:shared", "compare:all"]);
    expect(seen[0]).toEqual({ bucket: "compare:shared", limit: 3, windowSeconds: 60 });
  });
  it("a caller over its limit gets 429 with Retry-After and a stable body; the per-caller scope is named", async () => {
    const { limiter } = fakeLimiter((b) => (b.endsWith(":shared") ? { ...ALLOW, allowed: false, remaining: 0, retry_after_seconds: 42 } : ALLOW));
    const v = await enforceRateLimit(req(), POLICY, limiter);
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.code).toBe("rate_limited");
    expect(v.response.status).toBe(429);
    expect(v.response.headers.get("retry-after")).toBe("42");
    expect(v.response.headers.get("cache-control")).toBe("no-store");
    expect(v.response.headers.get("ratelimit-remaining")).toBe("0");
    expect(await v.response.json()).toEqual({
      ok: false, code: "rate_limited", scope: "caller", limit: 3, window_seconds: 60, retry_after_seconds: 42,
      error: "Too many requests from this connection in a short time. Try again in 42 seconds.",
    });
  });
  it("a caller already over ITS limit is refused without touching the route-wide ceiling, so it cannot drain it", async () => {
    const { limiter, seen } = fakeLimiter((b) => (b.endsWith(":shared") ? { ...ALLOW, allowed: false, remaining: 0 } : ALLOW));
    const v = await enforceRateLimit(req(), POLICY, limiter);
    expect(v.ok).toBe(false);
    expect(seen.map((s) => s.bucket)).toEqual(["compare:shared"]);          // "compare:all" was never hit
  });
  it("when the route-wide ceiling is spent the answer names that scope", async () => {
    const { limiter, seen } = fakeLimiter((b) => (b.endsWith(":all") ? { ...ALLOW, allowed: false, retry_after_seconds: 9 } : ALLOW));
    const v = await enforceRateLimit(req(), POLICY, limiter);
    expect(v.ok).toBe(false);
    if (!v.ok) { expect((await v.response.json()).scope).toBe("all"); expect(v.response.status).toBe(429); expect(v.response.headers.get("retry-after")).toBe("9"); }
    expect(seen.map((s) => s.bucket)).toEqual(["compare:shared", "compare:all"]);
  });
  it.each([
    ["the store refuses", { ok: false, reason: "unavailable" } as HitResult, "rate_limiter_unavailable"],
    ["the store times out", { ok: false, reason: "timeout" } as HitResult, "rate_limiter_unavailable"],
    ["the store answers nonsense", { ok: false, reason: "malformed_answer" } as HitResult, "rate_limiter_unavailable"],
    ["the limiter is not configured", { ok: false, reason: "unconfigured" } as HitResult, "rate_limiter_unconfigured"],
  ])("when %s it FAILS CLOSED: 503, a reason code, Retry-After, no detail", async (_n, answer, code) => {
    const { limiter } = fakeLimiter(() => answer);
    const v = await enforceRateLimit(req(), POLICY, limiter);
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.response.status).toBe(503);
    expect(v.response.headers.get("retry-after")).toBe("5");
    const body = await v.response.json();
    expect(body).toMatchObject({ ok: false, code });
    expect(JSON.stringify(body)).not.toMatch(/supabase|stub|sb_secret|rpc|postgrest/i);
  });
  it("under a trusted-proxy policy a missing or malformed address is 503, never a pass and never the shared bucket", async () => {
    vi.stubEnv("VERCEL", "1");
    quiet();
    const { limiter, seen } = fakeLimiter(() => ALLOW);
    for (const h of [{} as Record<string, string>, { "x-vercel-forwarded-for": "garbage" }]) {
      const v = await enforceRateLimit(req(h), POLICY, limiter);
      expect(v.ok).toBe(false);
      if (!v.ok) { expect(v.code).toBe("caller_identity_unavailable"); expect(v.response.status).toBe(503); }
    }
    expect(seen).toEqual([]);
    expect(logged()).not.toContain("garbage");
  });
  it("with no store configured it is 503 'unconfigured'; it does not pass", async () => {
    delete process.env.SUPABASE_URL;
    const { limiter, seen } = fakeLimiter(() => ALLOW);
    const v = await enforceRateLimit(req(), POLICY, limiter);
    expect(v.ok).toBe(false);
    if (!v.ok) { expect(v.code).toBe("rate_limiter_unconfigured"); expect(v.response.status).toBe(503); }
    expect(seen).toEqual([]);
  });
  it("the development bypass needs an explicit '1' AND a non-production runtime; production ignores it, however set", async () => {
    delete process.env.SUPABASE_URL;
    quiet();
    const { limiter } = fakeLimiter(() => ALLOW);
    expect((await enforceRateLimit(req(), POLICY, limiter)).ok).toBe(false);                 // no bypass requested
    vi.stubEnv("GF_RATE_LIMIT_DEV_BYPASS", "true");
    expect((await enforceRateLimit(req(), POLICY, limiter)).ok).toBe(false);                 // only the literal "1"
    vi.stubEnv("GF_RATE_LIMIT_DEV_BYPASS", "1");
    const dev = await enforceRateLimit(req(), POLICY, limiter);
    expect(dev).toMatchObject({ ok: true, bypassed: true });
    expect(logged()).toContain("BYPASSED");
    vi.stubEnv("NODE_ENV", "production");
    expect((await enforceRateLimit(req(), POLICY, limiter)).ok).toBe(false);                 // production runtime (NODE_ENV)
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("VERCEL_ENV", "production");
    expect((await enforceRateLimit(req(), POLICY, limiter)).ok).toBe(false);                 // production runtime (VERCEL_ENV)
  });
  it("the bypass does not apply when a store IS configured: the guard runs for real", async () => {
    vi.stubEnv("GF_RATE_LIMIT_DEV_BYPASS", "1");
    const { limiter, seen } = fakeLimiter(() => ALLOW);
    const v = await enforceRateLimit(req(), POLICY, limiter);
    expect(v).toMatchObject({ ok: true, bypassed: false });
    expect(seen.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
const HALL = {
  siteName: "Synthetic Hall", hallId: "H1", metro: "Dublin", firmCapacityMVA: 15, contractedMW: 12, currentPeakMW: 7.4,
  currentItLoadMW: 4.9, buswayAmpacityA: 400, tapoffMaxA: 63, floorLoadingKPa: 12, positionsAvailable: 180,
  plantCapacityKW: 6000, plantSupplyC: 6, platform: "gb300_nvl72",
};
const REQ = { hall: HALL, objective: "max_compute" };
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(siteUrl(path), { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
const compare = async (body: unknown = REQ, headers: Record<string, string> = {}) =>
  (await import("@/app/api/power/compare/route")).POST(post("/api/power/compare", body, headers));
const ctx = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });

describe.runIf(hasPython)("the public comparison route: the guard decides BEFORE the engine is asked", () => {
  it("below the limit the request reaches the real comparison handler and answers as before", async () => {
    const res = await compare();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true });
    expect(body.result.schema).toBe("gridforge/ttp-compare/1");
    expect(res.headers.get("ratelimit-remaining")).toBe("19");        // 20 per caller by default, one used
    expect(engineCalls).toBe(1);
    expect(order).toEqual(["limit:compare:allow", "limit:compare:allow", "engine"]);   // both counters decide, then the engine
  });

  it("past the limit it is 429 with Retry-After and the engine is not called again", async () => {
    process.env.GF_RATE_LIMIT_COMPARE = "2/600";
    expect((await compare()).status).toBe(200);
    expect((await compare()).status).toBe(200);
    expect(engineCalls).toBe(2);
    const denied = await compare();
    expect(denied.status).toBe(429);
    expect(Number(denied.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect(Number(denied.headers.get("retry-after"))).toBeLessThanOrEqual(600);
    expect(await denied.json()).toMatchObject({ ok: false, code: "rate_limited", scope: "caller", limit: 2, window_seconds: 600 });
    expect(engineCalls).toBe(2);                                        // not spent
    expect(order.slice(-2)).toEqual(["engine", "limit:compare:deny"]);        // the refusal is the last thing that happened: no engine after it
  });

  it("the route-wide ceiling protects the engine even when callers differ", async () => {
    vi.stubEnv("VERCEL", "1");
    process.env.GF_RATE_LIMIT_COMPARE_ALL = "2/600";
    expect((await compare(REQ, { "x-vercel-forwarded-for": IP_A })).status).toBe(200);
    expect((await compare(REQ, { "x-vercel-forwarded-for": IP_B })).status).toBe(200);
    const third = await compare(REQ, { "x-vercel-forwarded-for": "203.0.113.9" });
    expect(third.status).toBe(429);
    expect((await third.json()).scope).toBe("all");
    expect(engineCalls).toBe(2);
  });

  it("one address flooding the route cannot drain the route-wide ceiling: refused requests take no shared seat", async () => {
    process.env.GF_RATE_LIMIT_COMPARE = "2/600";
    for (let n = 0; n < 12; n++) await compare();
    expect(engineCalls).toBe(2);
    const all = db.rows("rate_limit_windows").find((r) => r.bucket === "compare:all")!;
    expect(all.hits).toBe(2);                                     // 12 requests, 2 admitted: 2 shared seats used, not 12
    // so somebody else, with their own allowance, is still served
    vi.stubEnv("VERCEL", "1");
    expect((await compare(REQ, { "x-vercel-forwarded-for": IP_B })).status).toBe(200);
  });

  it("varying a forged X-Forwarded-For does not escape the limit (off Vercel it is not read at all)", async () => {
    process.env.GF_RATE_LIMIT_COMPARE = "2/600";
    for (const [n, ip] of ["198.51.100.1", "198.51.100.2", "198.51.100.3", "198.51.100.4"].entries()) {
      const r = await compare(REQ, { "x-forwarded-for": ip, "x-real-ip": ip });
      expect(r.status, `request ${n + 1}`).toBe(n < 2 ? 200 : 429);
    }
    expect(engineCalls).toBe(2);
  });

  it("on Vercel two real callers are counted separately, and a forged X-Forwarded-For cannot borrow another's allowance", async () => {
    vi.stubEnv("VERCEL", "1");
    process.env.GF_RATE_LIMIT_COMPARE = "1/600";
    expect((await compare(REQ, { "x-vercel-forwarded-for": IP_A })).status).toBe(200);
    expect((await compare(REQ, { "x-vercel-forwarded-for": IP_A, "x-forwarded-for": IP_B })).status).toBe(429);   // still A
    expect((await compare(REQ, { "x-vercel-forwarded-for": IP_B })).status).toBe(200);                           // B has its own
    expect(engineCalls).toBe(2);
  });

  it("an invalid request is refused before the guard: no counter is touched and no engine unit is spent", async () => {
    process.env.GF_RATE_LIMIT_COMPARE = "1/600";
    for (const bad of [{ hall: { ...HALL, contractedMW: undefined } }, { hall: HALL, objective: "cheapest" }, "{not json"]) {
      const r = await compare(bad as unknown);
      expect([400, 422]).toContain(r.status);
    }
    const huge = await compare({ hall: HALL, pad: "x".repeat(70_000) });
    expect(huge.status).toBe(413);
    expect(order).toEqual([]);                                          // not one limiter call, not one engine call
    expect((await compare()).status).toBe(200);                         // and the single allowed hit was still there
  });

  it("concurrent requests at the threshold: exactly the allowance reaches the engine, the rest are 429", async () => {
    process.env.GF_RATE_LIMIT_COMPARE = "5/600";
    const rs = await Promise.all(Array.from({ length: 30 }, () => compare()));
    const statuses = rs.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 200)).toHaveLength(5);
    expect(statuses.filter((s) => s === 429)).toHaveLength(25);
    expect(engineCalls).toBe(5);
  }, 60_000);

  it("a limiter outage is 503 and the engine is never called; so are a timeout and a malformed answer", async () => {
    quiet();
    db.rpcs.set("gf_rate_limit_hit", () => { throw new PgError("XX000", "simulated outage", 500); });
    const down = await compare();
    expect(down.status).toBe(503);
    expect(await down.json()).toMatchObject({ ok: false, code: "rate_limiter_unavailable" });
    db.rpcs.set("gf_rate_limit_hit", () => ({ nonsense: true }));
    expect((await compare()).status).toBe(503);
    const dbFetch = globalThis.fetch;
    globalThis.fetch = (async (i: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof i === "string" ? i : i instanceof URL ? i.href : i.url;
      if (url.endsWith("/rpc/gf_rate_limit_hit")) throw new DOMException("The operation timed out.", "TimeoutError");
      return dbFetch(i as RequestInfo, init);
    }) as typeof fetch;
    const slow = await compare();
    expect(slow.status).toBe(503);
    expect(await slow.json()).toMatchObject({ code: "rate_limiter_unavailable" });
    expect(engineCalls).toBe(0);
  });

  it("with no store configured the route is 503 and the engine is never called", async () => {
    quiet();
    delete process.env.SUPABASE_URL;
    const r = await compare();
    expect(r.status).toBe(503);
    expect(await r.json()).toMatchObject({ code: "rate_limiter_unconfigured" });
    expect(engineCalls).toBe(0);
  });

  it("in a production runtime the development bypass is ignored even when set", async () => {
    quiet();
    delete process.env.SUPABASE_URL;
    vi.stubEnv("GF_RATE_LIMIT_DEV_BYPASS", "1");
    vi.stubEnv("NODE_ENV", "production");
    expect((await compare()).status).toBe(503);
    expect(engineCalls).toBe(0);
    vi.stubEnv("NODE_ENV", "test");
    expect((await compare()).status).toBe(200);                         // the explicit development bypass, outside production
    expect(engineCalls).toBe(1);
  });

  it("neither a denial nor an outage logs or returns an address, a token, or the request's facility details", async () => {
    quiet();
    vi.stubEnv("VERCEL", "1");
    process.env.GF_RATE_LIMIT_COMPARE = "1/600";
    const h = { "x-vercel-forwarded-for": IP_A, authorization: "Bearer secret-credential-value" };
    const ok = await compare(REQ, h);
    const denied = await compare(REQ, h);
    db.rpcs.set("gf_rate_limit_hit", () => { throw new PgError("XX000", "simulated outage", 500); });
    const down = await compare(REQ, h);
    const surface = logged() + JSON.stringify(await denied.json()) + JSON.stringify(await down.json()) + JSON.stringify([...denied.headers, ...down.headers]);
    for (const secret of [IP_A, "203.0.113", "secret-credential-value", "Synthetic Hall", "sb_secret_test", "stub.supabase.co"]) {
      expect(surface, secret).not.toContain(secret);
    }
    expect(ok.status).toBe(200);
    // and the stored counter holds only pseudonymous buckets
    const stored = JSON.stringify(db.rows("rate_limit_windows"));
    expect(stored).not.toContain(IP_A);
    expect(db.rows("rate_limit_windows").map((r) => String(r.bucket)).sort()).toEqual(
      expect.arrayContaining(["compare:all", expect.stringMatching(/^compare:ip:[0-9a-f]{32}$/)]));
  });
});

describe.runIf(hasPython)("every public route that spends the site's engine key is behind the same guard", () => {
  const BTM = {
    load_profile: { csv: "timestamp,kW\n2026-01-01T00:00:00,30000\n2026-01-01T00:15:00,30000\n", source: "hall.csv" },
    grid_firm_MW: 10, target_MW: 35, ride_through_hours: 3, redundancy: "N+1",
    generation: [{ id: "GEN-A", kind: "gas_engine", nameplate_MW: 20, capex_eur: 16_000_000, lead_time_weeks: 44, fuel_type: "natural gas" }],
    bess: [{ id: "BESS-1", power_MW: 8, energy_MWh: 32, capex_eur: 7_200_000, lead_time_weeks: 30 }],
  };
  const mkCase = async (body: unknown = BTM) => (await import("@/app/api/power/deploy/cases/route")).POST(post("/api/power/deploy/cases", body));

  it("deploy cases: creating a case is limited per caller, and a denied one reaches no engine", async () => {
    process.env.GF_RATE_LIMIT_DEPLOY = "2/600";
    expect((await mkCase()).status).toBe(200);
    expect((await mkCase()).status).toBe(200);
    const before = engineCalls;
    const denied = await mkCase();
    expect(denied.status).toBe(429);
    expect(denied.headers.get("retry-after")).toBeTruthy();
    expect(engineCalls).toBe(before);
    expect(db.rows("power_deployment_cases")).toHaveLength(2);          // and nothing was stored for the refused one
  });

  it("deploy cases: an oversized body is 413 before the guard or the engine; malformed JSON is 400", async () => {
    expect((await mkCase({ pad: "x".repeat(2 * 1024 * 1024 + 10) })).status).toBe(413);
    expect((await mkCase("{nope")).status).toBe(400);
    expect(order).toEqual([]);
  });

  it("deploy cases: revising a case shares the deploy allowance, so one token cannot be used to loop the engine", async () => {
    const made = await (await mkCase()).json();
    const revise = async () => (await import("@/app/api/power/deploy/cases/[token]/route")).POST(post("/x", { target_MW: 36 }), ctx({ token: made.case_token }));
    process.env.GF_RATE_LIMIT_DEPLOY = "2/600";                         // one already spent on creation
    expect((await revise()).status).toBe(200);
    const before = engineCalls;
    const denied = await revise();
    expect(denied.status).toBe(429);
    expect(engineCalls).toBe(before);
  });

  it("project comparison routes: a project token is free to mint, so priced compare and save share the comparison allowance", async () => {
    const { POST: mkProject } = await import("@/app/api/projects/route");
    // gf_create_project is not in this suite's fake set: install the project functions it needs
    const { installProjectRpcs } = await import("./project-rpc-fake");
    installProjectRpcs(db);
    const made = await (await mkProject(post("/api/projects", { project_name: "Rate" }))).json();
    expect(made.project_token).toBeTruthy();
    process.env.GF_RATE_LIMIT_COMPARE = "1/600";
    expect((await compare()).status).toBe(200);                         // the public route spends the one allowance
    const before = engineCalls;
    const priced = await (await import("@/app/api/projects/[token]/compare/route")).POST(post("/x", { request: REQ }), ctx({ token: made.project_token }));
    expect(priced.status).toBe(429);
    const saved = await (await import("@/app/api/projects/[token]/comparisons/route")).POST(
      post("/x", { request: REQ, idempotency_key: "rate-limit-key-0001" }), ctx({ token: made.project_token }));
    expect(saved.status).toBe(429);
    expect(engineCalls).toBe(before);
    expect(db.rows("project_comparisons")).toHaveLength(0);
    // an unknown project token is a 404 and does not spend an allowance either
    process.env.GF_RATE_LIMIT_COMPARE = "100/600";
    expect((await (await import("@/app/api/projects/[token]/compare/route")).POST(post("/x", { request: REQ }), ctx({ token: "no-such" }))).status).toBe(404);
  });
});
