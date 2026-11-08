/**
 * The first sentence of a constraint, platform or guide page says what the thing is, in words a reader or a model can lift on their own.
 * Every sentence is built from the reference record, states no figure of its own, and makes no claim a page cannot back.
 */
import fs from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ConstraintReference, PlatformEntry } from "@/lib/constraints";
import { NAMEPLATE_DEFINITION, constraintDefinition, platformDefinition } from "@/lib/definitions";
import { pageablePlatforms } from "@/lib/platform-pages";
import { stubEngine, FULL_ENGINE } from "./engine-stub";
import { AUDIENCES } from "@/lib/audiences";
import { CAPABILITY_REGISTRY } from "@/lib/capability-registry";
import { FOOTER_GROUPS, NAV_LINKS } from "@/lib/nav";
import { buildOpenApi, type ToolsFile } from "@/lib/openapi";
import { INTELLIGENCE_PLANS, PRODUCTS } from "@/lib/products";
import { PLANS } from "@/lib/subscriptions";

const ref = JSON.parse(fs.readFileSync("public/reference/constraints.json", "utf8")) as ConstraintReference;
const platforms = pageablePlatforms((JSON.parse(fs.readFileSync("public/reference/platforms.json", "utf8")) as { platforms: PlatformEntry[] }).platforms);
const BANNED = /\b(best|#1|number one|world'?s|leading|leader|unrivalled|guarantee[sd]?|trusted by|certified|only)\b|state[- ]of[- ]the[- ]art/i;

describe("definition sentences", () => {
  it("each constraint has one: a single sentence that names it and its domain, built from its own 'limits' field", () => {
    for (const c of ref.constraints) {
      const d = constraintDefinition(c);
      expect(d.startsWith(c.name), c.slug).toBe(true);
      expect(d, c.slug).toContain(c.domain);
      expect(d.endsWith("."), c.slug).toBe(true);
      expect(d.endsWith(".."), c.slug).toBe(false);
      expect(d, c.slug).toContain(c.limits.slice(1, 40));
      expect(d, c.slug).not.toMatch(BANNED);
      expect(d, c.slug).not.toMatch(/undefined|null|\[object/);
      expect(d.length, c.slug).toBeLessThan(400);
      // one sentence: no sentence break inside it except the colon
      expect(d.slice(0, -1).match(/\.\s+[A-Z]/g) ?? [], c.slug).toEqual([]);
    }
  });

  it("each platform has one that says what the record supports: the library's figures, from the cited sources, held as assumptions", () => {
    expect(platforms.length).toBeGreaterThan(1);
    for (const p of platforms) {
      const d = platformDefinition(p);
      expect(d.startsWith(p.name)).toBe(true);
      expect(d).toContain(`${p.rack_kW} kW per rack`);
      expect(d).toContain(`${p.gpus_per_rack} GPUs`);
      expect(d).toContain(`${(p.liquid_fraction * 100).toFixed(0)}% liquid heat-capture share is one of those assumptions`);
      expect(d).toContain("cited sources and held as library assumptions");
      // The library marks every figure ASSUMED (gridforge/compute/library.py); the record cites sources, some of them OEM or vendor material.
      // So no sentence may call a figure the manufacturer's published value.
      expect(d).not.toMatch(/as published by|manufacturer'?s? (own )?published|published by (its|the) manufacturer/i);
      expect(d).not.toMatch(BANNED);
    }
    expect(platformDefinition({ ...platforms[0], generic: true })).toContain("generic archetype with no manufacturer");
  });

  it("no platform surface calls a library figure the manufacturer's published value", async () => {
    const lib = fs.readFileSync("public/reference/platforms.json", "utf8");
    expect(lib).toContain("QCT"); // the GB200 entry cites an OEM brief, not NVIDIA
    const sources = ["app/platforms/page.tsx", "app/platforms/[id]/page.tsx", "lib/qa.ts", "lib/definitions.ts", "app/llms.txt/route.ts", "lib/openapi.ts"];
    for (const f of sources) {
      const code = fs.readFileSync(f, "utf8");
      expect(code, f).not.toMatch(/manufacturer(?:&rsquo;|')s own published|Manufacturer-published|Vendor-published figures|as the manufacturer publishes|per manufacturer-published/);
    }
    const mod = await import("@/app/platforms/[id]/page");
    const stop = stubEngine(FULL_ENGINE);
    try {
      const html = renderToStaticMarkup(await mod.default({ params: Promise.resolve({ id: "gb200_nvl72" }) } as never));
      expect(html).toContain("assumed, at 400 V three-phase; confirm against an OEM drawing");
      expect(html).not.toMatch(/manufacturer(&#x27;|&rsquo;|')s own published/);
    } finally {
      stop();
    }
  });

  it("the guide defines its two terms and claims nothing else", () => {
    expect(NAMEPLATE_DEFINITION).toMatch(/nameplate power is/);
    expect(NAMEPLATE_DEFINITION).toMatch(/useful compute is/);
    expect(NAMEPLATE_DEFINITION).not.toMatch(BANNED);
  });
});

describe("the page shows its definition first, where a reader and a crawler meet it", () => {
  const text = (html: string) => html.replace(/<!-- -->/g, "").replace(/<script[\s\S]*?<\/script>/g, "").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"');

  it("a constraint page: the definition is the first paragraph after the heading", async () => {
    const mod = await import("@/app/constraints/[slug]/page");
    for (const c of ref.constraints) {
      const html = text(renderToStaticMarkup(await mod.default({ params: Promise.resolve({ slug: c.slug }) } as never)));
      const after = html.slice(html.indexOf("</h1>"));
      const firstP = /<p[^>]*>([\s\S]*?)<\/p>/.exec(after)![1];
      expect(firstP, c.slug).toBe(constraintDefinition(c));
      expect(after.slice(0, after.indexOf(firstP)), c.slug).toContain("data-definition");
    }
  });

  it("a platform page: the definition is the first paragraph after the heading", async () => {
    const stop = stubEngine(FULL_ENGINE);
    try {
      const mod = await import("@/app/platforms/[id]/page");
      for (const p of platforms) {
        const html = text(renderToStaticMarkup(await mod.default({ params: Promise.resolve({ id: p.id }) } as never)));
        const after = html.slice(html.indexOf("</h1>"));
        expect(/<p[^>]*>([\s\S]*?)<\/p>/.exec(after)![1], p.id).toBe(platformDefinition(p));
      }
    } finally {
      stop();
    }
  });

  it("the guide: the definition comes before the short answer", async () => {
    const mod = await import("@/app/guides/nameplate-vs-useful-compute/page");
    const html = text(renderToStaticMarkup(await mod.default()));
    expect(html.indexOf(NAMEPLATE_DEFINITION)).toBeGreaterThan(0);
    expect(html.indexOf(NAMEPLATE_DEFINITION)).toBeLessThan(html.indexOf("THE SHORT ANSWER"));
  });

  it("the constraint article's structured data carries it as the abstract", async () => {
    const mod = await import("@/app/constraints/[slug]/page");
    const c = ref.constraints[0];
    const html = renderToStaticMarkup(await mod.default({ params: Promise.resolve({ slug: c.slug }) } as never));
    const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1].replace(/\\u003c/g, "<")));
    const article = blocks.find((b) => b["@type"] === "TechArticle")!;
    expect(article.abstract).toBe(constraintDefinition(c));
  });
});

/**
 * Names. Every user-facing name in the catalogue (products, plans, audiences, navigation) is unique, case-insensitively, and the three words that used
 * to name two things each (Developer, Platform, Screen) name one. Display names only: the plan keys (developer, team, enterprise), the product ids, the
 * route paths, the MCP tool names and the URLs people have been given are unchanged, and are pinned here so a rename of a name cannot touch them.
 *
 *   Intelligence "Developer"  -> "Solo"          (key developer; "Developer" is the API audience and /developers)
 *   Intelligence "Enterprise" -> "Organisation"  (key enterprise; "Enterprise" is also a segment of data-centre owner)
 *   Intelligence "Team"       -> "Team"          (kept: no other name on the site is "Team")
 *   nav "Developers"          -> "API and MCP"   (the page at /developers; "developers" stays the audience at /for/developers)
 *   nav "Platforms"           -> "Rack library"  (the page at /platforms; "Platform" stays the API plan "API - Platform", whose name the engine's commercial.py fixes)
 *   "Screen"                  -> only ever qualified: "Density Screen" (also the /v1/screen route) and "Portfolio Screen" (the engine's and the terms' names for the
 *                                portfolio engagement); a bare "Screen" is never a name
 */
describe("names: unique, and one thing per word", () => {
  const lower = (xs: string[]) => xs.map((x) => x.toLowerCase());
  const dupes = (xs: string[]) => lower(xs).filter((x, i, a) => a.indexOf(x) !== i);
  const productNames = Object.values(PRODUCTS).map((p) => p.name);
  const planNames = Object.values(INTELLIGENCE_PLANS).map((p) => p.name);
  const audienceNames = AUDIENCES.map((a) => a.name);
  const navLabels = [...NAV_LINKS, ...FOOTER_GROUPS.flatMap((g) => g.links)];
  const registryNames = CAPABILITY_REGISTRY.map((c) => c.name);
  /** Footer groups list some pages twice under two labels; a label used for two DIFFERENT pages is what collides. */
  const labelToHref = new Map<string, Set<string>>();
  for (const l of navLabels) labelToHref.set(l.label.toLowerCase(), (labelToHref.get(l.label.toLowerCase()) ?? new Set()).add(l.href));

  it("the resolved display names are pinned, and the keys and ids behind them are not touched", () => {
    expect(planNames).toEqual(["Solo", "Team", "Organisation"]);
    expect(Object.keys(INTELLIGENCE_PLANS)).toEqual(["developer", "team", "enterprise"]);
    expect(PLANS.map((p) => p.name)).toEqual(planNames);
    expect(PLANS.map((p) => p.id)).toEqual(["developer", "team", "enterprise"]);
    expect(Object.keys(PRODUCTS)).toEqual(["density_screen", "envelope_study_deposit", "hall_watch", "portfolio_screen_deposit", "procurement_spec", "api_triage", "api_scale", "api_platform"]);
    expect(productNames).toEqual([
      "Density Screen", "Capacity & Density Envelope Study — deposit", "Hall Watch", "Portfolio Screen — deposit", "Procurement Specification", "API — Triage", "API — Scale", "API — Platform",
    ]);
    expect(audienceNames).toContain("Data-centre developers");
    expect(NAV_LINKS.find((l) => l.href === "/developers")!.label).toBe("API and MCP");
    expect(navLabels.find((l) => l.href === "/platforms")!.label).toBe("Rack library");
    expect(navLabels.filter((l) => l.href === "/developers").map((l) => l.label)).toEqual(["API and MCP", "API and MCP (machine interface)", "API access"]);
    expect(INTELLIGENCE_PLANS.developer.priceCents).toBe(49_900);
    expect(INTELLIGENCE_PLANS.enterprise.kind).toBe("intelligence_subscription");
  });

  it("every product, plan and audience name is unique, case-insensitively, across the whole catalogue", () => {
    expect(dupes([...productNames, ...planNames, ...audienceNames])).toEqual([]);
    expect(dupes(registryNames)).toEqual([]);
    expect(dupes(AUDIENCES.map((a) => a.slug))).toEqual([]);
    for (const [label, hrefs] of labelToHref) expect([label, [...hrefs].length]).toEqual([label, 1]);
  });

  it("a plan name is never the name of a product, an audience or a navigation entry", () => {
    const others = lower([...productNames, ...audienceNames, ...navLabels.map((l) => l.label)]);
    for (const n of planNames) expect(others, n).not.toContain(n.toLowerCase());
  });

  it("'Developer(s)' names one thing: the audience of data-centre developers", () => {
    const all = [...productNames, ...planNames, ...audienceNames, ...navLabels.map((l) => l.label), ...registryNames];
    const hits = [...new Set(all.filter((n) => /\bdevelopers?\b/i.test(n)))];
    // the registry's free "developer allowance" is the API's free key, a use of the word for the person who calls it, not a name of a plan or page
    expect(hits.sort()).toEqual(["Data-centre developers", "Pay-as-you-go metering and free developer allowance"].sort());
    expect(planNames.some((n) => /developer/i.test(n))).toBe(false);
    expect(navLabels.some((l) => /^developers?\b/i.test(l.label))).toBe(false);
  });

  it("'Platform(s)' names one thing as a name: the API plan; the rack library is called the rack library", () => {
    const all = [...productNames, ...planNames, ...audienceNames, ...navLabels.map((l) => l.label), ...registryNames];
    expect([...new Set(all.filter((n) => /\bplatforms?\b/i.test(n)))]).toEqual(["API — Platform"]);
  });

  it("'Screen' is only ever qualified, and /v1/screen is the Density Screen route", () => {
    const all = [...productNames, ...planNames, ...audienceNames, ...navLabels.map((l) => l.label), ...registryNames];
    for (const n of all) expect(n.trim().toLowerCase(), n).not.toBe("screen");
    const screens = [...new Set(all.filter((n) => /\bscreen\b/i.test(n)).map((n) => n.replace(/ — deposit$/, "")))].sort();
    expect(screens).toEqual(["Density Screen", "Portfolio Screen"]);
    const tools = JSON.parse(fs.readFileSync("public/reference/tools.json", "utf8")) as ToolsFile & { tools: { name: string; description: string; endpoint: string }[] };
    const screenTool = tools.tools.find((t) => t.endpoint === "/v1/screen")!;
    expect(screenTool.name).toBe("gridforge_screen");
    expect(screenTool.description.startsWith("Density Screen.")).toBe(true);
    expect(tools.tools.find((t) => t.endpoint === "/v1/portfolio")!.description).not.toMatch(/\bscreen\b/i);
  });

  it("operation ids and MCP tool names are each unique, the tool names are the engine's, and no operation id repeats a plan or audience name", () => {
    const tools = JSON.parse(fs.readFileSync("public/reference/tools.json", "utf8")) as ToolsFile;
    const doc = buildOpenApi(tools, "https://example.invalid", "https://example.invalid/site-origin") as { paths: Record<string, Record<string, { operationId?: string }>> };
    const ids = Object.values(doc.paths).flatMap((p) => Object.values(p).map((o) => o.operationId).filter((x): x is string => typeof x === "string"));
    expect(ids.length).toBeGreaterThan(20);
    expect(dupes(ids)).toEqual([]);
    expect(dupes(tools.tools.map((t) => t.name))).toEqual([]);
    for (const t of tools.tools) expect(ids, t.name).toContain(t.name);
    // the rack library's read is named for what it is, not for the word the API plan uses
    expect(ids).toContain("rackLibrary");
    expect(ids).not.toContain("platforms");
    expect(ids.filter((i) => /platform/i.test(i))).toEqual([]);
    for (const n of [...planNames, ...audienceNames]) expect(lower(ids)).not.toContain(n.toLowerCase());
  });
});
