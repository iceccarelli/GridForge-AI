/**
 * The guard in front of every public route that spends the platform engine key (lib/rate-limit.ts, migration 0024).
 *
 * What matters is what happens when the guard cannot be evaluated: it must refuse (503) and the engine must not be
 * called. A limiter that waves a request through when its counter is down is not a limiter, and the migration that
 * creates the counter is applied by a person, so "not applied yet" is the normal state of a fresh deploy.
 */
import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { siteUrl } from "@/lib/site";
import { ENGINE_SPEND_CEILING, RATE_POLICIES, callerAddress, enforceRateLimit, resetMemoryLimiter, subjectOf } from "@/lib/rate-limit";
import { PostgrestFake } from "./postgrest-fake";
import { installProjectRpcs } from "./project-rpc-fake";

const ADDR = "203.0.113.77";
const req = (ip: string | null = ADDR, headers: Record<string, string> = {}) =>
  new Request(siteUrl("/api/power/compare"), { method: "POST", headers: { ...(ip ? { "x-forwarded-for": ip } : {}), ...headers } });

beforeEach(() => {
  resetMemoryLimiter();
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("with no store configured outside production (development and tests)", () => {
  it("lets a caller through up to its limit, then answers 429 with a Retry-After", async () => {
    const limit = RATE_POLICIES.ttp_compare_save.limit;
    for (let i = 0; i < limit; i++) expect(await enforceRateLimit(req(), "ttp_compare_save")).toBeNull();
    const over = await enforceRateLimit(req(), "ttp_compare_save");
    expect(over?.status).toBe(429);
    const retry = Number(over!.headers.get("retry-after"));
    expect(retry).toBeGreaterThanOrEqual(1);
    expect(retry).toBeLessThanOrEqual(RATE_POLICIES.ttp_compare_save.windowSeconds);
    const body = await over!.json();
    expect(body).toMatchObject({ ok: false, retry_after_seconds: retry });
    expect(body.error).toMatch(/Too many requests/);
    expect(over!.headers.get("cache-control")).toBe("no-store");
  });

  it("counts each caller separately", async () => {
    for (let i = 0; i < RATE_POLICIES.ttp_compare_save.limit; i++) await enforceRateLimit(req(ADDR), "ttp_compare_save");
    expect((await enforceRateLimit(req(ADDR), "ttp_compare_save"))?.status).toBe(429);
    expect(await enforceRateLimit(req("198.51.100.9"), "ttp_compare_save")).toBeNull();
  });

  it("counts each route separately, but every route against one shared ceiling on the key", async () => {
    for (let i = 0; i < RATE_POLICIES.ttp_compare_save.limit; i++) await enforceRateLimit(req(ADDR), "ttp_compare_save");
    expect(await enforceRateLimit(req(ADDR), "ttp_compare")).toBeNull();

    resetMemoryLimiter();
    // Many different callers, each well inside its own allowance, still cannot drain the key.
    let refused = 0;
    for (let i = 0; i < ENGINE_SPEND_CEILING.limit + 5; i++) {
      const r = await enforceRateLimit(req(`10.0.${Math.floor(i / 250)}.${i % 250}`), "ttp_compare");
      if (r) {
        expect(r.status).toBe(429);
        refused += 1;
      }
    }
    expect(refused).toBe(5);
  });

  it("a caller refused on its own allowance does not use up the shared ceiling", async () => {
    for (let i = 0; i < RATE_POLICIES.ttp_compare_save.limit; i++) await enforceRateLimit(req(ADDR), "ttp_compare_save");
    const before = ENGINE_SPEND_CEILING.limit;
    for (let i = 0; i < 50; i++) await enforceRateLimit(req(ADDR), "ttp_compare_save"); // all refused
    // 6 admitted so far; if the 50 refusals had counted, this many fresh callers would not all fit under the ceiling.
    let admitted = 0;
    for (let i = 0; i < before - RATE_POLICIES.ttp_compare_save.limit; i++) {
      if ((await enforceRateLimit(req(`172.16.${Math.floor(i / 250)}.${i % 250}`), "ttp_compare")) === null) admitted += 1;
    }
    expect(admitted).toBe(before - RATE_POLICIES.ttp_compare_save.limit);
  });

  it("refuses a production build that has no store, rather than counting in a process that restarts", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await enforceRateLimit(req(), "ttp_compare");
    expect(r?.status).toBe(503);
  });
});

describe("with the store configured", () => {
  let db: PostgrestFake;
  let restore: () => void;
  beforeEach(() => {
    process.env.SUPABASE_URL = "https://stub.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_test";
    db = new PostgrestFake(["rate_limit_windows", "projects", "project_events"]);
    installProjectRpcs(db);
    restore = db.install();
  });
  afterEach(() => restore());

  it("counts in the store through the one atomic function, and refuses over the limit", async () => {
    for (let i = 0; i < RATE_POLICIES.ttp_compare.limit; i++) expect(await enforceRateLimit(req(), "ttp_compare")).toBeNull();
    expect((await enforceRateLimit(req(), "ttp_compare"))?.status).toBe(429);
    const rpcs = db.calls.filter((c) => c.url.includes("/rpc/"));
    expect(rpcs.every((c) => c.url.endsWith("/rpc/gf_rate_limit_hit"))).toBe(true);
    expect(db.rows("rate_limit_windows").map((r) => r.bucket).sort()).toEqual(["engine_public", "ttp_compare"]);
  });

  it("stores and sends an HMAC of the caller, never the address, and logs nothing about the caller", async () => {
    const logs: string[] = [];
    for (const m of ["log", "info", "warn", "error"] as const) vi.spyOn(console, m).mockImplementation((...a) => void logs.push(a.map(String).join(" ")));
    await enforceRateLimit(req(ADDR, { "user-agent": "Mozilla/5.0 secret-agent" }), "ttp_compare");
    await enforceRateLimit(req(null, { "x-real-ip": ADDR }), "ttp_compare");
    const sent = JSON.stringify(db.calls);
    expect(sent).not.toContain(ADDR);
    expect(sent).not.toContain("secret-agent");
    expect(JSON.stringify(db.tables.get("rate_limit_windows"))).not.toContain(ADDR);
    for (const r of db.rows("rate_limit_windows")) expect(r.subject).toMatch(/^[0-9a-f]{64}$/);
    expect(logs.join("\n")).not.toContain(ADDR);
    // x-real-ip and x-forwarded-for name the same caller -> the same counter.
    expect(db.rows("rate_limit_windows").filter((r) => r.bucket === "ttp_compare")).toHaveLength(1);
    expect(db.rows("rate_limit_windows").find((r) => r.bucket === "ttp_compare")!.hits).toBe(2);
  });

  it("derives the subject under a secret, so the same address is not the same subject on another deployment", () => {
    const a = subjectOf(ADDR);
    process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_other";
    expect(subjectOf(ADDR)).not.toBe(a);
    expect(a).not.toBe(crypto.createHash("sha256").update(ADDR).digest("hex")); // not a bare hash anyone can precompute
  });

  it("fails closed when the migration is not applied (the function does not exist)", async () => {
    db.rpcs.delete("gf_rate_limit_hit");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await enforceRateLimit(req(), "ttp_compare");
    expect(r?.status).toBe(503);
    expect(r!.headers.get("retry-after")).toBeTruthy();
    expect((await r!.json()).error).toMatch(/temporarily unavailable/);
  });

  it("fails closed when the store is down", async () => {
    db.failMethod = { method: "POST", status: 500, body: "{}" };
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await enforceRateLimit(req(), "ttp_compare"))?.status).toBe(503);
  });

  it("fails closed when the store is unreachable", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    globalThis.fetch = (async () => { throw new TypeError("fetch failed"); }) as typeof fetch;
    expect((await enforceRateLimit(req(), "ttp_compare"))?.status).toBe(503);
  });

  it.each([["null", null], ["no verdict", { hits: 3 }], ["a string verdict", { allowed: "yes" }]])(
    "fails closed on an answer it does not understand (%s)", async (_n, answer) => {
      db.rpcs.set("gf_rate_limit_hit", () => answer);
      vi.spyOn(console, "error").mockImplementation(() => {});
      expect((await enforceRateLimit(req(), "ttp_compare"))?.status).toBe(503);
    });

  it("treats a refusal by the shared ceiling as 429 too", async () => {
    db.rpcs.set("gf_rate_limit_hit", ({ p_bucket }) => ({ allowed: p_bucket !== ENGINE_SPEND_CEILING.bucket, retry_after_seconds: 42 }));
    const r = await enforceRateLimit(req(), "ttp_compare");
    expect(r?.status).toBe(429);
    expect(r!.headers.get("retry-after")).toBe("42");
  });

  it("is atomic: concurrent hits are each counted once, so no two requests are both 'the last one allowed'", async () => {
    const results = await Promise.all(Array.from({ length: 30 }, () => enforceRateLimit(req(), "ttp_compare")));
    expect(results.filter((r) => r === null)).toHaveLength(RATE_POLICIES.ttp_compare.limit);
    expect(results.filter((r) => r?.status === 429)).toHaveLength(30 - RATE_POLICIES.ttp_compare.limit);
  });
});

describe("caller identification", () => {
  it("prefers x-real-ip, then the first x-forwarded-for hop, and bounds what it reads", () => {
    expect(callerAddress(req(null, { "x-real-ip": "1.1.1.1", "x-forwarded-for": "2.2.2.2" }))).toBe("1.1.1.1");
    expect(callerAddress(req("2.2.2.2, 3.3.3.3"))).toBe("2.2.2.2");
    expect(callerAddress(req(null))).toBe("unknown");
    expect(callerAddress(req("9".repeat(500))).length).toBeLessThanOrEqual(64);
  });
});
