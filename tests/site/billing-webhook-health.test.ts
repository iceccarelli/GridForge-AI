/**
 * GitHub issue #4: the Stripe webhook endpoint subscribed to `checkout.session.completed` only, so the handlers for `invoice.paid` and
 * `customer.subscription.deleted` (both written, idempotent and tested) could never fire in production.
 *
 * What the repository can and cannot do about that, proven here (MOCKS: a fake Stripe client with the shape of `webhookEndpoints.list`; nothing
 * here talks to Stripe and nothing proves what a live account is configured to send):
 *
 *   - every event the route acts on has a handler, and every one that moves money or access is REQUIRED by the health check;
 *   - an endpoint subscribed to what issue #4 describes is reported unhealthy, naming every missing event, by the health check AND by a mail to
 *     the operator from the daily cron (once a day while the gap stands), not only on the admin page somebody must open;
 *   - what it cannot do: enabling the events is the account owner's action in the Stripe Dashboard.
 */
import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { siteUrl } from "@/lib/site";
import { REQUIRED_WEBHOOK_EVENTS, RECOMMENDED_WEBHOOK_EVENTS, checkStripeWebhookHealth, webhookHealthAlert } from "@/lib/stripe-health";
import { at, audit, operatorMail, startRig, type Rig } from "./billing-holds-harness";

const URL = siteUrl("/api/stripe/webhook");
const ISSUE_4_EVENTS = ["checkout.session.completed"]; // verbatim from issue #4: `enabled_events: ["checkout.session.completed"]`

type Ep = { id: string; url: string; status: string; enabled_events?: unknown };
const client = (eps: Ep[]) => ({ webhookEndpoints: { list: async () => ({ data: eps }) } });
const ep = (events: unknown, over: Partial<Ep> = {}): Ep => ({ id: "we_1", url: URL, status: "enabled", enabled_events: events, ...over });

/** The nine events the product depends on: handler in the route, required by the health check, and what each protects. */
const MATRIX: { event: string; protects: string }[] = [
  { event: "checkout.session.completed", protects: "fulfilment of every paid checkout (key, watch, subscription, engagement)" },
  { event: "invoice.paid", protects: "reinstating past_due access, un-pausing, the key-renewal reminder" },
  { event: "invoice.payment_failed", protects: "past_due and the API grace period" },
  { event: "customer.subscription.deleted", protects: "revoking the key, cancelling Hall Watch and Intelligence" },
  { event: "customer.subscription.updated", protects: "portal pauses, plan switches and cancellations" },
  { event: "charge.refunded", protects: "suspending paid access on a full refund" },
  { event: "charge.dispute.created", protects: "suspending paid access on a chargeback" },
  { event: "charge.dispute.updated", protects: "an inquiry that escalates to a chargeback" },
  { event: "charge.dispute.closed", protects: "restoring access when a dispute is won" },
];

const route = fs.readFileSync("app/api/stripe/webhook/route.ts", "utf8");

describe("issue #4: which of the five causes it is, from the code", () => {
  it.each(MATRIX)("$event: the route HANDLES it ($protects)", ({ event }) => {
    expect(route, `no handler for ${event}`).toContain(`"${event}"`);
  });

  it.each(MATRIX)("$event: the health check REQUIRES it, so an endpoint that lacks it is unhealthy and the error names it", async ({ event }) => {
    expect(REQUIRED_WEBHOOK_EVENTS as readonly string[]).toContain(event);
    const others = REQUIRED_WEBHOOK_EVENTS.filter((e) => e !== event);
    const h = await checkStripeWebhookHealth(client([ep([...others, ...RECOMMENDED_WEBHOOK_EVENTS])]), URL);
    expect(h.healthy).toBe(false);
    expect(h.missingEvents).toEqual([event]);
    expect(h.error).toContain(event);
    expect(h.error).toMatch(/missing required event/);
  });

  it("the required set is exactly the events in the matrix (a handler added without a requirement, or the reverse, fails here)", () => {
    expect(new Set(REQUIRED_WEBHOOK_EVENTS)).toEqual(new Set(MATRIX.map((m) => m.event)));
  });

  it("the endpoint of issue #4 (checkout.session.completed only) is unhealthy and every other required event, invoice.paid and customer.subscription.deleted among them, is named", async () => {
    const h = await checkStripeWebhookHealth(client([ep(ISSUE_4_EVENTS)]), URL);
    expect(h.healthy).toBe(false);
    expect(h.reachable).toBe(true);
    expect([...h.missingEvents].sort()).toEqual(MATRIX.map((m) => m.event).filter((e) => e !== "checkout.session.completed").sort());
    expect(h.missingEvents).toEqual(expect.arrayContaining(["invoice.paid", "customer.subscription.deleted"]));
    for (const e of h.missingEvents) expect(h.error).toContain(e);
  });

  it("a missing subscription is never reported healthy by omission: no endpoint, a disabled one, an unlisted URL, and no Stripe client all say so", async () => {
    expect((await checkStripeWebhookHealth(client([]), URL)).healthy).toBe(false);
    expect((await checkStripeWebhookHealth(client([ep([...REQUIRED_WEBHOOK_EVENTS], { status: "disabled" })]), URL)).healthy).toBe(false);
    expect((await checkStripeWebhookHealth(client([ep([...REQUIRED_WEBHOOK_EVENTS], { url: "https://elsewhere.example/hook" })]), URL)).healthy).toBe(false);
    const none = await checkStripeWebhookHealth(null, URL);
    expect(none.healthy).toBe(false);
    expect(none.error).toMatch(/STRIPE_SECRET_KEY/);
  });
});

describe("the health check against shapes a real account can return", () => {
  it("an endpoint with no enabled_events list subscribes to nothing: every event is missing, and the check does not throw", async () => {
    for (const bad of [undefined, null, "*", 7, {}]) {
      const h = await checkStripeWebhookHealth(client([ep(bad)]), URL);
      expect(h.healthy, JSON.stringify(bad)).toBe(false);
      expect(h.missingEvents).toEqual([...REQUIRED_WEBHOOK_EVENTS]);
    }
  });

  it("two enabled endpoints for the same URL deliver the UNION of their events (Stripe sends to each), so a split subscription is healthy", async () => {
    const half = REQUIRED_WEBHOOK_EVENTS.slice(0, 4);
    const rest = REQUIRED_WEBHOOK_EVENTS.slice(4);
    const split = await checkStripeWebhookHealth(client([ep([...half], { id: "we_a" }), ep([...rest], { id: "we_b" })]), URL);
    expect(split.healthy).toBe(true);
    expect(split.missingEvents).toEqual([]);
    const gap = await checkStripeWebhookHealth(client([ep([...half], { id: "we_a" }), ep(["customer.updated"], { id: "we_b" })]), URL);
    expect(gap.healthy).toBe(false);
    expect(gap.missingEvents).toEqual([...rest]);
  });

  it("a DISABLED endpoint's events do not count when an enabled one exists", async () => {
    const h = await checkStripeWebhookHealth(
      client([ep([...REQUIRED_WEBHOOK_EVENTS], { id: "we_off", status: "disabled" }), ep(ISSUE_4_EVENTS, { id: "we_on" })]),
      URL
    );
    expect(h.healthy).toBe(false);
    expect(h.endpoint?.id).toBe("we_on");
    expect(h.missingEvents).toContain("invoice.paid");
  });

  it("a wildcard on one enabled endpoint covers everything, with a second restricted endpoint beside it", async () => {
    const h = await checkStripeWebhookHealth(client([ep(["*"], { id: "we_all" }), ep(ISSUE_4_EVENTS, { id: "we_one" })]), URL);
    expect(h.healthy).toBe(true);
    expect(h.missingRecommended).toEqual([]);
  });
});

describe("webhookHealthAlert: the gap is pushed to the operator, and says nothing it cannot know", () => {
  it("issue #4's endpoint produces a notice naming invoice.paid and customer.subscription.deleted and the owner-only fix", async () => {
    const a = await webhookHealthAlert(client([ep(ISSUE_4_EVENTS)]), URL);
    expect(a).not.toBeNull();
    expect(a!.subject).toMatch(/NOT wired up/);
    expect(a!.subject).toMatch(/8 required event\(s\) are not subscribed/);
    expect(a!.text).toContain("invoice.paid");
    expect(a!.text).toContain("customer.subscription.deleted");
    expect(a!.text).toMatch(/account-owner action/);
    expect(a!.text).toMatch(/once a day/);
  });

  it("no endpoint for this site and a disabled endpoint are alerted with their own wording", async () => {
    expect((await webhookHealthAlert(client([]), URL))!.subject).toMatch(/no endpoint is registered/);
    expect((await webhookHealthAlert(client([ep([...REQUIRED_WEBHOOK_EVENTS], { status: "disabled" })]), URL))!.subject).toMatch(/disabled/);
  });

  it("a healthy endpoint, no client, a client that cannot list endpoints, and an unreachable Stripe all produce no alert (nothing is claimed)", async () => {
    expect(await webhookHealthAlert(client([ep([...REQUIRED_WEBHOOK_EVENTS])]), URL)).toBeNull();
    expect(await webhookHealthAlert(null, URL)).toBeNull();
    expect(await webhookHealthAlert({ checkout: {} }, URL)).toBeNull();
    const down = { webhookEndpoints: { list: async () => { throw new Error("network down"); } } };
    expect(await webhookHealthAlert(down, URL)).toBeNull();
  });
});

describe("GET /api/cron/payg mails the operator about an unsubscribed webhook (MOCK Stripe, FAKE store)", () => {
  let rig: Rig;
  beforeEach(() => { rig = startRig(); });
  afterEach(() => rig.stop());

  const setEndpoints = (eps: Ep[] | Error) => {
    (rig.stripe as any).webhookEndpoints = {
      list: async () => {
        if (eps instanceof Error) throw eps;
        return { data: eps };
      },
    };
  };
  const cron = async () => {
    const { GET } = await import("@/app/api/cron/payg/route");
    return GET(new Request(siteUrl("/api/cron/payg"), { headers: { authorization: "Bearer cron-secret-value" } }));
  };
  const webhookMail = () => operatorMail(rig).filter((m) => /Stripe webhook is NOT wired up/.test(m.subject));

  it("issue #4's endpoint: the operator is mailed once, naming what is missing, and the response says so", async () => {
    setEndpoints([ep(ISSUE_4_EVENTS)]);
    const res = await cron();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.webhook.alerted).toBe(true);
    expect(body.webhook.missing).toEqual(expect.arrayContaining(["invoice.paid", "customer.subscription.deleted"]));
    expect(webhookMail()).toHaveLength(1);
    expect(webhookMail()[0].text).toContain("customer.subscription.deleted");
  });

  it("a second run the same day sends nothing more; the next day it is said again while the gap stands", async () => {
    setEndpoints([ep(ISSUE_4_EVENTS)]);
    await cron();
    await cron();
    expect(webhookMail()).toHaveLength(1);
    at(rig.T0 + 86_400 + 60);
    await cron();
    expect(webhookMail()).toHaveLength(2);
  });

  it("once the events are subscribed the notice stops", async () => {
    setEndpoints([ep(ISSUE_4_EVENTS)]);
    await cron();
    setEndpoints([ep([...REQUIRED_WEBHOOK_EVENTS])]);
    at(rig.T0 + 86_400 + 60);
    const body = await (await cron()).json();
    expect(body.webhook).toEqual({ alerted: false, missing: [] });
    expect(webhookMail()).toHaveLength(1);
  });

  it("Stripe unreachable, or a client that cannot list endpoints: the cron still answers 200, claims nothing and mails nothing", async () => {
    setEndpoints(new Error("simulated outage"));
    const down = await cron();
    expect(down.status).toBe(200);
    expect((await down.json()).webhook.alerted).toBe(false);
    delete (rig.stripe as any).webhookEndpoints;
    expect((await (await cron()).json()).webhook.alerted).toBe(false);
    expect(webhookMail()).toHaveLength(0);
  });

  it("the alert changes nothing else the cron does (no audit row, no account touched)", async () => {
    setEndpoints([ep(ISSUE_4_EVENTS)]);
    await cron();
    expect(audit(rig)).toHaveLength(0);
  });
});
