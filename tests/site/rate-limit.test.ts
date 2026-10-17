/**
 * The guard in front of every path that spends a shared provider credential (lib/rate-limit.ts, migration 0024).
 *
 * What matters most is what happens when the guard cannot decide: it must refuse (503) and no provider may be called. A
 * limiter that waves a request through when its counter is down is not a limiter, and the migration that creates the
 * counter is applied by a person, so "not applied yet" is the normal state of a fresh deploy.
 *
 * Atomicity of the counter itself is proven against PostgreSQL (tests/test_buyer_page_migration.py and
 * provider-spend.realdb.test.ts); this file uses an in-memory store and proves ordering, identity, accounting and failure
 * behaviour.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { siteUrl } from "@/lib/site";
import {
  CHAT_MAX_ANTHROPIC_CALLS,
  CHAT_MAX_ENGINE_CALLS,
  FREE_ENGINE_PATHS,
  PROVIDER_BUDGETS,
  RATE_POLICIES,
  accountSubject,
  anthropicFetch,
  callerIdentity,
  engineFetch,
  guardRequest,
  resetMemoryLimiter,
  subjectOf,
  trustedIpHeader,
} from "@/lib/rate-limit";
import { runTrusted } from "@/lib/spend-scope";
import { ENGINE_BODY_MAX_BYTES } from "@/lib/http-body";
import { MAX_TOOL_CALLS_PER_TURN } from "@/lib/ai/policy";
import { PostgrestFake } from "./postgrest-fake";

const ADDR = "203.0.113.77";
const req = (headers: Record<string, string> = { "x-forwarded-for": ADDR }) =>
  new Request(siteUrl("/api/x"), { method: "POST", headers });

const realFetch = globalThis.fetch;

beforeEach(() => {
  resetMemoryLimiter();
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.RATE_LIMIT_HMAC_KEY;
  delete process.env.GRIDFORGE_TRUSTED_IP_HEADER;
  delete process.env.VERCEL;
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  globalThis.fetch = realFetch;
});

function useStore(): { db: PostgrestFake; restore: () => void } {
  process.env.SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_test";
  const db = new PostgrestFake(["rate_limit_windows"]);
  currentDb = db;
  return { db, restore: db.install() };
}

/** Admit a request that the test expects to pass the request-level limit, narrowing the type to the runnable guard. */
async function admit(...args: Parameters<typeof guardRequest>) {
  const g = await guardRequest(...args);
  if (g.denied) throw new Error(`expected the request to be admitted, got ${g.denied.status}`);
  return g;
}

let currentDb: PostgrestFake | null = null;
/** Put a counter at `hits` for (bucket, subject) in the current in-memory store, as if already spent. */
function useStoreRow(bucket: string, subject: string, hits: number) {
  currentDb!.insertRow("rate_limit_windows", { bucket, subject, window_start: Math.floor(Date.now() / 1000 / 3600) * 3600, hits });
}

/** A provider stand-in that counts how often it was really called. */
function provider() {
  const calls: string[] = [];
  const inner = globalThis.fetch;
  globalThis.fetch = (async (i: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof i === "string" ? i : i instanceof URL ? i.href : i.url;
    if (url.startsWith("https://engine.test") || url.startsWith("https://api.anthropic.com")) {
      calls.push(url);
      return new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } });
    }
    return inner(i, init);
  }) as typeof fetch;
  return calls;
}

// ---------------------------------------------------------------------------------------------------------------------
describe("who is calling: the address comes only from a source the deployment controls", () => {
  it("in development and tests, reads x-real-ip, then the LAST x-forwarded-for entry", () => {
    const a = callerIdentity(req({ "x-real-ip": "1.1.1.1", "x-forwarded-for": "2.2.2.2" }));
    const b = callerIdentity(req({ "x-real-ip": "1.1.1.1" }));
    expect(a).toEqual(b);
    const c = callerIdentity(req({ "x-forwarded-for": "9.9.9.9, 3.3.3.3" }));
    const d = callerIdentity(req({ "x-forwarded-for": "3.3.3.3" }));
    expect(c).toEqual(d);
  });

  it("a production build with no declared source REFUSES to identify anyone, and guardRequest answers 503", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(callerIdentity(req({ "x-forwarded-for": ADDR, "x-real-ip": ADDR }))).toEqual({ ok: false, reason: "no_trusted_source" });
    const g = await guardRequest(req(), "qualify");
    expect(g.denied?.status).toBe(503);
    expect(JSON.stringify(await g.denied!.json())).not.toMatch(/trusted|header|identity/i); // nothing about the topology leaks
  });

  describe("on Vercel (VERCEL=1), x-forwarded-for is the platform-written header and nothing else is read", () => {
    beforeEach(() => {
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("VERCEL", "1");
      process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_test";
    });
    const as = (h: Record<string, string>) => {
      const r = callerIdentity(req(h));
      return r.ok ? r.subject : r.reason;
    };

    it("is x-forwarded-for", () => expect(trustedIpHeader()).toBe("x-forwarded-for"));

    it("a caller cannot become someone else, or a fresh identity, through any other header", () => {
      const real = as({ "x-forwarded-for": "198.51.100.1" });
      expect(as({ "x-forwarded-for": "198.51.100.1", "x-real-ip": "5.6.7.8", "x-vercel-forwarded-for": "9.9.9.9", forwarded: "for=1.2.3.4" })).toBe(real);
      expect(as({ "x-forwarded-for": "198.51.100.2", "x-real-ip": "198.51.100.1" })).not.toBe(real);
    });

    it("takes the last entry, so an address a client prepended is never read", () => {
      const real = as({ "x-forwarded-for": "198.51.100.1" });
      expect(as({ "x-forwarded-for": "6.6.6.6, 198.51.100.1" })).toBe(real);
      expect(as({ "x-forwarded-for": "6.6.6.6, 7.7.7.7, 198.51.100.1" })).toBe(real);
      expect(as({ "x-forwarded-for": "198.51.100.1, 6.6.6.6" })).not.toBe(real); // the proxy's own entry is the last one
    });

    it("a request that did not pass through the proxy (no header, or not an address) shares ONE 'unattributed' identity: it can never evade by omission", () => {
      const none = as({ "x-real-ip": "1.2.3.4" });
      expect(as({ "x-forwarded-for": "not-an-ip" })).toBe(none);
      expect(as({ "x-forwarded-for": "<script>" })).toBe(none);
      expect(as({ "x-forwarded-for": "1".repeat(200) })).toBe(none);
      expect(none).toBe(subjectOf("unattributed"));
      expect(none).not.toBe(as({ "x-forwarded-for": "198.51.100.1" }));
    });

    it("accepts IPv6", () => {
      const v6 = as({ "x-forwarded-for": "2001:db8::1" });
      expect(v6).toMatch(/^[0-9a-f]{64}$/);
      expect(v6).not.toBe(subjectOf("unattributed"));
    });
  });

  it("an operator can name the header their own proxy writes; a malformed declaration trusts nothing", () => {
    vi.stubEnv("NODE_ENV", "production");
    process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_test";
    process.env.GRIDFORGE_TRUSTED_IP_HEADER = "Fly-Client-IP";
    expect(trustedIpHeader()).toBe("fly-client-ip");
    const real = callerIdentity(req({ "fly-client-ip": "198.51.100.9" }));
    expect(callerIdentity(req({ "fly-client-ip": "198.51.100.9", "x-forwarded-for": "1.1.1.1" }))).toEqual(real);
    process.env.GRIDFORGE_TRUSTED_IP_HEADER = "x-forwarded-for; drop table";
    expect(trustedIpHeader()).toBeNull();
    expect(callerIdentity(req({ "x-forwarded-for": ADDR }))).toEqual({ ok: false, reason: "no_trusted_source" });
  });

  describe("the pseudonymising secret", () => {
    beforeEach(() => {
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("VERCEL", "1");
    });
    const headers = { "x-forwarded-for": ADDR };

    it("production with no secret at all refuses, rather than using a per-process random one", () => {
      expect(callerIdentity(req(headers))).toEqual({ ok: false, reason: "no_secret" });
      expect(subjectOf("x")).toBeNull();
      expect(accountSubject("a@b.example")).toBeNull();
    });

    it("a dedicated key takes precedence over the database key, and a short one is ignored", () => {
      process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_test";
      const viaDb = callerIdentity(req(headers));
      process.env.RATE_LIMIT_HMAC_KEY = "x".repeat(40);
      const viaDedicated = callerIdentity(req(headers));
      expect(viaDedicated).not.toEqual(viaDb);
      process.env.RATE_LIMIT_HMAC_KEY = "short";
      expect(callerIdentity(req(headers))).toEqual(viaDb);
    });

    it("rotating the key re-pseudonymises everyone: the same address is a different subject (documented consequence)", () => {
      process.env.RATE_LIMIT_HMAC_KEY = "k".repeat(40);
      const before = callerIdentity(req(headers));
      process.env.RATE_LIMIT_HMAC_KEY = "j".repeat(40);
      expect(callerIdentity(req(headers))).not.toEqual(before);
    });

    it("a pseudonym is not a bare hash anyone could precompute from an address", () => {
      process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_test";
      const who = callerIdentity(req(headers));
      expect(who.ok && who.subject).not.toBe(crypto.createHash("sha256").update(ADDR).digest("hex"));
    });

    it("an account pseudonym is separate from an address pseudonym, case-insensitive on the email", () => {
      process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_test";
      expect(accountSubject("Ada@Example.com")).toBe(accountSubject(" ada@example.com "));
      expect(accountSubject("ada@example.com")).not.toBe(subjectOf("ada@example.com"));
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("request level: guardRequest", () => {
  it("admits up to the limit, then answers 429 with a Retry-After inside the window", async () => {
    const limit = RATE_POLICIES.ttp_compare_save.limit;
    for (let i = 0; i < limit; i++) expect((await guardRequest(req(), "ttp_compare_save")).denied).toBeNull();
    const over = (await guardRequest(req(), "ttp_compare_save")).denied!;
    expect(over.status).toBe(429);
    const retry = Number(over.headers.get("retry-after"));
    expect(retry).toBeGreaterThanOrEqual(1);
    expect(retry).toBeLessThanOrEqual(RATE_POLICIES.ttp_compare_save.windowSeconds);
    expect(await over.json()).toMatchObject({ ok: false, retry_after_seconds: retry });
    expect(over.headers.get("cache-control")).toBe("no-store");
  });

  it("counts each caller and each route separately", async () => {
    for (let i = 0; i < RATE_POLICIES.ttp_compare_save.limit; i++) await guardRequest(req(), "ttp_compare_save");
    expect((await guardRequest(req(), "ttp_compare_save")).denied?.status).toBe(429);
    expect((await guardRequest(req({ "x-forwarded-for": "198.51.100.9" }), "ttp_compare_save")).denied).toBeNull();
    expect((await guardRequest(req(), "qualify")).denied).toBeNull();
  });

  it("limits a VERIFIED account as well as the address, so one subscriber cannot multiply their allowance across addresses", async () => {
    const opts = { cls: "customer" as const, account: { verifiedEmail: "Ada@Example.com", policy: "siting_account" as const } };
    for (let i = 0; i < RATE_POLICIES.siting_account.limit; i++) {
      expect((await guardRequest(req({ "x-forwarded-for": `198.51.100.${i + 1}` }), "siting", opts)).denied).toBeNull();
    }
    const over = (await guardRequest(req({ "x-forwarded-for": "198.51.100.200" }), "siting", opts)).denied!;
    expect(over.status).toBe(429); // a fresh address, the same verified account
    // A different account from the same fresh address is unaffected.
    expect((await guardRequest(req({ "x-forwarded-for": "198.51.100.200" }), "siting", { ...opts, account: { ...opts.account, verifiedEmail: "bob@example.com" } })).denied).toBeNull();
  });

  it("never stores, sends or logs the address, the email or any header", async () => {
    const { db, restore } = useStore();
    const logs: string[] = [];
    for (const m of ["log", "info", "warn", "error"] as const) vi.spyOn(console, m).mockImplementation((...a) => void logs.push(a.map(String).join(" ")));
    await guardRequest(req({ "x-forwarded-for": ADDR, "user-agent": "Mozilla secret-agent", authorization: "Bearer sekret" }), "siting", {
      cls: "customer", account: { verifiedEmail: "ada@example.com", policy: "siting_account" },
    });
    const wire = JSON.stringify(db.calls);
    for (const secret of [ADDR, "ada@example.com", "secret-agent", "sekret", "sb_secret_test"]) {
      expect(wire).not.toContain(secret);
      expect(JSON.stringify(db.tables.get("rate_limit_windows"))).not.toContain(secret);
      expect(logs.join("\n")).not.toContain(secret);
    }
    for (const r of db.rows("rate_limit_windows")) expect(r.subject).toMatch(/^[0-9a-f]{64}$/);
    restore();
  });

  it("is atomic through the store: concurrent admissions are each counted once", async () => {
    const { restore } = useStore();
    const results = await Promise.all(Array.from({ length: 40 }, () => guardRequest(req(), "ttp_compare")));
    expect(results.filter((g) => g.denied === null)).toHaveLength(RATE_POLICIES.ttp_compare.limit);
    expect(results.filter((g) => g.denied?.status === 429)).toHaveLength(40 - RATE_POLICIES.ttp_compare.limit);
    restore();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("fails closed: whenever the guard cannot decide, nothing runs", () => {
  beforeEach(() => vi.spyOn(console, "error").mockImplementation(() => {}));

  it("production with no store configured refuses instead of counting in a process that restarts", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL", "1");
    process.env.RATE_LIMIT_HMAC_KEY = "k".repeat(40);
    expect((await guardRequest(req({ "x-forwarded-for": ADDR }), "qualify")).denied?.status).toBe(503);
  });

  it("the in-memory counter is development-only: it cannot answer in production even when a store is also absent", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL", "1");
    process.env.RATE_LIMIT_HMAC_KEY = "k".repeat(40);
    for (let i = 0; i < 3; i++) expect((await guardRequest(req({ "x-forwarded-for": ADDR }), "qualify")).denied?.status).toBe(503);
    // ...and the source says so: the fallback is behind the production check and nowhere else.
    const src = fs.readFileSync("lib/rate-limit.ts", "utf8");
    expect(src).toMatch(/if \(!creds\(\)\) \{\s*if \(isProduction\(\)\) \{[\s\S]*?return null;\s*\}\s*return memoryHit/);
  });

  it("migration 0024 not applied (the function does not exist): 503", async () => {
    const { db, restore } = useStore();
    db.rpcs.delete("gf_rate_limit_hit");
    const g = await guardRequest(req(), "qualify");
    expect(g.denied?.status).toBe(503);
    expect(g.denied!.headers.get("retry-after")).toBeTruthy();
    expect(JSON.stringify(await g.denied!.json())).toMatch(/temporarily unavailable/);
    restore();
  });

  it("store down: 503", async () => {
    const { db, restore } = useStore();
    db.failMethod = { method: "POST", status: 500, body: "{}" };
    expect((await guardRequest(req(), "qualify")).denied?.status).toBe(503);
    restore();
  });

  it("store unreachable: 503", async () => {
    useStore();
    globalThis.fetch = (async () => { throw new TypeError("fetch failed"); }) as typeof fetch;
    expect((await guardRequest(req(), "qualify")).denied?.status).toBe(503);
  });

  it.each([["null", null], ["no verdict", { hits: 3 }], ["a string verdict", { allowed: "yes" }], ["an array", [true]]])(
    "an answer it does not understand (%s): 503", async (_n, answer) => {
      const { db, restore } = useStore();
      db.rpcs.set("gf_rate_limit_hit", () => answer);
      expect((await guardRequest(req(), "qualify")).denied?.status).toBe(503);
      restore();
    });

  it("the 503 body says nothing about why", async () => {
    const { db, restore } = useStore();
    db.rpcs.delete("gf_rate_limit_hit");
    const body = JSON.stringify(await (await guardRequest(req(), "qualify")).denied!.json());
    expect(body).not.toMatch(/0024|migration|supabase|rpc|rate_limit|secret/i);
    restore();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("provider level: every actual provider call is counted, wherever it is made from", () => {
  it("a provider call with NO scope is refused in production and never reaches the provider", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const calls = provider();
    const r = await engineFetch("https://engine.test/v1/compare", { method: "POST" });
    expect(r.status).toBe(503);
    expect(calls).toHaveLength(0);
    expect((await anthropicFetch("https://api.anthropic.com/v1/messages")).status).toBe(503);
    expect(calls).toHaveLength(0);
  });

  it("outside production an unscoped call passes (so unit tests of helpers need no scope), and only there", async () => {
    const calls = provider();
    expect((await engineFetch("https://engine.test/v1/compare")).status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it("a scoped call is charged to the caller's budget and the shared aggregate, in separate buckets per provider and tier", async () => {
    const { db, restore } = useStore();
    const calls = provider();
    const g = await admit(req(), "qualify");
    await g.run(async () => {
      await engineFetch("https://engine.test/v1/compare", { method: "POST" });      // metered unit spend
      await engineFetch("https://engine.test/v1/qualify", { method: "POST" });      // the free tier is a different resource
      await anthropicFetch("https://api.anthropic.com/v1/messages", { method: "POST" });
      await anthropicFetch("https://api.anthropic.com/v1/messages", { method: "POST" });
    });
    expect(calls).toHaveLength(4);
    const hits = Object.fromEntries(db.rows("rate_limit_windows").map((r) => [r.bucket, r.hits]));
    expect(hits).toMatchObject({
      qualify: 1,
      engine_public_caller: 1, engine_public: 1,
      engine_public_free_caller: 1, engine_public_free: 1,
      anthropic_public_caller: 2, anthropic_public: 2,
    });
    restore();
  });

  it("a customer-class scope spends from the customer budgets, not the public ones", async () => {
    const { db, restore } = useStore();
    provider();
    const g = await admit(req(), "customer_generate", { cls: "customer" });
    await g.run(async () => { await engineFetch("https://engine.test/v1/study", { method: "POST" }); });
    const buckets = db.rows("rate_limit_windows").map((r) => r.bucket);
    expect(buckets).toEqual(expect.arrayContaining(["engine_customer_caller", "engine_customer"]));
    expect(buckets).not.toContain("engine_public");
    restore();
  });

  it("a caller who has used up their budget is refused the provider call, which is never made; the whole request answers 429 even if a helper swallowed it", async () => {
    const { db, restore } = useStore();
    const calls = provider();
    const g = await admit(req(), "qualify");
    const who = callerIdentity(req());
    const bucket = PROVIDER_BUDGETS["engine:public:metered"].caller;
    db.insertRow("rate_limit_windows", { bucket: bucket.bucket, subject: who.ok ? who.subject : "", window_start: Math.floor(Date.now() / 1000 / bucket.windowSeconds) * bucket.windowSeconds, hits: bucket.limit });
    const out = await g.run(async () => {
      const r = await engineFetch("https://engine.test/v1/compare", { method: "POST" });
      expect(r.status).toBe(429);
      expect(Number(r.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
      expect(r.headers.get("x-should-retry")).toBe("false");
      return "the helper swallowed the refusal and reported success";
    });
    expect(calls).toHaveLength(0);
    expect((out as Response).status).toBe(429);
    // A caller refused on their own budget did not use up anything of the shared ceiling.
    expect(db.rows("rate_limit_windows").filter((r) => r.bucket === PROVIDER_BUDGETS["engine:public:metered"].aggregate.bucket)).toHaveLength(0);
    restore();
  });

  it("the shared aggregate stops many callers who are each inside their own allowance", async () => {
    const { db, restore } = useStore();
    const calls = provider();
    const agg = PROVIDER_BUDGETS["engine:public:metered"].aggregate;
    db.insertRow("rate_limit_windows", { bucket: agg.bucket, subject: subjectOf("aggregate"), window_start: Math.floor(Date.now() / 1000 / agg.windowSeconds) * agg.windowSeconds, hits: agg.limit });
    const g = await admit(req({ "x-forwarded-for": "198.51.100.50" }), "ttp_compare");
    const out = await g.run(async () => (await engineFetch("https://engine.test/v1/compare", { method: "POST" })).status);
    expect((out as Response).status).toBe(429);
    expect(calls).toHaveLength(0);
    restore();
  });

  it("after the first refusal in a request, no further provider calls are made or counted", async () => {
    const { db, restore } = useStore();
    const calls = provider();
    db.insertRow("rate_limit_windows", { bucket: PROVIDER_BUDGETS["anthropic:public"].caller.bucket, subject: (callerIdentity(req()) as { subject: string }).subject, window_start: Math.floor(Date.now() / 1000 / 3600) * 3600, hits: PROVIDER_BUDGETS["anthropic:public"].caller.limit });
    const g = await admit(req(), "chat");
    await g.run(async () => {
      for (let i = 0; i < 5; i++) await anthropicFetch("https://api.anthropic.com/v1/messages", { method: "POST" });
    });
    const rpcCalls = db.calls.filter((c) => c.url.includes("gf_rate_limit_hit")).length;
    expect(calls).toHaveLength(0);
    // 1 admission hit + exactly 1 provider-gate hit (the refused one); the other four calls cost nothing.
    expect(rpcCalls).toBe(2);
    restore();
  });

  it("trusted work is not metered per caller and touches no counter", async () => {
    const { db, restore } = useStore();
    const calls = provider();
    await runTrusted("cron-secret", async () => {
      for (let i = 0; i < 5; i++) await engineFetch("https://engine.test/v1/diff", { method: "POST" });
    });
    expect(calls).toHaveLength(5);
    expect(db.calls.filter((c) => c.url.includes("rate_limit"))).toHaveLength(0);
    restore();
  });

  it("a handler that fails AFTER a refusal (as an SDK does on a refused call) still answers the refusal, not its own failure", async () => {
    const { restore } = useStore();
    provider();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const g = await admit(req(), "chat");
    const who = callerIdentity(req());
    const b = PROVIDER_BUDGETS["anthropic:public"].caller;
    useStoreRow(b.bucket, who.ok ? who.subject : "", b.limit);
    const out = await g.run(async () => {
      const r = await anthropicFetch("https://api.anthropic.com/v1/messages", { method: "POST" });
      throw new Error(`the SDK turned HTTP ${r.status} into an exception`);
    });
    expect((out as Response).status).toBe(429);
    restore();
  });

  it("a handler that throws something else still throws; only a refusal is turned into a response", async () => {
    provider();
    const g = await admit(req(), "qualify");
    await expect(g.run(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
  });

  it("the gate cannot be bypassed by fan-out inside one request: N concurrent calls spend exactly the budget", async () => {
    const { db, restore } = useStore();
    const calls = provider();
    const budget = PROVIDER_BUDGETS["engine:public:metered"].caller;
    const g = await admit(req(), "qualify");
    const statuses = await g.run(async () =>
      Promise.all(Array.from({ length: budget.limit + 60 }, () => engineFetch("https://engine.test/v1/compare", { method: "POST" }).then((r) => r.status))));
    // The whole request answers its refusal, but the provider saw exactly the budget and not one call more.
    expect(statuses).toBeInstanceOf(Response);
    expect(calls).toHaveLength(budget.limit);
    expect(db.rows("rate_limit_windows").find((r) => r.bucket === budget.bucket)!.hits).toBe(budget.limit + 60);
    restore();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("the policy table is internally consistent and its documented bounds are real", () => {
  const all = [...Object.values(RATE_POLICIES), ...Object.values(PROVIDER_BUDGETS).flatMap((b) => [b.caller, b.aggregate])];

  it("bucket names are unique, valid for the table's check constraint, and windows are within the function's limits", () => {
    const names = all.map((p) => p.bucket);
    expect(new Set(names).size).toBe(names.length);
    for (const p of all) {
      expect(p.bucket).toMatch(/^[a-z0-9_:.-]{1,64}$/);
      expect(p.limit).toBeGreaterThanOrEqual(1);
      expect(p.limit).toBeLessThanOrEqual(100000);
      expect(p.windowSeconds).toBeGreaterThanOrEqual(1);
      expect(p.windowSeconds).toBeLessThanOrEqual(86400);
    }
  });

  it("the existing comparison policies are unchanged", () => {
    expect(RATE_POLICIES.ttp_compare).toEqual({ bucket: "ttp_compare", limit: 20, windowSeconds: 600 });
    expect(RATE_POLICIES.ttp_compare_save).toEqual({ bucket: "ttp_compare_save", limit: 6, windowSeconds: 3600 });
    expect(PROVIDER_BUDGETS["engine:public:metered"].aggregate).toEqual({ bucket: "engine_public", limit: 600, windowSeconds: 3600 });
  });

  it("a caller's budget never exceeds the shared aggregate it draws from", () => {
    for (const b of Object.values(PROVIDER_BUDGETS)) expect(b.caller.limit).toBeLessThanOrEqual(b.aggregate.limit);
  });

  it("chat fan-out is bounded and the bound is derived from the code that fans out", () => {
    // lib/ai/agent.ts runs at most MAX_TOOL_CALLS_PER_TURN + 1 model rounds and MAX_TOOL_CALLS_PER_TURN tool calls; lib/extract.ts adds one.
    expect(CHAT_MAX_ANTHROPIC_CALLS).toBe(MAX_TOOL_CALLS_PER_TURN + 1 + 1);
    expect(CHAT_MAX_ENGINE_CALLS).toBe(MAX_TOOL_CALLS_PER_TURN);
    // 40 admitted requests an hour, each at most 6 Anthropic calls: the per-caller Anthropic budget is exactly that product.
    expect(PROVIDER_BUDGETS["anthropic:public"].caller.limit).toBe(RATE_POLICIES.chat.limit * CHAT_MAX_ANTHROPIC_CALLS);
    // and the engine side (free-tier qualify only for an anonymous caller) fits inside the free-tier caller budget.
    expect(RATE_POLICIES.chat.limit * CHAT_MAX_ENGINE_CALLS).toBeLessThanOrEqual(PROVIDER_BUDGETS["engine:public:free"].caller.limit);
  });

  it("matches the engine: its public (unmetered) POST route is exactly what the site calls 'free', and its body ceiling is the site's", () => {
    const server = fs.readFileSync("gridforge/api/server.py", "utf8");
    const publicPaths = [...server.matchAll(/"(\/v1\/[a-z/_]+)":\s*\(handle_\w+,\s*Tier\.PUBLIC\)/g)].map((m) => m[1]).sort();
    expect([...FREE_ENGINE_PATHS].sort()).toEqual(publicPaths);
    const max = /MAX_BODY_BYTES\s*=\s*(\d+)\s*\*\s*(\d+)/.exec(server)!;
    expect(Number(max[1]) * Number(max[2])).toBe(ENGINE_BODY_MAX_BYTES);
  });
});
