/**
 * Shared doubles for the billing-hold tests (refunds, disputes, pauses, settlement reversals). Everything here is a STAND-IN and says so:
 *
 *   HoldStripe   MockStripe (tests/site/payg-harness.ts) plus what the reversal handlers read: a charge's invoice / payment intent, an
 *                invoice's subscription or metadata (a pay-as-you-go settlement invoice names itself there), a subscription's period and pause
 *                state, and disputes (`pinDispute`: Stripe's CURRENT state of a dispute, which every dispute event is decided from).
 *                No live Stripe call is made; nothing here proves what live Stripe sends.
 *   mockEngine   the engine's /v1/revoke as a fetch interceptor.
 *   FAKE STORE   the in-memory PostgREST (tests/site/postgrest-fake.ts); the SQL itself is proven against PostgreSQL in
 *                tests/test_billing_holds_migration.py and tests/test_billing_pause_reversals_migration.py.
 */
import { vi } from "vitest";
import Stripe from "stripe";
import { siteUrl } from "@/lib/site";
import { setPaygStripeForTests } from "@/lib/payg-stripe";
import { resetPauseReconcileCache } from "@/lib/pause-reconcile";
import { MockStripe, mockEngine, newPaygDb, paygAccount, type MockEngine } from "./payg-harness";
import type { PostgrestFake, Row } from "./postgrest-fake";

export const WH = "whsec_holds";
export const DAY = 86_400;
const sdk = new Stripe("sk_test_placeholder");

type Facts = { status: string; amount_paid: number };

export class HoldStripe extends MockStripe {
  chargeInfo = new Map<string, { customer?: string; invoice?: string | null; payment_intent?: string | null }>();
  paymentIntentInvoice = new Map<string, string>();
  invoiceSubscription = new Map<string, string>();
  /** What Stripe says about an invoice (default: paid in full). */
  invoiceFacts = new Map<string, Facts>();
  /** Invoices that carry metadata and no subscription (a pay-as-you-go settlement invoice). */
  invoiceMeta = new Map<string, Record<string, string>>();
  /** A subscription's newest invoice, and the kind our checkout stamped on it. */
  subscriptionLatest = new Map<string, string>();
  subscriptionKinds = new Map<string, string>();
  /** A subscription as Stripe holds it NOW (status, pause_collection, period). Absent: the subscription exists without those. */
  subscriptionState = new Map<string, Record<string, unknown>>();
  /** The Checkout Session that took a payment intent (a one-time purchase): lib/one-time-holds.ts finds its row through it. */
  sessionByPaymentIntent = new Map<string, { id: string; metadata: Record<string, string> }>();
  constructor() {
    super();
    const missing = () => Object.assign(new Error("No such object"), { type: "StripeInvalidRequestError", code: "resource_missing", statusCode: 404 });
    const outage = (name: string) => {
      this.calls.push(name);
      if (this.failOnce.delete(name)) throw Object.assign(new Error("simulated Stripe outage"), { type: "StripeConnectionError", statusCode: 503 });
    };
    (this as any).charges = {
      retrieve: async (id: string) => {
        outage("charges.retrieve");
        const c = this.chargeInfo.get(id);
        if (!c) throw missing();
        return { id, ...c };
      },
    };
    (this as any).checkout = {
      sessions: {
        list: async (p: { payment_intent: string }) => {
          outage("checkout.sessions.list");
          const s = this.sessionByPaymentIntent.get(p.payment_intent);
          return { data: s ? [s] : [] };
        },
      },
    };
    (this as any).invoicePayments = {
      list: async (p: { payment: { payment_intent: string } }) => {
        outage("invoicePayments.list");
        const inv = this.paymentIntentInvoice.get(p.payment.payment_intent);
        return { data: inv ? [{ invoice: inv }] : [] };
      },
    };
    const base = this.invoices;
    (this as any).invoices = {
      ...base,
      retrieve: async (id: string) => {
        outage("invoices.retrieve");
        const meta = this.invoiceMeta.get(id);
        if (meta) return { id, metadata: meta, ...(this.invoiceFacts.get(id) ?? { status: "paid", amount_paid: 90_000 }) };
        const sub = this.invoiceSubscription.get(id);
        if (!sub) throw missing();
        return { id, ...(this.invoiceFacts.get(id) ?? { status: "paid", amount_paid: 90_000 }), parent: { subscription_details: { subscription: sub } } };
      },
    };
    (this as any).subscriptions = {
      retrieve: async (id: string) => {
        outage("subscriptions.retrieve");
        if (!this.subscriptionLatest.has(id) && !this.subscriptionKinds.has(id) && !this.subscriptionState.has(id)) throw missing();
        return { id, latest_invoice: this.subscriptionLatest.get(id) ?? null, metadata: { kind: this.subscriptionKinds.get(id) }, ...(this.subscriptionState.get(id) ?? {}) };
      },
    };
    this.installHangs();
  }
  /** An invoice that exists on a subscription, becomes its newest, and has the given facts. */
  addInvoice(invoice: string, sub: string, facts: Facts = { status: "paid", amount_paid: 90_000 }) {
    this.invoiceSubscription.set(invoice, sub);
    this.invoiceFacts.set(invoice, facts);
    this.subscriptionLatest.set(sub, invoice);
  }
  /** charge -> payment intent -> invoice -> subscription, as the newer API versions chain them (Charge carries no `invoice`). */
  link(charge: string, pi: string, invoice: string, sub: string) {
    this.chargeInfo.set(charge, { payment_intent: pi });
    this.paymentIntentInvoice.set(pi, invoice);
    this.invoiceSubscription.set(invoice, sub);
    this.subscriptionLatest.set(sub, invoice);
  }
  /** charge -> payment intent -> the Checkout Session of a ONE-TIME purchase (no invoice, no subscription). */
  linkOneTime(charge: string, pi: string, sessionId: string, kind: string) {
    this.chargeInfo.set(charge, { payment_intent: pi });
    this.sessionByPaymentIntent.set(pi, { id: sessionId, metadata: { kind } });
  }
  /** charge -> payment intent -> a pay-as-you-go SETTLEMENT invoice (metadata, no subscription). */
  linkSettlement(charge: string, pi: string, invoice: string, meta: Record<string, string>) {
    this.chargeInfo.set(charge, { payment_intent: pi });
    this.paymentIntentInvoice.set(pi, invoice);
    this.invoiceMeta.set(invoice, { kind: "payg_settlement", ...meta });
  }
  /** What Stripe holds for a subscription RIGHT NOW. */
  setSubscription(sub: string, state: Record<string, unknown>) {
    this.subscriptionState.set(sub, state);
  }
}

export interface Rig {
  db: PostgrestFake;
  engine: MockEngine;
  mail: { to: string; subject: string; text: string }[];
  stripe: HoldStripe;
  logs: unknown[][];
  T0: number;
  stop(): void;
}

let evt = 0;

/** The environment, the fake store (with the billing_audit table), the engine and Stripe stand-ins, and a frozen clock at `T0`. */
export function startRig(): Rig {
  Object.assign(process.env, {
    SUPABASE_URL: "https://stub.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "sb_secret_test", GRIDFORGE_KEY_SECRET: "test-signing-secret",
    STRIPE_SECRET_KEY: "sk_test_placeholder", STRIPE_WEBHOOK_SECRET: WH, CRON_SECRET: "cron-secret-value", RESEND_API_KEY: "re_test",
    LEAD_TO_EMAIL: "ops@example.test", LEAD_FROM_EMAIL: "T <p@timetopower.ai>", GRIDFORGE_API_KEY: "engine-key",
  });
  resetPauseReconcileCache();
  const logs: unknown[][] = [];
  for (const m of ["error", "log", "warn"] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { logs.push(a); });
  const T0 = Math.floor(Date.now() / 1000);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0 * 1000);
  const db = newPaygDb();
  db.createTable("billing_audit");
  db.uniqueKeys.set("billing_audit", [["dedupe_key"]]);
  db.createTable("payg_settlement_reversals");
  db.uniqueKeys.set("payg_settlement_reversals", [["dedupe_key"]]);
  db.createTable("watch_note_notices");
  // The columns migrations 0041 and 0043 add read back as NULL, as PostgREST returns them.
  for (const t of ["api_accounts", "watches", "subscriptions"]) {
    const prev = db.rowDefaults.get(t);
    db.rowDefaults.set(t, () => ({
      ...(prev?.() ?? {}),
      billing_hold: null, billing_hold_ref: null, billing_hold_invoice: null, billing_hold_at: null, billing_hold_prev_status: null,
      billing_pause_from: null, billing_pause_resumes_at: null, billing_pause_event_ts: null,
    }));
  }
  const restore = db.install();
  const mail: Rig["mail"] = [];
  const engine = mockEngine(mail);
  const stripe = new HoldStripe();
  setPaygStripeForTests(stripe);
  return {
    db, engine, mail, stripe, logs, T0,
    stop() {
      vi.useRealTimers();
      setPaygStripeForTests(null);
      engine.restore();
      restore();
      vi.restoreAllMocks();
    },
  };
}

/** Move the frozen clock to `unix` seconds. */
export const at = (unix: number) => vi.setSystemTime(unix * 1000);

/** POST a signed Stripe event to the real webhook route. */
export async function send(rig: Rig, type: string, object: Record<string, unknown>, opts: { created?: number; id?: string; unmirrored?: boolean } = {}) {
  if (!opts.unmirrored) rig.stripe.observe(type, object);
  const id = opts.id ?? `evt_${++evt}`;
  const payload = JSON.stringify({ id, type, ...(opts.created ? { created: opts.created } : {}), data: { object } });
  const { POST } = await import("@/app/api/stripe/webhook/route");
  return POST(new Request(siteUrl("/api/stripe/webhook"), { method: "POST", headers: { "stripe-signature": sdk.webhooks.generateTestHeaderString({ payload, secret: WH }) }, body: payload }));
}

export const daySpec = (rig: Rig, n: number) => new Date(rig.T0 * 1000 + n * 86_400_000).toISOString().slice(0, 10);
export const audit = (rig: Rig, action?: string) => (rig.db.rows("billing_audit") as Row[]).filter((r) => !action || r.action === action);
export const operatorMail = (rig: Rig) => rig.mail.filter((m) => m.to === "ops@example.test");
export const revokeCalls = (rig: Rig) => rig.engine.revokeCalls.filter((id) => id !== "");

export function apiAcct(rig: Rig, over: Record<string, unknown> = {}) {
  return paygAccount(rig.db, {
    account: "scale-1", token: "tok-scale-0123456789abcdefghij", plan: "api_scale", cap_units: null, monthly_units: 2500, stripe_subscription_id: "sub_api",
    stripe_customer_id: "cus_api", stripe_payment_method_id: null, key_id: "keyLIVE1", key_scope: "machine", key_issued_at: daySpec(rig, -5), key_expires_at: daySpec(rig, 30), ...over,
  });
}
export function watchRow(rig: Rig, over: Record<string, unknown> = {}) {
  return rig.db.insertRow("watches", {
    token: "wtok-0123456789abcdefghijklmn", status: "active", cadence: "quarterly", email: "w@hall.example", site_name: "North Hall", hall_id: "H1",
    stripe_subscription_id: "sub_w", stripe_customer_id: "cus_w", intake: { siteName: "H" }, last_state: { racks: 40 }, next_run_at: new Date(Date.now() + 30 * 86_400_000).toISOString(), ...over,
  });
}
export function intelRow(rig: Rig, over: Record<string, unknown> = {}) {
  return rig.db.insertRow("subscriptions", { email: "i@hall.example", plan: "team", status: "active", stripe_session_id: "cs_i", stripe_customer_id: "cus_i", stripe_subscription_id: "sub_i", ...over });
}

export const post = (path: string, body: unknown) => new Request(siteUrl(path), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
