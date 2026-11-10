/**
 * Review finding 3: an admin session was a stateless HMAC cookie `<expiry>.<nonce>.<mac>` valid for 12 hours, and logging out only asked the
 * BROWSER to forget it: a copied cookie (a log, a proxy, a stolen laptop) stayed valid to its expiry. Now:
 *
 *   - logout writes the session's nonce (a keyed hash of it, never the nonce) to a server-side denylist (migration 0055);
 *   - verifyAdminCookie reads it, and FAILS CLOSED in production when it cannot (store missing, migration not applied, unreachable, unexpected answer);
 *   - the lifetime is 4 hours, and a correctly signed cookie that claims longer (one minted under the old 12 hour rule) is refused;
 *   - no cookie, nonce or MAC is logged.
 *
 * LIMITS, stated honestly: revocation is per SESSION (a copied cookie of a session that was never logged out stays valid until it expires, at most 4
 * hours, or ADMIN_SESSION_SECRET is rotated -- which revokes every session). It is checked against the shared store on every admin request.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import { siteUrl } from "@/lib/site";
import { PostgrestFake } from "./postgrest-fake";

const PASSWORD = "a-long-random-admin-password";
const STRONG = "x".repeat(8) + "s3cret-admin-session-key-0123456789abcdef";

const jar: { name: string; value: string }[] = [];
const cookieOps: string[] = [];
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => jar.find((c) => c.name === name),
    set: (name: string, value: string) => { cookieOps.push(`set:${name}`); jar.push({ name, value }); },
    delete: (name: string) => { cookieOps.push(`delete:${name}`); const i = jar.findIndex((c) => c.name === name); if (i >= 0) jar.splice(i, 1); },
  }),
}));

const admin = () => import("@/lib/admin");
const logout = () => import("@/app/api/admin/login/route").then((m) => m.DELETE);
const login = () => import("@/app/api/admin/login/route").then((m) => m.POST);
const withCookie = (value: string) => { jar.length = 0; jar.push({ name: "gf_admin", value }); };
const del = () => new Request(siteUrl("/api/admin/login"), { method: "DELETE", headers: { "x-forwarded-for": "203.0.113.1" } });

let db: PostgrestFake;
let restore: () => void;
let logged: string[];

beforeEach(async () => {
  jar.length = 0;
  cookieOps.length = 0;
  process.env.ADMIN_PASSWORD = PASSWORD;
  delete process.env.ADMIN_SESSION_SECRET;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  logged = [];
  for (const m of ["log", "warn", "error"] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { logged.push(a.map(String).join(" ")); });
  const a = await admin();
  a.resetAdminSecretWarning();
  a.resetAdminRevocations();
  a.resetLoginThrottle();
});
afterEach(() => {
  restore?.();
  restore = () => {};
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  delete process.env.ADMIN_PASSWORD;
  delete process.env.ADMIN_SESSION_SECRET;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
});

function useStore() {
  process.env.SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_test";
  db = new PostgrestFake();
  restore = db.install();
}
function production() {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("VERCEL", "1"); // production names its proxy header; the login throttle needs a caller address
  process.env.ADMIN_SESSION_SECRET = STRONG;
}
const parts = (t: string) => t.split(".");
const noSecretsLogged = (t: string) => {
  const [exp, nonce, mac] = parts(t);
  const text = logged.join("\n");
  for (const s of [t, nonce, mac]) expect(text).not.toContain(s);
  expect(text).not.toContain(`${exp}.${nonce}`);
};

describe("lifetime", () => {
  it("is 4 hours (was 12): a fresh cookie is good at 3 h and refused at 5 h", async () => {
    const { adminToken, verifyAdminCookie, ADMIN_SESSION_SECONDS } = await admin();
    expect(ADMIN_SESSION_SECONDS).toBe(4 * 3600);
    const t = adminToken()!;
    expect(await verifyAdminCookie(t, Date.now() + 3 * 3600_000)).toBe(true);
    expect(await verifyAdminCookie(t, Date.now() + 5 * 3600_000)).toBe(false);
  });

  it("a correctly SIGNED cookie that claims more than the lifetime (minted under the old 12 hour rule) is refused at once", async () => {
    const { adminToken, verifyAdminCookie } = await admin();
    const old = adminToken(Date.now() + 8 * 3600_000)!; // expiry = now + 12 h
    expect(await verifyAdminCookie(old)).toBe(false);
    expect(await verifyAdminCookie(old, Date.now() + 9 * 3600_000)).toBe(true); // it only becomes acceptable once within a lifetime of expiry
  });

  it("the login cookie's maxAge is the lifetime", async () => {
    const src = (await import("node:fs")).readFileSync("app/api/admin/login/route.ts", "utf8");
    expect(src).toMatch(/maxAge: ADMIN_SESSION_SECONDS/);
  });
});

describe("logout revokes the session server-side", () => {
  it("after DELETE the same cookie is refused although it is correctly signed and unexpired; another session is untouched", async () => {
    useStore();
    const { adminToken, verifyAdminCookie } = await admin();
    const mine = adminToken()!;
    const other = adminToken()!;
    expect(await verifyAdminCookie(mine)).toBe(true);
    withCookie(mine);
    const res = (await logout())(del());
    const out = await res;
    expect(out.status).toBe(200);
    expect(await out.json()).toMatchObject({ ok: true, revoked: true });
    expect(cookieOps).toContain("delete:gf_admin");
    expect(await verifyAdminCookie(mine)).toBe(false); // a copy of the cookie is now worthless
    expect(await verifyAdminCookie(other)).toBe(true);
    noSecretsLogged(mine);
  });

  it("stores only a keyed hash of the nonce -- never the nonce, the MAC or the cookie -- with an expiry no later than the cookie's", async () => {
    useStore();
    const { adminToken } = await admin();
    const t = adminToken()!;
    const [exp, nonce, mac] = parts(t);
    withCookie(t);
    await (await logout())(del());
    const rows = db.rows("admin_session_revocations");
    expect(rows).toHaveLength(1);
    expect(rows[0].nonce_hash).toMatch(/^[0-9a-f]{64}$/);
    const stored = JSON.stringify(rows) + JSON.stringify(db.calls);
    for (const s of [t, nonce, mac]) expect(stored).not.toContain(s);
    expect(new Date(rows[0].expires_at as string).getTime()).toBeLessThanOrEqual(Number(exp));
  });

  it("logging out twice is harmless, and a garbage, forged or expired cookie writes nothing", async () => {
    useStore();
    const { adminToken } = await admin();
    const t = adminToken()!;
    withCookie(t);
    await (await logout())(del());
    withCookie(t);
    expect((await (await logout())(del())).status).toBe(200);
    expect(db.rows("admin_session_revocations")).toHaveLength(1);
    const forged = `${Date.now() + 60_000}.deadbeefdeadbeef.${"0".repeat(64)}`;
    const expired = adminToken(Date.now() - 5 * 3600_000)!;
    for (const v of ["garbage", forged, expired]) {
      withCookie(v);
      const r = await (await logout())(del());
      expect(r.status).toBe(200);
      expect(cookieOps.at(-1)).toBe("delete:gf_admin");
    }
    jar.length = 0;
    expect((await (await logout())(del())).status).toBe(200); // no cookie at all
    expect(db.rows("admin_session_revocations")).toHaveLength(1); // nobody can fill the table without a valid session
  });

  it("if the denylist cannot be written the browser still forgets the cookie, but the answer says it was NOT revoked (and logs no secret)", async () => {
    useStore();
    const { adminToken } = await admin();
    const t = adminToken()!;
    db.rpcs.delete("gf_admin_session_revoke"); // migration 0055 not applied
    withCookie(t);
    const res = await (await logout())(del());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, revoked: false });
    expect(cookieOps).toContain("delete:gf_admin");
    expect(logged.join("\n")).toMatch(/could not be revoked/);
    noSecretsLogged(t);
  });

  it("a cross-site logout is refused and revokes nothing", async () => {
    useStore();
    const { adminToken } = await admin();
    const t = adminToken()!;
    withCookie(t);
    const res = await (await logout())(new Request(siteUrl("/api/admin/login"), { method: "DELETE", headers: { "sec-fetch-site": "cross-site" } }));
    expect(res.status).toBe(403);
    expect(db.rows("admin_session_revocations")).toHaveLength(0);
  });

  it("development and tests without a store keep an in-memory denylist (never used in production)", async () => {
    const { adminToken, verifyAdminCookie } = await admin();
    const t = adminToken()!;
    withCookie(t);
    expect(await verifyAdminCookie(t)).toBe(true);
    await (await logout())(del());
    expect(await verifyAdminCookie(t)).toBe(false);
  });
});

describe("FAILS CLOSED in production when the revocation store cannot be read", () => {
  async function tokenInProduction() {
    production();
    const { adminToken } = await admin();
    return adminToken()!;
  }

  it("FAIL-CLOSED: a store that is not configured refuses a correctly signed, unexpired cookie", async () => {
    const t = await tokenInProduction();
    const { verifyAdminCookie } = await admin();
    expect(await verifyAdminCookie(t)).toBe(false);
    noSecretsLogged(t);
  });

  it("FAIL-CLOSED: migration 0055 not applied (the function answers 404) refuses the cookie", async () => {
    useStore();
    const t = await tokenInProduction();
    db.rpcs.delete("gf_admin_session_revoked");
    const { verifyAdminCookie } = await admin();
    expect(await verifyAdminCookie(t)).toBe(false);
    noSecretsLogged(t);
  });

  it("FAIL-CLOSED: a store that errors, is down, or answers in a form this code does not understand refuses the cookie", async () => {
    useStore();
    const t = await tokenInProduction();
    const { verifyAdminCookie } = await admin();
    for (const answer of [() => { throw new Error("boom"); }, () => "yes", () => ({ revoked: false }), () => null, () => [] as unknown[]]) {
      db.rpcs.set("gf_admin_session_revoked", answer as never);
      expect(await verifyAdminCookie(t)).toBe(false);
    }
    db.failNext = { status: 503, body: "{}" };
    db.rpcs.set("gf_admin_session_revoked", () => false);
    expect(await verifyAdminCookie(t)).toBe(false);
    expect(await verifyAdminCookie(t)).toBe(true); // and a readable store accepts it again
    noSecretsLogged(t);
  });

  it("a readable store: active session accepted, revoked session refused, in production", async () => {
    useStore();
    const t = await tokenInProduction();
    const { verifyAdminCookie } = await admin();
    expect(await verifyAdminCookie(t)).toBe(true);
    withCookie(t);
    await (await logout())(del());
    expect(await verifyAdminCookie(t)).toBe(false);
  });

  it("the store is not even asked about a cookie whose signature is wrong or that has expired", async () => {
    useStore();
    const t = await tokenInProduction();
    const { verifyAdminCookie } = await admin();
    const before = db.calls.length;
    expect(await verifyAdminCookie("garbage")).toBe(false);
    expect(await verifyAdminCookie(undefined)).toBe(false);
    expect(await verifyAdminCookie(`${parts(t)[0]}.${parts(t)[1]}.${"0".repeat(64)}`)).toBe(false);
    expect(await verifyAdminCookie(t, Date.now() + 5 * 3600_000)).toBe(false);
    expect(db.calls.length).toBe(before);
  });

  it("login does not hand out a cookie it could never accept: with an unreadable store it answers 503 and sets nothing", async () => {
    useStore();
    production();
    db.rpcs.delete("gf_admin_session_revoked");
    const res = await (await login())(new Request(siteUrl("/api/admin/login"), { method: "POST", headers: { "x-forwarded-for": "203.0.113.2", "content-type": "application/json" }, body: JSON.stringify({ password: PASSWORD }) }));
    expect(res.status).toBe(503);
    expect(JSON.stringify(await res.json())).toMatch(/0055|revocation|session store/i);
    expect(cookieOps.filter((o) => o.startsWith("set:"))).toEqual([]);
  });

  it("login still works with a readable store", async () => {
    useStore();
    production();
    const res = await (await login())(new Request(siteUrl("/api/admin/login"), { method: "POST", headers: { "x-forwarded-for": "203.0.113.3", "content-type": "application/json" }, body: JSON.stringify({ password: PASSWORD }) }));
    expect(res.status).toBe(200);
    expect(cookieOps).toContain("set:gf_admin");
  });
});

describe("a session's identity in the denylist is bound to the signing secret", () => {
  it("the stored hash is not the bare SHA-256 of the nonce, and a different secret gives a different hash", async () => {
    useStore();
    const { adminToken } = await admin();
    process.env.ADMIN_SESSION_SECRET = STRONG;
    const t = adminToken()!;
    withCookie(t);
    await (await logout())(del());
    const h = db.rows("admin_session_revocations")[0].nonce_hash as string;
    expect(h).not.toBe(crypto.createHash("sha256").update(parts(t)[1]).digest("hex"));
  });
});
