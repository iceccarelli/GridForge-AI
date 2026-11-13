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
import { afterEach, describe, expect, it, vi } from "vitest";
import { JsonLd } from "@/components/JsonLd";
import { apiServiceJsonLd, engagementCatalogJsonLd, engagementOfferJsonLd, isDepositProduct } from "@/lib/jsonld";
import { eurExact } from "@/lib/payg-pricing";
import { API_PRODUCTS, LADDER_PRODUCTS, PAYG, PRODUCTS, eurFromCents } from "@/lib/products";
import { FULL_ENGINE, stubEngine } from "./engine-stub";

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

// ---------------------------------------------------------------------------------------------------------------------------------
// The metered API: the free allowance, pay-as-you-go and the monthly plans, as schema.org Offers on a WebAPI.
// ---------------------------------------------------------------------------------------------------------------------------------
async function pageBlocks(load: () => Promise<{ default: () => unknown }>): Promise<any[]> {
  const stop = stubEngine(FULL_ENGINE);
  try {
    const html = renderToStaticMarkup(await ((await load()).default as () => Promise<React.ReactElement>)());
    return [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1].replace(/\\u003c/g, "<")));
  } finally {
    stop();
  }
}

describe("/developers structured data: the API, its free allowance, pay-as-you-go and plans", () => {
  it("is WebPage + WebAPI + BreadcrumbList, every block parses, and the offers are the catalogue's", async () => {
    const blocks = await pageBlocks(() => import("@/app/developers/page"));
    expect(blocks.map((b) => b["@type"]).sort()).toEqual(["BreadcrumbList", "WebAPI", "WebPage"]);
    const api = blocks.find((b) => b["@type"] === "WebAPI");
    expect(api).toEqual(JSON.parse(JSON.stringify(apiServiceJsonLd({ plans: true }))));
    const [free, payg, ...plans] = api.offers;
    expect(api.offers).toHaveLength(2 + API_PRODUCTS.length);

    // the free allowance: nothing to pay, for the quantity the catalogue states
    expect(free).toMatchObject({ "@type": "Offer", name: "Free allowance", price: "0", priceCurrency: "EUR" });
    expect(free.eligibleQuantity).toMatchObject({ value: PAYG.freeAllowanceUnits, unitText: "units per month" });
    expect(free.description).toContain(`${PAYG.freeAllowanceUnits} units a month`);

    // pay-as-you-go: the unit price, in the catalogue's currency, per unit; the minimum invoice and the carry-forward are in the sentence
    expect(cents(payg.priceSpecification.price)).toBe(PAYG.unitPriceCents);
    expect(payg.priceSpecification).toMatchObject({
      "@type": "UnitPriceSpecification",
      priceCurrency: PAYG.currency.toUpperCase(),
      unitText: "per unit",
      referenceQuantity: { value: 1, unitText: "unit" },
    });
    expect(payg.description).toContain("minimum invoice");
    expect(payg.description).toContain(eurExact(PAYG.minInvoiceCents));
    expect(payg.description).toContain("carried forward");

    // the plans: price per month and the included units, per product
    plans.forEach((offer: any, i: number) => {
      const p = API_PRODUCTS[i];
      expect(offer.name).toBe(p.name);
      expect(cents(offer.priceSpecification.price), p.id).toBe(p.amountCents);
      expect(offer.priceSpecification).toMatchObject({ billingDuration: "P1M", unitText: "per month", referenceQuantity: { value: 1, unitCode: "MON" } });
      expect(offer.description, p.id).toContain(`${p.apiUnits} metered units a month`);
    });
  });

  it("every price in it is a catalogue amount, and it claims no availability, rating, review or count", async () => {
    const blocks = await pageBlocks(() => import("@/app/developers/page"));
    const catalogue = new Set<number>([PAYG.unitPriceCents, ...API_PRODUCTS.map((p) => p.amountCents)]);
    const found = pricesIn(blocks);
    // the free allowance has price "0" on the Offer itself; the others are inside priceSpecification
    expect(found).toHaveLength(2 + API_PRODUCTS.length);
    for (const price of found) expect(price === "0" || catalogue.has(cents(price)), `price ${price} is not a catalogue amount`).toBe(true);
    const flat = JSON.stringify(blocks);
    expect(flat).not.toMatch(/availability|InStock|PreOrder|OnlineOnly|aggregateRating|reviewRating|ratingValue|reviewCount|"review"|bestRating|userCount/);
  });

  it("/pricing carries the free allowance and pay-as-you-go it shows, and not the plans it points to /developers for", async () => {
    const blocks = await pageBlocks(() => import("@/app/pricing/page"));
    const api = blocks.find((b) => b["@type"] === "WebAPI");
    expect(api.offers.map((o: any) => o.name)).toEqual(["Free allowance", "Pay-as-you-go"]);
    expect(blocks.map((b) => b["@type"]).sort()).toEqual(["BreadcrumbList", "OfferCatalog", "WebAPI", "WebPage"]);
  });

  describe("follows the catalogue", () => {
    afterEach(() => {
      vi.doUnmock("@/lib/products");
      vi.resetModules();
    });

    it("change the unit price, the free allowance, the minimum invoice or a plan and the markup changes with it", async () => {
      vi.resetModules();
      vi.doMock("@/lib/products", async (orig) => {
        const real = await orig<typeof import("@/lib/products")>();
        const products = { ...real.PRODUCTS, api_scale: { ...real.PRODUCTS.api_scale, amountCents: 333_300, apiUnits: 3_333 } };
        return {
          ...real,
          PRODUCTS: products,
          API_PRODUCTS: Object.values(products).filter((p) => p.surface === "developers"),
          PAYG: { ...real.PAYG, unitPriceCents: 275, minInvoiceCents: 725, freeAllowanceUnits: 31 },
        };
      });
      const { apiServiceJsonLd: moved } = await import("@/lib/jsonld");
      const api = JSON.parse(JSON.stringify(moved({ plans: true })));
      const [free, payg, ...plans] = api.offers;
      expect(free.eligibleQuantity.value).toBe(31);
      expect(free.description).toContain("31 units a month");
      expect(payg.priceSpecification.price).toBe("2.75");
      expect(payg.description).toContain("7.25");
      const scale = plans.find((o: any) => o.name === "API — Scale");
      expect(scale.priceSpecification.price).toBe("3333");
      expect(scale.description).toContain("3333 metered units a month");
      expect(JSON.stringify(api)).not.toContain("25 units a month");
    });
  });
});
