/**
 * Red-team F8: the Founding Partner credit was minted as a fresh EUR 2,500 coupon per checkout session while slots were counted only
 * from PAID deposits, so N concurrent sessions each got the credit. A slot is now RESERVED atomically (gf_founding_reserve) before
 * any coupon exists. Stripe is a mock; the reservation function is mirrored from SQL (SUPPLEMENTAL, proven in
 * tests/test_payg_migration.py against real PostgreSQL, including under concurrent connections).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { siteUrl } from "@/lib/site";
import { COMMERCE } from "@/lib/commerce";
import { PostgrestFake } from "./postgrest-fake";

const coupons: Record<string, unknown>[] = [];
const sessions: Record<string, any>[] = [];
let failSession = false;

vi.mock("stripe", () => ({
  default: class {
    coupons = { create: async (p: Record<string, unknown>) => (coupons.push(p), { id: `coupon_${coupons.length}` }) };
    checkout = { sessions: { create: async (p: Record<string, any>) => { if (failSession) throw new Error("stripe down"); sessions.push(p); return { url: "https://checkout.stripe.test/s" }; } } };
  },
}));

let db: PostgrestFake;
let restore: () => void;

beforeEach(() => {
  process.env.STRIPE_SECRET_KEY = "sk_test_x";
  process.env.GRIDFORGE_LEGACY_DEPOSIT = "1"; // the off-catalogue path is opt-in (QA6-8); the reservation tests exercise it deliberately
  process.env.SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_test";
  coupons.length = 0; sessions.length = 0; failSession = false;
  vi.spyOn(console, "error").mockImplementation(() => {});
  db = new PostgrestFake(["engagement_deposits"]);
  restore = db.install();
});
afterEach(() => { delete process.env.GRIDFORGE_LEGACY_DEPOSIT; restore(); vi.restoreAllMocks(); });

const paid = (n: number) => db.seed("engagement_deposits", Array.from({ length: n }, (_, i) => ({ stripe_session_id: `cs_${i}`, kind: "engagement_deposit", amount_cents: COMMERCE.deposit.amountCents - COMMERCE.founding.creditCents, status: "paid" })));
const checkout = async () =>
  (await import("@/app/api/checkout/route")).POST(new Request(siteUrl("/api/checkout"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ founding: true }) }));

describe("the last Founding slots go to exactly as many sessions as there are slots", () => {
  it("N concurrent checkouts for the last slot: ONE coupon, ONE credited session (it was N before the reservation)", async () => {
    paid(COMMERCE.founding.totalSlots - 1);
    const results = await Promise.all(Array.from({ length: 6 }, () => checkout()));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(coupons).toHaveLength(1);
    expect(sessions.filter((s) => s.metadata.founding_applied === "yes")).toHaveLength(1);
    expect(sessions.filter((s) => s.metadata.founding_applied === "no")).toHaveLength(5);
    expect(sessions.filter((s) => s.discounts.length === 0)).toHaveLength(5);
  });

  it("with all slots free, concurrent sessions are credited up to the slot count and no further", async () => {
    const total = COMMERCE.founding.totalSlots;
    await Promise.all(Array.from({ length: total + 4 }, () => checkout()));
    expect(coupons).toHaveLength(total);
    expect(sessions.filter((s) => s.metadata.founding_applied === "yes")).toHaveLength(total);
  });

  it("a credited session carries its reservation and lapses before the reservation does", async () => {
    paid(0);
    await checkout();
    const s = sessions[0];
    expect(s.metadata.founding_reservation).toMatch(/^[0-9a-f-]{36}$/);
    expect(db.rows("founding_reservations")).toHaveLength(1);
    const lifeMin = (s.expires_at - Date.now() / 1000) / 60;
    expect(lifeMin).toBeGreaterThanOrEqual(30); // Stripe's minimum session life
    expect(new Date((db.rows("founding_reservations")[0] as any).expires_at).getTime() / 1000).toBeGreaterThan(s.expires_at);
  });

  it("gives the slot back when Stripe fails, so a failed checkout does not burn a slot", async () => {
    paid(COMMERCE.founding.totalSlots - 1);
    failSession = true;
    expect((await checkout()).status).toBe(500);
    expect(db.rows("founding_reservations")).toHaveLength(0);
    failSession = false;
    await checkout();
    expect(coupons.length).toBeGreaterThanOrEqual(1);
    expect(sessions.at(-1)!.metadata.founding_applied).toBe("yes");
  });

  it("an expired reservation frees its slot", async () => {
    paid(COMMERCE.founding.totalSlots - 1);
    await checkout(); // reserves the last slot
    (db.rows("founding_reservations")[0] as any).expires_at = new Date(Date.now() - 1000).toISOString();
    await checkout();
    expect(sessions.filter((s) => s.metadata.founding_applied === "yes")).toHaveLength(2);
  });

  it("FAILS CLOSED (503, no coupon, no session) when the reservation cannot be made, e.g. migration 0028 is not applied", async () => {
    paid(0);
    db.rpcs.delete("gf_founding_reserve");
    const res = await checkout();
    expect(res.status).toBe(503);
    expect(coupons).toHaveLength(0);
    expect(sessions).toHaveLength(0);
  });

  it("the ordinary deposit is unaffected when no slot is left", async () => {
    paid(COMMERCE.founding.totalSlots);
    const body = await (await checkout()).json();
    expect(body.founding_applied).toBe(false);
    expect(coupons).toHaveLength(0);
  });
});

describe("QA6-8: a NEW generic deposit or Founding session needs the explicit legacy flag", () => {
  const post = async (body: unknown) =>
    (await import("@/app/api/checkout/route")).POST(new Request(siteUrl("/api/checkout"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));

  it("by default `{}`, `{founding:true}` and a body with no product are refused (400, naming the catalogue): no coupon, no session, nothing charged", async () => {
    delete process.env.GRIDFORGE_LEGACY_DEPOSIT;
    for (const body of [{}, { founding: true }, { company: "X", email: "a@b.example", capacityMW: 20 }]) {
      const res = await post(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      const j = await res.json();
      expect(j.ok).toBe(false);
      expect(j.error).toMatch(/no generic deposit/i);
      expect(j.error).toMatch(/catalogue/i);
    }
    expect(coupons).toHaveLength(0);
    expect(sessions).toHaveLength(0);
    expect(db.rows("founding_reservations")).toHaveLength(0);
  });

  it("any value other than exactly 1 leaves it off", async () => {
    for (const v of ["0", "true", "yes", ""]) {
      process.env.GRIDFORGE_LEGACY_DEPOSIT = v;
      expect((await post({ founding: true })).status, v).toBe(400);
    }
    expect(sessions).toHaveLength(0);
  });

  it("with the flag on, the old path works unchanged (including the Founding reservation)", async () => {
    process.env.GRIDFORGE_LEGACY_DEPOSIT = "1";
    expect((await post({ founding: true })).status).toBe(200);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].metadata.kind).toBe("engagement_deposit");
  });

  it("a CATALOGUE product is never affected by the flag", async () => {
    delete process.env.GRIDFORGE_LEGACY_DEPOSIT;
    const res = await post({ product: "density_screen" });
    expect(res.status).toBe(200);
    expect(sessions[0].metadata.kind).toBe("density_screen");
  });
});
