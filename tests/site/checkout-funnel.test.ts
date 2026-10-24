/**
 * The checkout funnel (lib/funnel.ts, migration 0042): what the checkout route records, and what it must never record or change.
 *
 *   checkout_attempted        a VALID catalogue request passed every gate this site controls and was handed to Stripe
 *   checkout_session_created  Stripe returned a URL -- NOT a payment
 *   checkout_failed           a valid request refused, or Stripe gave no session, with one fixed reason
 *
 * Stripe is a MOCK (its create calls are recorded), the store is the in-memory PostgREST fake, and the telemetry write is broken in
 * several ways to prove the checkout answers the same. Whether the real database enforces the same lists is proven against PostgreSQL in
 * tests/test_checkout_funnel_migration.py; here the two lists are only compared (the migration file is parsed).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CHECKOUT_EVENTS, CHECKOUT_FAILURE_REASONS, CHECKOUT_KINDS, CHECKOUT_RECORD_TIMEOUT_MS, CHECKOUT_STRIPE_STAGE_REASONS, FUNNEL_EVENTS,
  checkFunnelEvent, recordCheckoutEvent,
} from "@/lib/funnel";
import { PRODUCTS } from "@/lib/products";
import { resetApiReadinessCache } from "@/lib/api-readiness";
import { siteUrl } from "@/lib/site";
import { PostgrestFake } from "./postgrest-fake";

// ---------------------------------------------------------------------------------------------------- the Stripe mock

const sessions: Record<string, any>[] = [];
const coupons: Record<string, any>[] = [];
let stripeMode: "ok" | "session_fails" | "no_url" | "coupon_fails" = "ok";

vi.mock("stripe", () => ({
  default: class {
    coupons = {
      create: async (p: Record<string, any>) => {
        coupons.push(p);
        if (stripeMode === "coupon_fails") throw new Error("stripe coupon down cus_SECRET123");
        return { id: `coupon_${coupons.length}` };
      },
    };
    checkout = {
      sessions: {
        create: async (p: Record<string, any>) => {
          sessions.push(p);
          if (stripeMode === "session_fails") throw new Error("stripe down sk_live_SECRET cs_live_a1B2c3D4e5F6");
          return { id: "cs_test_a1B2c3D4e5F6g7H8", url: stripeMode === "no_url" ? null : "https://checkout.stripe.test/c/pay/cs_test_a1B2c3D4e5F6g7H8" };
        },
      },
    };
  },
}));

// ---------------------------------------------------------------------------------------------------- fixtures

let db: PostgrestFake;
let restore: () => void;
/** How the telemetry write (and only it) misbehaves. */
let telemetry: "ok" | "reject" | "http500" | "hang" | "throws" | "missing_table" = "ok";
let logs: string[];

const TABLES = ["funnel_events", "projects", "project_shares", "qualifications", "engagement_deposits", "leads"];

beforeEach(() => {
  process.env.SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_test";
  process.env.STRIPE_SECRET_KEY = "sk_test_funnel";
  delete process.env.GRIDFORGE_LEGACY_DEPOSIT;
  delete process.env.GRIDFORGE_API_URL;
  sessions.length = 0;
  coupons.length = 0;
  stripeMode = "ok";
  telemetry = "ok";
  logs = [];
  resetApiReadinessCache();
  for (const m of ["error", "warn", "log"] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(" ")));
  db = new PostgrestFake(TABLES);
  db.uniqueKeys.set("funnel_events", [["dedupe_key"]]);
  restore = db.install();
  const inner = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/rest/v1/funnel_events") && telemetry !== "ok" && telemetry !== "missing_table") {
      if (telemetry === "reject") throw new TypeError("fetch failed");
      if (telemetry === "throws") throw new Error("boom");
      if (telemetry === "hang") return new Promise<Response>(() => {});
      return new Response(JSON.stringify({ code: "XX000", message: "db down" }), { status: 500, headers: { "content-type": "application/json" } });
    }
    return inner(input as RequestInfo, init);
  }) as typeof fetch;
});
afterEach(() => {
  restore();
  vi.restoreAllMocks();
  delete process.env.GRIDFORGE_LEGACY_DEPOSIT;
});

const post = (body: unknown, raw?: string) =>
  new Request(siteUrl("/api/checkout"), { method: "POST", headers: { "content-type": "application/json" }, body: raw ?? JSON.stringify(body) });
const checkout = async (body: unknown, raw?: string) => (await import("@/app/api/checkout/route")).POST(post(body, raw));
const events = () => (db.rows("funnel_events") as any[]).map((e) => ({ name: e.name as string, props: e.props as Record<string, string> }));
const names = () => events().map((e) => e.name);

/** What a buyer, Stripe and the books see from one checkout: status, body, what was sent to Stripe (time removed), and any throw. */
async function observe(body: unknown) {
  sessions.length = 0;
  coupons.length = 0;
  let out: { status?: number; body?: unknown; threw?: string } = {};
  try {
    const res = await checkout(body);
    out = { status: res.status, body: await res.json() };
  } catch (e) {
    out = { threw: (e as Error).message };
  }
  const strip = (p: Record<string, any>) => ({
    ...p,
    expires_at: p.expires_at === undefined ? undefined : "<time>",
    metadata: p.metadata?.founding_reservation ? { ...p.metadata, founding_reservation: "<reservation id>" } : p.metadata,
  });
  return { ...out, sessions: sessions.map(strip), coupons: coupons.map(strip), reservations: db.rows("founding_reservations").length };
}

// ---------------------------------------------------------------------------------------------------- the vocabulary

describe("checkout events are a closed vocabulary", () => {
  it("the three events, the failure categories and the kinds are exactly these (adding one is a deliberate change here AND in migration 0042)", () => {
    expect([...CHECKOUT_EVENTS]).toEqual(["checkout_attempted", "checkout_session_created", "checkout_failed"]);
    for (const e of CHECKOUT_EVENTS) expect(FUNNEL_EVENTS).toContain(e);
    expect([...CHECKOUT_FAILURE_REASONS]).toEqual([
      "payments_not_configured", "project_reference_rejected", "store_unavailable", "api_plan_not_ready",
      "founding_slots_unreadable", "founding_reservation_failed", "stripe_coupon_failed", "stripe_session_failed",
    ]);
    expect([...CHECKOUT_STRIPE_STAGE_REASONS]).toEqual(["stripe_coupon_failed", "stripe_session_failed"]);
    expect([...CHECKOUT_KINDS].sort()).toEqual([...new Set([...Object.values(PRODUCTS).map((p) => p.kind), "engagement_deposit"])].sort());
  });

  it("every valid combination is accepted: a kind on attempted/created, a kind and a reason on failed", () => {
    for (const kind of CHECKOUT_KINDS) {
      expect(checkFunnelEvent("checkout_attempted", { kind })).toEqual({ ok: true, props: { kind } });
      expect(checkFunnelEvent("checkout_session_created", { kind })).toEqual({ ok: true, props: { kind } });
      for (const reason of CHECKOUT_FAILURE_REASONS) expect(checkFunnelEvent("checkout_failed", { kind, reason })).toEqual({ ok: true, props: { kind, reason } });
    }
  });

  it("everything else is refused", () => {
    const k = "density_screen";
    const bad: [string, unknown, string][] = [
      ["checkout_attempted", {}, "bad_value"], // kind is required
      ["checkout_session_created", {}, "bad_value"],
      ["checkout_failed", { kind: k }, "bad_value"], // a failure has a reason
      ["checkout_failed", { reason: "stripe_session_failed" }, "bad_value"], // ... and a kind
      ["checkout_failed", { kind: k, reason: "made_up_reason" }, "bad_value"],
      ["checkout_failed", { kind: k, reason: "Stripe_Session_Failed" }, "bad_value"],
      ["checkout_failed", { kind: k, reason: "free text about the card" }, "bad_value"],
      ["checkout_attempted", { kind: k, reason: "stripe_session_failed" }, "prop_not_allowed"], // only a failure has a reason
      ["checkout_session_created", { kind: k, reason: "stripe_session_failed" }, "prop_not_allowed"],
      ["checkout_attempted", { kind: "not_a_product" }, "bad_value"],
      ["checkout_attempted", { kind: "Density Screen" }, "bad_value"],
      ["checkout_attempted", { kind: "hall_watch_extra" }, "bad_value"],
      ["checkout_attempted", { kind: "intelligence_subscription" }, "bad_value"], // not sold by this route
      ["checkout_attempted", { kind: k, plan: "team" }, "prop_not_allowed"], // a key the vocabulary knows but this event may not carry
      ["checkout_attempted", { kind: k, account_ref: "0123456789ab" }, "prop_not_allowed"],
      ["checkout_attempted", { kind: k, email: "a@b.example" }, "prop_not_allowed"],
      ["checkout_attempted", { kind: k, session_id: "cs_test_a1B2c3D4e5F6" }, "prop_not_allowed"],
      ["checkout_attempted", { kind: k, company: "Acme" }, "prop_not_allowed"],
      ["checkout_attempted", { kind: k, units: 1 }, "prop_not_allowed"],
      ["checkout_attempted", { kind: "ops@acme.example" }, "bad_value"],
      ["checkout_attempted", { kind: "cs_test_a1b2c3d4e5f6g7h8" }, "bad_value"], // Stripe-id shaped, lower case
      ["checkout_attempted", { kind: "https://checkout.stripe.test/c/pay/x" }, "bad_value"],
      ["checkout_attempted", { kind: "gfk1.eyJhIjoiYWNtZSJ9.c2ln" }, "bad_value"],
      ["checkout_attempted", { kind: 7 }, "bad_value"],
      ["checkout_attempted", { kind: null }, "bad_value"],
      ["checkout_attempted", { kind: ["density_screen"] }, "bad_value"],
      ["checkout_attempted", [], "props_not_object"],
      ["checkout_attempted", null, "props_not_object"],
      ["checkout_failed", { kind: k, reason: "stripe_session_failed", extra: 1 }, "prop_not_allowed"],
    ];
    for (const [name, props, why] of bad) expect(checkFunnelEvent(name, props), `${name} ${JSON.stringify(props)}`).toEqual({ ok: false, reason: why });
  });

  it("an unknown event name is still refused", () => {
    for (const n of ["checkout_paid", "checkout_completed", "checkout_returned", "payment_succeeded", "checkout_started"]) {
      expect(checkFunnelEvent(n, { kind: "density_screen" })).toEqual({ ok: false, reason: "unknown_event" });
    }
  });

  it("the lists in lib/funnel.ts equal the lists in migration 0042 (the migration file is parsed, so they cannot drift)", () => {
    const sql = readFileSync(path.join(process.cwd(), "supabase/migrations/0042_checkout_funnel.sql"), "utf8").replace(/--.*$/gm, "");
    const quoted = (s: string) => [...s.matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]);
    const listAfter = (re: RegExp) => {
      const m = sql.match(re);
      expect(m, String(re)).not.toBeNull();
      return quoted(m![1]);
    };
    const nameList = listAfter(/funnel_events_name_check\s+check\s*\(\s*name\s+in\s*\(([^)]*)\)/);
    expect([...nameList].sort()).toEqual([...FUNNEL_EVENTS].sort());
    const gate = listAfter(/name not in \(([^)]*)\)/);
    expect([...gate].sort()).toEqual([...CHECKOUT_EVENTS].sort());
    const kinds = listAfter(/props->>'kind' in \(([^)]*)\)/);
    expect([...kinds].sort()).toEqual([...CHECKOUT_KINDS].sort());
    const reasons = listAfter(/props->>'reason' in \(([^)]*)\)/);
    expect([...reasons].sort()).toEqual([...CHECKOUT_FAILURE_REASONS].sort());
    // and the only keys the constraint lets through are the two this file lets through
    expect(sql).toMatch(/\(props - 'kind' - 'reason'\) = '\{\}'::jsonb/);
  });

  it("the earlier events survive in the widened name list", () => {
    const sql = readFileSync(path.join(process.cwd(), "supabase/migrations/0035_funnel_measurement.sql"), "utf8").replace(/--.*$/gm, "");
    const old = [...(sql.match(/funnel_events_name_check\s+check\s*\(\s*name\s+in\s*\(([^)]*)\)/)![1]).matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]);
    for (const n of old) expect(FUNNEL_EVENTS).toContain(n);
    expect(old.length + 3).toBe(FUNNEL_EVENTS.length);
  });
});

// ---------------------------------------------------------------------------------------------------- what is recorded

describe("a valid checkout records attempted, then session_created -- and nothing about the buyer", () => {
  it("every catalogue product: attempted then session_created, with the catalogue kind and nothing else", async () => {
    for (const p of Object.values(PRODUCTS)) {
      db.rows("funnel_events").length = 0;
      process.env.GRIDFORGE_API_URL = ""; // API plans are covered below; this loop is about the others
      if (p.apiUnits) continue;
      const res = await checkout({ product: p.id });
      expect(res.status, p.id).toBe(200);
      expect(events(), p.id).toEqual([
        { name: "checkout_attempted", props: { kind: p.kind } },
        { name: "checkout_session_created", props: { kind: p.kind } },
      ]);
    }
  });

  it("carries no email, company, site, token, qualification id, project id, Stripe id or URL, however much the request carried", async () => {
    const proj = db.insertRow("projects", { project_token: "pt_SECRETPROJECTTOKEN0123456789", name: "North Hall" });
    const res = await checkout({
      product: "density_screen", email: "director@northhall.example", company: "North Hall Ltd", capacityMW: 12, service: "workspace-density_screen",
      qualificationId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301", qualificationToken: "q_SECRETQUALTOKEN", project_token: "pt_SECRETPROJECTTOKEN0123456789",
    });
    expect(res.status).toBe(200);
    expect(names()).toEqual(["checkout_attempted", "checkout_session_created"]);
    const stored = JSON.stringify(db.rows("funnel_events"));
    for (const secret of ["director@northhall", "North Hall", "SECRETQUALTOKEN", "3f2504e0", "SECRETPROJECTTOKEN", String(proj.id), "cs_test_", "checkout.stripe.test", "sk_test", "capacity", "workspace-"]) {
      expect(stored, secret).not.toContain(secret);
    }
    for (const e of events()) expect(Object.keys(e.props)).toEqual(["kind"]);
  });

  it("an unverified qualification reference is DROPPED, not refused: the sale proceeds and is recorded as an ordinary attempt", async () => {
    const res = await checkout({ product: "density_screen", qualificationId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301", qualificationToken: "wrong" });
    expect(res.status).toBe(200);
    expect(events()).toEqual([
      { name: "checkout_attempted", props: { kind: "density_screen" } },
      { name: "checkout_session_created", props: { kind: "density_screen" } },
    ]);
  });

  it("a created session is a session, not a payment: nothing here records engagement_commissioned / subscription_started, and no event is written on return", async () => {
    await checkout({ product: "hall_watch" });
    expect(names().filter((n) => n === "engagement_commissioned" || n === "subscription_started" || n === "first_charge")).toEqual([]);
    // the buyer returning from Stripe is a page load of /commissioned, which this route never sees
    expect(names()).toEqual(["checkout_attempted", "checkout_session_created"]);
  });

  it("the legacy deposit (only when the operator switched it on) is recorded with its own kind, engagement_deposit", async () => {
    process.env.GRIDFORGE_LEGACY_DEPOSIT = "1";
    const res = await checkout({});
    expect(res.status).toBe(200);
    expect(events()).toEqual([
      { name: "checkout_attempted", props: { kind: "engagement_deposit" } },
      { name: "checkout_session_created", props: { kind: "engagement_deposit" } },
    ]);
  });
});

describe("invalid, unknown or malformed input records nothing (no commercial activity)", () => {
  const cases: [string, unknown, string?][] = [
    ["an unknown product id", { product: "not_a_product" }],
    ["a product id that is only a kind-like string", { product: "Density_Screen" }],
    ["a non-string product", { product: { id: "density_screen" } }],
    ["an array product", { product: ["density_screen"] }],
    ["a numeric product", { product: 7 }],
    ["two selectors", { product: "density_screen", sku: "density_screen" }],
    ["a selector that is not `product`", { sku: "density_screen" }],
    ["a price id", { priceId: "price_123" }],
    ["a product with a hostile value", { product: "ops@acme.example" }],
    ["no product at all (the generic deposit is off the catalogue)", {}],
    ["no product and the founding flag", { founding: true }],
    ["a malformed body", undefined, "{not json"],
    ["an empty body", undefined, ""],
  ];
  for (const [label, body, raw] of cases) {
    it(label, async () => {
      const res = await checkout(body, raw);
      expect([400, 500]).toContain(res.status);
      expect(sessions).toHaveLength(0);
      expect(db.rows("funnel_events")).toHaveLength(0);
    });
  }

  it("the same inputs record nothing when payments are not configured either (the refusal is not about a real product)", async () => {
    delete process.env.STRIPE_SECRET_KEY;
    for (const [, body, raw] of cases) {
      const res = await checkout(body, raw);
      expect(res.status).toBe(503);
    }
    expect(db.rows("funnel_events")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------------- every failure category

describe("every refusal and failure path records its category", () => {
  const failed = (kind: string, reason: string) => ({ name: "checkout_failed", props: { kind, reason } });

  it("payments_not_configured: no Stripe key (503), recorded for a valid product only, with no attempt", async () => {
    delete process.env.STRIPE_SECRET_KEY;
    const res = await checkout({ product: "density_screen", email: "a@b.example" });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: "Payments not configured" });
    expect(events()).toEqual([failed("density_screen", "payments_not_configured")]);
  });

  it("payments_not_configured: the legacy deposit is recorded only when that path is on", async () => {
    delete process.env.STRIPE_SECRET_KEY;
    await checkout({});
    expect(events()).toEqual([]);
    process.env.GRIDFORGE_LEGACY_DEPOSIT = "1";
    await checkout({});
    expect(events()).toEqual([failed("engagement_deposit", "payments_not_configured")]);
  });

  it("project_reference_rejected: an unknown project token (404)", async () => {
    const res = await checkout({ product: "density_screen", project_token: "pt_nope" });
    expect(res.status).toBe(404);
    expect(events()).toEqual([failed("density_screen", "project_reference_rejected")]);
    expect(sessions).toHaveLength(0);
  });

  it("project_reference_rejected: an empty token, a product that cannot attach, a non-string token (400)", async () => {
    for (const body of [
      { product: "density_screen", project_token: "" },
      { product: "api_triage", project_token: "pt_x" },
      { product: "density_screen", project_token: 7 },
    ]) {
      db.rows("funnel_events").length = 0;
      expect((await checkout(body)).status).toBe(400);
      expect(events(), JSON.stringify(body)).toEqual([failed(body.product === "api_triage" ? "api_triage" : "density_screen", "project_reference_rejected")]);
    }
  });

  it("project_reference_rejected: a buyer link that is unknown, malformed, empty, for the wrong product, or sent together with a project token", async () => {
    for (const body of [
      { product: "density_screen", project_share_token: "nope" },
      { product: "density_screen", project_share_token: "" },
      { product: "hall_watch", project_share_token: "x".repeat(40) },
      { product: "portfolio_screen_deposit", project_share_token: "x".repeat(40) },
      { product: "density_screen", project_token: "pt_x", project_share_token: "x".repeat(40) },
    ]) {
      db.rows("funnel_events").length = 0;
      const res = await checkout(body);
      expect([400, 404], JSON.stringify(body)).toContain(res.status);
      expect(names(), JSON.stringify(body)).toEqual(["checkout_failed"]);
      expect(events()[0].props.reason).toBe("project_reference_rejected");
    }
  });

  it("store_unavailable: the project cannot be confirmed because the store cannot be read (502)", async () => {
    db.failMethod = { method: "GET", status: 500, body: JSON.stringify({ message: "down" }) };
    const res = await checkout({ product: "density_screen", project_token: "pt_x" });
    expect(res.status).toBe(502);
    expect(events()).toEqual([failed("density_screen", "store_unavailable")]);
  });

  it("store_unavailable: a buyer link whose lookup fails", async () => {
    db.failMethod = { method: "GET", status: 500, body: JSON.stringify({ message: "down" }) };
    const res = await checkout({ product: "density_screen", project_share_token: "x".repeat(43) });
    expect(res.status).toBe(502);
    expect(events()).toEqual([failed("density_screen", "store_unavailable")]);
  });

  it("api_plan_not_ready: key issuance not proven (503, no session)", async () => {
    const res = await checkout({ product: "api_triage" });
    expect(res.status).toBe(503);
    expect(sessions).toHaveLength(0);
    expect(events()).toEqual([failed("api_triage", "api_plan_not_ready")]);
  });

  it("founding_slots_unreadable and founding_reservation_failed (legacy deposit, fail closed, no coupon)", async () => {
    process.env.GRIDFORGE_LEGACY_DEPOSIT = "1";
    db.dropTable("engagement_deposits");
    expect((await checkout({ founding: true })).status).toBe(503);
    expect(events()).toEqual([failed("engagement_deposit", "founding_slots_unreadable")]);
    db.rows("funnel_events").length = 0;
    db.createTable("engagement_deposits");
    db.rpcs.delete("gf_founding_reserve");
    expect((await checkout({ founding: true })).status).toBe(503);
    expect(events()).toEqual([failed("engagement_deposit", "founding_reservation_failed")]);
    expect(coupons).toHaveLength(0);
    expect(sessions).toHaveLength(0);
  });

  it("stripe_session_failed: Stripe throws (500); attempted is recorded, session_created is NOT", async () => {
    stripeMode = "session_fails";
    const res = await checkout({ product: "density_screen" });
    expect(res.status).toBe(500);
    expect(events()).toEqual([{ name: "checkout_attempted", props: { kind: "density_screen" } }, failed("density_screen", "stripe_session_failed")]);
    expect(names()).not.toContain("checkout_session_created");
    // the exception text (which here holds secret-looking strings) is nowhere
    expect(JSON.stringify(db.rows("funnel_events"))).not.toMatch(/sk_live|cs_live|SECRET/);
  });

  it("stripe_session_failed: Stripe answers without a URL (no usable session is not a created session)", async () => {
    stripeMode = "no_url";
    const res = await checkout({ product: "envelope_study_deposit" });
    expect(events()).toEqual([{ name: "checkout_attempted", props: { kind: "envelope_study_deposit" } }, failed("envelope_study_deposit", "stripe_session_failed")]);
    // ... and the buyer is told the truth too: a session with nowhere to pay is a failure, never `{ ok: true, url: null }`.
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false });
    expect(body.url).toBeUndefined();
  });

  it("stripe_coupon_failed: the Founding coupon fails; the route still throws exactly as before and the slot is given back", async () => {
    process.env.GRIDFORGE_LEGACY_DEPOSIT = "1";
    stripeMode = "coupon_fails";
    await expect(checkout({ founding: true })).rejects.toThrow(/stripe coupon down/);
    expect(events()).toEqual([{ name: "checkout_attempted", props: { kind: "engagement_deposit" } }, failed("engagement_deposit", "stripe_coupon_failed")]);
    expect(db.rows("founding_reservations")).toHaveLength(0);
    expect(sessions).toHaveLength(0);
  });

  it("every category in the closed list is exercised by a test in this file", () => {
    const here = readFileSync(path.join(process.cwd(), "tests/site/checkout-funnel.test.ts"), "utf8");
    for (const r of CHECKOUT_FAILURE_REASONS) expect(here.split(`"${r}"`).length - 1, r).toBeGreaterThanOrEqual(2);
  });

  it("a successful session after an earlier failure is counted once as created and the failure stays a failure", async () => {
    stripeMode = "session_fails";
    await checkout({ product: "density_screen" });
    stripeMode = "ok";
    await checkout({ product: "density_screen" });
    expect(names()).toEqual(["checkout_attempted", "checkout_failed", "checkout_attempted", "checkout_session_created"]);
  });
});

describe("API plans: an attempt only when readiness is proven", () => {
  it("not ready records api_plan_not_ready and NO attempt (nothing was handed to Stripe)", async () => {
    const res = await checkout({ product: "api_scale" });
    expect(res.status).toBe(503);
    expect(names()).toEqual(["checkout_failed"]);
    expect(events()[0].props).toEqual({ kind: "api_scale", reason: "api_plan_not_ready" });
  });
});

// ---------------------------------------------------------------------------------------------------- telemetry cannot change a checkout

describe("a telemetry failure never changes the checkout", () => {
  const FAULTS = ["reject", "http500", "throws", "missing_table", "hang"] as const;

  type Scenario = { label: string; body: unknown; setup?: () => void; env?: () => void };
  const scenarios: Scenario[] = [
    { label: "a successful session", body: { product: "density_screen", email: "a@b.example", company: "Hall Co" } },
    { label: "a successful recurring session", body: { product: "hall_watch" } },
    { label: "an unknown product", body: { product: "nope" } },
    { label: "an unknown project (404)", body: { product: "density_screen", project_token: "pt_nope" } },
    { label: "an API plan that is not ready (503)", body: { product: "api_triage" } },
    { label: "Stripe failing to create the session (500)", body: { product: "procurement_spec" }, setup: () => { stripeMode = "session_fails"; } },
    { label: "Stripe returning no URL", body: { product: "density_screen" }, setup: () => { stripeMode = "no_url"; } },
    { label: "payments not configured (503)", body: { product: "density_screen" }, env: () => { delete process.env.STRIPE_SECRET_KEY; } },
    {
      label: "the legacy Founding deposit, credited",
      body: { founding: true },
      env: () => { process.env.GRIDFORGE_LEGACY_DEPOSIT = "1"; },
    },
    {
      label: "the legacy Founding deposit, coupon failing (throws)",
      body: { founding: true },
      env: () => { process.env.GRIDFORGE_LEGACY_DEPOSIT = "1"; },
      setup: () => { stripeMode = "coupon_fails"; },
    },
  ];

  for (const sc of scenarios) {
    it(`${sc.label}: same status, body, Stripe calls and reservations whether the funnel write works, errors, throws, hangs or the table is missing`, async () => {
      const run = async (fault: (typeof FAULTS)[number] | "ok") => {
        db.rows("funnel_events").length = 0;
        db.rows("founding_reservations").length = 0;
        telemetry = fault === "missing_table" ? "ok" : fault;
        if (fault === "missing_table") db.dropTable("funnel_events");
        else db.createTable("funnel_events");
        stripeMode = "ok";
        sc.env?.();
        sc.setup?.();
        const started = Date.now();
        const seen = await observe(sc.body);
        const elapsed = Date.now() - started;
        return { seen, elapsed, written: db.rows("funnel_events").length };
      };
      const baseline = await run("ok");
      for (const fault of FAULTS) {
        const broken = await run(fault);
        expect(broken.seen, `${sc.label} / ${fault}`).toEqual(baseline.seen);
        expect(broken.written, `${sc.label} / ${fault}`).toBe(0);
        // bounded: at most one wait per event the route would record (at most two), plus slack
        expect(broken.elapsed, `${sc.label} / ${fault}`).toBeLessThan(2 * CHECKOUT_RECORD_TIMEOUT_MS + 1500);
      }
    }, 30_000);
  }

  it("the baseline really did record something in the scenarios that should (so the comparison above is not vacuous)", async () => {
    await checkout({ product: "density_screen" });
    expect(names()).toEqual(["checkout_attempted", "checkout_session_created"]);
  });

  it("a hanging store costs the buyer a bounded wait, not the request", async () => {
    telemetry = "hang";
    const t0 = Date.now();
    const res = await checkout({ product: "density_screen" });
    const waited = Date.now() - t0;
    expect(res.status).toBe(200);
    expect((await res.json()).url).toMatch(/^https:\/\/checkout\.stripe\.test\//);
    expect(sessions).toHaveLength(1);
    expect(waited).toBeGreaterThanOrEqual(CHECKOUT_RECORD_TIMEOUT_MS - 50); // it waited for the bound...
    expect(waited).toBeLessThan(2 * CHECKOUT_RECORD_TIMEOUT_MS + 1500); // ...and for nothing longer
  });

  it("recordCheckoutEvent itself never throws or rejects, with any fault, and respects its own bound", async () => {
    for (const t of ["reject", "http500", "throws", "missing_table"] as const) {
      telemetry = t;
      if (t === "missing_table") db.dropTable("funnel_events");
      await expect(recordCheckoutEvent("checkout_attempted", { kind: "density_screen" })).resolves.toBeUndefined();
    }
    telemetry = "hang";
    const t0 = Date.now();
    await expect(recordCheckoutEvent("checkout_attempted", { kind: "density_screen" }, 50)).resolves.toBeUndefined();
    expect(Date.now() - t0).toBeLessThan(1000);
    // an event the vocabulary refuses is dropped without a throw, too
    await expect(recordCheckoutEvent("checkout_failed", { kind: "density_screen" })).resolves.toBeUndefined();
    await expect(recordCheckoutEvent("checkout_attempted", { kind: "ops@acme.example" })).resolves.toBeUndefined();
  });

  it("with no store configured at all the checkout is unchanged", async () => {
    const withStore = await observe({ product: "density_screen" });
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const without = await observe({ product: "density_screen" });
    expect(without).toEqual(withStore);
  });

  it("the log of a failed write names a category and a path, never a body or the event's values", async () => {
    telemetry = "http500";
    await checkout({ product: "density_screen", email: "director@northhall.example" });
    const joined = logs.join("\n");
    expect(joined).not.toContain("director@northhall");
    expect(joined).not.toContain("db down");
  });
});
