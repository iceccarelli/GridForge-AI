/**
 * Usage alerts (80% / 100% of the cap, once per account / month / percent) and the allow-listed funnel events.
 * Email goes to a Resend sink; the store is the in-memory PostgREST with SQL mirrors (SUPPLEMENTAL). No live service is contacted.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PAYG } from "@/lib/products";
import { FUNNEL_EVENTS, FUNNEL_PROP_KEYS, checkFunnelEvent, recordFunnelEvent } from "@/lib/funnel";
import { mockEngine, newPaygDb, paygAccount, type MockEngine } from "./payg-harness";
import type { PostgrestFake } from "./postgrest-fake";

let db: PostgrestFake;
let restore: () => void;
let engine: MockEngine;
let mail: { to: string; subject: string; text: string }[];
const NOW = new Date("2026-10-21T08:00:00Z");

beforeEach(() => {
  Object.assign(process.env, {
    SUPABASE_URL: "https://stub.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "sb_secret_test", RESEND_API_KEY: "re_test",
    LEAD_TO_EMAIL: "ops@example.test", LEAD_FROM_EMAIL: "Time to Power <power@timetopower.ai>",
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  db = newPaygDb();
  restore = db.install();
  mail = [];
  engine = mockEngine(mail);
});
afterEach(() => { engine.restore(); restore(); vi.useRealTimers(); vi.restoreAllMocks(); });

let seq = 0;
function use(account: string, units: number, over: Record<string, unknown> = {}) {
  db.rows("usage_events").push({
    event_id: `e${++seq}`, seq, account, key_id: "k", scope: "payg", endpoint: "/v1/study", units, kind: "charge", project: "", idem: "", ref: "",
    occurred_at: "2026-10-05T10:00:00.000Z", ...over,
  });
}
const alertsLib = () => import("@/lib/payg-alerts");
const notes = () => db.rows("customer_notifications") as any[];
const alertMail = () => mail.filter((m) => /GridForge:/.test(m.subject));

describe("usage alerts", () => {
  it("fire once per account / month / percent: 80% sends one, a rerun sends nothing, 100% sends exactly one more", async () => {
    const { sendUsageAlerts } = await alertsLib();
    paygAccount(db, { cap_units: 50 });
    use("acme-123456", 40); // 80% of 50
    const first = await sendUsageAlerts(NOW);
    expect(first).toMatchObject({ sent: 1, errors: 0 });
    expect(alertMail()).toHaveLength(1);
    expect(alertMail()[0].subject).toContain("80%");
    expect(alertMail()[0].to).toBe("ops@acme.example");
    expect(alertMail()[0].text).toContain("40 of 50 units in 2026-10");
    expect(alertMail()[0].text).toContain("hard stop");
    expect(alertMail()[0].text).toContain("HTTP 402");
    expect(alertMail()[0].text).toMatch(/EUR 80\.00/); // 40 units at the catalogue price
    expect(alertMail()[0].text).toContain("/api-access/");

    await sendUsageAlerts(NOW);
    await sendUsageAlerts(NOW);
    expect(alertMail()).toHaveLength(1);
    expect(db.rows("usage_alerts")).toHaveLength(1);

    use("acme-123456", 10); // now 100%
    const third = await sendUsageAlerts(NOW);
    expect(third.sent).toBe(1);
    await sendUsageAlerts(NOW);
    expect(alertMail()).toHaveLength(2);
    expect(alertMail()[1].subject).toContain("100%");
    expect((db.rows("usage_alerts") as any[]).map((a) => a.percent).sort((x, y) => x - y)).toEqual([80, 100]);
    expect(notes().map((n) => n.dedupe_key).sort()).toEqual([
      `usage_alert:${(db.rows("api_accounts")[0] as any).id}:2026-10:100`,
      `usage_alert:${(db.rows("api_accounts")[0] as any).id}:2026-10:80`,
    ]);
  });

  it("a jump straight past both thresholds sends both, once each; the percents come from the catalogue", async () => {
    const { sendUsageAlerts } = await alertsLib();
    paygAccount(db, { cap_units: 50 });
    use("acme-123456", 60);
    await sendUsageAlerts(NOW);
    await sendUsageAlerts(NOW);
    expect(alertMail()).toHaveLength(PAYG.alertPercents.length);
  });

  it("below 80% sends nothing; a new month starts afresh (the same percent alerts again)", async () => {
    const { sendUsageAlerts } = await alertsLib();
    paygAccount(db, { cap_units: 50 });
    use("acme-123456", 39);
    await sendUsageAlerts(NOW);
    expect(alertMail()).toHaveLength(0);
    use("acme-123456", 1);
    await sendUsageAlerts(NOW);
    expect(alertMail()).toHaveLength(1);
    // November
    vi.setSystemTime(new Date("2026-11-10T08:00:00Z"));
    use("acme-123456", 45, { occurred_at: "2026-11-02T10:00:00.000Z" });
    await sendUsageAlerts(new Date("2026-11-10T08:00:00Z"));
    expect(alertMail()).toHaveLength(2);
    expect(alertMail()[1].text).toContain("2026-11");
  });

  it("counts net of refunds (a refunded request does not push an account over a threshold)", async () => {
    const { sendUsageAlerts } = await alertsLib();
    paygAccount(db, { cap_units: 50 });
    use("acme-123456", 45);
    use("acme-123456", 45, { kind: "refund", ref: "e1", event_id: "r1" });
    await sendUsageAlerts(NOW);
    expect(alertMail()).toHaveLength(0);
  });

  it("alerts a free account about its free allowance (never about money), and a subscription account about nothing", async () => {
    const { sendUsageAlerts } = await alertsLib();
    paygAccount(db, { account: "free-1", token: "tok-free-0123456789abcdefghijk", plan: "api_free", cap_units: null, monthly_units: 25, email: "free@dev.example" });
    paygAccount(db, { account: "sub-1", token: "tok-sub-0123456789abcdefghijkl", plan: "api_scale", cap_units: null, monthly_units: 100, email: "sub@dev.example" });
    use("free-1", 25, { scope: "trial" });
    use("sub-1", 100, { scope: "machine" });
    await sendUsageAlerts(NOW);
    const m = alertMail();
    expect(m.map((x) => x.to)).toEqual(["free@dev.example", "free@dev.example"]);
    expect(m[0].text).toContain("free allowance");
    expect(m[0].text).toContain("never invoiced");
    expect(m[0].text).not.toMatch(/Accrued/);
  });

  it("does not alert a cancelled or past_due account, nor one with no cap on record", async () => {
    const { sendUsageAlerts } = await alertsLib();
    paygAccount(db, { account: "a", token: "tok-a-0123456789abcdefghijklmn", status: "past_due" });
    paygAccount(db, { account: "b", token: "tok-b-0123456789abcdefghijklmn", cap_units: null });
    use("a", 50); use("b", 50);
    await sendUsageAlerts(NOW);
    expect(alertMail()).toHaveLength(0);
  });

  it("when the outbox cannot record the obligation nothing is marked sent, so the next run still sends it", async () => {
    const { sendUsageAlerts } = await alertsLib();
    paygAccount(db, { cap_units: 50 });
    use("acme-123456", 45);
    db.failMethod = { method: "POST", status: 500, body: "{}" };
    const r = await sendUsageAlerts(NOW);
    expect(r.sent).toBe(0);
    expect(r.errors).toBeGreaterThan(0);
    expect(db.rows("usage_alerts")).toHaveLength(0);
    expect(alertMail()).toHaveLength(0);
    db.failMethod = null;
    expect((await sendUsageAlerts(NOW)).sent).toBe(1);
    expect(alertMail()).toHaveLength(1);
  });
});

describe("funnel events are a closed vocabulary", () => {
  it("accepts exactly the six events with allow-listed, code-shaped properties", () => {
    expect(FUNNEL_EVENTS).toEqual(expect.arrayContaining(["alert_sent", "first_charge", "free_account_created", "key_minted", "payg_enabled", "payment_failed"])); // the full closed list is pinned in payg-funnel-report.test.ts
    for (const name of FUNNEL_EVENTS.filter((n) => !n.startsWith("checkout_"))) expect(checkFunnelEvent(name, { plan: "api_payg", scope: "payg", cap_eur: 100, percent: 80, month: "2026-10", units: 12, amount_cents: 2400, account_ref: "0123456789ab", reason: "cap_change" }).ok).toBe(true); // the three checkout events take exactly kind (+ reason on a failure): tests/site/checkout-funnel.test.ts
    expect(checkFunnelEvent("key_minted", {}).ok).toBe(true);
  });

  it("REJECTS a non-allow-listed event name, property key, or value that could carry an email, a token, a card detail or free text", () => {
    const bad: [unknown, unknown, string][] = [
      ["page_view", {}, "unknown_event"],
      ["key_minted", { email: "a@b.example" }, "prop_not_allowed"],
      ["key_minted", { token: "abc" }, "prop_not_allowed"],
      ["key_minted", { company: "Acme" }, "prop_not_allowed"],
      ["key_minted", { card: "4242424242424242" }, "prop_not_allowed"],
      ["key_minted", { plan: "ops@acme.example" }, "bad_value"],
      ["key_minted", { plan: "gfk1.eyJhIjoiYWNtZSJ9.c2lnbmF0dXJlLXNpZ25hdHVyZS1zaWc" }, "bad_value"],
      ["key_minted", { plan: "n6xB2kq0wVn9mQp3hT7yL4aZ8sJ1cD5eF" }, "bad_value"],
      ["key_minted", { reason: "free text with spaces" }, "bad_value"],
      ["key_minted", { reason: "x".repeat(41) }, "bad_value"],
      ["key_minted", { plan: { nested: "x" } }, "bad_value"],
      ["key_minted", { units: Number.NaN }, "bad_value"],
      ["key_minted", { plan: null }, "bad_value"],
      ["key_minted", [], "props_not_object"],
      ["key_minted", "email=a@b.c", "props_not_object"],
    ];
    for (const [name, props, why] of bad) {
      const r = checkFunnelEvent(name, props);
      expect(r.ok, JSON.stringify(props)).toBe(false);
      expect(r).toEqual({ ok: false, reason: why });
    }
    // and the prop-key list itself holds nothing identifying
    for (const k of FUNNEL_PROP_KEYS) expect(k).not.toMatch(/mail|token|name|card|ip|address|company/);
  });

  it("recordFunnelEvent writes nothing for a refused event, and never throws", async () => {
    expect(await recordFunnelEvent("key_minted", { email: "a@b.example" } as never)).toBe(false);
    expect(await recordFunnelEvent("nonsense" as never, {})).toBe(false);
    expect(db.rows("funnel_events")).toHaveLength(0);
    db.dropTable("funnel_events");
    expect(await recordFunnelEvent("key_minted", { plan: "api_payg" })).toBe(false); // a missing table is a lost event, not an error
  });

  it("is once-only per dedupe key, and events without one all record", async () => {
    expect(await recordFunnelEvent("payg_enabled", { cap_eur: 100 }, { dedupeKey: "payg_enabled:abc" })).toBe(true);
    expect(await recordFunnelEvent("payg_enabled", { cap_eur: 100 }, { dedupeKey: "payg_enabled:abc" })).toBe(false);
    expect(await recordFunnelEvent("key_minted", { scope: "payg" })).toBe(true);
    expect(await recordFunnelEvent("key_minted", { scope: "payg" })).toBe(true);
    expect(db.rows("funnel_events")).toHaveLength(3);
  });

  it("the events the flows actually wrote contain no email, token or key", async () => {
    const { sendUsageAlerts } = await alertsLib();
    paygAccount(db, { cap_units: 50 });
    use("acme-123456", 45);
    await sendUsageAlerts(NOW);
    const { createFreeAccount } = await import("@/lib/payg-accounts");
    await createFreeAccount("someone@example.com", "Some Co");
    const all = JSON.stringify(db.rows("funnel_events"));
    expect(db.rows("funnel_events").length).toBeGreaterThanOrEqual(2);
    expect(all).not.toMatch(/@|gfk1|token|someone|Some Co|acme-123456|ops@/i);
  });
});

describe("per-scope cap usage (the engine counts caps per account, month and scope)", () => {
  it("a payg cap is spent only by payg units, the free allowance only by the rest, a subscription by everything", async () => {
    const { capUsedUnits } = await import("@/lib/payg-usage");
    const n = { net: 30, billable_net: 5 };
    expect(capUsedUnits("api_payg", n)).toBe(5);
    expect(capUsedUnits("api_free", n)).toBe(25);
    expect(capUsedUnits("api_scale", n)).toBe(30);
    expect(capUsedUnits("api_free", { net: 3, billable_net: 5 })).toBe(0);
  });
});
