/**
 * Red-team findings F10, F11 and F12. Each test fails on the code before the fix.
 *
 *   F10  the rate limiter keyed IPv6 callers by the full /128, so one /64 was 2^64 callers with a fresh allowance each
 *   F11  the admin login throttle trusted the FIRST x-forwarded-for entry (the one a client writes), and the session HMAC
 *        key was the raw ADMIN_PASSWORD
 *   F12  /api/engagements handed out document/intake/watch tokens, and /api/subscription-status the plan and the seat
 *        owner, to any Supabase session that merely claimed an email address
 */
import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { siteUrl } from "@/lib/site";
import { RATE_POLICIES, callerIdentity, guardRequest, resetMemoryLimiter, subjectOf } from "@/lib/rate-limit";
import { PostgrestFake } from "./postgrest-fake";
import { bearerFor, installWithAuth, unconfirmedBearerFor } from "./auth-fake";

function reqFrom(forwarded: string, extra: Record<string, string> = {}) {
  return new Request(siteUrl("/api/x"), { method: "POST", headers: { "x-forwarded-for": forwarded, ...extra } });
}
const subjectFor = (forwarded: string) => {
  const who = callerIdentity(reqFrom(forwarded));
  if (!who.ok) throw new Error(who.reason);
  return who.subject;
};

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
});

// ---------------------------------------------------------------------------------------------------------------------
describe("F10: IPv6 callers are bucketed by /64", () => {
  it("every /128 inside one /64 is the same caller; another /64 is another caller", () => {
    const a = subjectFor("2001:db8:abcd:12::1");
    expect(subjectFor("2001:db8:abcd:12::2")).toBe(a);
    expect(subjectFor("2001:db8:abcd:12:ffff:ffff:ffff:ffff")).toBe(a);
    expect(subjectFor("2001:0DB8:ABCD:0012:0:0:0:9")).toBe(a); // spelling and case do not matter
    expect(subjectFor("2001:db8:abcd:13::1")).not.toBe(a);
    expect(subjectFor("2001:db8:abce:12::1")).not.toBe(a);
  });

  it("a zone id does not make a new caller", () => {
    expect(subjectFor("fe80::1%eth0")).toBe(subjectFor("fe80::2"));
    expect(subjectFor("fe80::1%eth0")).toBe(subjectFor("fe80::1%wlan1"));
  });

  it("an IPv4-mapped IPv6 address is the IPv4 caller it wraps, and IPv4 is keyed exactly as before", () => {
    const v4 = subjectFor("203.0.113.77");
    expect(v4).toBe(subjectOf("203.0.113.77"));
    expect(subjectFor("::ffff:203.0.113.77")).toBe(v4);
    expect(subjectFor("::ffff:cb00:714d")).toBe(v4); // the same address in hex groups
    expect(subjectFor("::ffff:203.0.113.78")).not.toBe(v4);
  });

  it("the last x-forwarded-for entry still decides, and a malformed address is not an address", () => {
    expect(subjectFor("2001:db8::99, 2001:db8:1:2::5")).toBe(subjectFor("2001:db8:1:2::6"));
    const bad = callerIdentity(reqFrom("2001:db8:::1"));
    expect(bad.ok && bad.subject).toBe(subjectOf("unattributed"));
  });

  it("an attacker rotating addresses inside their /64 shares one allowance on a real route policy", async () => {
    const limit = RATE_POLICIES.audit.limit;
    const hostIn64 = (i: number) => `2001:db8:feed:beef:${(i + 1).toString(16)}::${(i * 7 + 1).toString(16)}`;
    for (let i = 0; i < limit; i++) {
      const g = await guardRequest(reqFrom(hostIn64(i)), "audit");
      expect(g.denied, `request ${i + 1}`).toBeNull();
    }
    const over = await guardRequest(reqFrom(hostIn64(limit)), "audit");
    expect(over.denied?.status).toBe(429);
    // A caller in a different /64 is unaffected.
    expect((await guardRequest(reqFrom("2001:db8:feed:cafe::1"), "audit")).denied).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("F11: admin login throttle identity and session key", () => {
  const PASSWORD = "a-long-random-admin-password";
  const admin = () => import("@/lib/admin");

  beforeEach(async () => {
    process.env.ADMIN_PASSWORD = PASSWORD;
    delete process.env.ADMIN_SESSION_SECRET;
    const a = await admin();
    a.resetLoginThrottle();
    a.resetAdminSecretWarning();
  });
  afterEach(() => {
    delete process.env.ADMIN_PASSWORD;
    delete process.env.ADMIN_SESSION_SECRET;
  });

  it("a client-written first x-forwarded-for hop buys no fresh identity: the throttle keys on the proxy-appended last entry", async () => {
    const { requestKey, throttleLogin } = await admin();
    const REAL = "203.0.113.10";
    const waits: number[] = [];
    for (let i = 0; i < 9; i++) waits.push(throttleLogin(requestKey(reqFrom(`198.51.100.${i + 1}, ${REAL}`))));
    expect(waits.slice(0, 8).every((w) => w === 0)).toBe(true);
    expect(waits[8]).toBeGreaterThan(0); // the 9th guess from the same real address, whatever it claimed to be, is throttled
    expect(requestKey(reqFrom(`198.51.100.99, ${REAL}`))).toBe(requestKey(reqFrom(REAL)));
    expect(requestKey(reqFrom(REAL))).toBe(subjectFor(REAL)); // the rate limiter's own identity, not an address
  });

  it("honours the deployment's declared proxy header, and on a production build with none declared shares one key", async () => {
    const { requestKey } = await admin();
    vi.stubEnv("GRIDFORGE_TRUSTED_IP_HEADER", "fly-client-ip");
    expect(requestKey(reqFrom("1.1.1.1", { "fly-client-ip": "203.0.113.5" }))).toBe(subjectOf("203.0.113.5"));
    vi.unstubAllEnvs();
    vi.stubEnv("NODE_ENV", "production");
    const k1 = requestKey(reqFrom("1.1.1.1"));
    const k2 = requestKey(reqFrom("2.2.2.2"));
    expect(k1).toBe(k2);
    expect(k1).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
  });

  it("IPv6 attempts from one /64 share one throttle", async () => {
    const { requestKey, throttleLogin } = await admin();
    for (let i = 0; i < 8; i++) expect(throttleLogin(requestKey(reqFrom(`2001:db8:aa:bb::${i + 1}`)))).toBe(0);
    expect(throttleLogin(requestKey(reqFrom("2001:db8:aa:bb:1:2:3:4")))).toBeGreaterThan(0);
  });

  const forge = (secret: string | Buffer) => {
    const payload = `${Date.now() + 60_000}.deadbeefdeadbeef`;
    return `${payload}.${crypto.createHmac("sha256", secret).update(payload).digest("hex")}`;
  };

  it("without ADMIN_SESSION_SECRET the signing key is derived, never the raw password: a cookie signed with the password is refused", async () => {
    const { adminToken, verifyAdminCookie } = await admin();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const token = adminToken();
    expect(token).toBeTruthy();
    expect(verifyAdminCookie(token!)).toBe(true); // keeps working
    expect(verifyAdminCookie(forge(PASSWORD))).toBe(false);
  });

  it("warns once per process that the key is derived, and never prints the password", async () => {
    const { adminToken, verifyAdminCookie } = await admin();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    adminToken();
    adminToken();
    verifyAdminCookie("1.2.3");
    expect(warn).toHaveBeenCalledTimes(1);
    const text = String(warn.mock.calls[0].join(" "));
    expect(text).toContain("ADMIN_SESSION_SECRET");
    expect(text).not.toContain(PASSWORD);
  });

  it("with ADMIN_SESSION_SECRET set, that secret alone signs: no warning, and the password has no part in it", async () => {
    const SECRET = "s".repeat(40);
    process.env.ADMIN_SESSION_SECRET = SECRET;
    const { adminToken, verifyAdminCookie } = await admin();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const token = adminToken()!;
    expect(verifyAdminCookie(token)).toBe(true);
    expect(verifyAdminCookie(forge(SECRET))).toBe(true);
    expect(verifyAdminCookie(forge(PASSWORD))).toBe(false);
    process.env.ADMIN_PASSWORD = "a-different-password-entirely";
    expect(verifyAdminCookie(token)).toBe(true); // rotating the password no longer logs the session out
    expect(warn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("F12: token-bearing portal answers need a verified identity", () => {
  const EMAIL = "buyer@acme.example";
  let db: PostgrestFake;
  let restore: () => void;

  beforeEach(() => {
    process.env.SUPABASE_URL = "https://stub.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_test";
    db = new PostgrestFake(["deliverables", "watches", "subscriptions", "subscription_seats"]);
    db.seed("deliverables", [
      { email: EMAIL, token: "doc_token_released", intake_token: "intake_a", kind: "density_screen", status: "released", title: "North Hall", amount_cents: 450000, created_at: "2026-01-02T00:00:00Z", released_at: "2026-01-09T00:00:00Z" },
      { email: EMAIL, token: "doc_token_waiting", intake_token: "intake_waiting", kind: "density_screen", status: "awaiting_intake", title: null, amount_cents: 450000, created_at: "2026-01-03T00:00:00Z", released_at: null },
    ]);
    db.seed("watches", [
      { email: EMAIL, token: "watch_token_1", status: "active", cadence: "weekly", site_name: "North Hall", hall_id: "H1", created_at: "2026-01-04T00:00:00Z", last_run_at: null, next_run_at: null },
    ]);
    restore = installWithAuth(db).restore;
  });
  afterEach(() => restore());

  const get = (headers: Record<string, string>) =>
    import("@/app/api/engagements/route").then(({ GET }) => GET(new Request(siteUrl("/api/engagements"), { headers })));

  it("a verified identity gets its tokens (the portal keeps working)", async () => {
    const body = await (await get(bearerFor(EMAIL))).json();
    expect(body.verified).toBe(true);
    expect(body.engagements.map((e: any) => [e.status, e.documentToken, e.intakeToken])).toEqual(
      expect.arrayContaining([["released", "doc_token_released", null], ["awaiting_intake", null, "intake_waiting"]]),
    );
    expect(body.watches[0].token).toBe("watch_token_1");
  });

  it("a session that only claims the address gets the degraded list: no document, intake or watch token anywhere", async () => {
    const res = await get(unconfirmedBearerFor(EMAIL));
    expect(res.status).toBe(200);
    const text = await res.text();
    const body = JSON.parse(text);
    expect(body.ok).toBe(true);
    expect(body.verified).toBe(false);
    expect(body.engagements).toHaveLength(2);
    for (const e of body.engagements) expect([e.documentToken, e.intakeToken]).toEqual([null, null]);
    expect(body.watches.every((w: any) => w.token === null)).toBe(true);
    for (const secret of ["doc_token_released", "doc_token_waiting", "intake_a", "intake_waiting", "watch_token_1"]) {
      expect(text).not.toContain(secret);
    }
  });

  it("no session at all is still a 401", async () => {
    expect((await get({})).status).toBe(401);
  });

  it("/api/subscription-status tells an unverified claim nothing: not the plan, not the seat owner", async () => {
    db.seed("subscriptions", [{ email: EMAIL, plan: "enterprise", status: "active", created_at: "2026-01-01T00:00:00Z" }]);
    const { POST } = await import("@/app/api/subscription-status/route");
    const ask = (headers: Record<string, string>) =>
      POST(new Request(siteUrl("/api/subscription-status"), { method: "POST", headers: { "content-type": "application/json", ...headers }, body: "{}" }));
    const claimed = await (await ask(unconfirmedBearerFor(EMAIL))).json();
    expect(claimed).toEqual({ ok: true, active: false, verified: false });
    const real = await (await ask(bearerFor(EMAIL))).json();
    expect(real).toMatchObject({ ok: true, active: true, plan: "enterprise" });
  });
});
