/**
 * The admin report's checkout section: measured counts kept apart from derived values, explicit denominators, null (never 0, never NaN)
 * where there is nothing to divide by, and wording that never lets a created session pass for a payment. The SQL read function is mirrored
 * in TypeScript (SUPPLEMENTAL: tests/test_checkout_funnel_migration.py runs the real SQL).
 */
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adminToken } from "@/lib/admin";
import { siteUrl } from "@/lib/site";
import { CHECKOUT_FAILURE_REASONS } from "@/lib/funnel";
import { checkoutSection, funnelReport, rate } from "@/lib/payg-analytics";
import { CheckoutSection } from "@/components/AdminFunnelPanel";
import { newPaygDb } from "./payg-harness";
import { installCheckoutFunnelRpc } from "./checkout-funnel-fake";
import type { PostgrestFake } from "./postgrest-fake";

const jar: { name: string; value: string }[] = [];
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (name: string) => jar.find((c) => c.name === name) }) }));

const NOW = new Date("2026-10-21T08:00:00Z");
const ago = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();
let db: PostgrestFake;
let restore: () => void;

beforeEach(() => {
  jar.length = 0;
  Object.assign(process.env, {
    SUPABASE_URL: "https://stub.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "sb_secret_test", ADMIN_PASSWORD: "a-long-random-admin-password",
    GRIDFORGE_KEY_SECRET: "test-signing-secret", RATE_LIMIT_HMAC_KEY: "r".repeat(40),
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
  db = newPaygDb();
  for (const t of ["qualifications", "engagement_deposits"]) db.createTable(t);
  installCheckoutFunnelRpc(db);
  restore = db.install();
});
afterEach(() => { restore(); vi.restoreAllMocks(); });

function ev(name: string, props: Record<string, unknown>, at = ago(1)) { db.insertRow("funnel_events", { name, props, dedupe_key: null, created_at: at }); }
const attempt = (kind: string, n = 1, at?: string) => { for (let i = 0; i < n; i++) ev("checkout_attempted", { kind }, at); };
const created = (kind: string, n = 1, at?: string) => { for (let i = 0; i < n; i++) ev("checkout_session_created", { kind }, at); };
const failed = (kind: string, reason: string, n = 1, at?: string) => { for (let i = 0; i < n; i++) ev("checkout_failed", { kind, reason }, at); };
const report = async (days = 30) => {
  const r = await funnelReport(days, NOW);
  if (!r.ok) throw new Error("report: " + r.error);
  return r;
};
const available = (c: Awaited<ReturnType<typeof report>>["checkout"]) => {
  if (!c.available) throw new Error("checkout section unavailable: " + c.reason);
  return c;
};

describe("the checkout section of the report", () => {
  it("with no checkout events every count is 0 and every derived value is null (never 0, never NaN), with its denominator shown", async () => {
    const c = available((await report()).checkout);
    expect(c.measured).toMatchObject({ source: "events", attempted: 0, session_created: 0, failed: 0 });
    expect(Object.keys(c.measured.failed_by_reason)).toEqual([...CHECKOUT_FAILURE_REASONS]);
    expect(Object.values(c.measured.failed_by_reason).every((n) => n === 0)).toBe(true);
    for (const d of [c.derived.session_creation_rate, c.derived.stripe_failure_rate, c.derived.refusal_rate]) {
      expect(d.value).toBeNull();
      expect(Object.is(d.value, NaN)).toBe(false);
      expect(d.denominator).toBe(0);
      expect(d.source).toBe("derived");
      expect(d.formula).toMatch(/\//);
    }
    expect(c.derived.unresolved_attempts.value).toBe(0);
    expect(c.measured.by_kind).toEqual({});
  });

  it("counts, by reason and by kind, with derived rates that carry numerator and denominator", async () => {
    attempt("density_screen", 10); created("density_screen", 7); failed("density_screen", "stripe_session_failed", 2);
    attempt("hall_watch", 2); created("hall_watch", 2);
    failed("density_screen", "payments_not_configured", 3); // refused before Stripe: not an attempt
    failed("api_triage", "api_plan_not_ready", 5);
    const r = await report();
    const c = available(r.checkout);
    expect(c.measured).toMatchObject({ attempted: 12, session_created: 9, failed: 10 });
    expect(c.measured.failed_by_reason).toMatchObject({ stripe_session_failed: 2, payments_not_configured: 3, api_plan_not_ready: 5, stripe_coupon_failed: 0 });
    expect(c.measured.by_kind).toEqual({
      api_triage: { attempted: 0, session_created: 0, failed: 5 },
      density_screen: { attempted: 10, session_created: 7, failed: 5 },
      hall_watch: { attempted: 2, session_created: 2, failed: 0 },
    });
    expect(c.derived.refused_before_stripe).toBe(8);
    expect(c.derived.failed_at_stripe).toBe(2);
    expect(c.derived.session_creation_rate).toMatchObject({ numerator: 9, denominator: 12, value: 0.75, source: "derived" });
    expect(c.derived.stripe_failure_rate).toMatchObject({ numerator: 2, denominator: 12, value: 0.1667 });
    expect(c.derived.refusal_rate).toMatchObject({ numerator: 8, denominator: 20, value: 0.4 });
    expect(c.derived.unresolved_attempts.value).toBe(12 - 9 - 2);
    expect(c.derived.by_kind.density_screen.session_creation_rate).toMatchObject({ numerator: 7, denominator: 10, value: 0.7 });
    expect(c.derived.by_kind.api_triage.session_creation_rate).toMatchObject({ numerator: 0, denominator: 0, value: null }); // refused only: no attempts to divide by
    expect(c.derived.by_kind.api_triage.failed_by_reason.api_plan_not_ready).toBe(5);
  });

  it("zero created over real attempts is 0 (we saw attempts and no sessions), distinct from null (no attempts)", async () => {
    attempt("density_screen", 4); failed("density_screen", "stripe_session_failed", 4);
    const c = available((await report()).checkout);
    expect(c.derived.session_creation_rate).toMatchObject({ numerator: 0, denominator: 4, value: 0 });
    expect(c.derived.stripe_failure_rate.value).toBe(1);
    // refusals only: attempts are 0, so the creation rate is null, but the refusal rate has a real denominator
    db.rows("funnel_events").length = 0;
    failed("density_screen", "payments_not_configured", 2);
    const d = available((await report()).checkout).derived;
    expect(d.session_creation_rate.value).toBeNull();
    expect(d.refusal_rate).toMatchObject({ numerator: 2, denominator: 2, value: 1 });
  });

  it("events outside the window are not counted", async () => {
    attempt("density_screen", 2, ago(40)); created("density_screen", 2, ago(40));
    attempt("density_screen", 1, ago(3));
    const c = available((await report(30)).checkout);
    expect(c.measured).toMatchObject({ attempted: 1, session_created: 0 });
    expect(available((await report(90)).checkout).measured).toMatchObject({ attempted: 3, session_created: 2 });
  });

  it("an outcome without its attempt shows as a negative unresolved value (arithmetic, not hidden)", () => {
    const c = checkoutSection({ counts: { checkout_session_created: 2 }, by_kind: {}, failed_reasons: {}, failed_by_kind: {} });
    if (!c.available) throw new Error("x");
    expect(c.derived.unresolved_attempts.value).toBe(-2);
    expect(c.derived.session_creation_rate.value).toBeNull();
  });

  it("malformed counts from the store become 0, never NaN or negative; garbage never reaches a rate", () => {
    const c = checkoutSection({ counts: { checkout_attempted: "abc", checkout_session_created: -4, checkout_failed: null }, failed_reasons: { stripe_session_failed: Number.NaN, made_up: 9 } });
    if (!c.available) throw new Error("x");
    expect(c.measured).toMatchObject({ attempted: 0, session_created: 0, failed: 0 });
    expect(JSON.stringify(c)).not.toMatch(/NaN|Infinity/);
    expect(c.derived.session_creation_rate.value).toBeNull();
    expect(c.measured.failed_by_reason).not.toHaveProperty("made_up");
  });

  it("rate() itself: null for a zero, negative, NaN or missing denominator", () => {
    for (const d of [0, -1, Number.NaN, null]) expect(rate(3, d)).toBeNull();
    expect(rate(1, 3)).toBe(0.3333);
  });

  it("is UNAVAILABLE (not zero) when migration 0042 is not applied, and the rest of the report still works", async () => {
    db.rpcs.delete("gf_checkout_funnel_summary");
    const r = await report();
    expect(r.checkout.available).toBe(false);
    if (r.checkout.available) return;
    expect(r.checkout.reason).toMatch(/0042/);
    expect(r.checkout.statement).toMatch(/NOT a payment/);
    expect(JSON.stringify(r.checkout)).not.toMatch(/"attempted"|"value"/);
    expect(r.steps.length).toBeGreaterThan(0);
  });

  it("states, in the report itself, that a session is not a payment and what the payment evidence is", async () => {
    const c = (await report()).checkout;
    expect(c.statement).toMatch(/NOT a payment/);
    expect(c.statement).toMatch(/engagement_commissioned/);
    expect(c.statement).toMatch(/subscription_started/);
    expect(c.statement).toMatch(/returning from Stripe is not evidence of payment/);
    expect((await report()).unmeasured.join(" ")).toMatch(/created checkout session is not a payment/);
  });

  it("the commissioned / subscription events are reported separately and never derived from checkout events", async () => {
    attempt("density_screen", 3); created("density_screen", 3);
    const r = await report();
    expect(r.engagements.commissioned.total).toBe(0);
    expect(r.subscriptions.started.total).toBe(0);
    ev("engagement_commissioned", { kind: "density_screen" });
    const r2 = await report();
    expect(r2.engagements.commissioned.total).toBe(1);
    expect(available(r2.checkout).measured.session_created).toBe(3);
  });

  it("carries no email, token, Stripe id or URL", async () => {
    attempt("density_screen"); failed("hall_watch", "stripe_session_failed");
    const text = JSON.stringify((await report()).checkout);
    expect(text).not.toMatch(/@|https?:|cs_(test|live)|sk_|tok/);
  });

  it("the admin route serves it (admin only)", async () => {
    attempt("density_screen", 2); created("density_screen", 1);
    const { GET } = await import("@/app/api/admin/funnel/route");
    expect((await GET(new Request(siteUrl("/api/admin/funnel")))).status).toBe(401);
    jar.push({ name: "gf_admin", value: adminToken()! });
    const res = await GET(new Request(siteUrl("/api/admin/funnel?days=7")));
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.checkout.available).toBe(true);
    expect(j.checkout.measured.attempted).toBe(2);
    expect(j.checkout.derived.session_creation_rate).toMatchObject({ numerator: 1, denominator: 2, value: 0.5 });
  });
});

describe("the panel's checkout wording", () => {
  const html = async (): Promise<string> => {
    attempt("density_screen", 10); created("density_screen", 7); failed("density_screen", "stripe_session_failed", 2); failed("api_triage", "api_plan_not_ready", 1);
    const r = await report();
    return renderToStaticMarkup(React.createElement(CheckoutSection, { checkout: r.checkout as never, days: 30 }));
  };
  const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ");

  it("separates MEASURED events from DERIVED values, labelled as such", async () => {
    const t = text(await html());
    expect(t).toContain("Measured (recorded events)");
    expect(t).toContain("Derived (calculated from the counts above; not recorded)");
    expect(t.indexOf("Measured (recorded events)")).toBeLessThan(t.indexOf("Derived (calculated"));
    expect(t).toMatch(/Session creation rate \(derived\)/);
    expect(t).toMatch(/Stripe failure rate \(derived\)/);
    expect(t).toMatch(/Refusal rate before Stripe \(derived\)/);
    expect(t).toMatch(/7 of 10/); // explicit denominator
    expect(t).toMatch(/70\.0%/);
  });

  it("says plainly that a created session is not a payment and what the only payment evidence is", async () => {
    const t = text(await html());
    expect(t).toMatch(/created checkout session is NOT a payment/);
    expect(t).toMatch(/Session created \(Stripe returned a URL; not a payment\)/);
    expect(t).toMatch(/only payment and commission evidence is the engagement_commissioned and subscription_started events/);
    expect(t).not.toMatch(/Payments? (taken|received|made)|Paid\b|Revenue|Conversions?\b/i);
  });

  it("prints n/a, never 0.0% or NaN, where there is nothing to divide by", () => {
    const c = checkoutSection({ counts: {}, by_kind: {}, failed_reasons: {}, failed_by_kind: {} });
    const t = text(renderToStaticMarkup(React.createElement(CheckoutSection, { checkout: c as never, days: 7 })));
    expect(t).toMatch(/n\/a/);
    expect(t).not.toMatch(/NaN|Infinity/);
    expect(t).not.toMatch(/\b0\.0%/);
    expect(t).toMatch(/0 of 0/);
  });

  it("an unavailable section prints the reason and no figure", () => {
    const c = checkoutSection(null);
    const t = text(renderToStaticMarkup(React.createElement(CheckoutSection, { checkout: c as never, days: 7 })));
    expect(t).toMatch(/Checkout figures unavailable/);
    expect(t).toMatch(/NOT a payment/);
    expect(t).not.toMatch(/Measured \(recorded events\)/);
  });

  it("lists every failure reason, including the ones with no events", async () => {
    const t = text(await html());
    for (const reason of CHECKOUT_FAILURE_REASONS) expect(t).toContain(`failed: ${reason}`);
  });
});
