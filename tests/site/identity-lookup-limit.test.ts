/**
 * Review finding 2: an UNAUTHENTICATED request carrying any `Authorization: Bearer ...` made this site call Supabase Auth
 * (/auth/v1/user) before any limiter ran (lib/portal.ts `identify`, reached first by /api/engagements, /api/subscription-status,
 * /api/scenarios, /api/team and, through `registryCaller`, the site and hall registry). A stranger could therefore turn this site into
 * a hose pointed at Supabase Auth, and a loop of junk tokens would also trip the project's own Auth rate limits for real users.
 *
 *   (a) every lookup is counted per caller BEFORE the outbound call, in a new budget (`auth_lookup`), refused with the standard 429;
 *   (b) a token Supabase rejected is remembered for a short window, keyed on a SHA-256 of the token (the token is never stored), so a
 *       repeated junk token costs one outbound call per window per instance.
 *
 * LIMITS, stated honestly: the negative cache is in memory, so it is per server instance (N instances = up to N calls per window for
 * one token); the counter is the shared Postgres one in production. A VALID token is never cached (its behaviour is unchanged): each
 * valid request is still one lookup, counted.
 */
import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { siteUrl } from "@/lib/site";
import { RATE_POLICIES, resetMemoryLimiter } from "@/lib/rate-limit";
import { IDENTITY_REJECTION_TTL_MS, identify, rejectedTokenKeys, resetIdentityCache } from "@/lib/portal";
import { PostgrestFake } from "./postgrest-fake";
import { bearerFor, installWithAuth, jwtFor, junkJwt } from "./auth-fake";

const ADDR = "203.0.113.50";
const get = (headers: Record<string, string>, path = "/api/engagements") =>
  new Request(siteUrl(path), { headers: { "x-forwarded-for": ADDR, ...headers } });
/** JWT-shaped junk with a FUTURE exp: it cannot be told from a real token without asking Supabase, so it is the junk that still costs a lookup. */
const junk = (i: number | string) => ({ authorization: `Bearer ${junkJwt(i)}` });

let db: PostgrestFake;
let restore: () => void;
let authCalls: () => number;

beforeEach(() => {
  resetMemoryLimiter();
  resetIdentityCache();
  delete process.env.RATE_LIMIT_HMAC_KEY;
  delete process.env.GRIDFORGE_TRUSTED_IP_HEADER;
  delete process.env.VERCEL;
  process.env.SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_test";
  db = new PostgrestFake(["deliverables", "watches", "subscriptions", "subscription_seats", "scenarios"]);
  ({ restore, authCalls } = installWithAuth(db));
});
afterEach(() => {
  restore();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("(a) a per-caller counter stands in front of the outbound lookup", () => {
  it("distinct junk tokens from one address: exactly the budget reaches Supabase, then 429 with Retry-After and NO further outbound call", async () => {
    const limit = RATE_POLICIES.auth_lookup.limit;
    for (let i = 0; i < limit; i++) {
      const r = await identify(get(junk(i)));
      expect(r, `lookup ${i + 1}`).toMatchObject({ ok: false, status: 401 });
    }
    expect(authCalls()).toBe(limit);
    const over = await identify(get(junk("over")));
    expect(over).toMatchObject({ ok: false, status: 429 });
    expect(over.ok === false && over.retryAfter).toBeGreaterThanOrEqual(1);
    expect(authCalls()).toBe(limit); // the 301st did not call Supabase
  });

  it("the route answers the standard 429 shape: status, Retry-After, no-store and { ok:false, error, retry_after_seconds }", async () => {
    const { GET } = await import("@/app/api/engagements/route");
    for (let i = 0; i < RATE_POLICIES.auth_lookup.limit; i++) await GET(get(junk(i)));
    const res = await GET(get(junk("one-more")));
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, retry_after_seconds: expect.any(Number) });
    expect(body.error).toMatch(/^Too many requests\. Try again in \d+ seconds?\.$/);
  });

  it.each([
    ["/api/subscription-status", () => import("@/app/api/subscription-status/route").then((m) => (r: Request) => m.POST(new Request(r.url, { method: "POST", headers: r.headers })))],
    ["/api/scenarios", () => import("@/app/api/scenarios/route").then((m) => (r: Request) => m.GET(r))],
    ["/api/team", () => import("@/app/api/team/route").then((m) => (r: Request) => m.GET(r))],
    ["/api/sites (registryCaller)", () => import("@/app/api/sites/route").then((m) => (r: Request) => m.GET(r))],
  ])("%s refuses with 429 + Retry-After once the caller's lookup budget is spent, without calling Supabase Auth", async (path, load) => {
    const url = path.startsWith("/api/sites") ? "/api/sites" : path;
    const call = await load();
    for (let i = 0; i < RATE_POLICIES.auth_lookup.limit; i++) await identify(get(junk(i), url));
    const before = authCalls();
    const res = await call(get(junk("x"), url));
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect(authCalls()).toBe(before);
  });

  it("another caller is unaffected by a stranger who spent its own budget", async () => {
    for (let i = 0; i < RATE_POLICIES.auth_lookup.limit + 5; i++) await identify(get(junk(i)));
    const other = await identify(new Request(siteUrl("/api/engagements"), { headers: { "x-forwarded-for": "198.51.100.8", ...bearerFor("a@acme.example") } }));
    expect(other).toMatchObject({ ok: true, email: "a@acme.example", verified: true });
  });

  it("a request with no bearer token costs neither a count nor an outbound call", async () => {
    for (let i = 0; i < RATE_POLICIES.auth_lookup.limit + 20; i++) expect(await identify(get({}))).toMatchObject({ ok: false, status: 401 });
    expect(authCalls()).toBe(0);
    expect(await identify(get(bearerFor("a@acme.example")))).toMatchObject({ ok: true }); // nothing was charged by the empty requests
  });

  it("FAILS CLOSED: if the counter cannot be read the lookup is refused (503) and Supabase Auth is not called", async () => {
    db.rpcs.delete("gf_rate_limit_hit"); // migration 0024 "not applied"
    vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await identify(get(bearerFor("a@acme.example")));
    expect(r).toMatchObject({ ok: false, status: 503 });
    expect(authCalls()).toBe(0);
  });

  it("an IPv6 caller rotating /64s inside one /48 is held by the /48 ceiling too", async () => {
    vi.stubEnv("GRIDFORGE_RATE_V6_48_FACTOR", "4"); // a lower factor than the default (32) keeps this loop short; the code path is the same
    const ceiling = RATE_POLICIES.auth_lookup.limit * 4;
    let refused = 0;
    // one lookup from each of ceiling + 5 distinct /64s of 2001:db8:feed::/48: no /64 is near its own limit
    for (let i = 0; i < ceiling + 5; i++) {
      const r = await identify(new Request(siteUrl("/api/engagements"), { headers: { "x-forwarded-for": `2001:db8:feed:${(i + 1).toString(16)}::1`, ...junk(i) } }));
      if (!r.ok && r.status === 429) refused++;
    }
    expect(authCalls()).toBe(ceiling);
    expect(refused).toBe(5);
  });
});

describe("(b) a short negative cache keyed on a hash of the token", () => {
  it("the same junk token 200 times costs ONE outbound call, and every answer is the same 401", async () => {
    for (let i = 0; i < 200; i++) expect(await identify(get(junk("same")))).toMatchObject({ ok: false, status: 401, error: "Your session has expired. Sign in again." });
    expect(authCalls()).toBe(1);
  });

  it("repeats do not spend the caller's lookup budget either", async () => {
    for (let i = 0; i < 500; i++) await identify(get(junk("same")));
    // a different token still has the whole budget but one
    for (let i = 0; i < RATE_POLICIES.auth_lookup.limit - 1; i++) expect(await identify(get(junk(`fresh-${i}`)))).toMatchObject({ status: 401 });
    expect(authCalls()).toBe(RATE_POLICIES.auth_lookup.limit);
  });

  it("stores a SHA-256 of the token and never the token", async () => {
    const token = junkJwt("secret-looking-abcdef0123456789");
    await identify(get({ authorization: `Bearer ${token}` }));
    const keys = rejectedTokenKeys();
    expect(keys).toEqual([crypto.createHash("sha256").update(token).digest("hex")]);
    expect(JSON.stringify(keys)).not.toContain(token);
  });

  it("is short: after the window the token is asked about again", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-10T10:00:00Z"));
    await identify(get(junk("a")));
    await identify(get(junk("a")));
    expect(authCalls()).toBe(1);
    vi.setSystemTime(new Date(Date.now() + IDENTITY_REJECTION_TTL_MS + 1000));
    await identify(get(junk("a")));
    expect(authCalls()).toBe(2);
    expect(IDENTITY_REJECTION_TTL_MS).toBeLessThanOrEqual(120_000);
  });

  it("is bounded: a flood of distinct junk tokens cannot grow it without limit", async () => {
    for (let i = 0; i < 3000; i++) {
      // a different caller each time, so the per-caller budget is not what is bounding this
      await identify(new Request(siteUrl("/api/engagements"), { headers: { "x-forwarded-for": `10.${i >> 8}.${i & 255}.1`, ...junk(i) } }));
    }
    expect(rejectedTokenKeys().length).toBeLessThanOrEqual(2000);
  });

  it("does not cache an outage: a 5xx from Supabase Auth is a 503 and the next request asks again", async () => {
    const real = globalThis.fetch;
    let n = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/auth/v1/user")) {
        n++;
        return new Response("boom", { status: 500 });
      }
      return real(input, init);
    }) as typeof fetch;
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await identify(get(junk("o")))).toMatchObject({ ok: false, status: 503 });
    expect(await identify(get(junk("o")))).toMatchObject({ ok: false, status: 503 });
    expect(n).toBe(2);
    globalThis.fetch = real;
  });

  it("VALID tokens behave exactly as before: asked every time, identity returned, never cached", async () => {
    for (let i = 0; i < 5; i++) {
      expect(await identify(get(bearerFor("Owner@Acme.example")))).toEqual({ ok: true, email: "owner@acme.example", verified: true });
    }
    expect(authCalls()).toBe(5);
    expect(rejectedTokenKeys()).toEqual([]);
  });
});

describe("P2-4(a): a bearer that cannot be an access token is refused locally, for free", () => {
  const nowS = () => Math.floor(Date.now() / 1000);
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const cannotBeValid: [string, string][] = [
    ["a bare word", "forged"],
    ["two segments", "aaa.bbb"],
    ["four segments", "aaa.bbb.ccc.ddd"],
    ["an empty segment", `${b64({ alg: "x" })}..sig`],
    ["characters outside base64url", `${b64({ alg: "x" })}.${b64({ exp: nowS() + 600 })}.sig+/=`],
    ["a payload that is not JSON", `${b64({ alg: "x" })}.${Buffer.from("not json").toString("base64url")}.sig`],
    ["a payload that is not an object", `${b64({ alg: "x" })}.${b64([1, 2])}.sig`],
    ["an exp in the past", jwtFor("a@acme.example", { exp: nowS() - 5 })],
    ["an exp that is not a number", `${b64({ alg: "x" })}.${b64({ exp: "soon" })}.sig`],
    ["a token over 8 KiB", `${"a".repeat(9000)}.b.c`],
  ];

  it.each(cannotBeValid)("%s: 401, no outbound call, no budget spent, nothing cached", async (_label, token) => {
    const r = await identify(get({ authorization: `Bearer ${token}` }));
    expect(r).toMatchObject({ ok: false, status: 401 });
    expect(authCalls()).toBe(0);
    expect(rejectedTokenKeys()).toEqual([]);
    expect(db.rows("rate_limit_windows").filter((x) => String(x.bucket).startsWith("auth_lookup"))).toEqual([]);
  });

  it("a shared-address flood of non-JWT tokens no longer blocks a valid user", async () => {
    for (let i = 0; i < RATE_POLICIES.auth_lookup.limit * 3; i++) await identify(get({ authorization: `Bearer flood-${i}` }));
    for (let i = 0; i < 50; i++) await identify(get({ authorization: `Bearer ${jwtFor("x@y.example", { exp: nowS() - 60 - i })}` }));
    expect(authCalls()).toBe(0);
    expect(await identify(get(bearerFor("honest@acme.example")))).toMatchObject({ ok: true, email: "honest@acme.example" });
  });

  it("the LIMIT that remains: JWT-shaped junk with a future exp still costs a counted lookup, so a shared-address flood of THAT can exhaust the budget", async () => {
    // Stated plainly because it is true: such a token cannot be told from a real one without asking Supabase. The budget is what bounds it.
    for (let i = 0; i < RATE_POLICIES.auth_lookup.limit; i++) await identify(get(junk(i)));
    expect(authCalls()).toBe(RATE_POLICIES.auth_lookup.limit);
    expect(await identify(get(bearerFor("honest@acme.example")))).toMatchObject({ ok: false, status: 429 });
  });
});

describe("P2-4(b): a lookup that turns out to be a valid user is given back", () => {
  const spent = () => db.rows("rate_limit_windows").filter((r) => String(r.bucket).startsWith("auth_lookup")).reduce((n, r) => n + (r.hits as number), 0);

  it("twice the budget of VALID lookups from one address all succeed, and the budget is left unspent", async () => {
    for (let i = 0; i < RATE_POLICIES.auth_lookup.limit * 2; i++) expect(await identify(get(bearerFor("honest@acme.example"))), `lookup ${i + 1}`).toMatchObject({ ok: true });
    expect(authCalls()).toBe(RATE_POLICIES.auth_lookup.limit * 2);
    expect(spent()).toBe(0);
  });

  it("is correct under the /48 counter too: both the /64 and the /48 hit are given back", async () => {
    const v6 = (i: number) => new Request(siteUrl("/api/engagements"), { headers: { "x-forwarded-for": `2001:db8:feed:${(i + 1).toString(16)}::1`, ...bearerFor("honest@acme.example") } });
    for (let i = 0; i < 40; i++) expect(await identify(v6(i))).toMatchObject({ ok: true });
    expect(db.rows("rate_limit_windows").some((r) => String(r.bucket) === "auth_lookup_v6_48")).toBe(false); // the row is gone, not left at 40
    expect(spent()).toBe(0);
  });

  it("only a 200 is refunded: a rejected token and a failing Supabase stay counted", async () => {
    await identify(get(junk("rejected")));
    expect(spent()).toBe(1);
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return url.includes("/auth/v1/user") ? new Response("boom", { status: 500 }) : real(input, init);
    }) as typeof fetch;
    vi.spyOn(console, "error").mockImplementation(() => {});
    await identify(get(junk("down")));
    globalThis.fetch = real;
    expect(spent()).toBe(2);
  });

  it("a valid user among junk keeps the junk's cost counted (the refund is for the valid lookup only)", async () => {
    for (let i = 0; i < 5; i++) await identify(get(junk(i)));
    for (let i = 0; i < 5; i++) await identify(get(bearerFor("honest@acme.example")));
    expect(spent()).toBe(5);
  });
});
