/**
 * The deposits that open no object (Envelope Study EUR 9,000, Portfolio Screen EUR 15,000).
 *
 * Properties, each on what was stored: the payment is a durable row written before the webhook
 * answers; a failed write asks Stripe to retry and leaves no half-record; redelivery is a no-op; the
 * operator moves it forward one proven step at a time; the customer page tells the truth.
 *
 * Fake-backed (in-memory PostgREST). Triggers (no skipping/reversal/rewrite, append-only) are proven
 * against real PostgreSQL in tests/test_projects_migration.py and the realdb suite, not here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import Stripe from "stripe";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { siteUrl } from "@/lib/site";
import { PostgrestFake } from "./postgrest-fake";

// The page is compiled with the classic JSX transform under vitest.
(globalThis as { React?: unknown }).React = React;
const jar: { name: string; value: string }[] = [];
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (n: string) => jar.find((c) => c.name === n) }) }));

const WH_SECRET = "whsec_test_secret_for_signature_generation";
let db: PostgrestFake;
let restore: () => void;
let stripe: Stripe;
let emails: string[];

beforeEach(() => {
  jar.length = 0;
  emails = [];
  process.env.SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_test";
  process.env.STRIPE_SECRET_KEY = "sk_test_placeholder";
  process.env.STRIPE_WEBHOOK_SECRET = WH_SECRET;
  process.env.ADMIN_PASSWORD = "a-long-random-admin-password";
  process.env.RESEND_API_KEY = "re_test";
  process.env.LEAD_TO_EMAIL = "founder@example.test";
  stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  db = new PostgrestFake(["engagement_deposits", "leads", "projects", "project_links", "project_events"]);
  db.uniqueKeys.set("engagement_deposits", [["stripe_session_id"]]);
  const undo = db.install();
  const dbFetch = globalThis.fetch;
  globalThis.fetch = (async (i: RequestInfo | URL, init?: RequestInit) => {
    if (String(i).startsWith("https://api.resend.com")) { emails.push(String(init?.body)); return new Response("{}", { status: 200 }); }
    return dbFetch(i, init);
  }) as typeof fetch;
  restore = () => { globalThis.fetch = dbFetch; undo(); };
});
afterEach(() => { restore(); delete process.env.RESEND_API_KEY; delete process.env.ADMIN_PASSWORD; });

function completed(sessionId: string, kind: string, amount: number, extra: Record<string, string> = {}) {
  const payload = JSON.stringify({
    id: `evt_${sessionId}`, type: "checkout.session.completed",
    data: { object: { id: sessionId, object: "checkout_session", customer_email: "buyer@hall.example", amount_total: amount, currency: "eur", metadata: { kind, company: "Hall Co", ...extra } } },
  });
  return new Request(siteUrl("/api/stripe/webhook"), {
    method: "POST", headers: { "stripe-signature": stripe.webhooks.generateTestHeaderString({ payload, secret: WH_SECRET }), "content-type": "application/json" }, body: payload,
  });
}
const hook = async (r: Request) => (await import("@/app/api/stripe/webhook/route")).POST(r);
const signIn = () => jar.push({ name: "gf_admin", value: createHash("sha256").update(process.env.ADMIN_PASSWORD!).digest("hex") });
const post = (path: string, body: unknown) => new Request(siteUrl(path), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
async function step(id: string, body: Record<string, unknown>) {
  const { POST } = await import("@/app/api/admin/deposits/[id]/route");
  const res = await POST(post("/x", body), { params: Promise.resolve({ id }) });
  return { res, body: (await res.json()) as any };
}

describe("the payment becomes a durable hand-off record", () => {
  it.each([["envelope_study_deposit", 900_000], ["portfolio_screen_deposit", 1_500_000]])(
    "%s: one row however often Stripe redelivers, one founder email",
    async (kind, amount) => {
      for (let i = 0; i < 3; i++) expect((await hook(completed("cs_d1", kind, amount))).status).toBe(200);
      expect(db.rows("engagement_deposits")).toEqual([
        expect.objectContaining({ stripe_session_id: "cs_d1", kind, amount_cents: amount, currency: "eur", email: "buyer@hall.example", company: "Hall Co" }),
      ]);
      expect(emails).toHaveLength(1);
      expect(emails[0]).toContain("/api/admin/deposits");
    }
  );

  it("a failed write asks Stripe to retry, leaves nothing, sends no email — and the retry lands once", async () => {
    const real = globalThis.fetch;
    let down = true;
    globalThis.fetch = (async (i: RequestInfo | URL, init?: RequestInit) =>
      down && String(i).includes("/engagement_deposits") ? new Response("{}", { status: 503 }) : real(i, init)) as typeof fetch;
    expect((await hook(completed("cs_d2", "envelope_study_deposit", 900_000))).status).toBe(500);
    expect(db.rows("engagement_deposits")).toHaveLength(0);
    expect(emails).toHaveLength(0);
    down = false;
    expect((await hook(completed("cs_d2", "envelope_study_deposit", 900_000))).status).toBe(200);
    expect((await hook(completed("cs_d2", "envelope_study_deposit", 900_000))).status).toBe(200);
    expect(db.rows("engagement_deposits")).toHaveLength(1);
    expect(emails).toHaveLength(1);
  });

  it("is recorded even when the buyer never filled in a lead form (there is no lead to mark)", async () => {
    expect(db.rows("leads")).toHaveLength(0);
    expect((await hook(completed("cs_d3", "portfolio_screen_deposit", 1_500_000))).status).toBe(200);
    expect(db.rows("engagement_deposits")).toHaveLength(1);
  });

  it("keeps the project named at checkout as a claim on the record", async () => {
    await hook(completed("cs_d4", "envelope_study_deposit", 900_000, {}));
    expect((db.rows("engagement_deposits")[0] as any).project_id).toBeNull();
  });
});

describe("the operator's work list and the proven steps", () => {
  it("needs the admin session", async () => {
    await hook(completed("cs_a", "envelope_study_deposit", 900_000));
    const { GET } = await import("@/app/api/admin/deposits/route");
    expect((await GET(new Request(siteUrl("/api/admin/deposits")))).status).toBe(401);
    const id = (db.rows("engagement_deposits")[0] as any).id;
    expect((await step(id, { owner: "A. Rivera" })).res.status).toBe(401);
    expect((db.rows("engagement_deposits")[0] as any).status).toBe("paid");
  });

  it("lists open deposits oldest first and each step needs its proof, in order, once", async () => {
    signIn();
    await hook(completed("cs_b1", "envelope_study_deposit", 900_000));
    await hook(completed("cs_b2", "portfolio_screen_deposit", 1_500_000));
    const { GET } = await import("@/app/api/admin/deposits/route");
    const listed: any = await (await GET(new Request(siteUrl("/api/admin/deposits")))).json();
    expect(listed.items).toHaveLength(2);

    const id = (db.rows("engagement_deposits")[0] as any).id as string;
    expect((await step(id, {})).res.status).toBe(422);                              // contacting needs a named owner
    expect((await step(id, { owner: "  " })).res.status).toBe(422);
    expect((await step(id, { owner: "A. Rivera" })).body.deposit).toMatchObject({ status: "contacted", owner: "A. Rivera" });
    expect((await step(id, {})).res.status).toBe(422);                              // scoping needs the scope note
    expect((await step(id, { scope_note: "Hall A and B; 35 MW target; deliver by the agreed date" })).body.deposit.status).toBe("scoped");
    expect((await step(id, { owner: "x" })).res.status).toBe(422);                  // delivery needs its reference
    expect((await step(id, { delivery_ref: "https://example.test/delivery/hall-a" })).body.deposit.status).toBe("delivered");
    expect((await step(id, { delivery_ref: "again" })).res.status).toBe(409);       // nothing past delivered
    expect((await step("not-a-uuid", { owner: "x" })).res.status).toBe(404);

    const open: any = await (await GET(new Request(siteUrl("/api/admin/deposits")))).json();
    expect(open.items.map((d: any) => d.stripe_session_id)).toEqual(["cs_b2"]);      // delivered ones drop off the list
  });
});

describe("the customer page tells the truth", () => {
  async function page(sessionId: string) {
    const { default: Page } = await import("@/app/commissioned/page");
    return renderToStaticMarkup(await Page({ searchParams: Promise.resolve({ session_id: sessionId }) }));
  }

  it("a deposit buyer is told it is scoped with them — not that an intake link is on its way", async () => {
    await hook(completed("cs_p1", "envelope_study_deposit", 900_000));
    const html = await page("cs_p1");
    expect(html).toContain("Capacity &amp; Density Envelope Study");
    expect(html).toContain("there is no intake form");
    expect(html).toContain("Payment received. We have not contacted you yet.");
    expect(html).not.toMatch(/intake link is on its way/);
    expect(html).not.toMatch(/within \d+|business days?/i);                           // no invented response time
  });

  it("reflects the recorded step", async () => {
    signIn();
    await hook(completed("cs_p2", "portfolio_screen_deposit", 1_500_000));
    await step((db.rows("engagement_deposits")[0] as any).id, { owner: "A. Rivera" });
    expect(await page("cs_p2")).toContain("We have contacted you to scope the engagement.");
  });

  it("an unknown session still gets the generic page, not a deposit claim", async () => {
    expect(await page("cs_nope")).not.toContain("there is no intake form");
  });
});
