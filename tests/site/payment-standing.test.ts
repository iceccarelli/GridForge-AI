import { describe, expect, it } from "vitest";
import type Stripe from "stripe";
import { paymentStanding } from "@/lib/payment-standing";

const session = (charge: Partial<Stripe.Charge> | null, over: Partial<Stripe.Checkout.Session> = {}) =>
  async () => ({ payment_status: "paid", payment_intent: charge ? { latest_charge: { amount: 10000, amount_refunded: 0, refunded: false, disputed: false, ...charge } } : null, ...over }) as unknown as Stripe.Checkout.Session;

describe("paymentStanding", () => {
  it("a paid, undisputed, unrefunded charge stands", async () => {
    expect(await paymentStanding("cs_a", session({}))).toEqual({ state: "ok", partial_refund_cents: 0 });
  });
  it("a partial refund is reported but does not block", async () => {
    expect(await paymentStanding("cs_a", session({ amount_refunded: 2500 }))).toEqual({ state: "ok", partial_refund_cents: 2500 });
  });
  it("a full refund blocks, by flag or by amount", async () => {
    expect((await paymentStanding("cs_a", session({ refunded: true, amount_refunded: 10000 }))).state).toBe("refunded");
    expect((await paymentStanding("cs_a", session({ amount_refunded: 10000 }))).state).toBe("refunded");
  });
  it("a dispute blocks, and wins over a full refund", async () => {
    expect((await paymentStanding("cs_a", session({ disputed: true }))).state).toBe("disputed");
    expect((await paymentStanding("cs_a", session({ disputed: true, refunded: true, amount_refunded: 10000 }))).state).toBe("disputed");
  });
  it("an unexpanded payment intent or charge (a string id) on a paid session is unknown, never fine", async () => {
    const strPi = async () => ({ payment_status: "paid", payment_intent: "pi_1" }) as unknown as Stripe.Checkout.Session;
    const strCharge = async () => ({ payment_status: "paid", payment_intent: { latest_charge: "ch_1" } }) as unknown as Stripe.Checkout.Session;
    expect((await paymentStanding("cs_a", strPi)).state).toBe("unavailable");
    expect((await paymentStanding("cs_a", strCharge)).state).toBe("unavailable");
  });
  it("a paid session whose charge cannot be read is unknown, not fine", async () => {
    expect((await paymentStanding("cs_a", session(null))).state).toBe("unavailable");
  });
  it("Stripe failing is unavailable", async () => {
    expect((await paymentStanding("cs_a", async () => { throw new Error("down"); })).state).toBe("unavailable");
  });
  it("nothing to ask: no session, a malformed id, no payment due", async () => {
    expect((await paymentStanding(null, session({}))).state).toBe("unchecked");
    expect((await paymentStanding("not-a-session", session({}))).state).toBe("unchecked");
    expect((await paymentStanding("cs_a", session(null, { payment_status: "no_payment_required" }))).state).toBe("unchecked");
  });
});
