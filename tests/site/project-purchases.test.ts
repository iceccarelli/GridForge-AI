/**
 * Project → the EXISTING money path → project record.
 *
 * Checkout puts the project's id in the Stripe session metadata after validating the project
 * token; the webhook (the authoritative payment event) opens the deliverable/watch exactly as
 * before and then attaches it to the project. Redelivery is the normal case, so every test that
 * matters delivers the same event twice and counts what exists.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Stripe from "stripe";
import { siteUrl } from "@/lib/site";
import { PostgrestFake } from "./postgrest-fake";
import { installProjectRpcs } from "./project-rpc-fake";

const created: Record<string, any>[] = [];
vi.mock("stripe", async (orig) => {
  const real: any = await orig();
  const Real = real.default;
  return {
    default: class extends Real {
      constructor(key: string) {
        super(key);
        (this as any).coupons = { create: async () => ({ id: "coupon_test" }) };
        (this as any).checkout = {
          sessions: {
            create: async (params: Record<string, unknown>) => {
              created.push(params);
              return { url: "https://checkout.stripe.test/session" };
            },
          },
        };
      }
    },
  };
});

const WH_SECRET = "whsec_test_secret_for_signature_generation";
let db: PostgrestFake;
let restore: () => void;
let stripe: Stripe;

beforeEach(() => {
  process.env.SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_test";
  process.env.STRIPE_SECRET_KEY = "sk_test_placeholder";
  process.env.STRIPE_WEBHOOK_SECRET = WH_SECRET;
  delete process.env.RESEND_API_KEY;
  created.length = 0;
  stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  db = new PostgrestFake([
    "projects", "project_links", "project_events", "project_evidence", "procurement_packages",
    "procurement_responses", "procurement_comparisons", "project_observations", "project_observation_reviews", "supplier_actuals", "supplier_actual_reviews", "supplier_reality", "deliverables", "watches", "watch_notes", "leads",
  ]);
  db.uniqueKeys.set("deliverables", [["stripe_session_id"]]);
  db.uniqueKeys.set("watches", [["stripe_subscription_id"]]);
  installProjectRpcs(db);
  restore = db.install();
});
afterEach(() => restore());

const json = (path: string, body: unknown) =>
  new Request(siteUrl(path), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function project(name = "Hall A"): Promise<{ token: string; id: string }> {
  const { POST } = await import("@/app/api/projects/route");
  const r: any = await (await POST(json("/api/projects", { project_name: name }))).json();
  return { token: r.project_token, id: db.rows("projects").find((p) => p.project_token === r.project_token)!.id as string };
}

function completed(sessionId: string, kind: string, extra: Record<string, unknown> = {}, session: Record<string, unknown> = {}) {
  const event = {
    id: `evt_${sessionId}`,
    type: "checkout.session.completed",
    data: { object: { id: sessionId, object: "checkout_session", customer_email: "buyer@hall.example", amount_total: 450000, customer: "cus_1", metadata: { kind, company: "Hall Co", ...extra }, ...session } },
  };
  const payload = JSON.stringify(event);
  return new Request(siteUrl("/api/stripe/webhook"), {
    method: "POST",
    headers: { "stripe-signature": stripe.webhooks.generateTestHeaderString({ payload, secret: WH_SECRET }), "content-type": "application/json" },
    body: payload,
  });
}
const hook = async (req: Request) => (await import("@/app/api/stripe/webhook/route")).POST(req);
const purchaseEvents = () => db.rows("project_events").filter((e) => e.event_type === "paid_product_attached");

describe("checkout carries the project reference — safely", () => {
  const checkout = async (body: unknown) => (await import("@/app/api/checkout/route")).POST(json("/api/checkout", body));

  it("puts the project's ID (never its token) in the session metadata, at the catalogue price", async () => {
    const p = await project();
    const res = await checkout({ product: "density_screen", project_token: p.token });
    expect(res.status).toBe(200);
    expect(created).toHaveLength(1);
    expect(created[0].metadata).toMatchObject({ kind: "density_screen", project_id: p.id });
    expect(JSON.stringify(created[0])).not.toContain(p.token);
    expect(created[0].line_items[0].price_data.unit_amount).toBe(450000); // lib/products.ts, unchanged
  });

  it("carries it on a subscription too", async () => {
    const p = await project();
    await checkout({ product: "hall_watch", project_token: p.token });
    expect(created[0].mode).toBe("subscription");
    expect(created[0].subscription_data.metadata.project_id).toBe(p.id);
    expect(created[0].metadata.project_id).toBe(p.id);
  });

  it("refuses — with no Stripe session — a wrong token, a product that cannot attach, or a store that cannot say", async () => {
    const p = await project();
    expect((await checkout({ product: "density_screen", project_token: "nope" })).status).toBe(404);
    expect((await checkout({ product: "api_triage", project_token: p.token })).status).toBe(400);
    expect((await checkout({ project_token: p.token })).status).toBe(400); // the generic deposit is not per-project
    expect((await checkout({ product: "density_screen", project_token: 7 })).status).toBe(400);
    delete process.env.SUPABASE_URL;
    expect((await checkout({ product: "density_screen", project_token: p.token })).status).toBe(503);
    expect(created).toHaveLength(0);
  });

  it("leaves a checkout with no project exactly as it was", async () => {
    await checkout({ product: "density_screen" });
    expect("project_id" in created[0].metadata).toBe(false);
  });
});

describe("the webhook attaches the purchase to its project, once", () => {
  it("Density Screen: one deliverable, one link, one event — however many times Stripe redelivers", async () => {
    const p = await project();
    for (let i = 0; i < 3; i++) expect((await hook(completed("cs_ds_1", "density_screen", { project_id: p.id }))).status).toBe(200);
    const [d] = db.rows("deliverables");
    expect(db.rows("deliverables")).toHaveLength(1);
    expect(db.rows("project_links").filter((l) => l.object_type === "deliverable")).toEqual([
      expect.objectContaining({ project_id: p.id, object_id: d.id }),
    ]);
    expect(purchaseEvents()).toHaveLength(1);
    expect(purchaseEvents()[0].payload).toMatchObject({
      kind: "density_screen", object_type: "deliverable", object_id: d.id, amount_cents: 450000, stripe_session_id: "cs_ds_1",
    });
    // the document/intake tokens never reach the project record
    expect(JSON.stringify(db.rows("project_links")) + JSON.stringify(purchaseEvents())).not.toContain(String(d.token));
  });

  it("Procurement Specification attaches the same way", async () => {
    const p = await project();
    await hook(completed("cs_ps_1", "procurement_spec", { project_id: p.id }, { amount_total: 1800000 }));
    expect(purchaseEvents()[0].payload).toMatchObject({ kind: "procurement_spec", amount_cents: 1800000 });
    expect(db.rows("project_links")).toHaveLength(1);
  });

  it("Hall Watch: one watch, one link, one event across redeliveries", async () => {
    const p = await project();
    const sub = { subscription: "sub_w1", amount_total: 600000 };
    for (let i = 0; i < 2; i++) await hook(completed("cs_w_1", "hall_watch", { project_id: p.id }, sub));
    expect(db.rows("watches")).toHaveLength(1);
    expect(db.rows("project_links").filter((l) => l.object_type === "watch")).toHaveLength(1);
    expect(purchaseEvents()).toHaveLength(1);
  });

  it("Envelope Study deposit has no object: the event alone, once", async () => {
    const p = await project();
    for (let i = 0; i < 2; i++) await hook(completed("cs_es_1", "envelope_study_deposit", { project_id: p.id }, { amount_total: 900000 }));
    expect(db.rows("project_links")).toHaveLength(0);
    expect(purchaseEvents()).toHaveLength(1);
    expect(purchaseEvents()[0].payload).toMatchObject({ kind: "envelope_study_deposit", object_type: null, amount_cents: 900000 });
  });

  it("a purchase with no project behaves exactly as before", async () => {
    await hook(completed("cs_plain", "density_screen"));
    expect(db.rows("deliverables")).toHaveLength(1);
    expect(db.rows("project_links")).toHaveLength(0);
    expect(db.rows("project_events")).toHaveLength(0);
  });

  it("a transient failure asks Stripe to retry, and the retry does not duplicate the deliverable", async () => {
    const p = await project();
    db.failEvents = true;
    expect((await hook(completed("cs_ds_2", "density_screen", { project_id: p.id }))).status).toBe(500);
    expect(db.rows("deliverables")).toHaveLength(1);      // the customer is fulfilled
    expect(db.rows("project_links")).toHaveLength(0);     // but the attachment left no half-state
    expect(purchaseEvents()).toHaveLength(0);
    db.failEvents = false;
    expect((await hook(completed("cs_ds_2", "density_screen", { project_id: p.id }))).status).toBe(200);
    expect(db.rows("deliverables")).toHaveLength(1);
    expect(db.rows("project_links")).toHaveLength(1);
    expect(purchaseEvents()).toHaveLength(1);
  });

  it("a project that does not exist never fails a paid, fulfilled purchase", async () => {
    const res = await hook(completed("cs_ds_3", "density_screen", { project_id: "00000000-0000-4000-8000-00000000dead" }));
    expect(res.status).toBe(200);
    expect(db.rows("deliverables")).toHaveLength(1);
    expect(purchaseEvents()).toHaveLength(0);
  });

  it("an object already in another project is never moved", async () => {
    const a = await project("A");
    const b = await project("B");
    await hook(completed("cs_ds_4", "density_screen", { project_id: a.id }));
    // the same deliverable arriving under a different project (e.g. a replayed, doctored delivery)
    await hook(completed("cs_ds_4", "density_screen", { project_id: b.id }));
    expect(db.rows("project_links").map((l) => l.project_id)).toEqual([a.id]);
    expect(purchaseEvents()).toHaveLength(1);
  });
});

describe("the project record shows what was bought, from real records", () => {
  it("lists the engagement with its live status and the amount Stripe reported", async () => {
    const p = await project();
    await hook(completed("cs_ds_5", "density_screen", { project_id: p.id }));
    await hook(completed("cs_es_5", "envelope_study_deposit", { project_id: p.id }, { amount_total: 900000 }));
    const { GET } = await import("@/app/api/projects/[token]/route");
    const s: any = await (await GET(new Request(siteUrl("/x")), { params: Promise.resolve({ token: p.token }) })).json();
    expect(s.engagements).toEqual([
      expect.objectContaining({ kind: "density_screen", name: "Density Screen", amount_cents: 450000, object_type: "deliverable", status: "awaiting_intake" }),
      expect.objectContaining({ kind: "envelope_study_deposit", object_type: null, status: null, amount_cents: 900000 }),
    ]);
    // a deliverable's credentials never appear in project state
    expect(JSON.stringify(s)).not.toMatch(/intake_token|document_html/);
  });
});
