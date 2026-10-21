/**
 * Three money-path defects:
 *  1. rotation recorded the old key id in the DB but never revoked it on the engine, yet claimed
 *     revoked_previous: true; cancellation pushed only the live id.
 *  2. a past_due account could still mint/rotate 35-day keys.
 *  3. the Founding Partner credit never ran out and minted a coupon per request.
 * ENGINE here is a stub fetch that records /v1/revoke calls; FAKE STORE is the in-memory PostgREST.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Stripe from "stripe";
import { siteUrl } from "@/lib/site";
import { PostgrestFake } from "./postgrest-fake";

const coupons: unknown[] = [];
const sessions: Record<string, any>[] = [];
vi.mock("stripe", async (orig) => {
  const real = (await orig()) as { default: typeof import("stripe").default };
  const Real = real.default;
  return {
    default: class extends Real {
      constructor(k: string) {
        super(k);
        (this as any).coupons = { create: async (p: unknown) => (coupons.push(p), { id: "coupon_x" }) };
        (this as any).checkout = {
          sessions: { create: async (p: Record<string, any>) => (sessions.push(p), { id: "cs_1", url: "https://checkout.stripe.test/s" }) },
        };
      }
    },
  };
});

const TOKEN = "portal-token";
const WH = "whsec_keys_founding";
let db: PostgrestFake;
let undo: () => void;
let revokeCalls: string[];
let engineStatus = 200;
const realFetch = globalThis.fetch;

const iso = (d: number) => {
  const x = new Date();
  x.setUTCDate(x.getUTCDate() + d);
  return x.toISOString().slice(0, 10);
};
function seed(over: Record<string, unknown> = {}) {
  db.seed("api_accounts", [
    { token: TOKEN, account: "acme", email: "o@a.example", company: "Acme", plan: "api_scale", monthly_units: 2500,
      status: "active", key_id: "oldkey01", key_issued_at: iso(-30), key_expires_at: iso(20), revoked_key_ids: [],
      stripe_subscription_id: "sub_1", ...over },
  ]);
}
const post = (b: unknown) =>
  new Request(siteUrl("/api/keys"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });

beforeEach(() => {
  process.env.GRIDFORGE_LEGACY_DEPOSIT = "1"; // the off-catalogue deposit path is opt-in (QA6-8); these tests exercise it deliberately
  process.env.SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_test";
  process.env.GRIDFORGE_KEY_SECRET = "test-signing-secret";
  process.env.GRIDFORGE_API_URL = "https://engine.test";
  process.env.GRIDFORGE_ADMIN_KEY = "admin";
  process.env.STRIPE_SECRET_KEY = "sk_test_x";
  process.env.STRIPE_WEBHOOK_SECRET = WH;
  delete process.env.RESEND_API_KEY;
  coupons.length = 0;
  sessions.length = 0;
  revokeCalls = [];
  engineStatus = 200;
  db = new PostgrestFake(["api_accounts", "engagement_deposits", "subscriptions", "watches", "leads"]);
  const restoreDb = db.install();
  const dbFetch = globalThis.fetch;
  globalThis.fetch = (async (i: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof i === "string" ? i : i instanceof URL ? i.href : i.url;
    if (url.startsWith("https://engine.test/v1/revoke")) {
      revokeCalls.push(JSON.parse(String(init?.body)).key_id);
      return new Response("{}", { status: engineStatus });
    }
    return dbFetch(i as RequestInfo, init);
  }) as typeof fetch;
  undo = () => { globalThis.fetch = realFetch; restoreDb(); };
});
afterEach(() => undo());

describe("rotation revokes on the engine, honestly", () => {
  it("revokes the old id on the engine and reports it only because the engine confirmed", async () => {
    seed();
    const { POST } = await import("@/app/api/keys/route");
    const body = await (await POST(post({ token: TOKEN, rotate: true }))).json();
    expect(revokeCalls).toEqual(["oldkey01"]);
    expect(body.revoked_previous).toBe(true);
    expect((db.rows("api_accounts")[0] as any).revoked_key_ids).toContain("oldkey01");
  });

  it("does not claim revoked_previous when the engine refuses, and keeps the id for retry", async () => {
    seed();
    engineStatus = 500;
    const { POST } = await import("@/app/api/keys/route");
    const body = await (await POST(post({ token: TOKEN, rotate: true }))).json();
    expect(body.issued).toBe(true);
    expect(body.revoked_previous).toBe(false);
    expect(body.revocation_pending).toBe(true);
    expect((db.rows("api_accounts")[0] as any).revoked_key_ids).toContain("oldkey01");
  });

  it("tracks (without killing) the key an in-window mint overwrites", async () => {
    seed({ key_expires_at: iso(3) });
    const { POST } = await import("@/app/api/keys/route");
    const body = await (await POST(post({ token: TOKEN }))).json();
    expect(body.issued).toBe(true);
    expect(body.revoked_previous).toBe(false);
    expect(revokeCalls).toEqual([]);
    expect((db.rows("api_accounts")[0] as any).revoked_key_ids).toContain("oldkey01");
  });
});

describe("only an active subscription mints", () => {
  it.each(["past_due", "paused", "unpaid"])("refuses %s with 402 and leaves the key alone", async (status) => {
    seed({ status });
    const { POST, GET } = await import("@/app/api/keys/route");
    const res = await POST(post({ token: TOKEN, rotate: true }));
    expect(res.status).toBe(402);
    expect((db.rows("api_accounts")[0] as any).key_id).toBe("oldkey01");
    expect(revokeCalls).toEqual([]);
    expect((await GET(new Request(siteUrl(`/api/keys?token=${TOKEN}`)))).status).toBe(200);
  });
});

describe("cancellation pushes every revoked id plus the live one", () => {
  it("revokes the whole history on the engine", async () => {
    seed({ revoked_key_ids: ["gone0001", "gone0002"] });
    const stripe = new Stripe("sk_test_x");
    const payload = JSON.stringify({ id: "evt_1", type: "customer.subscription.deleted",
      data: { object: { id: "sub_1", object: "subscription", metadata: {} } } });
    const req = new Request(siteUrl("/api/stripe/webhook"), { method: "POST", body: payload,
      headers: { "stripe-signature": stripe.webhooks.generateTestHeaderString({ payload, secret: WH }) } });
    const res = await (await import("@/app/api/stripe/webhook/route")).POST(req);
    expect(res.status).toBe(200);
    expect(revokeCalls.sort()).toEqual(["gone0001", "gone0002", "oldkey01"]);
  });
});

describe("the Founding Partner credit runs out", () => {
  const foundingPaid = (n: number) =>
    db.seed("engagement_deposits", Array.from({ length: n }, (_, i) => ({
      id: `d${i}`, stripe_session_id: `cs_${i}`, kind: "engagement_deposit", amount_cents: 250_000, status: "paid" })));
  const checkout = async () =>
    (await import("@/app/api/checkout/route")).POST(
      new Request(siteUrl("/api/checkout"), { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ founding: true }) }));

  it("grants the credit while slots remain", async () => {
    foundingPaid(4);
    const res = await checkout();
    expect(res.status).toBe(200);
    expect(coupons).toHaveLength(1);
    expect(sessions[0].discounts).toHaveLength(1);
  });

  it("refuses the discount and creates no coupon once all slots are claimed", async () => {
    foundingPaid(5);
    const res = await checkout();
    const body = await res.json();
    expect(body.founding_applied).toBe(false);
    expect(coupons).toHaveLength(0);
    expect(sessions[0].discounts).toEqual([]);
    expect(sessions[0].metadata.founding_applied).toBe("no");
  });

  it("fails closed when the count cannot be read", async () => {
    db.failNext = { status: 503, body: "{}" };
    const res = await checkout();
    expect(res.status).toBe(503);
    expect(coupons).toHaveLength(0);
    expect(sessions).toHaveLength(0);
  });
});
