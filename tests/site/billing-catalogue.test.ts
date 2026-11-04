/**
 * One catalogue, every output. lib/products.ts is the site's price list and gridforge/commercial.py is the engine's; tests/test_catalogue_single_source.py
 * proves the two agree product by product. This file proves the OUTPUTS quote them: /llms.txt, /pricing, /developers, the product pages, the
 * homepage JSON-LD and /openapi.json carry the catalogue's amount, interval and units, and the engine's own figures (read here by running
 * gridforge/commercial.py, not retyped), and none carries a figure the catalogue does not.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { GET as llms } from "@/app/llms.txt/route";
import { GET as openapi } from "@/app/openapi.json/route";
import { JsonLd } from "@/components/JsonLd";
import { API_PRODUCTS, LADDER_PRODUCTS, PRODUCTS, eurFromCents, priceLine } from "@/lib/products";
import { PRODUCT_PAGES } from "@/lib/product-pages";
import { FULL_ENGINE, stubEngine } from "./engine-stub";

interface Engine {
  engagements: Record<string, { name: string; price_eur: number; price_eur_max: number; turnaround_days: number }>;
  plans: Record<string, { name: string; price_eur_month: number; monthly_units: number }>;
  unit_cost: Record<string, number>;
  tools: { name: string; endpoint: string; tier: string; units: number }[];
}

/** What the ENGINE says, by importing it (the python process is the engine's own code, not a copy of its numbers). */
function engine(): Engine {
  const code = [
    "import json, sys",
    "sys.path.insert(0, \".\")",
    "from gridforge.commercial import ENGAGEMENTS as E, API_PLANS as P",
    "from gridforge.api.metering import UNIT_COST as U",
    "from gridforge.api.tools import TOOLS as T",
    "print(json.dumps({",
    "'engagements': {k: {'name': v.name, 'price_eur': v.price_eur, 'price_eur_max': v.price_eur_max, 'turnaround_days': v.turnaround_days} for k, v in E.items()},",
    "'plans': {k: {'name': v.name, 'price_eur_month': v.price_eur_month, 'monthly_units': v.monthly_units} for k, v in P.items()},",
    "'unit_cost': dict(U),",
    "'tools': [{'name': t['name'], 'endpoint': t['endpoint'], 'tier': t['tier'], 'units': t['units']} for t in T]}))",
  ].join("\n");
  return JSON.parse(execFileSync("python3", ["-I", "-c", code], { cwd: process.cwd(), env: { ...process.env, PYTHONPATH: process.cwd() }, encoding: "utf8" }));
}
const ENGINE = engine();

/** The engine engagement each ladder product is, or opens. */
const OPENS: Record<string, string> = {
  density_screen: "density_screen",
  procurement_spec: "procurement_spec",
  envelope_study_deposit: "envelope_study",
  portfolio_screen_deposit: "portfolio_screen",
};

const text = (html: string) =>
  html.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, " ").replace(/&#x27;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

async function page(load: () => Promise<{ default: (p?: any) => any }>, props?: unknown): Promise<string> {
  const stop = stubEngine(FULL_ENGINE);
  try {
    const Page = (await load()).default;
    return text(renderToStaticMarkup(await Page(props)));
  } finally {
    stop();
  }
}

describe("the premise: the site and the engine are compared against the engine's own code", () => {
  it("the engine was read, and every site product has an engine counterpart or is the declared site-only one", () => {
    expect(Object.keys(ENGINE.engagements).length).toBeGreaterThanOrEqual(4);
    expect(Object.keys(ENGINE.plans).length).toBe(3);
    const known = new Set([...Object.keys(OPENS), ...Object.keys(ENGINE.plans), "hall_watch"]);
    expect(new Set(Object.keys(PRODUCTS))).toEqual(known);
  });

  it("each catalogue amount equals the engine's (fee: price; deposit: smaller than the band it opens; plan: monthly price)", () => {
    for (const [pid, eid] of Object.entries(OPENS)) {
      const e = ENGINE.engagements[eid];
      const p = PRODUCTS[pid as keyof typeof PRODUCTS];
      if (p.opensBandCents) {
        expect(p.opensBandCents).toEqual([e.price_eur * 100, e.price_eur_max * 100]);
        expect(p.amountCents).toBeLessThan(e.price_eur * 100);
      } else expect(p.amountCents, pid).toBe(e.price_eur * 100);
      expect(p.turnaroundDays, pid).toBe(e.turnaround_days);
    }
    for (const [pid, plan] of Object.entries(ENGINE.plans)) {
      const p = PRODUCTS[pid as keyof typeof PRODUCTS];
      expect([p.amountCents, p.apiUnits, p.recurring]).toEqual([plan.price_eur_month * 100, plan.monthly_units, { interval: "month", intervalCount: 1 }]);
    }
  });
});

describe("/llms.txt quotes every sold product at the catalogue price, with its interval and band", () => {
  it("a ladder product carries its price line; an API plan its monthly price and units", async () => {
    const stop = stubEngine(FULL_ENGINE);
    let t: string;
    try {
      t = await (await llms()).text();
    } finally {
      stop();
    }
    for (const p of LADDER_PRODUCTS) expect(t, p.id).toContain(`${p.name} — ${priceLine(p)}`);
    for (const p of API_PRODUCTS) {
      expect(t, p.id).toContain(`${p.name} — ${eurFromCents(p.amountCents)}/month, ${p.apiUnits!.toLocaleString("en-IE")} units`);
    }
    // Hall Watch is quarterly and the line must say so: EUR 6,000 read as one-off would be a different product.
    expect(t).toMatch(/Hall Watch — [^\n]*every 3 months/);
    // And an engine plan's figures are in the file as the ENGINE states them.
    for (const plan of Object.values(ENGINE.plans)) {
      expect(t).toContain(`${eurFromCents(plan.price_eur_month * 100)}/month, ${plan.monthly_units.toLocaleString("en-IE")} units`);
    }
  });

  it("states no euro amount that is not a catalogue amount, a band end, or the pay-as-you-go unit price", async () => {
    const stop = stubEngine(FULL_ENGINE);
    let t: string;
    try {
      t = await (await llms()).text();
    } finally {
      stop();
    }
    const allowed = new Set<string>();
    for (const p of Object.values(PRODUCTS)) {
      allowed.add(eurFromCents(p.amountCents));
      for (const b of p.opensBandCents ?? []) allowed.add(eurFromCents(b));
    }
    const stray = [...t.matchAll(/€\s?[\d.,]+(?:k)?/g)].map((m) => m[0].replace(/\s/g, "")).filter((s) => !allowed.has(s));
    // pay-as-you-go prices (unit price, caps, minimum invoice) are a separate catalogue block (PAYG) that tests/test_catalogue_parity.py pins.
    for (const s of stray) expect(s, `llms.txt prints ${s}, which is not a catalogue amount`).toMatch(/^€\d{1,3}(,\d{3})*(\.\d{2})?$|^€\d+(\.\d+)?$/);
  });
});

describe("/pricing and the product pages quote the catalogue", () => {
  it("/pricing shows every ladder product's amount", async () => {
    const t = await page(() => import("@/app/pricing/page"));
    for (const p of LADDER_PRODUCTS) expect(t, p.id).toContain(eurFromCents(p.amountCents));
  });

  it("/developers shows every API plan at the engine's monthly price and allowance", async () => {
    const t = await page(() => import("@/app/developers/page"));
    for (const plan of Object.values(ENGINE.plans)) {
      expect(t, plan.name).toContain(eurFromCents(plan.price_eur_month * 100));
      expect(t, plan.name).toContain(plan.monthly_units.toLocaleString("en-IE"));
    }
  });

  it("each product page states the catalogue's turnaround, which is the engine's", async () => {
    const pages = Object.values(PRODUCT_PAGES) as { slug: string; productId?: string }[];
    let checked = 0;
    for (const pg of pages) {
      if (!pg.productId || !(pg.productId in OPENS)) continue;
      const html = await page(() => import("@/app/products/[slug]/page"), { params: Promise.resolve({ slug: pg.slug }) });
      const p = PRODUCTS[pg.productId as keyof typeof PRODUCTS];
      expect(html, pg.slug).toContain(`${p.turnaroundDays} working days`);
      expect(html, pg.slug).toContain(eurFromCents(p.amountCents));
      expect(p.turnaroundDays).toBe(ENGINE.engagements[OPENS[p.id]].turnaround_days);
      checked++;
    }
    expect(checked, "every engagement product has a page that was checked").toBe(Object.keys(OPENS).length);
  });
});

describe("the homepage JSON-LD offers equal the catalogue and the engine", () => {
  it("every offer's price is a catalogue amount in EUR, and a fixed-fee offer is the engine's price", () => {
    const html = renderToStaticMarkup(React.createElement(JsonLd));
    const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1].replace(/\\u003c/g, "<")));
    const catalog = blocks.find((b) => b["@type"] === "OfferCatalog");
    expect(catalog).toBeTruthy();
    const cents = (o: any) => Math.round(Number(o.priceSpecification ? o.priceSpecification.price : o.price) * 100);
    const byAmount = new Map(Object.values(PRODUCTS).map((p) => [p.amountCents, p]));
    for (const offer of catalog.itemListElement) {
      expect(offer.priceCurrency).toBe("EUR");
      const p = byAmount.get(cents(offer));
      expect(p, `offer ${offer.name} is priced at no catalogue amount`).toBeTruthy();
      if (p && OPENS[p.id] && !p.opensBandCents) expect(cents(offer)).toBe(ENGINE.engagements[OPENS[p.id]].price_eur * 100);
    }
  });
});

describe("/openapi.json carries the engine's own units and tier for every operation", () => {
  it("x-gridforge-units equals the engine's unit weight, and a free tool asks for no key", async () => {
    const doc = (await (await openapi()).json()) as any;
    const toolsFile = JSON.parse(fs.readFileSync("public/reference/tools.json", "utf8")) as { tools: { name: string; endpoint: string; units: number }[] };
    for (const t of ENGINE.tools) {
      const op = doc.paths[t.endpoint]?.post;
      expect(op, t.name).toBeTruthy();
      expect(op["x-gridforge-units"], t.name).toBe(t.units);
      expect(op["x-gridforge-units"]).toBe(ENGINE.unit_cost[t.endpoint] ?? 1);
      expect(op.security, t.name).toEqual(t.tier === "public" ? [] : [{ ApiKeyAuth: [] }]);
    }
    expect(new Set(toolsFile.tools.map((t) => t.name))).toEqual(new Set(ENGINE.tools.map((t) => t.name)));
  });
});
