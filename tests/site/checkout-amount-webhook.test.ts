/**
 * A PAID one-time checkout whose amount or currency differs from the catalogue is fulfilled exactly as a normal sale (the money is taken)
 * and the operator is told once per session. The same sale at the catalogue price sends no such notice.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Stripe from "stripe";
import { siteUrl } from "@/lib/site";
import { PostgrestFake } from "./postgrest-fake";
import { checkoutEvent, paidSession } from "./checkout-fixture";

const sent: { subject: string; text: string }[] = [];
let mailUp = true;
vi.mock("@/lib/mail", async (orig) => ({
  ...(await orig<typeof import("@/lib/mail")>()),
  notifyOperator: async (subject: string, text: string) => {
    if (!mailUp) return { sent: false, category: "provider_error", reason: "down" };
    sent.push({ subject, text });
    return { sent: true, id: "m1" };
  },
}));

const WH = "whsec_amount_mismatch";
let db: PostgrestFake;
let undo: () => void;
let errors: string[];
let logs: string[];

beforeEach(() => {
  sent.length = 0; errors = []; logs = []; mailUp = true;
  vi.spyOn(console, "error").mockImplementation((...a) => { errors.push(a.join(" ")); });
  vi.spyOn(console, "log").mockImplementation((...a) => { logs.push(a.join(" ")); });
  Object.assign(process.env, { SUPABASE_URL: "https://stub.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "sb_secret_test", STRIPE_SECRET_KEY: "sk_test_amount", STRIPE_WEBHOOK_SECRET: WH });
  db = new PostgrestFake(["deliverables", "subscriptions", "customer_notifications", "leads", "funnel_events", "operator_notices"]);
  db.uniqueKeys.set("operator_notices", [["dedupe_key"]]);
  undo = db.install();
});
afterEach(() => { undo(); vi.restoreAllMocks(); });

async function deliver(event: Record<string, unknown>) {
  const payload = JSON.stringify(event);
  const { POST } = await import("@/app/api/stripe/webhook/route");
  return POST(new Request(siteUrl("/api/stripe/webhook"), { method: "POST", headers: { "stripe-signature": new Stripe("sk_test_amount").webhooks.generateTestHeaderString({ payload, secret: WH }) }, body: payload }));
}
const session = (fields: Record<string, unknown>) => paidSession({ id: "cs_amt_1", customer_email: "buyer@hall.example", customer: "cus_1", metadata: { kind: "density_screen", company: "Hall Co" }, ...fields });
const mismatchMails = () => sent.filter((m) => /does not match the catalogue/.test(m.subject));

describe("a paid one-time checkout that does not match the catalogue", () => {
  it("is fulfilled, the operator is told once however often it is redelivered, and no customer detail is in the mail", async () => {
    for (let n = 0; n < 3; n++) {
      const res = await deliver(checkoutEvent(session({ amount_subtotal: 90000, amount_total: 90000, currency: "eur" }), { id: `evt_${n}` }));
      expect(res.status).toBe(200);
    }
    expect(db.rows("deliverables")).toHaveLength(1);
    expect(mismatchMails()).toHaveLength(1);
    expect(mismatchMails()[0].text).toContain("charged 90000 cents");
    expect(mismatchMails()[0].text).toContain("cs_amt_1");
    expect(mismatchMails()[0].text).not.toContain("buyer@hall.example");
    expect(errors.join("\n")).toContain("does not match the catalogue");
  });

  it("a different currency at the right number is flagged too", async () => {
    expect((await deliver(checkoutEvent(session({ amount_subtotal: 450000, amount_total: 450000, currency: "usd" })))).status).toBe(200);
    expect(db.rows("deliverables")).toHaveLength(1);
    expect(mismatchMails()[0].text).toContain("charged in USD");
  });

  it("the catalogue price in EUR sends no mismatch notice", async () => {
    expect((await deliver(checkoutEvent(session({ amount_subtotal: 450000, amount_total: 450000, currency: "eur" })))).status).toBe(200);
    expect(db.rows("deliverables")).toHaveLength(1);
    expect(mismatchMails()).toHaveLength(0);
  });
});
