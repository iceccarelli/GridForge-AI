/**
 * POST /api/billing/portal { account: "intelligence" }: the way a GridForge Intelligence subscriber manages or cancels their subscription.
 *
 * The sales page promises that a subscription can be cancelled, so the signed-in owner must be able to do it. The route opens Stripe's hosted
 * Billing Portal for the customer on the OWNER'S OWN subscription row. Real routes, the real subscription store layer (an in-memory PostgREST
 * fake with the team functions), the real identity check (Supabase Auth's /auth/v1/user is a stand-in, auth-fake.ts) and a MOCK Stripe client
 * (MockStripe, payg-harness.ts): no live Stripe or Supabase call is made. What the portal ALLOWS (cancelling, and whether at once or at the
 * end of the paid period) is configured in the Stripe dashboard, which no test here can prove.
 *
 * The properties:
 *   - the owner gets a portal URL for THEIR subscription's customer, never cached;
 *   - a seat member is 403, a stranger 402, no session 401, an unconfirmed address 403, and Stripe is not called in any of those;
 *   - the customer id is read from the server-side row: nothing in the request can name one;
 *   - when the portal cannot be opened the answer names the next step (write to the contact address);
 *   - the same request limit as the token branch; and the token branch itself is unchanged and never reads the session.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SITE, siteUrl } from "@/lib/site";
import { setPaygStripeForTests } from "@/lib/payg-stripe";
import { resetMemoryLimiter } from "@/lib/rate-limit";
import { resetIdentityCache } from "@/lib/portal";
import { INTELLIGENCE_PORTAL_REQUEST, INTELLIGENCE_PORTAL_RETURN_PATH } from "@/lib/subscription-manage";
import { MockStripe, newPaygDb, paygAccount } from "./payg-harness";
import { installTeamRpcs } from "./team-rpc-fake";
import { bearerFor, installWithAuth, junkJwt, unconfirmedBearerFor } from "./auth-fake";
import type { PostgrestFake } from "./postgrest-fake";

let db: PostgrestFake;
let restore: () => void;
let authCalls: () => number;
let mock: MockStripe;

const OWNER = "owner@team.example";
const SEAT = "seat@team.example";
const STRANGER = "stranger@else.example";

beforeEach(() => {
  Object.assign(process.env, { SUPABASE_URL: "https://stub.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "sb_secret_test", STRIPE_SECRET_KEY: "sk_test_placeholder", RATE_LIMIT_HMAC_KEY: "r".repeat(40) });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  resetMemoryLimiter();
  resetIdentityCache();
  db = newPaygDb();
  installTeamRpcs(db);
  const wired = installWithAuth(db);
  restore = wired.restore;
  authCalls = wired.authCalls;
  mock = new MockStripe();
  setPaygStripeForTests(mock);
});
afterEach(() => {
  setPaygStripeForTests(null);
  restore();
  vi.restoreAllMocks();
});

let ipn = 0;
const post = (body: unknown, headers: Record<string, string> = {}, ip = `10.7.0.${(++ipn % 250) + 1}`) =>
  new Request(siteUrl("/api/billing/portal"), { method: "POST", headers: { "content-type": "application/json", "x-real-ip": ip, ...headers }, body: JSON.stringify(body) });
const route = () => import("@/app/api/billing/portal/route");
const ask = async (headers: Record<string, string>, body: unknown = INTELLIGENCE_PORTAL_REQUEST) => (await route()).POST(post(body, headers));

const subscription = (over: Record<string, unknown> = {}) =>
  db.insertRow("subscriptions", { email: OWNER, plan: "team", status: "active", stripe_customer_id: "cus_owner", stripe_subscription_id: "sub_owner", stripe_session_id: "cs_owner", ...over });
const seat = (email = SEAT) => db.insertRow("subscription_members", { owner_email: OWNER, email, added_at: new Date().toISOString(), removed_at: null });

describe("the billing owner", () => {
  it("gets a Billing Portal URL for THEIR subscription's customer, returning to the account page, and the answer is never cached", async () => {
    subscription();
    const res = await ask(bearerFor(OWNER));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, url: expect.stringMatching(/^https:\/\/billing\.stripe\.test\//) });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(mock.portalSessions).toHaveLength(1);
    expect(mock.portalSessions[0].customer).toBe("cus_owner");
    expect(mock.portalSessions[0].return_url).toBe(siteUrl(INTELLIGENCE_PORTAL_RETURN_PATH));
    // The return address carries nothing that identifies the account, and no cookie is needed to come back (the browser's session does it).
    expect(mock.portalSessions[0].return_url).not.toMatch(/token|cus_|@/);
    expect(res.headers.get("set-cookie")).toBeNull();
    // The session was verified with Supabase Auth, and nothing but the portal session was created: no cancel, no charge.
    expect(authCalls()).toBeGreaterThan(0);
    expect(mock.calls).toEqual(["billingPortal.sessions.create"]);
    // Opening the portal changes nothing here: the webhook applies a cancellation.
    expect(db.rows("subscriptions")[0].status).toBe("active");
  });

  it("can still open it when a payment has failed (past_due): that is when they need to replace the card or cancel", async () => {
    subscription({ status: "past_due" });
    const res = await ask(bearerFor(OWNER));
    expect(res.status).toBe(200);
    expect(mock.portalSessions.map((s) => s.customer)).toEqual(["cus_owner"]);
  });

  it("uses the customer on the server-side row: no customer, email, plan or token in the request is honoured", async () => {
    subscription();
    db.insertRow("subscriptions", { email: "victim@else.example", plan: "team", status: "active", stripe_customer_id: "cus_VICTIM", stripe_subscription_id: "sub_v", stripe_session_id: "cs_v" });
    const apiAccount = paygAccount(db, { stripe_customer_id: "cus_api_victim" });
    const res = await ask(bearerFor(OWNER), {
      ...INTELLIGENCE_PORTAL_REQUEST,
      customer: "cus_VICTIM", stripe_customer_id: "cus_VICTIM", customer_id: "cus_VICTIM", email: "victim@else.example", plan: "enterprise", token: apiAccount.token,
    });
    expect(res.status).toBe(200);
    expect(mock.portalSessions.map((s) => s.customer)).toEqual(["cus_owner"]);
  });

  it("the customer is the one on the CALLER's subscription, whoever else has one", async () => {
    subscription();
    db.insertRow("subscriptions", { email: "other-owner@else.example", plan: "developer", status: "active", stripe_customer_id: "cus_other", stripe_subscription_id: "sub_o", stripe_session_id: "cs_o" });
    expect((await ask(bearerFor("other-owner@else.example"))).status).toBe(200);
    expect((await ask(bearerFor(OWNER))).status).toBe(200);
    expect(mock.portalSessions.map((s) => s.customer)).toEqual(["cus_other", "cus_owner"]);
  });
});

describe("everyone else", () => {
  it("no session at all: 401, never cached, Supabase and Stripe are not asked", async () => {
    subscription();
    const res = await ask({});
    expect(res.status).toBe(401);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toMatchObject({ ok: false, error: expect.stringMatching(/sign in/i) });
    expect(authCalls()).toBe(0);
    expect(mock.calls).toEqual([]);
  });

  it("a forged or expired session: 401, and Stripe is not called", async () => {
    subscription();
    for (const headers of [{ authorization: "Bearer not-a-jwt" }, { authorization: `Bearer ${junkJwt(1)}` }]) {
      const res = await ask(headers);
      expect(res.status, JSON.stringify(headers)).toBe(401);
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
    expect(mock.calls).toEqual([]);
  });

  it("an address Supabase has not confirmed: 403, and Stripe is not called", async () => {
    subscription();
    const res = await ask(unconfirmedBearerFor(OWNER));
    expect(res.status).toBe(403);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(mock.calls).toEqual([]);
  });

  it("a signed-in person with no subscription: 402, and Stripe is not called", async () => {
    subscription();
    const res = await ask(bearerFor(STRANGER));
    expect(res.status).toBe(402);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(mock.calls).toEqual([]);
  });

  it("a subscription that has ended offers nothing to manage: 402", async () => {
    subscription({ status: "cancelled" });
    expect((await ask(bearerFor(OWNER))).status).toBe(402);
    expect(mock.calls).toEqual([]);
  });

  it("a SEAT MEMBER is 403, told the owner manages billing, and Stripe is not called", async () => {
    subscription();
    seat();
    const res = await ask(bearerFor(SEAT));
    expect(res.status).toBe(403);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const j = await res.json();
    expect(j).toMatchObject({ ok: false, error: expect.stringMatching(/only the billing owner can manage billing or cancel/i) });
    expect(JSON.stringify(j)).not.toMatch(/seats/); // it is not the seat-management refusal
    expect(JSON.stringify(j)).not.toContain("cus_owner");
    expect(mock.calls).toEqual([]);
  });

  it("a seat member cannot borrow the owner's identity or customer by naming them", async () => {
    subscription();
    seat();
    const res = await ask(bearerFor(SEAT), { ...INTELLIGENCE_PORTAL_REQUEST, email: OWNER, customer: "cus_owner", stripe_customer_id: "cus_owner" });
    expect(res.status).toBe(403);
    expect(mock.calls).toEqual([]);
  });
});

describe("when the portal cannot be opened, the answer says what to do next", () => {
  const next = `write to ${SITE.email}`;

  it("no Stripe customer on the row: 409, reason no_customer, names the contact address, Stripe is not called", async () => {
    subscription({ stripe_customer_id: null });
    const res = await ask(bearerFor(OWNER));
    expect(res.status).toBe(409);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const j = await res.json();
    expect(j).toMatchObject({ ok: false, reason: "no_customer" });
    expect(j.error).toContain("not available right now");
    expect(j.error).toContain(next);
    expect(mock.calls).toEqual([]);
  });

  it("the Billing Portal not configured in the Stripe dashboard: 502 with a plain message and the contact address, no Stripe text", async () => {
    subscription();
    mock.portalConfigured = false;
    const res = await ask(bearerFor(OWNER));
    expect(res.status).toBe(502);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("set-cookie")).toBeNull();
    const j = await res.json();
    expect(j).toMatchObject({ ok: false, reason: "portal_unavailable" });
    expect(j.error).toContain(next);
    expect(JSON.stringify(j)).not.toMatch(/configuration|live mode|StripeInvalid/i);
  });

  it("Stripe failing: 502, the same wording", async () => {
    subscription();
    mock.failOnce.add("billingPortal.sessions.create");
    const res = await ask(bearerFor(OWNER));
    expect(res.status).toBe(502);
    expect((await res.json()).error).toContain(next);
  });

  it("Stripe not configured on this deployment: 503 naming the contact address", async () => {
    subscription();
    setPaygStripeForTests(null);
    delete process.env.STRIPE_SECRET_KEY;
    const res = await ask(bearerFor(OWNER));
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect((await res.json()).error).toContain(next);
  });

  it("the subscription store not configured: 503 naming the contact address, not a claim about the customer", async () => {
    subscription();
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const res = await ask(bearerFor(OWNER));
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect((await res.json()).error).toContain(next);
    expect(mock.calls).toEqual([]);
  });
});

describe("the request limit", () => {
  it("is the same hourly limit as the token branch and the other account changes, and a 429 is never cached", async () => {
    subscription();
    const { POST } = await route();
    const out: number[] = [];
    let limited: Response | null = null;
    for (let i = 0; i < 32; i++) {
      const res = await POST(post(INTELLIGENCE_PORTAL_REQUEST, bearerFor(OWNER), "203.0.113.77"));
      out.push(res.status);
      if (res.status === 429) limited ??= res;
    }
    expect(out.filter((s) => s === 429).length).toBeGreaterThan(0);
    expect(out.filter((s) => s === 200).length).toBe(30); // payg_manage: 30 an hour per caller address
    expect(limited!.headers.get("cache-control")).toBe("no-store");
    expect(limited!.headers.get("retry-after")).toBeTruthy();
    expect(mock.portalSessions).toHaveLength(30);
  });
});

describe("the token branch is unchanged, and the two never mix", () => {
  it("an API portal token without { account } still opens that account's customer, returns via the cookie route, and never reads the session", async () => {
    const a = paygAccount(db);
    subscription();
    const res = await ask(bearerFor(OWNER), { token: a.token });
    expect(res.status).toBe(200);
    expect(mock.portalSessions[0].customer).toBe("cus_acme");
    expect(mock.portalSessions[0].return_url).toMatch(/\/api\/billing\/return$/);
    expect(res.headers.get("set-cookie")).toContain(`gf_billing_return=api:${a.token}`);
    expect(authCalls()).toBe(0);
  });

  it("a portal token cannot stand in for the session on the Intelligence branch: 401, Stripe is not called", async () => {
    const a = paygAccount(db);
    subscription();
    const res = await ask({}, { ...INTELLIGENCE_PORTAL_REQUEST, token: a.token });
    expect(res.status).toBe(401);
    expect(mock.calls).toEqual([]);
  });

  it("any other { account } value is just a token request: unknown account, 404", async () => {
    subscription();
    const res = await ask(bearerFor(OWNER), { account: "api" });
    expect(res.status).toBe(404);
    expect(mock.calls).toEqual([]);
  });
});
