/**
 * The buyer of a deposit is told, durably, what it states.
 *
 * Envelope Study (EUR 9,000) and Portfolio Screen (EUR 15,000) deposits open no intake and no link, so the buyer's only
 * confirmation was Stripe's receipt and the /commissioned page. The receipt is now an obligation in the outbox (0021, kind
 * deposit_receipt via 0034): one per deposit, redelivery-safe, retried when the provider fails, rebuilt from the deposit row.
 *
 * MOCKS: PostgREST fake database, intercepted mail. The SQL check constraint of 0034 is proven on PostgreSQL in
 * tests/test_delivery_handoff_migration.py.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Stripe from "stripe";
import { siteUrl } from "@/lib/site";
import { depositTerms } from "@/lib/engagement-state";
import { SCOPING_PREPARATION, engagementIntakeSchema } from "@/lib/engagement-intake";
import { PostgrestFake } from "./postgrest-fake";
import { paidSession } from "./checkout-fixture";

const WH = "whsec_deposit_receipt";
let db: PostgrestFake;
let undo: () => void;
let mail: { to: string[] | string; subject: string; text: string; key: string | null }[];
let providerDown = false;

beforeEach(() => {
  mail = []; providerDown = false;
  process.env.SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_test";
  process.env.STRIPE_SECRET_KEY = "sk_test_placeholder";
  process.env.STRIPE_WEBHOOK_SECRET = WH;
  process.env.RESEND_API_KEY = "re_test";
  process.env.LEAD_FROM_EMAIL = "Time to Power <power@timetopower.ai>";
  process.env.LEAD_TO_EMAIL = "ops@example.test";
  delete process.env.RESEND_FROM;
  db = new PostgrestFake(["engagement_deposits", "leads", "customer_notifications"]);
  db.uniqueKeys.set("engagement_deposits", [["stripe_session_id"]]);
  db.uniqueKeys.set("customer_notifications", [["dedupe_key"]]);
  db.rowDefaults.set("customer_notifications", () => ({
    status: "pending", attempts: 0, max_attempts: 6, next_attempt_at: new Date(0).toISOString(),
    claimed_until: null, last_error: null, last_http_status: null, provider_message_id: null, accepted_at: null,
  }));
  const restoreDb = db.install();
  const dbFetch = globalThis.fetch;
  globalThis.fetch = (async (i: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof i === "string" ? i : i instanceof URL ? i.href : i.url;
    if (url.startsWith("https://api.resend.com")) {
      if (providerDown) return new Response("{}", { status: 503 });
      const b = JSON.parse(String(init?.body));
      mail.push({ ...b, key: (init?.headers as Record<string, string>)["Idempotency-Key"] ?? null });
      return new Response(JSON.stringify({ id: "em_1" }), { status: 200 });
    }
    return dbFetch(i as RequestInfo, init);
  }) as typeof fetch;
  undo = () => { globalThis.fetch = dbFetch; restoreDb(); };
});
afterEach(() => undo());

const stripe = new Stripe("sk_test_placeholder");
async function pay(kind: string, amount: number, session = "cs_dep_1") {
  const payload = JSON.stringify({ id: `evt_${session}`, type: "checkout.session.completed", data: { object: paidSession({
    id: session, customer_email: "buyer@hall.example", currency: "eur", amount_total: amount,
    metadata: { kind, company: "Hall Co" } }) } });
  const { POST } = await import("@/app/api/stripe/webhook/route");
  return POST(new Request(siteUrl("/api/stripe/webhook"), { method: "POST",
    headers: { "stripe-signature": stripe.webhooks.generateTestHeaderString({ payload, secret: WH }) }, body: payload }));
}
const toBuyer = () => mail.filter((m) => ([] as string[]).concat(m.to).includes("buyer@hall.example"));
const deposit = () => db.rows("engagement_deposits")[0] as any;
const notices = () => (db.rows("customer_notifications") as any[]).filter((n) => n.kind === "deposit_receipt");

describe("the deposit receipt", () => {
  it("states what it reserves, opens and credits, that no date is promised, who contacts them, the reference and what to prepare", async () => {
    expect((await pay("envelope_study_deposit", 900_000)).status).toBe(200);
    const [m] = toBuyer();
    expect(toBuyer()).toHaveLength(1);
    const t = depositTerms("envelope_study_deposit")!;
    for (const line of [t.reserves, t.opens, t.credit, t.timing]) expect(m.text).toContain(line);
    expect(m.text).toContain(`Reference: ${deposit().id}`);
    expect(m.subject).toContain(String(deposit().id).slice(0, 8));
    expect(m.text).toContain("No date is promised until the scope is agreed");
    expect(m.text).toMatch(/nobody is assigned at the moment of payment.*reply to this email quoting the reference/);
    expect(m.text).toMatch(/Density Screen/);                                  // the credit for an earlier Screen
    for (const p of SCOPING_PREPARATION) expect(m.text).toContain(p.label);
    expect(m.text).toContain("DSO connection agreement");
    expect(m.text).not.toMatch(/within \d|business days?|guarantee/i);
    expect(m.text).not.toContain("intake/");                                    // there is no intake link for a deposit
  });

  it("the Portfolio Screen's receipt asks for the list of halls and promises no Screen credit", async () => {
    await pay("portfolio_screen_deposit", 1_500_000);
    const [m] = toBuyer();
    expect(m.text).toContain("The list of halls");
    expect(m.text).not.toMatch(/Density Screen/);
  });

  it("is sent once however often Stripe redelivers, and is one obligation", async () => {
    for (let i = 0; i < 3; i++) expect((await pay("envelope_study_deposit", 900_000)).status).toBe(200);
    expect(toBuyer()).toHaveLength(1);
    expect(notices()).toHaveLength(1);
    expect(notices()[0]).toMatchObject({ status: "accepted", subject_table: "engagement_deposits", subject_id: deposit().id });
    expect(db.rows("engagement_deposits")).toHaveLength(1);
  });

  it("a provider outage leaves a pending obligation (no payment is lost), and the redelivery completes it once", async () => {
    providerDown = true;
    expect((await pay("envelope_study_deposit", 900_000)).status).toBe(200);
    expect(toBuyer()).toHaveLength(0);
    expect(notices()).toEqual([expect.objectContaining({ status: "pending" })]);
    expect(db.rows("engagement_deposits")).toHaveLength(1);                    // the deposit itself is recorded regardless
    providerDown = false;
    for (const n of notices()) n.next_attempt_at = new Date(0).toISOString();
    expect((await pay("envelope_study_deposit", 900_000)).status).toBe(200);
    expect(toBuyer()).toHaveLength(1);
    expect((await pay("envelope_study_deposit", 900_000)).status).toBe(200);
    expect(toBuyer()).toHaveLength(1);
  });

  it("names the contact once a person is recorded against the deposit (a retry after contact says who)", async () => {
    providerDown = true;
    await pay("envelope_study_deposit", 900_000);
    Object.assign(deposit(), { status: "contacted", owner: "A. Rivera" });
    providerDown = false;
    for (const n of notices()) n.next_attempt_at = new Date(0).toISOString();
    await pay("envelope_study_deposit", 900_000);
    expect(toBuyer()[0].text).toContain("A. Rivera is recorded as your contact");
    expect(toBuyer()[0].text).not.toContain("nobody is assigned");
  });

  it("sends nothing for a payment that is not a deposit this site sells (the generic legacy deposit)", async () => {
    expect((await pay("engagement_deposit", 500_000)).status).toBe(200);
    expect(toBuyer()).toHaveLength(0);
    expect(notices()).toHaveLength(0);
    expect(db.rows("engagement_deposits")).toHaveLength(1);
  });

  it("carries no credential: no token, no key", async () => {
    await pay("envelope_study_deposit", 900_000);
    expect(toBuyer()[0].text).not.toMatch(/[A-Za-z0-9_-]{40,}/);
  });
});

describe("what to prepare is the engagement intake's own fields", () => {
  it("every key is a real field of the intake schema, so the list cannot drift from the form", () => {
    const fields = Object.keys(engagementIntakeSchema.shape);
    for (const p of SCOPING_PREPARATION) expect(fields, p.field).toContain(p.field);
    expect(new Set(SCOPING_PREPARATION.map((p) => p.field)).size).toBe(SCOPING_PREPARATION.length);
  });
});
