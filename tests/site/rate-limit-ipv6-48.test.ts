/**
 * Review finding 1: callers were bucketed by IPv6 /64 only, so a caller holding a /48 (65,536 /64s) or a /32 got a fresh allowance
 * from every /64 it chose to speak from, on every IP-keyed limiter. A caller is now limited by BOTH its /64 and its /48.
 *
 * What these tests pin:
 *   - the identity carries a second, coarser pseudonym (the /48) for IPv6 and none for IPv4 or an unattributed caller;
 *   - a caller rotating /64s inside one /48 is stopped at the /48 ceiling (IPV6_48_FACTOR x the route's limit), on the request
 *     level, on the provider-spend level and on the admin login throttle;
 *   - a normal caller (one /64, or a few /64s of an office) is never refused by the /48 bucket before its own /64 allowance;
 *   - removing the /48 charge from lib/rate-limit.ts makes the rotation scenario succeed: the scenario test is sensitive to it
 *     (a mutation check run against a mutated copy of the module, below).
 *
 * LIMITS, stated honestly: the in-memory counter used here is per process; production uses the shared Postgres counter (0024).
 * A caller with a /32 can still use 8 allowances per /48 it rotates between -- the /48 bucket bounds a /48, not a whole provider.
 * The shared aggregate budgets and the provider-spend ceiling are what bound the total.
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { siteUrl } from "@/lib/site";
import { runInSpendScope } from "@/lib/spend-scope";
import {
  IPV6_48_FACTOR_DEFAULT,
  PROVIDER_BUDGETS,
  RATE_POLICIES,
  callerIdentity,
  engineFetch,
  guardRequest,
  ipv6CoarseFactor,
  resetMemoryLimiter,
  subjectOf,
} from "@/lib/rate-limit";

const reqFrom = (forwarded: string) => new Request(siteUrl("/api/x"), { method: "POST", headers: { "x-forwarded-for": forwarded } });
/** The i-th /64 inside the documentation /48 2001:db8:feed::/48 -- a different 4th group each time. */
const in48 = (i: number, host = 1) => `2001:db8:feed:${(i + 1).toString(16)}::${host.toString(16)}`;
const id = (forwarded: string) => {
  const who = callerIdentity(reqFrom(forwarded));
  if (!who.ok) throw new Error(who.reason);
  return who;
};

beforeEach(() => {
  resetMemoryLimiter();
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.RATE_LIMIT_HMAC_KEY;
  delete process.env.GRIDFORGE_TRUSTED_IP_HEADER;
  delete process.env.GRIDFORGE_RATE_V6_48_FACTOR;
  delete process.env.VERCEL;
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("the /48 identity", () => {
  it("two /64s inside one /48 are two fine identities and ONE coarse identity; another /48 is another coarse identity", () => {
    const a = id(in48(0));
    const b = id(in48(1));
    expect(a.subject).not.toBe(b.subject); // still keyed by /64 first
    expect(a.coarse).toBeTruthy();
    expect(a.coarse).toBe(b.coarse);
    expect(id("2001:db8:feed:ffff:1:2:3:4").coarse).toBe(a.coarse); // any /64 of the /48, any host in it
    expect(id("2001:db8:beef:1::1").coarse).not.toBe(a.coarse);
    expect(a.coarse).toMatch(/^[0-9a-f]{64}$/);
    expect(a.coarse).not.toBe(a.subject);
  });

  it("IPv4, an IPv4-mapped address and an unattributed caller have no coarse identity: they are keyed exactly as before", () => {
    expect(id("203.0.113.77").coarse).toBeUndefined();
    expect(id("203.0.113.77").subject).toBe(subjectOf("203.0.113.77"));
    expect(id("::ffff:203.0.113.77").coarse).toBeUndefined();
    expect(id("not-an-ip").coarse).toBeUndefined();
  });

  it("the default ceiling is stated, and a malformed override means the default, never 'unlimited'", () => {
    expect(IPV6_48_FACTOR_DEFAULT).toBe(8);
    expect(ipv6CoarseFactor({} as NodeJS.ProcessEnv)).toBe(8);
    expect(ipv6CoarseFactor({ GRIDFORGE_RATE_V6_48_FACTOR: "4" } as unknown as NodeJS.ProcessEnv)).toBe(4);
    for (const bad of ["0", "-3", "1e9", "NaN", "", "8.5", "99999", "lots"]) {
      expect(ipv6CoarseFactor({ GRIDFORGE_RATE_V6_48_FACTOR: bad } as unknown as NodeJS.ProcessEnv), bad).toBe(8);
    }
  });
});

/** Rotate through `tries` distinct /64s of one /48, one request each, on the route policy `audit`; how many were admitted? */
async function rotate(guard: typeof guardRequest, tries: number) {
  let admitted = 0;
  let firstRefusal: number | null = null;
  for (let i = 0; i < tries; i++) {
    const g = await guard(reqFrom(in48(i)), "audit");
    if (g.denied === null) admitted++;
    else firstRefusal ??= g.denied.status;
  }
  return { admitted, firstRefusal };
}

describe("a caller rotating /64s inside one /48 is stopped; a normal caller is not", () => {
  it("is admitted at most limit x factor times, then refused 429", async () => {
    const ceiling = RATE_POLICIES.audit.limit * IPV6_48_FACTOR_DEFAULT;
    const { admitted, firstRefusal } = await rotate(guardRequest, ceiling + 30);
    expect(admitted).toBe(ceiling); // not 65,536 allowances: one /48 gets a bounded number
    expect(firstRefusal).toBe(429);
    // ...and a caller in a DIFFERENT /48 is unaffected by it
    expect((await guardRequest(reqFrom("2001:db8:cafe:1::1"), "audit")).denied).toBeNull();
  });

  it("a refused rotating attacker carries a Retry-After the standard way", async () => {
    const ceiling = RATE_POLICIES.audit.limit * IPV6_48_FACTOR_DEFAULT;
    await rotate(guardRequest, ceiling);
    const g = await guardRequest(reqFrom(in48(ceiling + 5)), "audit");
    expect(g.denied?.status).toBe(429);
    expect(Number(g.denied?.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
  });

  it("a normal single caller is limited by its own /64 first and never meets the /48 bucket", async () => {
    const limit = RATE_POLICIES.audit.limit;
    for (let i = 0; i < limit; i++) expect((await guardRequest(reqFrom(in48(0, i + 1)), "audit")).denied, `request ${i + 1}`).toBeNull();
    expect((await guardRequest(reqFrom(in48(0, 99)), "audit")).denied?.status).toBe(429); // its own /64 allowance, as before
    // refusals by the /64 do not drain the shared /48: a neighbour /64 in the same /48 still has its full allowance
    for (let i = 0; i < limit; i++) expect((await guardRequest(reqFrom(in48(1, i + 1)), "audit")).denied, `neighbour ${i + 1}`).toBeNull();
  });

  it("an office spread over a few /64s of its /48 (up to the factor) is not throttled before each /64's own allowance", async () => {
    const limit = RATE_POLICIES.audit.limit;
    // IPV6_48_FACTOR_DEFAULT /64s each using its whole allowance: exactly the /48 ceiling, all admitted.
    for (let net = 0; net < IPV6_48_FACTOR_DEFAULT; net++) {
      for (let i = 0; i < limit; i++) expect((await guardRequest(reqFrom(in48(net, i + 1)), "audit")).denied, `net ${net} request ${i + 1}`).toBeNull();
    }
  });

  it("IPv4 is unchanged: limit requests, then 429, with no coarse bucket", async () => {
    const limit = RATE_POLICIES.audit.limit;
    for (let i = 0; i < limit; i++) expect((await guardRequest(reqFrom("203.0.113.9"), "audit")).denied).toBeNull();
    expect((await guardRequest(reqFrom("203.0.113.9"), "audit")).denied?.status).toBe(429);
    expect((await guardRequest(reqFrom("203.0.113.10"), "audit")).denied).toBeNull();
  });

  it("the provider-spend budget is also charged per /48: rotating /64s cannot multiply a caller's engine budget", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("{}", { status: 200 })) as typeof fetch;
    try {
      const budget = PROVIDER_BUDGETS["engine:public:free"]; // 360 an hour per caller, 3000 for everyone
      const ceiling = budget.caller.limit * IPV6_48_FACTOR_DEFAULT; // 2880: below the aggregate, so only the /48 can be what stops this
      expect(ceiling).toBeLessThan(budget.aggregate.limit);
      let ok = 0;
      for (let i = 0; i < ceiling + 40; i++) {
        const who = id(in48(i)); // every call from its own /64, one call each: no /64 is anywhere near its own 360
        const out = await runInSpendScope({ cls: "public", caller: who.subject, caller48: who.coarse ?? null, denial: null }, () => engineFetch("https://engine.example/v1/qualify"));
        if (out.status === 200) ok++;
        else expect(out.status).toBe(429);
      }
      expect(ok).toBe(ceiling);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("the admin login throttle is charged per /48 too", () => {
  const PASSWORD = "a-long-random-admin-password";
  beforeEach(() => {
    process.env.ADMIN_PASSWORD = PASSWORD;
    delete process.env.ADMIN_SESSION_SECRET;
  });
  afterEach(() => {
    delete process.env.ADMIN_PASSWORD;
  });

  it("guesses rotated across the /64s of one /48 stop at limit x factor", async () => {
    const { requestKey, requestCoarseKey, throttleLogin, resetLoginThrottle } = await import("@/lib/admin");
    resetLoginThrottle();
    const ceiling = RATE_POLICIES.admin_login.limit * IPV6_48_FACTOR_DEFAULT;
    let allowed = 0;
    for (let i = 0; i < ceiling + 20; i++) {
      const r = reqFrom(in48(i));
      if ((await throttleLogin(requestKey(r), undefined, requestCoarseKey(r))) === 0) allowed++;
    }
    expect(allowed).toBe(ceiling);
    // a single /64 still gets exactly its own allowance, as before
    resetLoginThrottle();
    const one = reqFrom(in48(3));
    let single = 0;
    for (let i = 0; i < 20; i++) if ((await throttleLogin(requestKey(one), undefined, requestCoarseKey(one))) === 0) single++;
    expect(single).toBe(RATE_POLICIES.admin_login.limit);
  });
});

describe("mutation check: without the /48 charge the rotation scenario succeeds", () => {
  it("the same scenario against a copy of lib/rate-limit.ts with the /48 charge removed admits far more than the ceiling", async () => {
    const src = fs.readFileSync(path.resolve(__dirname, "../../lib/rate-limit.ts"), "utf8");
    const marker = "const wide = await chargeCoarse(RATE_POLICIES[name], who.coarse);";
    expect(src.split(marker).length - 1, "the request-level /48 charge must appear exactly once").toBe(1);
    const mutantPath = path.resolve(__dirname, "../../lib/__mutant_rate_limit_no48.ts");
    fs.writeFileSync(mutantPath, src.replace(marker, "const wide = null; /* MUTANT: /48 charge removed */"));
    try {
      const mutant = (await import(/* @vite-ignore */ mutantPath)) as typeof import("@/lib/rate-limit");
      mutant.resetMemoryLimiter();
      const ceiling = RATE_POLICIES.audit.limit * IPV6_48_FACTOR_DEFAULT;
      const { admitted } = await rotate(mutant.guardRequest, ceiling + 30);
      expect(admitted).toBe(ceiling + 30); // every rotated /64 got a fresh allowance: this is the defect the /48 bucket closes
      // and the real module, same scenario, is stopped (the other tests): the scenario distinguishes the two.
      resetMemoryLimiter();
      expect((await rotate(guardRequest, ceiling + 30)).admitted).toBe(ceiling);
    } finally {
      fs.rmSync(mutantPath, { force: true });
    }
  });
});
