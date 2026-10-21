/**
 * POST /api/billing/portal: the customer's way to cancel, replace a card and read invoices, through Stripe's hosted Billing Portal.
 * The Stripe client is a MOCK (MockStripe, payg-harness.ts); no live Stripe call is made. What the portal ALLOWS is configured in the Stripe
 * dashboard, which no test here can prove (docs/10_PAYG_LAUNCH_CHECKLIST.md names that as an external dependency).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { siteUrl } from "@/lib/site";
import { setPaygStripeForTests } from "@/lib/payg-stripe";
import { resetMemoryLimiter } from "@/lib/rate-limit";
import { MockStripe, mockEngine, newPaygDb, paygAccount, type MockEngine } from "./payg-harness";
import type { PostgrestFake } from "./postgrest-fake";

let db: PostgrestFake;
let restore: () => void;
let mock: MockStripe;
let engine: MockEngine;

beforeEach(() => {
  Object.assign(process.env, { SUPABASE_URL: "https://stub.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "sb_secret_test", STRIPE_SECRET_KEY: "sk_test_placeholder", RATE_LIMIT_HMAC_KEY: "r".repeat(40) });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  resetMemoryLimiter();
  db = newPaygDb();
  restore = db.install();
  engine = mockEngine();
  mock = new MockStripe();
  setPaygStripeForTests(mock);
});
afterEach(() => { setPaygStripeForTests(null); engine.restore(); restore(); vi.restoreAllMocks(); });

let ipn = 0;
const post = (body: unknown, ip = `10.6.0.${(++ipn % 250) + 1}`) =>
  new Request(siteUrl("/api/billing/portal"), { method: "POST", headers: { "content-type": "application/json", "x-real-ip": ip }, body: JSON.stringify(body) });
const route = () => import("@/app/api/billing/portal/route");
const WATCH = "watch-token-0123456789abcdefghij";
const watch = (over: Record<string, unknown> = {}) => db.insertRow("watches", { token: WATCH, status: "active", email: "w@x.example", stripe_customer_id: "cus_watch", stripe_subscription_id: "sub_w", ...over });

describe("an API or pay-as-you-go account", () => {
  it("opens a Billing Portal session for ITS Stripe customer and answers { ok, url } with a token-free return URL", async () => {
    const a = paygAccount(db);
    const res = await (await route()).POST(post({ token: a.token }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, url: expect.stringMatching(/^https:\/\/billing\.stripe\.test\//) });
    expect(mock.portalSessions).toHaveLength(1);
    expect(mock.portalSessions[0].customer).toBe("cus_acme");
    expect(mock.portalSessions[0].return_url).toMatch(/\/api\/billing\/return$/);
    expect(JSON.stringify(mock.portalSessions)).not.toContain(a.token as string);
    expect(res.headers.get("set-cookie")).toContain(`gf_billing_return=api:${a.token}`);
    expect(res.headers.get("set-cookie")).toMatch(/HttpOnly.*|.*HttpOnly/);
    expect(res.headers.get("set-cookie")).toMatch(/Path=\/api\/billing/);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(mock.calls).toEqual(["billingPortal.sessions.create"]); // nothing else is touched: no cancel, no charge
    expect(a.status).toBe("active"); // this route changes nothing; the webhook applies a cancellation
  });

  it("works for a subscription account, a past_due one and a cancelled one (invoice history outlives the subscription)", async () => {
    const { POST } = await route();
    for (const [i, over] of [[1, { plan: "api_scale", stripe_customer_id: "cus_sub" }], [2, { status: "past_due" }], [3, { status: "cancelled" }]] as const) {
      const a = paygAccount(db, { account: `x${i}`, token: `tok-x${i}-0123456789abcdefghijkl`, ...over });
      expect((await POST(post({ token: a.token }))).status).toBe(200);
    }
    expect(mock.portalSessions.map((s) => s.customer)).toEqual(["cus_sub", "cus_acme", "cus_acme"]);
  });

  it("409 when there is no Stripe customer behind the account (a free account that never added a card), and Stripe is not called", async () => {
    const a = paygAccount(db, { plan: "api_free", stripe_customer_id: null });
    const res = await (await route()).POST(post({ token: a.token }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, reason: "no_customer" });
    expect(mock.calls).toEqual([]);
  });
});

describe("a Hall Watch", () => {
  it("takes the Hall Watch token, uses the watch's customer, and returns to the watch page (never a token in the URL)", async () => {
    watch();
    const res = await (await route()).POST(post({ token: WATCH }));
    expect(res.status).toBe(200);
    expect(mock.portalSessions[0].customer).toBe("cus_watch");
    expect(mock.portalSessions[0].return_url).not.toContain(WATCH);
    expect(res.headers.get("set-cookie")).toContain(`gf_billing_return=watch:${WATCH}`);
  });

  it("409 without a customer", async () => {
    watch({ stripe_customer_id: null });
    expect((await (await route()).POST(post({ token: WATCH }))).status).toBe(409);
  });
});

describe("refusals", () => {
  it("an unknown, empty or malformed token is 404 and calls nothing; the token alone selects the customer (no customer field is read)", async () => {
    paygAccount(db);
    const { POST } = await route();
    for (const body of [{ token: "nope" }, { token: "" }, {}, { token: 5 }, { token: "x".repeat(500) }]) {
      const res = await POST(post(body));
      expect(res.status, JSON.stringify(body).slice(0, 40)).toBe(404);
      expect(await res.json()).toEqual({ ok: false, error: "Unknown account" });
    }
    // someone else's customer cannot be named
    const a = paygAccount(db, { account: "mine", token: "tok-mine-0123456789abcdefghijk", stripe_customer_id: "cus_mine" });
    await POST(post({ token: a.token, customer: "cus_VICTIM", stripe_customer_id: "cus_VICTIM" }));
    expect(mock.portalSessions.map((s) => s.customer)).toEqual(["cus_mine"]);
  });

  it("502 with a plain message (no Stripe text) while the Billing Portal is not configured in the Stripe dashboard; nothing changes", async () => {
    const a = paygAccount(db);
    mock.portalConfigured = false;
    const res = await (await route()).POST(post({ token: a.token }));
    expect(res.status).toBe(502);
    const j = await res.json();
    expect(j).toMatchObject({ ok: false, reason: "portal_unavailable" });
    expect(JSON.stringify(j)).not.toMatch(/configuration|live mode/i);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("503 when Stripe is not configured; 502 when it fails; rate limited like the other account changes", async () => {
    const a = paygAccount(db);
    const { POST } = await route();
    mock.failOnce.add("billingPortal.sessions.create");
    expect((await POST(post({ token: a.token }))).status).toBe(502);
    const out: number[] = [];
    for (let i = 0; i < 32; i++) out.push((await POST(post({ token: a.token }, "203.0.113.60"))).status);
    expect(out.filter((s) => s === 429).length).toBeGreaterThan(0);
    setPaygStripeForTests(null);
    delete process.env.STRIPE_SECRET_KEY;
    resetMemoryLimiter();
    expect((await POST(post({ token: a.token }))).status).toBe(503);
  });
});

describe("GET /api/billing/return", () => {
  const route2 = () => import("@/app/api/billing/return/route");
  const get = (cookie?: string) => new Request(siteUrl("/api/billing/return"), { headers: cookie ? { cookie } : {} });

  it("redirects an API/PAYG customer to their portal page and a Hall Watch customer to their watch page, and clears the cookie", async () => {
    const { GET } = await route2();
    const api = await GET(get("gf_billing_return=api:api-token-0123456789abcdefghij"));
    expect(api.status).toBe(303);
    expect(api.headers.get("location")).toBe(siteUrl("/api-access/api-token-0123456789abcdefghij?billing=returned"));
    expect(api.headers.get("set-cookie")).toMatch(/gf_billing_return=;.*Max-Age=0/);
    const w = await GET(get(`gf_billing_return=watch:${WATCH}`));
    expect(w.headers.get("location")).toBe(siteUrl(`/watch/${WATCH}?billing=returned`));
  });

  it("without a usable cookie it shows a page that says to open the emailed link, and never redirects", async () => {
    const { GET } = await route2();
    for (const cookie of [undefined, "gf_billing_return=api:short", "gf_billing_return=evil:abcdefghijklmnopqrstuvwxyz", "gf_billing_return=api:../../evil/abcdefghij", "gf_billing_return=https://evil.example/xyz"]) {
      const res = await GET(get(cookie));
      expect(res.status, String(cookie)).toBe(200);
      expect(res.headers.get("location")).toBeNull();
      expect(await res.text()).toMatch(/open the link in the email/i);
    }
  });
});
