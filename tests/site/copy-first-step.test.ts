/**
 * Copy this stream owns says only what the code proves.
 *
 *  - "Most halls begin/start with ..." and "the one most halls buy" are claims about buyers that nothing in the repository can back (there
 *    are no recorded customers). The route through the offers is described as what it is: "the first paid step".
 *  - The fee is not "fixed and agreed before we start" for every engagement: two start with a deposit and the fee is agreed in writing,
 *    within a band, before work starts (lib/engagement-state.ts depositTerms).
 *  - "An evidence class on every number" is wider than the engine's own wording, which is every HEADLINE quantity.
 */
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { FULL_ENGINE, stubEngine } from "./engine-stub";
import { EngagementLadder } from "@/components/EngagementLadder";
import ThreePaths from "@/components/ThreePaths";
import { PRODUCT_PAGES } from "@/lib/product-pages";

vi.mock("next/font/local", () => ({ default: () => ({ variable: "", className: "" }) }));

const flat = (h: string) => h.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, " ").replace(/&#x27;|&apos;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");

async function page(load: () => Promise<{ default: (a: never) => unknown }>, props?: unknown): Promise<string> {
  const stop = stubEngine(FULL_ENGINE);
  try {
    const comp = (await load()).default as (a?: unknown) => Promise<React.ReactElement> | React.ReactElement;
    return flat(renderToStaticMarkup(await comp(props)));
  } finally {
    stop();
  }
}

const PAGES: [string, () => Promise<string>][] = [
  ["/pricing", () => page(() => import("@/app/pricing/page"))],
  ["/products", () => page(() => import("@/app/products/page"))],
  ["/reference", () => page(() => import("@/app/reference/page"))],
  ["/about", () => page(() => import("@/app/about/page"))],
  ...PRODUCT_PAGES.map((p): [string, () => Promise<string>] => [`/products/${p.slug}`, () => page(() => import("@/app/products/[slug]/page"), { params: Promise.resolve({ slug: p.slug }) })]),
  ["EngagementLadder", async () => flat(renderToStaticMarkup(React.createElement(EngagementLadder)))],
  ["ThreePaths", async () => flat(renderToStaticMarkup(React.createElement(ThreePaths)))],
];

describe.each(PAGES)("%s", (_name, render) => {
  it("makes no claim about what most halls do, and no 'usually leads to' claim", async () => {
    const t = await render();
    expect(t.length).toBeGreaterThan(200);
    expect(t).not.toMatch(/most halls/i);
    expect(t).not.toMatch(/usually leads to/i);
  });

  it("does not say the fee is simply 'fixed and agreed before we start'", async () => {
    const t = await render();
    expect(t).not.toMatch(/fixed fee agreed before we\s+start|fixed-fee and agreed before we start|Fixed-fee engineering engagements and metered/i);
  });
});

describe("metadata of the pages this stream owns", () => {
  it("claims no evidence class 'on every number', and no 'most halls'", async () => {
    const mods = await Promise.all([
      import("@/app/evidence/page"),
      import("@/app/developers/page"),
      import("@/app/pricing/page"),
      import("@/app/products/page"),
      import("@/app/reference/page"),
    ]);
    for (const m of mods) {
      const md = m.metadata as { title?: unknown; description?: unknown; openGraph?: { title?: unknown; description?: unknown } };
      const blob = JSON.stringify([md.title, md.description, md.openGraph?.title, md.openGraph?.description]);
      expect(blob).not.toMatch(/most halls|fixed-fee|every number/i);
      expect(blob).not.toMatch(/what it is not/i);
    }
    const evidence = (await import("@/app/evidence/page")).metadata;
    expect(String(evidence.description)).toMatch(/headline figure/);
  });
});
