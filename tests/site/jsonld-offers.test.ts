/**
 * The homepage's structured data tells machines the truth about what the engagements are and what they cost.
 *
 *  - every price in it equals the catalogue (lib/products.ts); none is typed in the markup;
 *  - a deposit (scoped with a person, no intake form) is not "InStock", and says "deposit";
 *  - Hall Watch's EUR 6,000 is per quarter, and the markup says so, so it cannot be read as one-off;
 *  - there is ONE priced OfferCatalog, not two overlapping ones;
 *  - nothing claims a rating, a review or a count of anything.
 */
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { JsonLd } from "@/components/JsonLd";
import { engagementCatalogJsonLd, engagementOfferJsonLd, isDepositProduct } from "@/lib/jsonld";
import { LADDER_PRODUCTS, PRODUCTS, eurFromCents } from "@/lib/products";

function blocks(): any[] {
  const html = renderToStaticMarkup(React.createElement(JsonLd));
  return [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) =>
    JSON.parse(m[1].replace(/\\u003c/g, "<"))
  );
}

function pricesIn(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) node.forEach((n) => pricesIn(n, out));
  else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (k === "price") out.push(String(v));
      else pricesIn(v, out);
    }
  }
  return out;
}

const cents = (price: string) => Math.round(Number(price) * 100);

describe("the homepage JSON-LD", () => {
  const all = blocks();
  const catalogs = all.filter((b) => b["@type"] === "OfferCatalog");

  it("carries exactly one OfferCatalog, the priced one (no second, overlapping, unpriced catalogue)", () => {
    expect(catalogs).toHaveLength(1);
    expect(catalogs[0].name).toMatch(/Engagements$/);
    expect(catalogs[0].itemListElement).toHaveLength(LADDER_PRODUCTS.length);
  });

  it("every price equals the catalogue amount for that product, and no price is invented", () => {
    const catalogue = new Set(Object.values(PRODUCTS).map((p) => p.amountCents));
    const found = pricesIn(all);
    expect(found.length).toBe(LADDER_PRODUCTS.length);
    for (const price of found) expect(catalogue.has(cents(price)), `price ${price} is not a catalogue amount`).toBe(true);
    catalogs[0].itemListElement.forEach((offer: any, i: number) => {
      const p = LADDER_PRODUCTS[i];
      const price = offer.priceSpecification ? offer.priceSpecification.price : offer.price;
      expect(cents(price), p.id).toBe(p.amountCents);
      expect(offer.priceCurrency, p.id).toBe("EUR");
    });
  });

  it("a deposit is not InStock and its name says deposit", () => {
    const deposits = LADDER_PRODUCTS.filter(isDepositProduct);
    expect(deposits.map((p) => p.id).sort()).toEqual(["envelope_study_deposit", "portfolio_screen_deposit"]);
    for (const p of deposits) {
      const offer: any = engagementOfferJsonLd(p);
      expect(offer.availability, p.id).toBeUndefined();
      expect(JSON.stringify(offer), p.id).not.toMatch(/InStock|PreOrder|OnlineOnly/);
      expect(offer.name, p.id).toMatch(/deposit/i);
      expect(offer.itemOffered.name, p.id).toMatch(/deposit/i);
      expect(offer.description, p.id).toMatch(/deposit/i);
      // The scoped band it opens is stated from the catalogue, not typed.
      expect(offer.description, p.id).toContain(eurFromCents(p.opensBandCents![0]));
      expect(offer.description, p.id).toContain(eurFromCents(p.opensBandCents![1]));
    }
  });

  it("a deposit is marked deposit even if a future product name forgets to say so", () => {
    const offer: any = engagementOfferJsonLd({ ...PRODUCTS.envelope_study_deposit, name: "Capacity & Density Envelope Study" });
    expect(offer.name).toMatch(/deposit/i);
  });

  it("fixed-fee engagements bought at checkout stay InStock", () => {
    for (const id of ["density_screen", "procurement_spec"] as const) {
      expect((engagementOfferJsonLd(PRODUCTS[id]) as any).availability).toBe("https://schema.org/InStock");
    }
  });

  it("Hall Watch is a recurring price: a UnitPriceSpecification with its billing duration, and no bare one-off price", () => {
    const p = PRODUCTS.hall_watch;
    expect(p.recurring).toEqual({ interval: "month", intervalCount: 3 });
    const offer: any = engagementOfferJsonLd(p);
    expect(offer.price).toBeUndefined();
    expect(offer.priceSpecification).toMatchObject({
      "@type": "UnitPriceSpecification",
      priceCurrency: "EUR",
      billingDuration: "P3M",
      referenceQuantity: { "@type": "QuantitativeValue", value: 3, unitCode: "MON" },
    });
    expect(cents(offer.priceSpecification.price)).toBe(p.amountCents);
    expect(offer.priceSpecification.unitText).toMatch(/per 3 months/);
  });

  it("only recurring products carry a priceSpecification; only the recurring one is not a plain price", () => {
    for (const p of LADDER_PRODUCTS) {
      const offer: any = engagementOfferJsonLd(p);
      expect(Boolean(offer.priceSpecification), p.id).toBe(Boolean(p.recurring));
      expect(offer.price === undefined, p.id).toBe(Boolean(p.recurring));
    }
  });

  it("claims no rating, review, count of reviews, or aggregate anything, anywhere in the page's structured data", () => {
    const flat = JSON.stringify(all);
    expect(flat).not.toMatch(/aggregateRating|reviewRating|ratingValue|ratingCount|reviewCount|"review"|"Review"|bestRating|interactionStatistic|userCount/);
  });

  it("is built from the same function the page uses", () => {
    expect(catalogs[0]).toEqual(engagementCatalogJsonLd());
  });
});
