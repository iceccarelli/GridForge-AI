/**
 * A buyer who buys a second Intelligence plan supersedes the first in OUR records, but the first Stripe
 * subscription keeps billing. Nothing here cancels it (money moved on a customer's behalf); the
 * operator is told, with the ids, on every payment that clears for it — and it entitles nothing.
 *
 * FAKE-BACKED store; email is intercepted. Stripe is not contacted.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Stripe from "stripe";
import { siteUrl } from "@/lib/site";
import { PostgrestFake } from "./postgrest-fake";

const WH = "whsec_superseded_billing_secret";
let db: PostgrestFake;
let undo: () => void;
let allMail: { subject: string; text: string }[];
/** Only the operator notices under test (purchase emails also pass through Resend). */
const alerts = () => allMail.filter((m) => /still billing/.test(m.subject));
const stripe = new Stripe("sk_test_placeholder");

beforeEach(() => {
  allMail = [];
  process.env.SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_test";
  process.env.STRIPE_SECRET_KEY = "sk_test_placeholder";
  process.env.STRIPE_WEBHOOK_SECRET = WH;
  process.env.RESEND_API_KEY = "re_test";
  process.env.LEAD_TO_EMAIL = "ops@example.test";
  db = new PostgrestFake(["subscriptions", "api_accounts", "watches", "watch_notes", "leads", "deliverables"]);
  const restoreDb = db.install();
  const dbFetch = globalThis.fetch;
  globalThis.fetch = (async (i: RequestInfo | URL, init?: RequestInit) => {
    if (String(i).startsWith("https://api.resend.com")) { allMail.push(JSON.parse(String(init?.body))); return new Response("{}", { status: 200 }); }
    return dbFetch(i as RequestInfo, init);
  }) as typeof fetch;
  undo = () => { globalThis.fetch = dbFetch; restoreDb(); };
});
afterEach(() => { undo(); delete process.env.RESEND_API_KEY; });

function send(type: string, object: Record<string, unknown>) {
  const payload = JSON.stringify({ id: `evt_${Math.random().toString(36).slice(2)}`, type, data: { object } });
  return import("@/app/api/stripe/webhook/route").then(({ POST }) =>
    POST(new Request(siteUrl("/api/stripe/webhook"), { method: "POST", headers: { "stripe-signature": stripe.webhooks.generateTestHeaderString({ payload, secret: WH }) }, body: payload })));
}
const buy = (sub: string, plan: string) => send("checkout.session.completed", {
  id: `cs_${sub}`, object: "checkout_session", customer_email: "buyer@hall.example", customer: "cus_1", subscription: sub,
  amount_total: 199_900, metadata: { kind: "intelligence_subscription", plan },
});
const paid = (sub: string) => send("invoice.paid", { id: `in_${sub}`, object: "invoice", subscription: sub });
const rowOf = (sub: string) => (db.rows("subscriptions") as any[]).find((r) => r.stripe_subscription_id === sub);

describe("a superseded Intelligence subscription that is still being paid for", () => {
  it("tells the operator which Stripe subscription to cancel, and does not revive it", async () => {
    await buy("sub_old", "developer");
    await buy("sub_new", "team");
    expect(rowOf("sub_old").status).toBe("superseded");
    expect(rowOf("sub_new").status).toBe("active");

    expect((await paid("sub_old")).status).toBe(200);
    expect(rowOf("sub_old").status).toBe("superseded");                       // still entitles nothing
    expect(alerts()).toHaveLength(1);
    expect(alerts()[0].subject).toContain("still billing");
    expect(alerts()[0].text).toContain("sub_old");
    expect(alerts()[0].text).toContain("buyer@hall.example");

    await paid("sub_old");                                                    // and it repeats while it keeps billing
    expect(alerts()).toHaveLength(2);
  });

  it("says nothing about the subscription that is actually in force", async () => {
    await buy("sub_old", "developer");
    await buy("sub_new", "team");
    await paid("sub_new");
    expect(alerts()).toHaveLength(0);
    expect(rowOf("sub_new").status).toBe("active");
  });

  it("is loud in the log even when email is not configured", async () => {
    delete process.env.RESEND_API_KEY;
    await buy("sub_old", "developer");
    await buy("sub_new", "team");
    expect((await paid("sub_old")).status).toBe(200);                         // never fails the webhook
    expect(alerts()).toHaveLength(0);
  });
});
