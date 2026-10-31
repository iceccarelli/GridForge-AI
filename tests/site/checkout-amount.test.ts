/**
 * A one-time checkout that charged something other than the catalogue price is fulfilled (the money is taken) but flagged to a person.
 * The comparison is pure, so it is tested on every one-time product in the catalogue, not on a hand-picked one.
 */
import { describe, expect, it } from "vitest";
import { oneTimeAmountMismatch } from "@/lib/checkout-amount";
import { PRODUCTS } from "@/lib/products";

const oneTime = Object.values(PRODUCTS).filter((p) => !p.recurring);

describe("oneTimeAmountMismatch", () => {
  it("covers a real set of one-time products", () => {
    expect(oneTime.length).toBeGreaterThanOrEqual(4);
  });

  it.each(oneTime.map((p) => [p.id, p] as const))("%s: the catalogue price in EUR is silent", (_id, p) => {
    expect(oneTimeAmountMismatch(p, { amount_subtotal: p.amountCents, amount_total: p.amountCents, currency: "eur" })).toBeNull();
  });

  it.each(oneTime.map((p) => [p.id, p] as const))("%s: a different amount is named, with both figures", (_id, p) => {
    const m = oneTimeAmountMismatch(p, { amount_subtotal: p.amountCents - 1, currency: "eur" });
    expect(m).toContain(`charged ${p.amountCents - 1} cents`);
    expect(m).toContain(`sells it for ${p.amountCents}`);
  });

  it("flags another currency even at the right number", () => {
    const p = oneTime[0];
    expect(oneTimeAmountMismatch(p, { amount_subtotal: p.amountCents, currency: "USD" })).toContain("charged in USD");
  });

  it("compares the pre-discount subtotal, so a discount alone is not a catalogue mismatch", () => {
    const p = oneTime[0];
    expect(oneTimeAmountMismatch(p, { amount_subtotal: p.amountCents, amount_total: p.amountCents - 250_000, currency: "eur" })).toBeNull();
  });

  it("falls back to the total when a payload has no subtotal, and says nothing when it has neither", () => {
    const p = oneTime[0];
    expect(oneTimeAmountMismatch(p, { amount_total: p.amountCents + 5 })).not.toBeNull();
    expect(oneTimeAmountMismatch(p, {})).toBeNull();
  });

  it("is not for recurring products or unknown kinds (subscriptions are checked per subscription)", () => {
    expect(oneTimeAmountMismatch(PRODUCTS.hall_watch, { amount_subtotal: 1, currency: "eur" })).toBeNull();
    expect(oneTimeAmountMismatch(undefined, { amount_subtotal: 1, currency: "usd" })).toBeNull();
  });
});

describe("priceLine (llms.txt must not drop the billing period or the deposit's scoped band)", () => {
  it("states Hall Watch's real billing period", async () => {
    const { priceLine } = await import("@/lib/products");
    expect(priceLine(PRODUCTS.hall_watch)).toBe("€6,000 every 3 months");
  });
  it("states a deposit as a deposit with the engagement it opens", async () => {
    const { priceLine, eurFromCents } = await import("@/lib/products");
    for (const p of oneTime.filter((x) => x.opensBandCents)) {
      const line = priceLine(p);
      expect(line).toContain("deposit");
      expect(line).toContain(eurFromCents(p.opensBandCents![0]));
      expect(line).toContain(eurFromCents(p.opensBandCents![1]));
    }
  });
  it("leaves a fixed-fee product as its plain price", async () => {
    const { priceLine } = await import("@/lib/products");
    expect(priceLine(PRODUCTS.density_screen)).toBe("€4,500");
  });
});
