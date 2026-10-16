/**
 * The website says what now exists and nothing that does not: the comparison page, pricing, llms.txt and JSON-LD all
 * point along the buying path, and every price on them is read from the catalogue.
 */
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PRODUCTS, eurFromCents } from "@/lib/products";
import { projectLadder } from "@/lib/buyer-path";
import { comparisonToolJsonLd } from "@/lib/jsonld";
import { CAPABILITY_REGISTRY } from "@/lib/capability-registry";

describe("the comparison page", () => {
  it("leads to the next step in the buying path, at the catalogue price", async () => {
    const Page = (await import("@/app/power/compare/page")).default;
    const html = renderToStaticMarkup(React.createElement(Page)).replace(/<!-- -->/g, "");
    expect(html).toContain(PRODUCTS.density_screen.name);
    expect(html).toContain(eurFromCents(PRODUCTS.density_screen.amountCents));
    expect(html).toMatch(/href="\/pricing"/);
    expect(html).toMatch(/read-only page/);
    expect(html).toMatch(/Free, no account/);
  });

  it("carries WebApplication JSON-LD that claims no rating, review or usage figure", async () => {
    const Page = (await import("@/app/power/compare/page")).default;
    const html = renderToStaticMarkup(React.createElement(Page));
    const ld = JSON.parse(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html)![1].replace(/\\u003c/g, "<"));
    expect(ld).toMatchObject({ "@type": "WebApplication", url: expect.stringMatching(/\/power\/compare$/), isAccessibleForFree: true });
    expect(JSON.stringify(ld)).not.toMatch(/aggregateRating|review|ratingValue|userCount|interactionStatistic/i);
  });

  it("derives 'free' from the registry rather than asserting it", () => {
    const cap = CAPABILITY_REGISTRY.find((c) => c.capability_id === "ttp_compare")!;
    expect(comparisonToolJsonLd().isAccessibleForFree).toBe(cap.status === "free");
    const original = cap.status;
    try {
      (cap as { status: string }).status = "commercial";
      expect(comparisonToolJsonLd().isAccessibleForFree).toBe(false);
    } finally {
      (cap as { status: string }).status = original;
    }
  });
});

describe("the pricing page", () => {
  it("offers the free comparison as the way in, and types no price of its own for it", async () => {
    const Page = (await import("@/app/pricing/page")).default;
    const html = renderToStaticMarkup(React.createElement(Page));
    expect(html).toMatch(/href="\/power\/compare"/);
    expect(html).toContain("Not sure which step to start with?");
    expect(html).toMatch(/at the prices above/);
  });
});

describe("llms.txt", () => {
  it("documents the comparison, the buyer link and the checkout parameter, from the catalogue", async () => {
    const txt = await (await (await import("@/app/llms.txt/route")).GET()).text();
    expect(txt).toContain("/power/compare");
    expect(txt).toContain("gridforge_compare");
    expect(txt).toMatch(/may answer 429 with a Retry-After/);
    expect(txt).toContain("project_share_token");
    expect(txt).toMatch(/private and not indexed/);
    for (const p of projectLadder()) expect(txt).toContain(p.id);
    // Only the ids that can be commissioned for a project are offered for it; the portfolio deposit and API plans are not.
    const line = txt.slice(txt.indexOf("limited to the ids"), txt.indexOf("The price is the catalogue price"));
    expect(line.length).toBeGreaterThan(20);
    expect(line).not.toMatch(/portfolio_screen_deposit|api_/);
  });

  it("does not claim the guard or the buyer page is live", async () => {
    const txt = await (await (await import("@/app/llms.txt/route")).GET()).text();
    expect(txt).not.toMatch(/buyer page is live|rate limit is live|now live/i);
  });
});

describe("the sitemap and robots", () => {
  it("lists the comparison page but never a buyer page", async () => {
    const map = JSON.stringify(await (await import("@/app/sitemap")).default());
    expect(map).toContain("/power/compare");
    expect(map).not.toMatch(/\/p\//);
  });
});
