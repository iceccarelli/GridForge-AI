/**
 * The machine-readable file (/llms.txt) and the two human pages that quote the engine (/developers, /pricing) never
 * present an operation as callable while the DEPLOYED engine does not serve it, and follow the engine when it does.
 *
 * Three engines are stubbed at the engine's public GET /v1/version (tests/site/engine-stub.ts): a stale engine (the routes
 * Fly served before its 2026-10-27 redeploy, injected: the engine can fall behind this repository again), an engine redeployed from this repository, and an unreachable one. Unit weights come
 * from public/reference/tools.json in every case; only availability changes.
 */
import fs from "node:fs";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { GET as llms } from "@/app/llms.txt/route";
import { NOT_YET_AVAILABLE, AVAILABILITY_UNCONFIRMED, parseToolRates } from "@/lib/payg-pricing";
import { PAYG } from "@/lib/products";
import { eurExact } from "@/lib/payg-pricing";
import { FULL_ENGINE, STALE_ENGINE, stubEngine } from "./engine-stub";

const ROOT = process.cwd();
const catalogue = parseToolRates(JSON.parse(fs.readFileSync(path.join(ROOT, "public/reference/tools.json"), "utf8")));
const ENGINE = "https://gridforge-engine.fly.dev";

const text = (html: string) =>
  html.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, " ").replace(/&#x27;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();

async function withEngine<T>(routes: string[] | "down", fn: () => Promise<T>): Promise<T> {
  const stop = stubEngine(routes);
  try {
    return await fn();
  } finally {
    stop();
  }
}

const llmsText = (routes: string[] | "down") => withEngine(routes, async () => (await llms()).text());
async function pageHtml(load: () => Promise<{ default: () => Promise<React.ReactElement> }>, routes: string[] | "down") {
  return withEngine(routes, async () => renderToStaticMarkup(await (await load()).default()).replace(/<!-- -->/g, ""));
}
const developers = (routes: string[] | "down") => pageHtml(() => import("@/app/developers/page"), routes);
const pricing = (routes: string[] | "down") => pageHtml(() => import("@/app/pricing/page"), routes);

const served = (routes: string[]) => (r: { endpoint: string }) => routes.includes(r.endpoint);
const unservedByStale = catalogue.filter((r) => !served(STALE_ENGINE)(r));
const preBlocks = (html: string) => [...html.matchAll(/<pre[^>]*>([\s\S]*?)<\/pre>/g)].map((m) => text(m[1]));

describe("the premise: the stale engine really is missing operations the catalogue lists", () => {
  it("the catalogue names operations the injected stale engine does not serve", () => {
    const names = unservedByStale.map((r) => r.endpoint).sort();
    expect(names).toEqual(
      ["/v1/compare", "/v1/estimate", "/v1/power/assess", "/v1/power/deploy/assess", "/v1/power/deploy/bids", "/v1/power/deploy/spec"].sort()
    );
  });
});

describe("/llms.txt", () => {
  it("stale engine: lists only operations the engine serves, with their catalogue units, and nothing else as callable", async () => {
    const t = await llmsText(STALE_ENGINE);
    for (const r of catalogue) {
      const line = `\`${r.name}\` — POST ${ENGINE}${r.endpoint}`;
      if (served(STALE_ENGINE)(r)) expect(t, r.name).toContain(line);
      else {
        expect(t, r.name).not.toContain(line);
        expect(t, r.name).not.toContain(r.endpoint);
        expect(t, r.name).not.toContain(r.name);
      }
    }
    expect(t).toContain(`\`gridforge_screen\` — POST ${ENGINE}/v1/screen — 1 unit`);
    expect(t).toContain(`\`gridforge_portfolio\` — POST ${ENGINE}/v1/portfolio — 1 unit per hall`);
    expect(t).toContain(`\`gridforge_qualify\` — POST ${ENGINE}/v1/qualify — free`);
    expect(t).not.toContain("/power/compare");
    expect(t).toContain(`MCP endpoint (JSON-RPC 2.0): ${ENGINE}/mcp`);
  });

  it("fully deployed engine: every catalogue operation is listed as callable", async () => {
    const t = await llmsText(FULL_ENGINE);
    for (const r of catalogue) expect(t, r.name).toContain(`\`${r.name}\` — POST ${ENGINE}${r.endpoint}`);
    expect(t).toContain("/power/compare");
  });

  it("engine unreachable: no operation, no endpoint link and no MCP URL is advertised", async () => {
    const t = await llmsText("down");
    expect(t).toContain("could not be read");
    for (const r of catalogue) expect(t, r.name).not.toContain(`POST ${ENGINE}${r.endpoint}`);
    expect(t).not.toContain(`${ENGINE}/mcp`);
    expect(t).not.toContain(`${ENGINE}/v1/tools`);
  });
});

describe("/developers", () => {
  it("stale engine: unserved operations are labelled, carry no units, and appear in no snippet", async () => {
    const html = await developers(STALE_ENGINE);
    const rows = [...html.matchAll(/<tr[^>]*data-availability="unavailable"[^>]*>([\s\S]*?)<\/tr>/g)].map((m) => text(m[1]));
    // The tools table and the rate card both list each unserved operation, labelled, with name + endpoint + label only.
    for (const r of unservedByStale) {
      const mine = rows.filter((row) => row.includes(r.endpoint));
      expect(mine.length, r.name).toBeGreaterThanOrEqual(2);
      for (const row of mine) expect(row, r.name).toBe(`${r.name} ${r.endpoint} ${NOT_YET_AVAILABLE}`);
    }
    // Served operations keep their units.
    expect(html).toMatch(/gridforge_study[\s\S]{0,400}>5</);
    for (const block of preBlocks(html)) for (const r of unservedByStale) expect(block).not.toContain(r.endpoint);
    expect(preBlocks(html).some((b) => b.includes(`${ENGINE}/v1/qualify`))).toBe(true);
    // No price is attached to an unserved operation anywhere: the estimator offers only served ones.
    const options = [...html.matchAll(/<option[^>]*>([\s\S]*?)<\/option>/g)].map((m) => text(m[1]));
    expect(options.length).toBe(catalogue.length - unservedByStale.length);
    for (const r of unservedByStale) expect(options.join("|")).not.toContain(r.name);
    // No tool is advertised as callable that is not served: the BTM assessment link is gone.
    expect(html).not.toContain('href="/power/deploy"');
    expect(text(html)).toContain(NOT_YET_AVAILABLE);
  });

  it("fully deployed engine: every operation is callable, priced from the catalogue, and nothing is labelled unavailable", async () => {
    const html = await developers(FULL_ENGINE);
    expect(text(html)).not.toContain(NOT_YET_AVAILABLE);
    expect(html).not.toContain('data-availability="unavailable"');
    const options = [...html.matchAll(/<option[^>]*>([\s\S]*?)<\/option>/g)].map((m) => text(m[1]));
    expect(options.length).toBe(catalogue.length);
    const compare = catalogue.find((r) => r.endpoint === "/v1/compare")!;
    expect(text(html)).toContain(eurExact(compare.units * PAYG.unitPriceCents));
    expect(html).toContain('href="/power/deploy"');
    expect(text(html)).toContain("Check against the live engine");
  });

  it("engine unreachable: nothing is presented as callable and the page says availability is not confirmed", async () => {
    const html = await developers("down");
    expect(text(html)).toContain(AVAILABILITY_UNCONFIRMED);
    expect(preBlocks(html).filter((b) => b.includes("curl"))).toEqual([]);
    expect(html).not.toMatch(/<option/);
    expect(html).not.toContain('href="/power/deploy"');
  });
});

describe("/pricing", () => {
  it("stale engine: the rate card labels unserved operations without a price, and the estimator cannot select them", async () => {
    const html = await pricing(STALE_ENGINE);
    for (const r of unservedByStale) {
      const rows = [...html.matchAll(/<tr[^>]*data-availability="unavailable"[^>]*>([\s\S]*?)<\/tr>/g)]
        .map((m) => text(m[1]))
        .filter((row) => row.includes(r.endpoint));
      expect(rows, r.name).toEqual([`${r.name} ${r.endpoint} ${NOT_YET_AVAILABLE}`]);
    }
    const options = [...html.matchAll(/<option[^>]*>([\s\S]*?)<\/option>/g)].map((m) => text(m[1]));
    for (const r of unservedByStale) expect(options.join("|")).not.toContain(r.name);
    for (const r of catalogue.filter(served(STALE_ENGINE))) expect(options.join("|")).toContain(r.name);
    // Served rows still show the euro price derived from units x unit price (the one price list).
    const study = catalogue.find((r) => r.endpoint === "/v1/study")!;
    expect(text(html)).toContain(eurExact(study.units * PAYG.unitPriceCents));
    // The estimator does not offer to ask an endpoint the engine does not serve, and the comparison is not promoted.
    expect(text(html)).not.toContain("Check against the live engine");
    expect(html).not.toContain('href="/power/compare"');
  });

  it("fully deployed engine: all operations are priced and selectable, and the live estimate is offered", async () => {
    const html = await pricing(FULL_ENGINE);
    expect(text(html)).not.toContain(NOT_YET_AVAILABLE);
    const options = [...html.matchAll(/<option[^>]*>([\s\S]*?)<\/option>/g)].map((m) => text(m[1]));
    expect(options.length).toBe(catalogue.length);
    expect(text(html)).toContain("Check against the live engine");
    expect(html).toContain('href="/power/compare"');
  });

  it("engine unreachable: no price is attached to any operation", async () => {
    const html = await pricing("down");
    const rows = [...html.matchAll(/<tr[^>]*data-availability="unknown"[^>]*>([\s\S]*?)<\/tr>/g)].map((m) => text(m[1]));
    expect(rows.length).toBe(catalogue.length);
    for (const row of rows) expect(row).toContain(AVAILABILITY_UNCONFIRMED);
    expect(html).not.toMatch(/<option/);
  });
});

describe("the pages follow the engine without a site redeploy", () => {
  it("both are incrementally regenerated rather than frozen at build time", () => {
    for (const f of ["app/pricing/page.tsx", "app/developers/page.tsx", "app/llms.txt/route.ts", "app/power/compare/page.tsx", "app/power/deploy/page.tsx"]) {
      expect(fs.readFileSync(path.join(ROOT, f), "utf8"), f).toMatch(/export const revalidate = 300;/);
    }
  });
});
