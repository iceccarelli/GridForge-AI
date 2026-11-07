/**
 * /pricing tells one true story about how an engagement is priced, shows the market-intelligence subscription as its own section with
 * prices read from the catalogue, and gives a one-line "which one do I need?".
 *
 * The audit found "Fixed fee agreed before we start" on /pricing against "Pay the deposit; a person contacts you to scope" on the Study
 * and Portfolio pages, and the Intelligence plans (three prices) nowhere on /pricing.
 */
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FULL_ENGINE, stubEngine } from "./engine-stub";
import ThreePaths from "@/components/ThreePaths";
import { PRODUCT_PAGES } from "@/lib/product-pages";
import { CAPABILITY_REGISTRY } from "@/lib/capability-registry";
import { INTELLIGENCE_PLANS, INTELLIGENCE_PLAN_IDS } from "@/lib/products";
import { eurMonth } from "@/lib/subscriptions";

const text = (h: string) => h.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, " ").replace(/&#x27;|&apos;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");

async function pricing(): Promise<string> {
  const stop = stubEngine(FULL_ENGINE);
  try {
    const page = (await import("@/app/pricing/page")).default;
    return renderToStaticMarkup(await page()).replace(/<!-- -->/g, "");
  } finally {
    stop();
  }
}

describe("/pricing", () => {
  it("no longer says a fee is 'agreed before we start' without saying how the Study and Portfolio fee is agreed", async () => {
    const t = text(await pricing());
    expect(t).not.toMatch(/Fixed fee agreed before we\s+start/i);
    expect(t).not.toMatch(/fixed-fee and agreed before we start/i);
    // The wording true of the deposit flow (lib/engagement-state.ts depositTerms): a deposit, then a fee agreed in writing before work starts.
    expect(t).toMatch(/start with a deposit: the fee is then agreed with you in writing, within the band shown, before any work starts/);
    expect(t).toMatch(/credited in full against it/);
  });

  it("agrees with the product pages it links to: the deposit products say a person scopes the work", () => {
    const flows = PRODUCT_PAGES.filter((p) => p.slug === "envelope-study" || p.slug === "portfolio-screen").map((p) => p.flow.join(" "));
    for (const f of flows) expect(f).toMatch(/Pay the deposit; a person contacts you to scope the work/);
  });

  it("shows the Intelligence plans as their own section, with every price read from the catalogue and a link to /intelligence", async () => {
    const h = await pricing();
    const section = h.slice(h.indexOf('id="intelligence"'));
    expect(section).toContain("Market intelligence subscription");
    for (const id of INTELLIGENCE_PLAN_IDS) {
      const plan = INTELLIGENCE_PLANS[id];
      const card = text(section.slice(section.indexOf(`data-testid="intelligence-plan-${id}"`), section.indexOf("</li>", section.indexOf(`data-testid="intelligence-plan-${id}"`))));
      expect(card).toContain(plan.name);
      expect(card).toContain(eurMonth(plan.priceCents));
      expect(card).toMatch(/\/ month/);
    }
    expect(section).toContain('href="/intelligence"');
    // The plan name 'Developer' is shared with the API audience; the section says whose plans these are instead of renaming anything.
    expect(text(section)).toMatch(/plan names below belong to this dashboard; API plans are on the developers page/);
  });

  it("says Intelligence's production state is unverified exactly while the capability registry does", async () => {
    const h = await pricing();
    const unverified = CAPABILITY_REGISTRY.filter((c) => c.family === "intelligence").every((c) => c.production_status === "unverified");
    expect(h.includes('data-testid="intelligence-unverified"')).toBe(unverified);
    if (unverified) expect(text(h)).toMatch(/not yet verified this subscription end to end in production/);
  });

  it("has a one-line 'Which one do I need?' linking the free check, Density Screen, Envelope Study, API and Hall Watch", async () => {
    const h = await pricing();
    const aid = h.slice(h.indexOf('data-testid="which-one"'));
    const line = aid.slice(0, aid.indexOf("</p>"));
    expect(text(line)).toContain("Which one do I need?");
    for (const href of ["/qualify", "/products/density-screen", "/products/envelope-study", "/developers#plans", "/products/hall-watch"]) {
      expect(line, href).toContain(`href="${href}"`);
    }
  });

  it("the three-paths card states the same thing", () => {
    const t = text(renderToStaticMarkup(React.createElement(ThreePaths)));
    expect(t).not.toMatch(/Fixed fee agreed before we start/i);
    expect(t).toMatch(/agreed in writing after a deposit for the Study and the Portfolio Screen/);
  });
});
