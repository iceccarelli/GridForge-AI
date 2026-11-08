import { homeSource } from "./_home";
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

describe("the ladder links to the pages", () => {
  it("renders a Details link for every rung", () => {
    const src = readFileSync("components/EngagementLadder.tsx", "utf8");
    // The component links with a tiny slug map, not the page copy (that would put the copy into the browser bundle); a test pins the map to PRODUCT_PAGES.
    expect(src).toContain("/products/${slug}");
    expect(src).toContain("PRODUCT_PAGE_SLUGS");
    expect((src.match(/<DetailsLink /g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
});

describe("the engagements index and breadcrumbs", () => {
  it("lists /products in the sitemap and footer and builds a valid trail", async () => {
    const { breadcrumbJsonLd } = await import("@/lib/jsonld");
    const trail = breadcrumbJsonLd([
      { name: "Home", path: "/" },
      { name: "Engagements", path: "/products" },
    ]);
    expect(trail.itemListElement.map((i) => i.position)).toEqual([1, 2]);
    expect(trail.itemListElement[1].item).toMatch(/\/products$/);
    expect((await sitemap()).some((e) => e.url.endsWith("/products"))).toBe(true);
    expect(FOOTER_GROUPS.flatMap((g) => g.links.map((l) => l.href))).toContain("/products");
  });
});

describe("structured data on the high-intent pages", () => {
  it("qualifier markup states only what the page states", async () => {
    const { qualifierJsonLd } = await import("@/lib/jsonld");
    const q = qualifierJsonLd();
    expect(q["@type"]).toBe("WebApplication");
    expect(q.offers.price).toBe("0");
    const text = JSON.stringify(q).toLowerCase();
    for (const banned of ["aggregaterating", "review", "ratingvalue", "users"]) expect(text).not.toContain(banned);
  });

  it("the pages emit it", () => {
    for (const f of ["app/qualify/page.tsx", "app/pricing/page.tsx", "app/developers/page.tsx"]) {
      expect(readFileSync(f, "utf8")).toContain("<PageJsonLd");
    }
  });
});

describe("audit fixes: discovery and metadata", () => {
  it("every page that sets openGraph also sets its title and description (Next replaces, not merges)", () => {
    for (const f of ["app/page.tsx", "app/power/compare/page.tsx", "app/power/deploy/page.tsx"]) {
      const src = readFileSync(f, "utf8");
      const og = src.slice(src.indexOf("openGraph"));
      expect(og, f).toMatch(/title:/);
      expect(og, f).toMatch(/description:/);
    }
  });

  it("customer power-deploy cases are closed to crawlers but the public page is not", async () => {
    const robots = (await import("@/app/robots")).default;
    const rules = robots().rules as { userAgent: string; allow?: string | string[]; disallow?: string | string[] }[];
    const star = rules.find((r) => r.userAgent === "*")!;
    const dis = ([] as string[]).concat(star.disallow ?? []);
    expect(dis).toContain("/power/deploy/");
    expect(dis).not.toContain("/power/deploy");
  });

  it("the observatory and intelligence pages are linked from the footer", () => {
    const hrefs = FOOTER_GROUPS.flatMap((g) => g.links.map((l) => l.href));
    expect(hrefs).toContain("/observatory");
    expect(hrefs).toContain("/intelligence");
  });

  it("public copy never promises an engineer's sign-off or a name on an opinion", () => {
    for (const f of ["__HOME__", "app/pricing/page.tsx", "components/ThreePaths.tsx", "app/qualify/page.tsx", "lib/site.ts", "lib/products.ts"]) {
      const t = (f === "__HOME__" ? homeSource() : readFileSync(f, "utf8")).toLowerCase().replace(/&apos;|&rsquo;/g, "'");
      expect(t, f).not.toMatch(/carries an engineer's sign-off|engineer's name on an opinion|engineering you can rely on/);
    }
  });

  it("the Density Screen's turnaround is never stated without its basis on the home page", () => {
    const t = homeSource();
    expect(t).not.toMatch(/five working days,\s/);
  });
});
