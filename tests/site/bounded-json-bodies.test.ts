/**
 * Every open JSON route reads its body through the bounded reader (lib/http-body.ts), and POST /api/scenarios has an admission limit and a
 * per-subscriber row cap.
 *
 * `await req.json()` buffers whatever the caller sends. Five routes did it (checkout, subscribe, the follow-up, keys, scenarios): an
 * anonymous caller could make a serverless function hold a body of any size before the route had decided whether to look at it. Each
 * now refuses a body over its cap with 413, before anything else is read or spent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { siteUrl } from "@/lib/site";
import { RATE_POLICIES, resetMemoryLimiter } from "@/lib/rate-limit";
import { PostgrestFake } from "./postgrest-fake";
import { bearerFor, installWithAuth } from "./auth-fake";

const sessions: Record<string, unknown>[] = [];
vi.mock("stripe", () => ({
  default: class {
    coupons = { create: async () => ({ id: "coupon_test" }) };
    checkout = { sessions: { create: async (p: Record<string, unknown>) => { sessions.push(p); return { url: "https://checkout.stripe.test/session" }; } } };
  },
}));

const BIG = "x".repeat(300_000);
const json = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(siteUrl(path), { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

let db: PostgrestFake;
let restore: () => void;

beforeEach(() => {
  resetMemoryLimiter();
  sessions.length = 0;
  process.env.SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_test";
  process.env.STRIPE_SECRET_KEY = "sk_test_bounded";
  process.env.GRIDFORGE_KEY_SECRET = "test-signing-secret";
  delete process.env.VERCEL;
  delete process.env.GRIDFORGE_TRUSTED_IP_HEADER;
  db = new PostgrestFake(["subscriptions", "scenarios", "api_accounts", "qualifications", "leads"]);
  restore = installWithAuth(db).restore;
  for (const m of ["log", "info", "warn", "error"] as const) vi.spyOn(console, m).mockImplementation(() => {});
});
afterEach(() => {
  restore();
  vi.restoreAllMocks();
  delete process.env.STRIPE_SECRET_KEY;
});

describe("an oversized body is refused with 413 before the route does anything with it", () => {
  it("POST /api/checkout", async () => {
    const { POST } = await import("@/app/api/checkout/route");
    const res = await POST(json("/api/checkout", { product: "density_screen", company: BIG }));
    expect(res.status).toBe(413);
    expect(sessions).toHaveLength(0);
    // The same body with a small company is a normal request (the cap is on size, not on shape).
    const ok = await POST(json("/api/checkout", { product: "density_screen", company: "Acme" }));
    expect(ok.status).toBe(200);
  });

  it("POST /api/checkout, when Stripe is not configured, still answers 503 without buffering the body", async () => {
    delete process.env.STRIPE_SECRET_KEY;
    const { POST } = await import("@/app/api/checkout/route");
    const res = await POST(json("/api/checkout", { product: "density_screen", company: BIG }));
    expect(res.status).toBe(503);
  });

  it("POST /api/subscribe", async () => {
    const { POST } = await import("@/app/api/subscribe/route");
    const res = await POST(json("/api/subscribe", { plan: "team", email: BIG }));
    expect(res.status).toBe(413);
    expect(sessions).toHaveLength(0);
  });

  it("POST /api/qualify/[token]/follow-up", async () => {
    db.seed("qualifications", [{ token: "tok_a", site_name: "N", hall_id: "H", racks_as_found: 3, binding_constraint: "Transformer", status: "scored", follow_up_requested_at: null }]);
    const { POST } = await import("@/app/api/qualify/[token]/follow-up/route");
    const res = await POST(json("/api/qualify/tok_a/follow-up", { email: "a@b.example", note: BIG }), { params: Promise.resolve({ token: "tok_a" }) });
    expect(res.status).toBe(413);
    expect((db.rows("qualifications")[0] as Record<string, unknown>).follow_up_requested_at).toBeNull();
  });

  it("POST /api/keys", async () => {
    const { POST } = await import("@/app/api/keys/route");
    const res = await POST(json("/api/keys", { token: "portal-token", rotate: false, pad: BIG }));
    expect(res.status).toBe(413);
  });

  it("POST /api/keys with no body at all is still read as empty (the Authorization header names the account)", async () => {
    const { POST } = await import("@/app/api/keys/route");
    const res = await POST(new Request(siteUrl("/api/keys"), { method: "POST", headers: { authorization: "Bearer portal-token-unknown" } }));
    expect(res.status).toBe(404); // "Unknown account": it got as far as looking the account up
  });

  it("POST /api/scenarios", async () => {
    db.seed("subscriptions", [{ email: "ops@northhall.example", plan: "team", status: "active", created_at: "2026-01-01T00:00:00Z" }]);
    const { POST } = await import("@/app/api/scenarios/route");
    const res = await POST(json("/api/scenarios", { name: BIG, mw: 5 }, bearerFor("ops@northhall.example")));
    expect(res.status).toBe(413);
    expect(db.rows("scenarios")).toHaveLength(0);
  });
});

describe("no listed route reads its body with an unbounded req.json()", () => {
  it("scans the five route files", () => {
    for (const f of ["app/api/checkout/route.ts", "app/api/subscribe/route.ts", "app/api/qualify/[token]/follow-up/route.ts", "app/api/keys/route.ts", "app/api/scenarios/route.ts"]) {
      const src = fs.readFileSync(path.join(process.cwd(), f), "utf8");
      expect(src, `${f} reads its body with req.json()`).not.toMatch(/\breq(uest)?\.json\(\)/);
      expect(src, `${f} does not use the bounded reader`).toContain("readBoundedJson");
    }
  });
});

describe("POST /api/scenarios: admission and a row cap", () => {
  const SUBSCRIBER = "ops@northhall.example";
  const OTHER = "someone.else@rival.example";
  const save = (as = SUBSCRIBER, name = "Hall") => json("/api/scenarios", { name, mw: 5, regionId: "ie", valuePerMwMonth: 1000, monthsSaved: 2, avoidedEur: 10_000 }, bearerFor(as));

  beforeEach(() => {
    db.seed("subscriptions", [
      { email: SUBSCRIBER, plan: "team", status: "active", created_at: "2026-01-01T00:00:00Z" },
      { email: OTHER, plan: "team", status: "active", created_at: "2026-01-01T00:00:00Z" },
    ]);
  });

  it("is admitted per verified account: past the limit it answers 429 and saves nothing more", async () => {
    const { POST } = await import("@/app/api/scenarios/route");
    const limit = RATE_POLICIES.scenario_save.limit;
    expect(limit).toBeLessThan(100); // the limit bites before the row cap does, so each is tested on its own below
    for (let i = 0; i < limit; i++) expect((await POST(save())).status).toBe(200);
    const before = db.rows("scenarios").length;
    const res = await POST(save());
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect(db.rows("scenarios")).toHaveLength(before);
    // Another subscriber is unaffected (the allowance is per verified account, not per address).
    expect((await POST(save(OTHER))).status).toBe(200);
  });

  it("an unauthenticated or non-subscriber request costs no allowance", async () => {
    const { POST } = await import("@/app/api/scenarios/route");
    const limit = RATE_POLICIES.scenario_save.limit;
    db.seed("subscriptions", [{ email: "free@nobody.example", plan: "x", status: "cancelled", created_at: "2026-01-01T00:00:00Z" }]);
    for (let i = 0; i < limit + 3; i++) expect((await POST(save("free@nobody.example"))).status).toBe(402);
    expect((await POST(save())).status).toBe(200);
  });

  it("refuses the save past the per-subscriber cap with a clear 409, and counts only that subscriber's rows", async () => {
    const { POST, DELETE } = await import("@/app/api/scenarios/route");
    const { MAX_SCENARIOS_PER_SUBSCRIBER: CAP } = await import("@/lib/scenario-limits");
    db.seed("scenarios", [
      ...Array.from({ length: CAP }, (_, i) => ({ id: `mine-${i}`, email: SUBSCRIBER, name: `Mine ${i}`, avoided_eur: 1, created_at: "2026-01-01T00:00:00Z" })),
      ...Array.from({ length: 5 }, (_, i) => ({ id: `theirs-${i}`, email: OTHER, name: `Theirs ${i}`, avoided_eur: 1, created_at: "2026-01-01T00:00:00Z" })),
    ]);
    const res = await POST(save());
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(String(body.error)).toMatch(new RegExp(`${CAP}`));
    expect(String(body.error)).toMatch(/delete/i);
    expect(db.rows("scenarios").filter((r) => r.email === SUBSCRIBER)).toHaveLength(CAP);
    // Another subscriber with only five rows saves normally.
    expect((await POST(save(OTHER))).status).toBe(200);
    // Deleting one makes room for one.
    expect((await DELETE(new Request(siteUrl("/api/scenarios?id=mine-0"), { method: "DELETE", headers: bearerFor(SUBSCRIBER) }))).status).toBe(200);
    expect((await POST(save())).status).toBe(200);
    expect((await POST(save())).status).toBe(409);
  });
});
