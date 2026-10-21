/**
 * Red-team F5: checkout trusted a client-supplied customer_email, and recordSubscription then marked ALL entitling subscriptions
 * for that email `superseded`: a stranger could pay for the cheapest plan with a victim's address and strip the victim's seats.
 *
 * Fixed in two places, each proven here:
 *   - /api/subscribe never takes the email from the request body (only a verified signed-in session names one, and an existing Stripe
 *     customer is reused so an upgrade is the same payer);
 *   - the webhook entitles a NEW purchase over an existing entitling subscription only when it is the same Stripe customer; any other
 *     payer's purchase is recorded as superseded (entitles nothing), leaves the victim's subscription and seats alone, and tells the
 *     operator.
 * Stripe SDK calls are mocked for the checkout; webhook signatures are generated for real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Stripe from "stripe";
import { siteUrl } from "@/lib/site";
import { PostgrestFake } from "./postgrest-fake";
import { bearerFor, installWithAuth, unconfirmedBearerFor } from "./auth-fake";

const sessions: Record<string, any>[] = [];
vi.mock("stripe", async (orig) => {
  const real = (await orig()) as { default: typeof Stripe };
  return {
    default: class extends real.default {
      constructor(key: string) {
        super(key);
        (this as any).checkout = { sessions: { create: async (p: Record<string, any>) => (sessions.push(p), { url: "https://checkout.stripe.test/s" }) } };
      }
    },
  };
});

const WH = "whsec_f5_test";
let db: PostgrestFake;
let undo: () => void;
let mail: { to: string; subject: string; text: string }[];
const sdk = new Stripe("sk_test_placeholder");

beforeEach(() => {
  Object.assign(process.env, {
    SUPABASE_URL: "https://stub.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "sb_secret_test", STRIPE_SECRET_KEY: "sk_test_placeholder", STRIPE_WEBHOOK_SECRET: WH,
    RESEND_API_KEY: "re_test", LEAD_TO_EMAIL: "ops@example.test", LEAD_FROM_EMAIL: "Time to Power <power@timetopower.ai>",
  });
  sessions.length = 0;
  mail = [];
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  db = new PostgrestFake(["subscriptions", "subscription_members", "subscription_invitations", "customer_notifications", "api_accounts", "watches", "watch_notes", "leads", "deliverables"]);
  db.uniqueKeys.set("customer_notifications", [["dedupe_key"]]);
  db.rowDefaults.set("customer_notifications", () => ({ status: "pending", attempts: 0, max_attempts: 6, next_attempt_at: new Date(0).toISOString(), claimed_until: null, last_error: null, accepted_at: null, origin: "webhook", reopened_count: 0 }));
  const { restore } = installWithAuth(db);
  const inner = globalThis.fetch;
  globalThis.fetch = (async (i: RequestInfo | URL, init?: RequestInit) => {
    if (String(i).startsWith("https://api.resend.com")) { const b = JSON.parse(String(init?.body)); mail.push({ to: ([] as string[]).concat(b.to)[0], subject: b.subject, text: b.text }); return new Response(JSON.stringify({ id: "em" }), { status: 200 }); }
    return inner(i as RequestInfo, init);
  }) as typeof fetch;
  undo = () => { globalThis.fetch = inner; restore(); };
});
afterEach(() => { undo(); vi.restoreAllMocks(); });

const VICTIM = "victim@hall.example";
async function buy(email: string, customer: string, sub: string, plan: string, type = "checkout.session.completed") {
  const payload = JSON.stringify({ id: `evt_${sub}`, type, data: { object: { id: `cs_${sub}`, object: "checkout_session", customer_email: email, customer, subscription: sub, amount_total: 1, metadata: { kind: "intelligence_subscription", plan } } } });
  const { POST } = await import("@/app/api/stripe/webhook/route");
  return POST(new Request(siteUrl("/api/stripe/webhook"), { method: "POST", headers: { "stripe-signature": sdk.webhooks.generateTestHeaderString({ payload, secret: WH }) }, body: payload }));
}
const rowOf = (sub: string) => (db.rows("subscriptions") as any[]).find((r) => r.stripe_subscription_id === sub);

describe("a stranger cannot supersede somebody else's subscription by paying with their email", () => {
  it("the victim's subscription stays ACTIVE; the attacker's purchase is recorded as superseded and the operator is told", async () => {
    expect((await buy(VICTIM, "cus_victim", "sub_victim", "team")).status).toBe(200);
    expect(rowOf("sub_victim").status).toBe("active");

    const res = await buy(VICTIM, "cus_attacker", "sub_attacker", "developer");
    expect(res.status).toBe(200); // acknowledged: a redelivery could not change the answer
    expect(rowOf("sub_victim").status).toBe("active");
    expect(rowOf("sub_attacker").status).toBe("superseded");
    expect((db.rows("subscriptions") as any[]).filter((r) => r.status === "active" && r.email === VICTIM)).toHaveLength(1);
    const note = mail.find((m) => /NOT entitled/.test(m.subject));
    expect(note).toBeTruthy();
    expect(note!.text).toContain("sub_attacker");
    expect(note!.text).toContain("cus_attacker");
    // no welcome for an entitlement that was not granted
    expect(mail.filter((m) => /Welcome to GridForge Intelligence/.test(m.subject))).toHaveLength(1);
  });

  it("a redelivery of the attacker's event changes nothing and does not repeat the operator notice", async () => {
    await buy(VICTIM, "cus_victim", "sub_victim", "team");
    await buy(VICTIM, "cus_attacker", "sub_attacker", "developer");
    await buy(VICTIM, "cus_attacker", "sub_attacker", "developer");
    expect(db.rows("subscriptions")).toHaveLength(2);
    expect(rowOf("sub_victim").status).toBe("active");
    expect(mail.filter((m) => /NOT entitled/.test(m.subject))).toHaveLength(1);
  });

  it("the same payer upgrading (same Stripe customer) still replaces the old plan", async () => {
    await buy(VICTIM, "cus_victim", "sub_old", "developer");
    await buy(VICTIM, "cus_victim", "sub_new", "team");
    expect(rowOf("sub_old").status).toBe("superseded");
    expect(rowOf("sub_new").status).toBe("active");
    expect(mail.some((m) => /NOT entitled/.test(m.subject))).toBe(false);
  });

  it("the victim's seats survive (members keep access to the still-active subscription)", async () => {
    await buy(VICTIM, "cus_victim", "sub_victim", "team");
    db.rows("subscription_members").push({ id: "m1", owner_email: VICTIM, member_email: "colleague@hall.example", subscription_id: rowOf("sub_victim").id });
    await buy(VICTIM, "cus_attacker", "sub_attacker", "enterprise");
    const { lookupEntitlement } = await import("@/lib/subscribers");
    const e = await lookupEntitlement(VICTIM);
    expect(e.reachable && e.entitlement).toMatchObject({ role: "owner", subscription: { plan: "team", stripe_subscription_id: "sub_victim" } });
  });

  it("an attacker's later invoice.paid on the unentitled subscription does not revive it", async () => {
    await buy(VICTIM, "cus_victim", "sub_victim", "team");
    await buy(VICTIM, "cus_attacker", "sub_attacker", "developer");
    const payload = JSON.stringify({ id: "evt_paid", type: "invoice.paid", data: { object: { id: "in_1", object: "invoice", subscription: "sub_attacker" } } });
    const { POST } = await import("@/app/api/stripe/webhook/route");
    await POST(new Request(siteUrl("/api/stripe/webhook"), { method: "POST", headers: { "stripe-signature": sdk.webhooks.generateTestHeaderString({ payload, secret: WH }) }, body: payload }));
    expect(rowOf("sub_attacker").status).toBe("superseded");
    expect(rowOf("sub_victim").status).toBe("active");
  });
});

describe("/api/subscribe never takes the email from the request", () => {
  const subscribe = async (body: unknown, headers: Record<string, string> = {}) =>
    (await import("@/app/api/subscribe/route")).POST(new Request(siteUrl("/api/subscribe"), { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }));

  it("ignores a client-supplied email entirely (no customer_email, no customer)", async () => {
    expect((await subscribe({ plan: "developer", email: VICTIM })).status).toBe(200);
    expect(sessions[0]).not.toHaveProperty("customer_email");
    expect(sessions[0]).not.toHaveProperty("customer");
    expect(JSON.stringify(sessions[0])).not.toContain(VICTIM);
  });

  it("a verified signed-in session names ITS OWN address, whatever the body says", async () => {
    await subscribe({ plan: "developer", email: VICTIM }, bearerFor("me@mine.example"));
    expect(sessions[0].customer_email).toBe("me@mine.example");
    expect(JSON.stringify(sessions[0])).not.toContain(VICTIM);
  });

  it("an upgrade from a verified session REUSES the existing Stripe customer, so it is the same payer", async () => {
    await buy("me@mine.example", "cus_mine", "sub_1", "developer");
    await subscribe({ plan: "team" }, bearerFor("me@mine.example"));
    expect(sessions[0]).toMatchObject({ customer: "cus_mine" });
    expect(sessions[0]).not.toHaveProperty("customer_email");
  });

  it("an unconfirmed or forged session is treated as no session at all", async () => {
    await subscribe({ plan: "developer" }, unconfirmedBearerFor("me@mine.example"));
    expect(sessions[0]).not.toHaveProperty("customer_email");
    await subscribe({ plan: "developer" }, { authorization: "Bearer forged" });
    expect(sessions[1]).not.toHaveProperty("customer_email");
  });
});
