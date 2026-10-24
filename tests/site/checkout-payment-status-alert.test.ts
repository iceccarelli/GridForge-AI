/**
 * A checkout.session.completed whose payment_status this site does not know is acknowledged WITHOUT fulfilment (a retry cannot change the
 * payload), but it may be a sale that was paid: it is logged as an ERROR and the operator is told, once per session and value. "unpaid" is
 * the one expected not-paid value (a delayed method that settles at checkout.session.async_payment_succeeded) and stays a quiet log.
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

const WH = "whsec_status_alert";
let db: PostgrestFake;
let undo: () => void;
let errors: string[];
let logs: string[];

beforeEach(() => {
  sent.length = 0; errors = []; logs = []; mailUp = true;
  vi.spyOn(console, "error").mockImplementation((...a) => { errors.push(a.join(" ")); });
  vi.spyOn(console, "log").mockImplementation((...a) => { logs.push(a.join(" ")); });
  Object.assign(process.env, { SUPABASE_URL: "https://stub.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "sb_secret_test", STRIPE_SECRET_KEY: "sk_test_status", STRIPE_WEBHOOK_SECRET: WH });
  db = new PostgrestFake(["deliverables", "subscriptions", "customer_notifications", "leads", "funnel_events", "operator_notices"]);
  db.uniqueKeys.set("operator_notices", [["dedupe_key"]]);
  undo = db.install();
});
afterEach(() => { undo(); vi.restoreAllMocks(); });

async function deliver(event: Record<string, unknown>) {
  const payload = JSON.stringify(event);
  const { POST } = await import("@/app/api/stripe/webhook/route");
  return POST(new Request(siteUrl("/api/stripe/webhook"), { method: "POST", headers: { "stripe-signature": new Stripe("sk_test_status").webhooks.generateTestHeaderString({ payload, secret: WH }) }, body: payload }));
}
const session = (status: string) => paidSession({ id: "cs_alert_1", customer_email: "buyer@hall.example", customer: "cus_1", amount_total: 450000, metadata: { kind: "density_screen", company: "Hall Co" }, payment_status: status });

describe("an unknown payment_status", () => {
  it.each(["requires_review", "PAID", "processing"])("%j: 200, nothing fulfilled, logged as an ERROR, the operator told once (however often it is redelivered)", async (status) => {
    for (let n = 0; n < 3; n++) {
      const res = await deliver(checkoutEvent(session(status), { id: `evt_${n}` }));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, received: true, fulfilled: false });
    }
    expect(db.rows("deliverables")).toHaveLength(0);
    expect(errors.join("\n")).toContain(`UNKNOWN payment_status ${status}`);
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toMatch(/payment_status this site does not know/);
    expect(sent[0].text).toContain("cs_alert_1");
    expect(sent[0].text).not.toContain("buyer@hall.example");
  });

  it("`unpaid` (a delayed method) stays a quiet log: no error, no mail", async () => {
    expect((await deliver(checkoutEvent(session("unpaid")))).status).toBe(200);
    expect(sent).toHaveLength(0);
    expect(errors.join("\n")).not.toContain("UNKNOWN");
    expect(logs.join("\n")).toContain("payment_status unpaid");
  });
});

describe("when the operator mail cannot be delivered", () => {
  it("and mail is expected to work: 500, so Stripe redelivers until the only trace of a possibly paid sale can be mailed; then 200, one mail", async () => {
    Object.assign(process.env, { LEAD_TO_EMAIL: "ops@example.test", RESEND_API_KEY: "re_test" });
    try {
      mailUp = false;
      expect((await deliver(checkoutEvent(session("requires_review"), { id: "evt_r" }))).status).toBe(500);
      mailUp = true;
      expect((await deliver(checkoutEvent(session("requires_review"), { id: "evt_r" }))).status).toBe(200);
      expect(sent).toHaveLength(1);
      expect(db.rows("deliverables")).toHaveLength(0);
    } finally {
      delete process.env.LEAD_TO_EMAIL;
      delete process.env.RESEND_API_KEY;
    }
  });

  it("and mail is not configured at all: the logged error is the record and the event is acknowledged (no redelivery loop over a mail nobody can send)", async () => {
    mailUp = false;
    expect((await deliver(checkoutEvent(session("requires_review"), { id: "evt_r" }))).status).toBe(200);
    expect(errors.join("\n")).toContain("UNKNOWN payment_status requires_review");
  });
});
