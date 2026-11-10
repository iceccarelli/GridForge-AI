/**
 * Admin gate hardening: the session key fails closed in production, the login throttle is the shared Postgres counter
 * (so two serverless instances count together, and an unreadable counter refuses), and a cross-site write riding the
 * admin cookie is refused on every state-changing admin route.
 */
// NOTE (review finding 3): verifyAdminCookie is now async (it also reads the server-side denylist of logged-out sessions, migration 0055), so every
// call below is awaited. No expectation was changed; revocation itself is covered in tests/site/admin-session-revocation.test.ts.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SITE_URL } from "@/lib/site";
import { PostgrestFake } from "./postgrest-fake";

const jar: { name: string; value: string }[] = [];
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      const hit = [...jar].reverse().find((c) => c.name === name);
      return hit ? { name, value: hit.value } : undefined;
    },
    set: (name: string, value: string) => void jar.push({ name, value }),
    delete: () => {},
  }),
}));

const PASSWORD = "a-long-random-admin-password";
const STRONG = "k".repeat(40);
const realFetch = globalThis.fetch;

async function freshAdmin() {
  vi.resetModules();
  return await import("@/lib/admin");
}
async function freshLogin() {
  vi.resetModules();
  return await import("@/app/api/admin/login/route");
}
function login(password: string, headers: Record<string, string> = {}) {
  return new Request(`${SITE_URL}/api/admin/login`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.10", ...headers },
    body: JSON.stringify({ password }),
  });
}

beforeEach(() => {
  jar.length = 0;
  process.env.ADMIN_PASSWORD = PASSWORD;
  delete process.env.ADMIN_SESSION_SECRET;
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
  delete process.env.ADMIN_PASSWORD;
  delete process.env.ADMIN_SESSION_SECRET;
});

describe("finding 1: production refuses a session key that is not distinct and strong", () => {
  const forge = (secret: string) => {
    const payload = `${Date.now() + 60_000}.deadbeefdeadbeef`;
    return `${payload}.${crypto.createHmac("sha256", secret).update(payload).digest("hex")}`;
  };

  it("EXPLOIT (before the fix): the derived key is a pure function of the password, so anyone who learns or guesses the password offline can forge a session without ever hitting the login throttle", async () => {
    // Development path, which is what production used to run. Documented here so the attack stays understood.
    const { verifyAdminCookie } = await freshAdmin();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const derived = crypto.createHmac("sha256", PASSWORD).update("gf-admin-session-key-v1").digest("hex");
    expect(await verifyAdminCookie(forge(derived))).toBe(true);
  });

  for (const [label, secret] of [
    ["unset", undefined],
    ["too short", "short-secret"],
    ["31 characters", "x".repeat(31)],
    ["equal to the password", PASSWORD.padEnd(40, "!").slice(0, 0) + PASSWORD],
    ["containing the password", `prefix-${PASSWORD}-suffix-padding`],
  ] as const) {
    it(`production with ADMIN_SESSION_SECRET ${label}: no token is minted, every cookie is refused, one clear error is logged`, async () => {
      vi.stubEnv("NODE_ENV", "production");
      if (secret) process.env.ADMIN_SESSION_SECRET = secret;
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      const { adminToken, verifyAdminCookie, adminSessionReady } = await freshAdmin();
      expect(adminToken()).toBeNull();
      expect(adminSessionReady()).toBe(false);
      const derived = crypto.createHmac("sha256", PASSWORD).update("gf-admin-session-key-v1").digest("hex");
      expect(await verifyAdminCookie(forge(derived))).toBe(false);
      expect(await verifyAdminCookie(forge(PASSWORD))).toBe(false);
      if (secret) expect(await verifyAdminCookie(forge(secret))).toBe(false);
      expect(err).toHaveBeenCalledTimes(1);
      const text = String(err.mock.calls[0].join(" "));
      expect(text).toContain("ADMIN_SESSION_SECRET");
      expect(text).not.toContain(PASSWORD);
    });
  }

  it("production with a distinct 32+ character secret signs and verifies, and the password plays no part", async () => {
    vi.stubEnv("NODE_ENV", "production");
    process.env.ADMIN_SESSION_SECRET = STRONG;
    // INTENTIONAL CHANGE (review finding 3): production now also needs a readable session denylist (migration 0055) before it accepts any admin cookie
    // (fail closed; see tests/site/admin-session-revocation.test.ts). This test is about the signing key, so it is given a store that can be read.
    process.env.SUPABASE_URL = "https://stub.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_test";
    const restoreStore = new PostgrestFake().install();
    try {
      const { adminToken, verifyAdminCookie, adminSessionReady } = await freshAdmin();
      const t = adminToken()!;
      expect(adminSessionReady()).toBe(true);
      expect(await verifyAdminCookie(t)).toBe(true);
      expect(await verifyAdminCookie(forge(STRONG))).toBe(true);
      expect(await verifyAdminCookie(forge(PASSWORD))).toBe(false);
    } finally {
      restoreStore();
      delete process.env.SUPABASE_URL;
      delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    }
  });

  it("the production login route answers 503 naming the variable (and sets no cookie) when the secret is missing", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { POST } = await freshLogin();
    const res = await POST(login(PASSWORD));
    expect(res.status).toBe(503);
    expect(JSON.stringify(await res.json())).toContain("ADMIN_SESSION_SECRET");
    expect(jar).toHaveLength(0);
  });

  it("development keeps the explicit convenience: derived key with a warning, nothing refused", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { adminToken, verifyAdminCookie } = await freshAdmin();
    expect(await verifyAdminCookie(adminToken()!)).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("finding 2: the login throttle is the shared Postgres counter and fails closed", () => {
  function useStore() {
    process.env.SUPABASE_URL = "https://stub.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_test";
    const db = new PostgrestFake(["rate_limit_windows"]);
    return { db, restore: db.install() };
  }
  const req = (ip: string) => new Request(`${SITE_URL}/api/admin/login`, { method: "POST", headers: { "x-forwarded-for": ip } });

  it("two separately loaded instances (separate module state) count against ONE counter: 5 + 3 passes, the 9th is throttled", async () => {
    const { db, restore } = useStore();
    try {
      const a = await freshAdmin();
      const b = await freshAdmin();
      expect(a).not.toBe(b); // distinct module instances, as two serverless containers would be
      for (let i = 0; i < 5; i++) expect(await a.throttleLogin(a.requestKey(req("203.0.113.9")))).toBe(0);
      for (let i = 0; i < 3; i++) expect(await b.throttleLogin(b.requestKey(req("203.0.113.9")))).toBe(0);
      expect(await a.throttleLogin(a.requestKey(req("203.0.113.9")))).toBeGreaterThan(0);
      expect(await b.throttleLogin(b.requestKey(req("203.0.113.9")))).toBeGreaterThan(0);
      // the count lives in the table, keyed by a pseudonym, never an address
      const rows = db.rows("rate_limit_windows").filter((r) => r.bucket === "admin_login");
      expect(rows).toHaveLength(1);
      expect(JSON.stringify(rows)).not.toContain("203.0.113.9");
      // another caller is unaffected
      expect(await b.throttleLogin(b.requestKey(req("198.51.100.1")))).toBe(0);
    } finally {
      restore();
    }
  });

  it("through the real route: guesses spread across two instances still hit 429, and the right password is then refused too", async () => {
    const { restore } = useStore();
    process.env.ADMIN_SESSION_SECRET = STRONG;
    try {
      const a = await freshLogin();
      const b = await freshLogin();
      const statuses: number[] = [];
      for (let i = 0; i < 8; i++) statuses.push((await (i % 2 ? a : b).POST(login(`guess-${i}`))).status);
      expect(statuses.every((s) => s === 401)).toBe(true);
      const right = await a.POST(login(PASSWORD));
      expect(right.status).toBe(429);
      expect(Number(right.headers.get("Retry-After"))).toBeGreaterThan(0);
      expect(jar).toHaveLength(0);
    } finally {
      restore();
    }
  });

  it("fails closed: counter unreachable, or migration 0024 absent -> 503, the password is never compared, no cookie", async () => {
    const { db, restore } = useStore();
    process.env.ADMIN_SESSION_SECRET = STRONG;
    vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { POST } = await freshLogin();
      db.rpcs.delete("gf_rate_limit_hit");
      let res = await POST(login(PASSWORD));
      expect(res.status).toBe(503);
      db.installRateLimit();
      db.failNext = { status: 500, body: "boom" };
      res = await POST(login(PASSWORD));
      expect(res.status).toBe(503);
      expect(jar).toHaveLength(0);
      // and it recovers when the counter does
      expect((await POST(login(PASSWORD))).status).toBe(200);
    } finally {
      restore();
    }
  });

  it("fails closed on a production build with no store at all (the in-memory counter is development-only)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("GRIDFORGE_TRUSTED_IP_HEADER", "x-forwarded-for");
    process.env.ADMIN_SESSION_SECRET = STRONG;
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { POST } = await freshLogin();
    expect((await POST(login(PASSWORD))).status).toBe(503);
    expect(jar).toHaveLength(0);
  });
});

describe("finding 5: a cross-site write cannot ride the admin cookie", () => {
  const ADMIN_ROUTES = (() => {
    const out: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name === "route.ts") out.push(p);
      }
    };
    walk(path.join(process.cwd(), "app/api/admin"));
    return out;
  })();

  it("EVERY admin route that exports POST/PATCH/PUT/DELETE calls refuseCrossSiteWrite (a new one without it fails here)", () => {
    const missing: string[] = [];
    for (const f of ADMIN_ROUTES) {
      const src = fs.readFileSync(f, "utf8");
      const handlers = [...src.matchAll(/export async function (POST|PATCH|PUT|DELETE)\b/g)].length;
      const calls = [...src.matchAll(/refuseCrossSiteWrite\(req\)/g)].length;
      if (handlers > calls) missing.push(path.relative(process.cwd(), f));
    }
    expect(missing).toEqual([]);
  });

  it("refuses a cross-site Origin or Sec-Fetch-Site, accepts same-origin, the configured site, and no-header (non-browser) requests", async () => {
    const { refuseCrossSiteWrite } = await freshAdmin();
    const r = (h: Record<string, string>) => new Request(`${SITE_URL}/api/admin/leads`, { method: "PATCH", headers: h });
    expect(refuseCrossSiteWrite(r({ origin: "https://evil.example" }))?.status).toBe(403);
    expect(refuseCrossSiteWrite(r({ origin: "null" }))?.status).toBe(403);
    expect(refuseCrossSiteWrite(r({ origin: "not a url" }))?.status).toBe(403);
    expect(refuseCrossSiteWrite(r({ "sec-fetch-site": "cross-site" }))?.status).toBe(403);
    expect(refuseCrossSiteWrite(r({ origin: "https://timetopower.evil.example", host: new URL(SITE_URL).host }))?.status).toBe(403);
    expect(refuseCrossSiteWrite(r({ origin: SITE_URL }))).toBeNull();
    expect(refuseCrossSiteWrite(r({ origin: "https://preview.example", host: "preview.example" }))).toBeNull();
    expect(refuseCrossSiteWrite(r({ origin: "https://preview.example", "x-forwarded-host": "preview.example" }))).toBeNull();
    expect(refuseCrossSiteWrite(r({ "sec-fetch-site": "same-origin" }))).toBeNull();
    expect(refuseCrossSiteWrite(r({}))).toBeNull();
  });

  it("the login route and a gated admin route answer 403 to a cross-site browser request, before any password or cookie is looked at", async () => {
    process.env.ADMIN_SESSION_SECRET = STRONG;
    const { POST, DELETE } = await freshLogin();
    const res = await POST(login(PASSWORD, { origin: "https://evil.example" }));
    expect(res.status).toBe(403);
    expect(jar).toHaveLength(0);
    expect((await DELETE(new Request(`${SITE_URL}/api/admin/login`, { method: "DELETE", headers: { origin: "https://evil.example" } }))).status).toBe(403);
    const { adminToken } = await import("@/lib/admin");
    jar.push({ name: "gf_admin", value: adminToken()! });
    const { PATCH } = await import("@/app/api/admin/leads/route");
    const patch = await PATCH(
      new Request(`${SITE_URL}/api/admin/leads`, {
        method: "PATCH",
        headers: { "content-type": "application/json", origin: "https://evil.example" },
        body: JSON.stringify({ id: "x", status: "won" }),
      })
    );
    expect(patch.status).toBe(403);
  });
});
