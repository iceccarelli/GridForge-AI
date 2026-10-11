/**
 * The money path, as an executed truth table — one row per thing the catalogue sells.
 *
 *   Catalogue -> Checkout -> signed Stripe event -> Fulfilment -> intake -> engine -> human release -> customer
 *
 * Rows come FROM lib/products.ts (PRODUCTS and INTELLIGENCE_PLANS), not from a list typed here, so a
 * product added to the catalogue appears in this table with every cell unproven until it earns them.
 * Every cell is proven by running the real route handler; a cell is never filled from a comment.
 *
 * What is real and what is not, stated once:
 *   real  — the route handlers, the Stripe SDK's own signature verification, the Python capacity engine
 *           (a subprocess; this is what generates the deliverables), the catalogue and the registry
 *   fake  — PostgREST/Supabase (the in-memory fake) and Stripe SESSION CREATION (a stub that records what
 *           would have been sent). Nothing here talks to Stripe, so "a customer can pay" is NOT proven by
 *           this file — only that the request we would send carries the catalogue's exact product and amount.
 *   NOT proven anywhere in this repository: a live or test-mode Stripe Checkout round trip.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Stripe from "stripe";
import { siteUrl } from "@/lib/site";
import { PRODUCTS, INTELLIGENCE_PLANS, type Product } from "@/lib/products";
import { CAPABILITY_REGISTRY } from "@/lib/capability-registry";
import { PostgrestFake } from "./postgrest-fake";

// ---- stand-ins ------------------------------------------------------------------------------------------
const sent: Record<string, any>[] = [];
vi.mock("stripe", async (orig) => {
  const real: any = await orig();
  const Real = real.default;
  return {
    default: class extends Real {
      constructor(key: string) {
        super(key);
        (this as any).coupons = { create: async () => ({ id: "coupon_test" }) };
        (this as any).checkout = {
          sessions: { create: async (p: Record<string, unknown>) => { sent.push(p); return { url: "https://checkout.stripe.test/s" }; } },
        };
      }
    },
  };
});
const jar: { name: string; value: string }[] = [];
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (n: string) => jar.find((c) => c.name === n) }) }));

const WH_SECRET = "whsec_money_path_truth_table_secret";
const hasPython = spawnSync("python3", ["--version"]).status === 0;
const ENGINE_KEY = "truth-table-key";
let engine: ChildProcess | null = null;
let ENGINE = "";
let db: PostgrestFake;
let restore: () => void;
const realFetch = globalThis.fetch;

async function startEngine(): Promise<string> {
  const code = [
    "import os", `os.environ['GRIDFORGE_API_KEYS']='${ENGINE_KEY}'`, "os.environ['GRIDFORGE_RATE_LIMIT']='0'",
    "os.environ['GRIDFORGE_KEY_SECRET']='truth-table-signing-secret'", "os.environ['GRIDFORGE_ADMIN_KEY']='truth-table-admin'",
    `os.environ['GRIDFORGE_REVOKED_FILE']=${JSON.stringify(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "gf-tt-")), "revoked.json"))}`,
    "from gridforge.api.server import Handler, make_server", "Handler.limiter.per_minute=0",
    "h=make_server('127.0.0.1',0)", "print(h.server_address[1],flush=True)", "h.serve_forever()",
  ].join("\n");
  engine = spawn("python3", ["-c", code], { cwd: process.cwd(), stdio: ["ignore", "pipe", "inherit"] });
  return await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error("engine did not start")), 20_000);
    engine!.stdout!.once("data", (d) => { clearTimeout(t); res(`http://127.0.0.1:${String(d).trim()}`); });
  });
}

beforeAll(async () => { if (hasPython) ENGINE = await startEngine(); }, 30_000);
afterAll(() => { engine?.kill(); printTable(); });

beforeEach(() => {
  process.env.SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_test";
  process.env.STRIPE_SECRET_KEY = "sk_test_placeholder";
  process.env.STRIPE_WEBHOOK_SECRET = WH_SECRET;
  process.env.GRIDFORGE_API_URL = ENGINE;
  process.env.GRIDFORGE_API_KEY = ENGINE_KEY;
  process.env.GRIDFORGE_KEY_SECRET = "truth-table-signing-secret";
  process.env.GRIDFORGE_ADMIN_KEY = "truth-table-admin";
  process.env.ADMIN_PASSWORD = "a-long-random-admin-password";
  delete process.env.RESEND_API_KEY;
  sent.length = 0;
  jar.length = 0;
  db = new PostgrestFake(["deliverables", "watches", "watch_notes", "api_accounts", "subscriptions", "leads", "qualifications", "scenarios", "engagement_deposits"]);
  db.uniqueKeys.set("engagement_deposits", [["stripe_session_id"]]);
  db.uniqueKeys.set("deliverables", [["stripe_session_id"]]);
  db.uniqueKeys.set("watches", [["stripe_subscription_id"]]);
  db.uniqueKeys.set("api_accounts", [["stripe_subscription_id"]]);
  const undo = db.install();
  const dbFetch = globalThis.fetch;
  globalThis.fetch = (async (i: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof i === "string" ? i : i instanceof URL ? i.href : i.url;
    return url.startsWith(ENGINE) ? realFetch(i as RequestInfo, init) : dbFetch(i as RequestInfo, init);
  }) as typeof fetch;
  restore = () => undo();
});
afterEach(() => restore());

// ---- the table -------------------------------------------------------------------------------------------
type Cell = "proven" | "n/a" | "manual" | "UNPROVEN";
interface Row {
  product: string; price: string; mode: string;
  purchasable: Cell; signedWebhook: Cell; idempotent: Cell; fulfilment: string;
  intake: Cell; engine: Cell; humanRelease: Cell; customerAccess: Cell; registry: Cell;
  /** recurring products only: failed payment restricts, renewal restores, cancellation ends, an unapplied event is retried */
  lifecycle: Cell;
  /** what the entitlement actually lets the customer DO, and with which kind of proof */
  access: string;
}
const rows = new Map<string, Row>();
const row = (id: string, price: string, mode: string): Row => {
  if (!rows.has(id)) {
    rows.set(id, { product: id, price, mode, purchasable: "UNPROVEN", signedWebhook: "UNPROVEN", idempotent: "UNPROVEN",
      fulfilment: "UNPROVEN", intake: "n/a", engine: "n/a", humanRelease: "n/a", customerAccess: "n/a", registry: "UNPROVEN", lifecycle: mode === "subscription" ? "UNPROVEN" : "n/a", access: "n/a" });
  }
  return rows.get(id)!;
};
function printTable() {
  if (rows.size) console.table([...rows.values()]);
}

// ---- helpers ---------------------------------------------------------------------------------------------
const json = (p: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(siteUrl(p), { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const eur = (cents: number) => `€${(cents / 100).toLocaleString("en-IE")}`;

function signed(sessionId: string, kind: string, extra: Record<string, unknown> = {}, meta: Record<string, string> = {}) {
  const payload = JSON.stringify({
    id: `evt_${sessionId}`, type: "checkout.session.completed",
    data: { object: { id: sessionId, object: "checkout_session", customer_email: "buyer@hall.example", customer: "cus_1",
      amount_total: 100000, metadata: { kind, company: "Hall Co", ...meta }, ...extra } },
  });
  const sig = new Stripe("sk_test_placeholder").webhooks.generateTestHeaderString({ payload, secret: WH_SECRET });
  return new Request(siteUrl("/api/stripe/webhook"), { method: "POST", headers: { "stripe-signature": sig }, body: payload });
}
const hook = async (r: Request) => (await import("@/app/api/stripe/webhook/route")).POST(r);

const INTAKE = {
  siteName: "North Hall", hallId: "H1", metro: "Dublin", firmCapacityMVA: 15, contractedMW: 12, currentPeakMW: 7.4,
  currentItLoadMW: 4.9, buswayAmpacityA: 400, tapoffMaxA: 63, floorLoadingKPa: 12, positionsAvailable: 180,
  plantCapacityKW: 6000, plantSupplyC: 6, platform: "gb300_nvl72",
};

function fulfilmentClass(p: Product): "deliverable" | "watch" | "api_account" | "manual" {
  if (p.apiUnits) return "api_account";
  if (p.kind === "hall_watch") return "watch";
  if (p.producesDeliverable) return "deliverable";
  return "manual";           // a deposit: a person scopes the work; no object is opened
}

/** The registry must name this product and its web route must be a page that exists. */
function registryProves(productId: string): boolean {
  const cap = CAPABILITY_REGISTRY.find((c) => c.product_id === productId);
  if (!cap || cap.status === "internal_only" || cap.production_status !== "live") return false;
  if (!cap.web_route) return false;
  const dir = path.join(process.cwd(), "app", cap.web_route);
  return fs.existsSync(path.join(dir, "page.tsx")) || fs.existsSync(path.join(dir, "route.ts"));
}

const CI = process.env.CI === "true";
it.runIf(CI)("the real engine is available in CI (the deliverable cells cannot be skipped there)", () => {
  expect(hasPython).toBe(true);
});

// ---- recurring lifecycle: the same assertions for every product that renews --------------------------------
function billing(type: string, object: Record<string, unknown>) {
  const payload = JSON.stringify({ id: `evt_${type}_${Math.random().toString(36).slice(2)}`, type, data: { object } });
  const sig = new Stripe("sk_test_placeholder").webhooks.generateTestHeaderString({ payload, secret: WH_SECRET });
  return new Request(siteUrl("/api/stripe/webhook"), { method: "POST", headers: { "stripe-signature": sig }, body: payload });
}
const invoiceEvt = (type: "invoice.paid" | "invoice.payment_failed", sub: string) => billing(type, { id: `in_${sub}`, object: "invoice", subscription: sub });
const deletedEvt = (sub: string, kind: string) => billing("customer.subscription.deleted", { id: sub, object: "subscription", metadata: { kind } });

/**
 * failed payment restricts (where the product has a restricted state), renewal restores, cancellation ends,
 * late invoice events never reopen it, and an event whose write fails is retried — then applied, once.
 */
async function proveLifecycle(opts: { kind: string; sub: string; meta: Record<string, string>; table: string; status: () => string | undefined;
  afterFailure: string; checkoutSession: string }) {
  expect((await hook(signed(opts.checkoutSession, opts.kind, { subscription: opts.sub }, opts.meta))).status).toBe(200);
  expect(opts.status()).toBe("active");
  expect((await hook(invoiceEvt("invoice.payment_failed", opts.sub))).status).toBe(200);
  expect(opts.status()).toBe(opts.afterFailure);
  expect((await hook(invoiceEvt("invoice.paid", opts.sub))).status).toBe(200);
  expect(opts.status()).toBe("active");

  const realFetchNow = globalThis.fetch;
  globalThis.fetch = (async (i: RequestInfo | URL, init?: RequestInit) =>
    (init?.method ?? "GET") === "PATCH" && String(i).includes(`/rest/v1/${opts.table}`)
      ? new Response("{}", { status: 503 }) : realFetchNow(i as RequestInfo, init)) as typeof fetch;
  try {
    expect((await hook(deletedEvt(opts.sub, opts.kind))).status).toBe(500);          // not applied -> Stripe must redeliver
    expect(opts.status()).toBe("active");
  } finally { globalThis.fetch = realFetchNow; }
  for (let i = 0; i < 2; i++) expect((await hook(deletedEvt(opts.sub, opts.kind))).status).toBe(200);
  expect(opts.status()).toBe("cancelled");
  await hook(invoiceEvt("invoice.payment_failed", opts.sub));
  await hook(invoiceEvt("invoice.paid", opts.sub));
  expect(opts.status()).toBe("cancelled");                                            // late events never reopen it
}

// ---- per product -----------------------------------------------------------------------------------------
describe.each(Object.values(PRODUCTS))("$id", (p) => {
  const r = () => row(p.id, eur(p.amountCents), p.recurring ? "subscription" : "payment");

  it("is purchasable: checkout sends exactly the catalogue's product and amount", async () => {
    const { POST } = await import("@/app/api/checkout/route");
    const res = await POST(json("/api/checkout", { product: p.id }));
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(1);
    const line = sent[0].line_items[0].price_data;
    expect(line.unit_amount).toBe(p.amountCents);                                  // no price from anywhere but the catalogue
    expect(line.currency).toBe("eur");
    expect(sent[0].mode).toBe(p.recurring ? "subscription" : "payment");
    expect(sent[0].metadata.kind).toBe(p.kind);                                    // what the webhook dispatches on
    r().purchasable = "proven";
  });

  it("accepts the signed event, rejects a forged one, and fulfils idempotently", async () => {
    const klass = fulfilmentClass(p);
    const session = `cs_${p.id}`;
    const extra = p.recurring ? { subscription: `sub_${p.id}` } : {};
    const meta: Record<string, string> = p.apiUnits ? { plan: p.id } : {};

    const forged = signed(session, p.kind, extra, meta);
    expect((await hook(new Request(forged.url, { method: "POST", headers: { "stripe-signature": "t=1,v1=deadbeef" }, body: await forged.text() }))).status).toBe(400);
    r().signedWebhook = "proven";

    for (let i = 0; i < 3; i++) expect((await hook(signed(session, p.kind, extra, meta))).status).toBe(200);

    const count = {
      deliverable: db.rows("deliverables").length,
      watch: db.rows("watches").length,
      api_account: db.rows("api_accounts").length,
    };
    const expected = { deliverable: 0, watch: 0, api_account: 0, [klass]: 1 } as Record<string, number>;
    if (klass === "manual") {
      expect(count).toEqual({ deliverable: 0, watch: 0, api_account: 0 });  // nothing is conjured for a deposit
      // ...but the payment is a durable, owned hand-off record, once however often Stripe redelivers
      expect(db.rows("engagement_deposits")).toEqual([
        expect.objectContaining({ stripe_session_id: session, kind: p.kind, amount_cents: expect.any(Number) }),
      ]);
      expect(db.rows("engagement_deposits")).toHaveLength(1);
    }
    else expect(count).toEqual({ deliverable: expected.deliverable, watch: expected.watch, api_account: expected.api_account });
    r().idempotent = "proven";
    r().fulfilment = klass === "manual" ? "manual hand-off: engagement_deposits row ×1, a named person scopes it" : `${klass} ×1 after 3 deliveries`;
    if (klass === "manual") r().idempotent = "proven";   // one hand-off row after 3 deliveries
  });

  it.runIf(Boolean(p.recurring))("lifecycle: failed payment, renewal, cancellation, late events and an unapplied event", async () => {
    const klass = fulfilmentClass(p);
    const table = klass === "watch" ? "watches" : "api_accounts";
    const sub = `sub_lc_${p.id}`;
    await proveLifecycle({
      kind: p.kind, sub, table, checkoutSession: `cs_lc_${p.id}`, meta: p.apiUnits ? { plan: p.id } : {},
      afterFailure: klass === "watch" ? "paused" : "past_due",
      status: () => (db.rows(table) as any[]).find((x) => x.stripe_subscription_id === sub)?.status,
    });
    r().lifecycle = "proven";
  });

  it.runIf(Boolean(p.apiUnits) && hasPython)("access: the paid plan yields a key the REAL engine accepts, and cancellation revokes it", async () => {
    const sub = `sub_ax_${p.id}`;
    await hook(signed(`cs_ax_${p.id}`, p.kind, { subscription: sub }, { plan: p.id }));
    const acct = (db.rows("api_accounts") as any[]).find((a) => a.stripe_subscription_id === sub);
    expect(acct).toMatchObject({ plan: p.id, monthly_units: p.apiUnits });                // exactly the catalogue's allowance
    const { POST } = await import("@/app/api/keys/route");
    const minted: any = await (await POST(json("/api/keys", { token: acct.token }))).json();
    expect(minted.issued).toBe(true);
    const use = async () => (await realFetch(`${ENGINE}/v1/usage`, { headers: { "x-api-key": minted.key } })).status;
    expect(await use()).toBe(200);
    expect(await use()).toBe(200);
    await hook(deletedEvt(sub, p.kind));
    expect(await use()).not.toBe(200);
    r().access = "real engine: key accepted, then revoked on cancel";
  }, 40_000);

  it.runIf(Boolean(PRODUCTS.density_screen))("is represented accurately in the capability registry", () => {
    expect(registryProves(p.id), `${p.id}: registry entry missing, internal-only, not live, or its web route does not exist`).toBe(true);
    r().registry = "proven";
  });

  // Only a product that PRODUCES a deliverable has an intake, an engine step and a release gate.
  describe.runIf(p.producesDeliverable && hasPython)("deliverable chain", () => {
    it("intake -> the REAL engine -> a draft nobody can read -> human release -> the customer", async () => {
      await hook(signed(`cs_chain_${p.id}`, p.kind));
      const [d] = db.rows("deliverables") as any[];
      expect(d.status).toBe("awaiting_intake");

      const intake = await import("@/app/api/intake/[token]/route");
      const ctx = (t: string) => ({ params: Promise.resolve({ token: t }) });
      // intake: validated, and only the INTAKE token (not the document token) can submit
      const bad = await intake.POST(json("/x", { siteName: "x" }), ctx(d.intake_token));
      expect(bad.status).toBe(422);
      const ok = await intake.POST(json("/x", INTAKE), ctx(d.intake_token));
      expect(ok.status, await ok.clone().text()).toBe(200);
      r().intake = "proven";

      // the document is the engine's, for THIS product, and is a draft
      const row = db.rows("deliverables")[0] as any;
      expect(row.status).toBe("draft");
      expect(String(row.document_html).length).toBeGreaterThan(500);
      expect(String(row.title)).toMatch(p.id === "procurement_spec" ? /specification/i : /density screen/i);
      r().engine = "proven";

      // human review preserved: a draft is never served, and release needs the admin
      const read = await import("@/app/api/deliverable/[token]/route");
      expect((await read.GET(new Request(siteUrl("/x")), ctx(row.token))).status).toBe(409);
      const admin = await import("@/app/api/admin/deliverables/route");
      const release = () => admin.PATCH(new Request(siteUrl("/x"), { method: "PATCH", body: JSON.stringify({ token: row.token }) }));
      expect((await release()).status).toBe(401);
      jar.push({ name: "gf_admin", value: (await import("node:crypto")).createHash("sha256").update(process.env.ADMIN_PASSWORD!).digest("hex") });
      expect((await release()).status).toBe(200);
      r().humanRelease = "proven";

      // the customer, by the document token that is never emailed
      const served = await read.GET(new Request(siteUrl("/x")), ctx(row.token));
      expect(served.status).toBe(200);
      // the credential the customer is emailed (intake) must NOT open the released document
      expect((await read.GET(new Request(siteUrl("/x")), ctx(row.intake_token))).status).toBe(404);
      r().customerAccess = "proven";
    }, 120_000);
  });
});

// ---- GridForge Intelligence: a different checkout, the same webhook ------------------------------------
describe.each(Object.values(INTELLIGENCE_PLANS))("intelligence:$id", (plan) => {
  const r = () => row(`intelligence_${plan.id}`, eur(plan.priceCents), "subscription");

  it("is purchasable at the catalogue amount, and the signed webhook records one subscription however often delivered", async () => {
    const { POST } = await import("@/app/api/subscribe/route");
    const res = await POST(json("/api/subscribe", { plan: plan.id }));
    expect(res.status).toBe(200);
    expect(sent[0].line_items[0].price_data.unit_amount).toBe(plan.priceCents);
    expect(sent[0].metadata).toMatchObject({ kind: "intelligence_subscription", plan: plan.id });
    expect(sent[0].subscription_data.metadata).toMatchObject({ kind: "intelligence_subscription", plan: plan.id }); // so a cancellation is recognisable as ours
    r().purchasable = "proven";
    for (let i = 0; i < 3; i++) {
      expect((await hook(signed(`cs_intel_${plan.id}`, "intelligence_subscription", { subscription: `sub_i_${plan.id}` }, { plan: plan.id }))).status).toBe(200);
    }
    r().signedWebhook = "proven";
    expect(db.rows("subscriptions")).toHaveLength(1);
    r().idempotent = "proven";
    r().fulfilment = "subscription ×1 after 3 deliveries";
    const cap = CAPABILITY_REGISTRY.find((c) => c.intelligence_plan_id === plan.id);
    expect(cap && cap.production_status === "live" && cap.status !== "internal_only").toBe(true);
    r().registry = "proven";
  });
});

describe.each(Object.values(INTELLIGENCE_PLANS))("intelligence lifecycle:$id", (plan) => {
  it("failed payment, renewal, cancellation, late events and an unapplied event", async () => {
    const sub = `sub_lci_${plan.id}`;
    await proveLifecycle({
      kind: "intelligence_subscription", sub, table: "subscriptions", checkoutSession: `cs_lci_${plan.id}`, meta: { plan: plan.id },
      afterFailure: "past_due",
      status: () => (db.rows("subscriptions") as any[]).find((x) => x.stripe_subscription_id === sub)?.status,
    });
    row(`intelligence_${plan.id}`, eur(plan.priceCents), "subscription").lifecycle = "proven";
  });
});

describe("the table itself", () => {
  it("has no UNPROVEN cell for anything the catalogue sells", () => {
    // Runs after the rows above (same file, declaration order). A new product with an unmet cell fails here.
    const unproven = [...rows.values()].flatMap((x) => Object.entries(x).filter(([, v]) => v === "UNPROVEN").map(([k]) => `${x.product}.${k}`));
    expect(unproven).toEqual([]);
    expect(rows.size).toBe(Object.keys(PRODUCTS).length + Object.keys(INTELLIGENCE_PLANS).length);
  });
});
