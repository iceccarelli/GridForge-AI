import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LADDER_PRODUCTS, priceLine } from "@/lib/products";
import { PRODUCT_PAGES, productForPage } from "@/lib/product-pages";
import { engagementOfferJsonLd } from "@/lib/jsonld";
import { FOOTER_GROUPS } from "@/lib/nav";
import sitemap from "@/app/sitemap";

describe("per-product pages", () => {
  it("cover exactly the ladder, one page per product, with unique slugs", () => {
    expect(PRODUCT_PAGES.map((p) => p.productId).sort()).toEqual(LADDER_PRODUCTS.map((p) => p.id).sort());
    expect(new Set(PRODUCT_PAGES.map((p) => p.slug)).size).toBe(PRODUCT_PAGES.length);
  });

  it("carry no price or duration literal of their own", () => {
    const src = readFileSync("lib/product-pages.ts", "utf8");
    expect(src).not.toMatch(/[€$]\s?\d/);
    expect(src).not.toMatch(/\b\d+\s+(working\s+)?days?\b/i);
  });

  it("state the deposit honestly: a deposit page says what it opens", () => {
    for (const page of PRODUCT_PAGES) {
      const p = productForPage(page);
      if (p.opensBandCents) {
        expect(priceLine(p)).toMatch(/deposit/);
        expect(page.limits.join(" ")).toMatch(/not the price/);
      }
    }
  });

  it("make no claim of customers, results, certification or indemnity", () => {
    const text = JSON.stringify(PRODUCT_PAGES).toLowerCase();
    for (const banned of ["customers use", "trusted by", "guarantee", "certified", "market leader", "case study"]) {
      expect(text).not.toContain(banned);
    }
  });

  it("emit a catalogue-derived offer", () => {
    for (const page of PRODUCT_PAGES) {
      expect(engagementOfferJsonLd(productForPage(page))["@type"]).toBe("Offer");
    }
  });

  it("are linked from the footer and listed in the sitemap", async () => {
    const footer = FOOTER_GROUPS.flatMap((g) => g.links.map((l) => l.href));
    const map = (await sitemap()).map((e) => e.url);
    for (const page of PRODUCT_PAGES) {
      expect(footer).toContain(`/products/${page.slug}`);
      expect(map.some((u) => u.endsWith(`/products/${page.slug}`))).toBe(true);
    }
  });
});
