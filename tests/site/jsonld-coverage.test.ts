/**
 * Structured data on the pages the audit found without any: /reference, /observatory, /platforms, /power/deploy, /intelligence.
 *
 * Each emits a WebPage or CollectionPage (and a Dataset where the page publishes a data file) plus a breadcrumb. What is claimed is
 * only what the page itself says: no rating, review, customer count or invented sameAs, and no licence for data that has none.
 */
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { FULL_ENGINE, STALE_ENGINE, stubEngine } from "./engine-stub";
import { SITE_URL } from "@/lib/site";

// The observatory's view, scenario loader and live feeds belong to other tests; here only the page's own structured data matters.
vi.mock("@/components/observatory/ObservatoryView", () => ({ ObservatoryView: () => null }));
vi.mock("@/lib/observatory/scenario-data", () => ({ loadScenarioFile: () => ({}) }));
vi.mock("@/lib/observatory/sources", () => ({ getLiveContext: () => Promise.reject(new Error("offline")) }));
vi.mock("@/components/IntelligenceClient", () => ({ IntelligenceClient: () => null }));
vi.mock("@/components/PowerDeployCaseForm", () => ({ PowerDeployCaseForm: () => null }));

function ld(html: string): Record<string, any>[] {
  return [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1].replace(/\\u003c/g, "<")));
}

async function render(load: () => Promise<{ default: () => unknown }>): Promise<Record<string, any>[]> {
  const stop = stubEngine(FULL_ENGINE);
  try {
    const page = (await load()).default as () => Promise<React.ReactElement> | React.ReactElement;
    return ld(renderToStaticMarkup(await page()));
  } finally {
    stop();
  }
}

const CASES: [string, () => Promise<{ default: () => unknown }>, string[]][] = [
  ["/reference", () => import("@/app/reference/page"), ["CollectionPage", "BreadcrumbList"]],
  ["/observatory", () => import("@/app/observatory/page"), ["WebPage", "Dataset", "BreadcrumbList"]],
  ["/platforms", () => import("@/app/platforms/page"), ["CollectionPage", "Dataset", "BreadcrumbList"]],
  ["/power/deploy", () => import("@/app/power/deploy/page"), ["WebPage", "BreadcrumbList"]],
  ["/intelligence", () => import("@/app/intelligence/page"), ["WebPage", "BreadcrumbList"]],
];

describe.each(CASES)("%s", (route, load, types) => {
  it(`emits ${types.join(" + ")}, each pointing at this page or a file it publishes`, async () => {
    const data = await render(load);
    expect(data.map((d) => d["@type"]).sort()).toEqual([...types].sort());
    for (const d of data) {
      expect(d["@context"]).toBe("https://schema.org");
      if (d["@type"] === "BreadcrumbList") expect(d.itemListElement.at(-1).item).toBe(`${SITE_URL}${route}`);
      else expect(String(d.url).startsWith(`${SITE_URL}${route}`)).toBe(true);
      if (d["@type"] !== "BreadcrumbList") {
        expect(String(d.name).length).toBeGreaterThan(5);
        expect(String(d.description).length).toBeGreaterThan(40);
      }
    }
  });

  it("claims no rating, review, customer, licence or social profile", async () => {
    const blob = JSON.stringify(await render(load)).toLowerCase();
    for (const banned of ["aggregaterating", "ratingvalue", '"review"', "reviewcount", "sameas", '"license"', '"customer', "testimonial"]) {
      expect(blob, banned).not.toContain(banned);
    }
  });
});

describe("/power/deploy structured data follows the deployed engine", () => {
  it("describes the assessment only while the engine serves it; the breadcrumb is true either way", async () => {
    const run = async (routes: string[]) => {
      const stop = stubEngine(routes);
      try {
        const page = (await import("@/app/power/deploy/page")).default;
        return ld(renderToStaticMarkup(await page())).map((d) => d["@type"]).sort();
      } finally {
        stop();
      }
    };
    expect(await run(FULL_ENGINE)).toEqual(["BreadcrumbList", "WebPage"]);
    expect(await run(STALE_ENGINE)).toEqual(["BreadcrumbList"]);
  });
});

describe("Datasets point at files the site really serves", () => {
  it("the platform library's and the observatory's distributions exist in the repository", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const all = [...(await render(CASES[1][1])), ...(await render(CASES[2][1]))].filter((d) => d["@type"] === "Dataset");
    expect(all).toHaveLength(2);
    for (const d of all) {
      const url = String(d.distribution[0].contentUrl);
      expect(url.startsWith(SITE_URL)).toBe(true);
      expect(fs.existsSync(path.join(process.cwd(), "public", url.slice(SITE_URL.length))), url).toBe(true);
      expect(d.isAccessibleForFree).toBe(true);
    }
  });
});
