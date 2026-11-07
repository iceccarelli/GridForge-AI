/**
 * What a visitor can do from a product page, and what the page tells them before they pay.
 *
 * The audit found: no sample of the entry product, no link from a product page to /qualify or to the audience page that matches it, the buy
 * button below the first screen on a phone, and nothing that answers "what do I get, from whom, by when, and what does it not do" in one
 * place. This holds the page to: the three next steps come before the long copy; the "Before you buy" block is built only from facts the
 * code proves; and it invents no refund, tax, entity or cancellation term.
 */
import fs from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import ProductPageRoute from "@/app/products/[slug]/page";
import { AUDIENCES } from "@/lib/audiences";
import { PRODUCT_PAGES, audiencesForProduct, beforeYouBuy, productForPage, turnaroundText } from "@/lib/product-pages";
import { REFERENCE_DOCUMENTS } from "@/lib/reference-docs";

const html = async (slug: string) =>
  renderToStaticMarkup(await ProductPageRoute({ params: Promise.resolve({ slug }) })).replace(/<!-- -->/g, "");
const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&#x27;|&apos;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");

describe.each(PRODUCT_PAGES.map((p) => [p.slug, p] as const))("/products/%s", (slug, page) => {
  const p = productForPage(page);

  it("puts the buy button, the sample and the free check before the long description and the Before-you-buy block", async () => {
    const h = await html(slug);
    const buy = h.indexOf(`Commission the ${p.name.replace(/&/g, "&amp;")}`);
    const sample = h.indexOf("See the sample deliverable");
    const free = h.indexOf("Try the free capacity check first");
    // The Service JSON-LD in the head repeats the description; the visible one is what follows the actions.
    const description = h.indexOf(p.description.replace(/&/g, "&amp;").replace(/'/g, "&#x27;"), h.indexOf("</script>", h.lastIndexOf("application/ld+json")));
    const before = h.indexOf("Before you buy");
    for (const [name, at] of Object.entries({ buy, sample, free, description, before })) expect(at, name).toBeGreaterThan(-1);
    expect(Math.max(buy, sample, free)).toBeLessThan(Math.min(description, before));
  });

  it("links the sample of this very deliverable, or says plainly that none is published", async () => {
    const h = await html(slug);
    if (page.sample) {
      expect(h).toContain(`href="${page.sample.href}"`);
      expect(REFERENCE_DOCUMENTS.map((d) => `/reference/${d}.html`)).toContain(page.sample.href);
      expect(fs.existsSync(path.join(process.cwd(), "public", page.sample.href))).toBe(true);
    } else {
      expect(h).toContain('href="/reference"');
      expect(text(h)).toContain("No sample of this document is published yet");
    }
  });

  it("links the free check and every audience page whose route includes this product", async () => {
    const h = await html(slug);
    expect(h).toContain('href="/qualify"');
    const audiences = audiencesForProduct(p.id);
    for (const a of audiences) expect(h, a.slug).toContain(`href="/for/${a.slug}"`);
    // Where the audience map has nothing for a product, the page shows no audience section rather than inventing one.
    expect(h.includes("Read it for your role")).toBe(audiences.length > 0);
  });

  it("states turnaround with its basis, from the catalogue", async () => {
    const rows = beforeYouBuy(page);
    expect(rows.find((r) => r.label === "Turnaround")?.text).toBe(turnaroundText(p));
    expect(turnaroundText(p)).toContain(String(p.turnaroundDays));
    expect(text(await html(slug))).toContain(turnaroundText(p));
  });

  it("claims a named reviewer only for the products an engine endpoint generates and an engineer releases", () => {
    const review = beforeYouBuy(page).find((r) => r.label === "Who reviews it");
    expect(Boolean(review)).toBe(Boolean(p.endpoint));
    if (review) {
      expect(review.text).toMatch(/named engineer/);
      expect(review.text).toMatch(/not an issued engineering opinion/);
    }
  });

  it("lists what it does not include from the page's own limits, and points at the terms without describing them", async () => {
    const rows = beforeYouBuy(page);
    expect(rows.find((r) => r.label === "Not included")?.items).toEqual(page.limits);
    const terms = rows.find((r) => r.label === "Terms")!;
    expect(terms.link).toEqual({ href: "/legal/terms", label: "Read the terms" });
    expect(terms.text).toBe("Your purchase is subject to our terms.");
    expect(await html(slug)).toContain('href="/legal/terms"');
  });

  it("invents no refund, tax, legal-entity, guarantee or cancellation term in the block it adds", () => {
    const own = beforeYouBuy(page)
      .filter((r) => r.label !== "Not included" && r.label !== "You receive")
      .map((r) => r.text)
      .join(" ")
      .toLowerCase();
    expect(own).not.toMatch(/refund|vat\b|tax|money-back|money back|guarantee|cancel|ltd|gmbh|limited company|invoice|within \d+ days/);
  });
});

describe("the audience map", () => {
  it("routes every audience page to the product pages that exist, and the density screen to all of them", () => {
    const ids = new Set(PRODUCT_PAGES.map((p) => p.productId));
    for (const a of AUDIENCES) for (const s of a.path) if (s.kind !== "qualifier" && ids.has(s.kind)) expect(audiencesForProduct(s.kind).map((x) => x.slug)).toContain(a.slug);
    expect(audiencesForProduct("density_screen").length).toBe(AUDIENCES.length);
  });
});

describe("the Density Screen's data request is the sample's list of what it had to assume", () => {
  it("is linked from the block, and the sample really has that section", () => {
    const page = PRODUCT_PAGES.find((p) => p.slug === "density-screen")!;
    const row = beforeYouBuy(page).find((r) => r.label === "What we need from you")!;
    expect(row.link?.href).toBe("/reference/density_screen.html");
    expect(fs.readFileSync(path.join(process.cwd(), "public/reference/density_screen.md"), "utf8")).toContain("What we had to assume");
  });
});
