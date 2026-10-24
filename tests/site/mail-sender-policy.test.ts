/**
 * One sender policy for every outbound message.
 *
 * Production carries LEAD_FROM_EMAIL and not RESEND_FROM. The Stripe webhook's customer mail (intake link,
 * API-access link, watch link, key-rotation reminder) and the watch cron read RESEND_FROM alone, so on
 * that configuration a EUR 4,500 buyer's intake link was silently never sent, while the operator mail
 * (which resolved LEAD_FROM_EMAIL too) went out and made everything look healthy.
 *
 * FAKE-BACKED store; email intercepted (Resend is not contacted).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Stripe from "stripe";
import { siteUrl } from "@/lib/site";
import { mailSender } from "@/lib/mail";
import { PostgrestFake } from "./postgrest-fake";
import { paidSession } from "./checkout-fixture";

const WH = "whsec_mail_sender_policy";
let db: PostgrestFake;
let undo: () => void;
let mail: { from: string; to: string[] | string; subject: string; text: string }[];
let logged: string[];

beforeEach(() => {
  mail = [];
  logged = [];
  vi.spyOn(console, "error").mockImplementation((...a) => { logged.push(a.map(String).join(" ")); });
  vi.spyOn(console, "log").mockImplementation(() => {});
  process.env.SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_test";
  process.env.STRIPE_SECRET_KEY = "sk_test_placeholder";
  process.env.STRIPE_WEBHOOK_SECRET = WH;
  process.env.RESEND_API_KEY = "re_test";
  delete process.env.RESEND_FROM;
  delete process.env.LEAD_FROM_EMAIL;
  delete process.env.LEAD_TO_EMAIL;
  db = new PostgrestFake(["deliverables", "leads", "qualifications"]);
  db.uniqueKeys.set("deliverables", [["stripe_session_id"]]);
  const restoreDb = db.install();
  const dbFetch = globalThis.fetch;
  globalThis.fetch = (async (i: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof i === "string" ? i : i instanceof URL ? i.href : i.url;
    if (url.startsWith("https://api.resend.com")) { mail.push(JSON.parse(String(init?.body))); return new Response("{}", { status: 200 }); }
    return dbFetch(i as RequestInfo, init);
  }) as typeof fetch;
  undo = () => { globalThis.fetch = dbFetch; restoreDb(); };
});
afterEach(() => { undo(); vi.restoreAllMocks(); });

const stripe = new Stripe("sk_test_placeholder");
async function buy(id = "cs_ds_1", evt = "evt_ds") {
  const payload = JSON.stringify({ id: evt, type: "checkout.session.completed", data: { object: paidSession({
    id, customer_email: "buyer@hall.example", customer: "cus_1", amount_total: 450_000,
    metadata: { kind: "density_screen", company: "Hall Co" } }) } });
  const { POST } = await import("@/app/api/stripe/webhook/route");
  return POST(new Request(siteUrl("/api/stripe/webhook"), { method: "POST",
    headers: { "stripe-signature": stripe.webhooks.generateTestHeaderString({ payload, secret: WH }) }, body: payload }));
}
const toBuyer = () => mail.filter((m) => ([] as string[]).concat(m.to).includes("buyer@hall.example"));

describe("the sender policy", () => {
  it("is RESEND_FROM, then LEAD_FROM_EMAIL, then the caller's fallback, then nothing", () => {
    expect(mailSender()).toBeNull();
    expect(mailSender("fallback <f@x.test>")).toBe("fallback <f@x.test>");
    process.env.LEAD_FROM_EMAIL = "lead <lead@x.test>";
    expect(mailSender("fallback <f@x.test>")).toBe("lead <lead@x.test>");
    process.env.RESEND_FROM = "resend <resend@x.test>";
    expect(mailSender()).toBe("resend <resend@x.test>");
  });
});

describe("the paid buyer's intake link on the production configuration (LEAD_FROM_EMAIL only)", () => {
  it("is sent, from the resolved sender, exactly once, and a Stripe retry does not send it again", async () => {
    process.env.LEAD_FROM_EMAIL = "Time to Power <power@timetopower.ai>";
    expect((await buy()).status).toBe(200);
    const row = db.rows("deliverables")[0] as any;
    expect(toBuyer()).toHaveLength(1);
    expect(toBuyer()[0].from).toBe("Time to Power <power@timetopower.ai>");
    expect(toBuyer()[0].text).toContain(`/intake/${row.intake_token}`);
    expect(toBuyer()[0].text).not.toContain(row.token);          // the document token is never in the intake email

    expect((await buy("cs_ds_1", "evt_ds_retry")).status).toBe(200);
    expect(db.rows("deliverables")).toHaveLength(1);
    expect(toBuyer()).toHaveLength(1);
  });

  it("RESEND_FROM still wins when both are set", async () => {
    process.env.LEAD_FROM_EMAIL = "lead <lead@x.test>";
    process.env.RESEND_FROM = "resend <resend@x.test>";
    await buy();
    expect(toBuyer()[0].from).toBe("resend <resend@x.test>");
  });
});

describe("no sender anywhere", () => {
  it("still fulfils the purchase (200, one deliverable) and says out loud that the link was not emailed -- naming the record, never the link", async () => {
    const res = await buy();
    expect(res.status).toBe(200);
    const row = db.rows("deliverables")[0] as any;
    expect(row).toBeTruthy();
    expect(toBuyer()).toHaveLength(0);
    const line = logged.find((l) => l.includes("email NOT sent"));
    expect(line, logged.join("\n")).toBeTruthy();
    expect(line).toContain(row.id);                       // traceable to the paid record
    expect(line).toContain("not_configured");
    const all = logged.join("\n");
    for (const secret of [row.intake_token, row.token, "/intake/", "buyer@hall.example"]) expect(all).not.toContain(secret);
  });
});
