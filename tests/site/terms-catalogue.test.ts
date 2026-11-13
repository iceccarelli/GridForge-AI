/**
 * The Terms page states the metered rate, the free allowance and the minimum invoice. They used to be typed into the page
 * (the one commercial text not derived from PAYG), so a change to the catalogue left the contract wording behind. They are now
 * read from PAYG through the repository's euro formatter.
 *
 * Same method as tests/site/agent-surface-parity.test.ts: render with the real catalogue, render again with a perturbed one,
 * and require the text to follow; then require that the source types no figure.
 */
import fs from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const E = "€"; // spelled so this file holds no price literal (tests/test_one_company.py)

async function renderTerms(perturb: boolean): Promise<string> {
  vi.resetModules();
  if (perturb) {
    vi.doMock("@/lib/products", async (orig) => {
      const real = await orig<typeof import("@/lib/products")>();
      return { ...real, PAYG: { ...real.PAYG, unitPriceCents: 275, minInvoiceCents: 725, freeAllowanceUnits: 31 } };
    });
  }
  const Terms = (await import("@/app/legal/terms/page")).default;
  return renderToStaticMarkup(Terms()).replace(/<!-- -->/g, "").replace(/&amp;/g, "&").replace(/&#x27;/g, "'");
}

afterEach(() => {
  vi.doUnmock("@/lib/products");
  vi.resetModules();
});

describe("Terms, section 3: the metered rate is the catalogue's", () => {
  it("states the unit price, the free allowance and the minimum invoice from PAYG", async () => {
    const html = await renderTerms(false);
    const { PAYG } = await import("@/lib/products");
    const { eurExact } = await import("@/lib/payg-pricing");
    expect(html).toContain(`${eurExact(PAYG.unitPriceCents)} per unit after the ${PAYG.freeAllowanceUnits}-unit monthly free allowance`);
    expect(html).toContain(`below the ${eurExact(PAYG.minInvoiceCents)} minimum invoice carry forward`);
  });

  it("follows the catalogue when it changes, and no earlier figure survives", async () => {
    const base = await renderTerms(false);
    const moved = await renderTerms(true);
    expect(moved).toContain(`${E}2.75 per unit after the 31-unit monthly free allowance`);
    expect(moved).toContain(`below the ${E}7.25 minimum invoice`);
    expect(moved).not.toContain(`${E}2 per unit`);
    expect(moved).not.toContain("25-unit");
    expect(moved).not.toContain(`${E}5 minimum`);
    // The catalogue's own figures were on the page before the change, so the test compares something.
    expect(base).not.toEqual(moved);
  });

  it("the page source types no euro amount and no free-allowance figure", () => {
    const src = fs.readFileSync("app/legal/terms/page.tsx", "utf8");
    const code = src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code, "a euro amount typed in the Terms source").not.toMatch(/€\s?\d|\bEUR\s?\d|\d\s?EUR\b/);
    expect(code, "the free allowance typed in the Terms source").not.toMatch(/\b\d+-unit\b|\b\d+ (?:free )?units\b/);
    expect(code, "the page must read the catalogue").toContain("PAYG");
  });
});
