/**
 * The homepage card for a deposit must not read as the price of the engagement it opens.
 *
 * The Study card showed the deposit as its figure ("Commission — <deposit>") while the engagement it opens is priced in a band the card never
 * mentioned, and every card's days ran from an unstated start. The pricing page already said both correctly; the home page now says the same
 * thing from the same catalogue fields.
 */
import { describe, expect, it } from "vitest";
import { PRODUCTS, eurFromCents } from "@/lib/products";
import { serviceCards } from "@/lib/site";

const cards = serviceCards();
const card = (id: string) => cards.find((c) => c.productId === id)!;

describe("homepage service cards", () => {
  it("every deposit card names the band it is a deposit against, with both figures from the catalogue", () => {
    const deposits = cards.filter((c) => PRODUCTS[c.productId].opensBandCents);
    expect(deposits.length).toBeGreaterThan(0);
    for (const c of deposits) {
      const [lo, hi] = PRODUCTS[c.productId].opensBandCents!;
      expect(c.band).toBe(`Deposit against ${eurFromCents(lo)}–${eurFromCents(hi)}`);
    }
  });

  it("no card that is not a deposit claims a band", () => {
    for (const c of cards.filter((c) => !PRODUCTS[c.productId].opensBandCents)) expect(c.band).toBeNull();
  });

  it("says where the days start: from the scoping call for a deposit, from a complete intake for a fixed-fee document", () => {
    expect(card("envelope_study_deposit").timeline).toContain("from the scoping call");
    expect(card("density_screen").timeline).toContain("from a complete intake");
    expect(card("procurement_spec").timeline).toContain("from a complete intake");
    expect(card("hall_watch").timeline).toBe("Continuous");
  });

  it("the day counts are still the catalogue's", () => {
    for (const c of cards.filter((c) => !PRODUCTS[c.productId].recurring)) {
      expect(c.timeline.startsWith(`${PRODUCTS[c.productId].turnaroundDays} working days`)).toBe(true);
    }
  });
});
