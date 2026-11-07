/**
 * The webhook verifies the signature, but a correctly signed event can still come from the WRONG Stripe mode: a test-mode event delivered to a
 * live deployment (or the reverse) is a misconfigured endpoint, and fulfilling it would open a paid entitlement for money that never moved.
 * The guard derives the configured mode from the secret key's prefix, compares it with the event's `livemode`, and when they disagree refuses
 * with 400 `livemode_mismatch` (non-2xx, so the platform's failed-delivery alerting sees it), fulfils nothing and logs no secret.
 * When the key mode cannot be told, behaviour is unchanged.
 *
 * Stand-ins: signed with the Stripe SDK's own test-header helper (as in billing-webhook-adversarial.test.ts), in-memory store, no live Stripe.
 */
import Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { siteUrl } from "@/lib/site";
import { stripeKeyMode } from "@/lib/stripe-mode";
import { paidSession } from "./checkout-fixture";
import { WH, startRig, type Rig } from "./billing-holds-harness";
import type { Row } from "./postgrest-fake";

const sdk = new Stripe("sk_test_placeholder");
const LIVE_KEY = ["sk", "live", "51Abcdefghijklmnopqrstuvwxyz0123456789SECRETMARK"].join("_"); // assembled at runtime so no key-shaped literal sits in the source
const TEST_KEY = ["sk", "test", "51Abcdefghijklmnopqrstuvwxyz0123456789SECRETMARK"].join("_");
let rig: Rig;
beforeEach(() => { rig = startRig(); });
afterEach(() => rig.stop());

const watchCheckout = () => paidSession({ id: "cs_watch", object: "checkout.session", customer_email: "buyer@hall.example", customer: "cus_w", subscription: "sub_hall_watch", amount_total: 90_000, currency: "eur", metadata: { kind: "hall_watch", company: "Hall Co" } });
const watches = () => rig.db.rows("watches") as Row[];

async function deliver(livemode: unknown, key: string | undefined, opts: { type?: string; omitLivemode?: boolean } = {}) {
  if (key === undefined) delete process.env.STRIPE_SECRET_KEY; else process.env.STRIPE_SECRET_KEY = key;
  const payload = JSON.stringify({ id: `evt_${Math.random().toString(36).slice(2)}`, type: opts.type ?? "checkout.session.completed", ...(opts.omitLivemode ? {} : { livemode }), data: { object: watchCheckout() } });
  const { POST } = await import("@/app/api/stripe/webhook/route");
  return POST(new Request(siteUrl("/api/stripe/webhook"), { method: "POST", headers: { "stripe-signature": sdk.webhooks.generateTestHeaderString({ payload, secret: WH }) }, body: payload }));
}
const logged = () => rig.logs.map((a) => a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")).join("\n");

describe("stripeKeyMode", () => {
  it("reads the mode from the prefix alone, and is null for anything it cannot tell", () => {
    expect(stripeKeyMode(LIVE_KEY)).toBe("live");
    expect(stripeKeyMode("rk_live_abc")).toBe("live");
    expect(stripeKeyMode(TEST_KEY)).toBe("test");
    expect(stripeKeyMode("rk_test_abc")).toBe("test");
    for (const k of [undefined, "", "sk_placeholder", "pk_live_abc", "live", "SK_LIVE_x", " sk_live_x"]) expect(stripeKeyMode(k), String(k)).toBeNull();
  });
});

describe("matching modes are fulfilled as before", () => {
  it("a live event on a live key opens the entitlement", async () => {
    expect((await deliver(true, LIVE_KEY)).status).toBe(200);
    expect(watches()).toHaveLength(1);
  });
  it("a test event on a test key opens the entitlement", async () => {
    expect((await deliver(false, TEST_KEY)).status).toBe(200);
    expect(watches()).toHaveLength(1);
  });
});

describe("mismatched modes are refused", () => {
  for (const [name, livemode, key] of [["a test-mode event on a live key", false, LIVE_KEY], ["a live-mode event on a test key", true, TEST_KEY]] as const) {
    it(`${name}: 400 livemode_mismatch, nothing fulfilled, nothing written`, async () => {
      const res = await deliver(livemode, key);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ ok: false, error: "livemode_mismatch" });
      for (const t of ["watches", "api_accounts", "subscriptions", "deliverables", "funnel_events"]) { try { expect(rig.db.rows(t), t).toHaveLength(0); } catch (e) { if (!/no such table|unknown table/i.test(String(e))) throw e; } }
    });
  }
  it("applies to every event type, including ones the route would otherwise only acknowledge", async () => {
    for (const type of ["checkout.session.async_payment_failed", "invoice.paid", "charge.refunded", "customer.subscription.deleted"]) {
      expect((await deliver(false, LIVE_KEY, { type })).status, type).toBe(400);
    }
  });
  it("the refusal is a structured log line carrying the event id and both modes, and no secret: not the key, not the webhook secret, not the payload", async () => {
    await deliver(false, LIVE_KEY);
    const out = logged();
    const line = out.split("\n").find((l) => /livemode_mismatch/.test(l));
    expect(line, out).toBeDefined();
    expect(line).toMatch(/evt_/);
    expect(line).toMatch(/event_livemode=false/);
    expect(line).toMatch(/configured_mode=live/);
    for (const secret of [LIVE_KEY, "SECRETMARK", WH, "buyer@hall.example", "Hall Co"]) expect(out, secret).not.toContain(secret);
  });
});

describe("when the key mode cannot be told, nothing changes", () => {
  it.each([["no key at all (the route is unconfigured: 503, as before)", undefined, 503], ["an unrecognised key prefix", "sk_placeholder", 200]] as const)("%s", async (_n, key, status) => {
    expect((await deliver(false, key)).status).toBe(status);
    expect((await deliver(true, key)).status).toBe(status);
  });
  it("an event with no boolean livemode (not what Stripe sends) is handled as it always was, on either key mode", async () => {
    expect((await deliver(undefined, LIVE_KEY, { omitLivemode: true })).status).toBe(200);
    expect((await deliver("yes", TEST_KEY)).status).toBe(200);
  });
});
