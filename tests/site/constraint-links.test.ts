/**
 * The qualifier answer and the constraint pages lead on to each other.
 *
 *  - The free qualifier printed the binding constraint and the "what has to move" list as plain text, while the saved read linked the
 *    binding constraint. Both now link a constraint's name to /constraints/<slug> through ONE map (lib/constraint-links.ts), and a name the
 *    map does not know renders as text: never a guessed or broken link.
 *  - The map is name-based because the answer carries names, and the engine's spelling differs from the reference's for two constraints
 *    ("Firm supply (grid import + behind-the-meter)", "CDU capacity (derated to site water temperature)"). The saved read compared the
 *    reference's own spelling, so it showed no reference section for the supply constraint, the one that binds most often. This file parses
 *    the engine's own source for every name it can print and requires each to resolve to a page that is in the sitemap.
 *  - Each constraint page now carries in-content next steps (the lead-times page where it has a lead time; the Procurement Specification),
 *    BreadcrumbList structured data, and dateModified on its TechArticle read from lib/page-lastmod.json (never typed).
 */
import fs from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ref from "@/public/reference/constraints.json";
import pageDates from "@/lib/page-lastmod.json";
import { siteUrl } from "@/lib/site";
import { PostgrestFake } from "./postgrest-fake";

type RefConstraint = { id: string; slug: string; name: string; lead_time_weeks: { low: number; high: number } | null; specification_available: boolean };
const constraints = ref.constraints as unknown as RefConstraint[];
const text = (html: string) => html.replace(/<!-- -->/g, "").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"');

beforeEach(() => vi.resetModules());
afterEach(() => {
  vi.doUnmock("@/lib/page-lastmod.json");
  vi.doUnmock("@/lib/products");
  vi.resetModules();
});

// ------------------------------------------------------------------------------------------------ the engine's names
/** Every (constraint id, name) the engine's own source can print, read from the three modules that build constraint results. */
function engineNames(): { id: string; name: string }[] {
  const out: { id: string; name: string }[] = [];
  for (const f of ["gridforge/power/constraints.py", "gridforge/thermal/constraints.py", "gridforge/site/constraints.py"]) {
    const src = fs.readFileSync(f, "utf8");
    for (const m of src.matchAll(/(?:ConstraintResult|_unbounded)\(\s*"([a-z_]+)",\s*"(?:electrical|thermal|physical)",\s*"([^"]+)"/g)) out.push({ id: m[1], name: m[2] });
  }
  return out;
}

describe("every constraint name the engine can print resolves to a constraint page, or to nothing", () => {
  it("reads all thirteen constraints out of the engine's source, so the test compares something", () => {
    const names = engineNames();
    expect(new Set(names.map((n) => n.id)).size).toBe(constraints.length);
    expect(constraints.length).toBe(13);
    expect(names.length).toBeGreaterThanOrEqual(13);
  });

  it("each (id, name) maps to the page of THAT constraint, and that page is in the sitemap", async () => {
    const { constraintSlugsByName, slugForConstraint } = await import("@/lib/constraint-links");
    const sitemap = (await (await import("@/app/sitemap")).default()).map((e) => e.url);
    const slugs = constraintSlugsByName(ref as never);
    const unresolved: string[] = [];
    for (const { id, name } of engineNames()) {
      const slug = slugForConstraint(slugs, name);
      const expected = constraints.find((c) => c.id === id)!.slug;
      if (slug !== expected) unresolved.push(`${id}: ${JSON.stringify(name)} -> ${slug}`);
      else expect(sitemap, name).toContain(siteUrl(`/constraints/${slug}`));
    }
    expect(unresolved).toEqual([]);
  });

  it("the reference's own names resolve too, and every slug in the map is a constraint page", async () => {
    const { constraintSlugsByName } = await import("@/lib/constraint-links");
    const slugs = constraintSlugsByName(ref as never);
    for (const c of constraints) expect(slugs[c.name], c.name).toBe(c.slug);
    const pages = new Set(constraints.map((c) => c.slug));
    for (const [name, slug] of Object.entries(slugs)) expect(pages.has(slug), `${name} -> ${slug}`).toBe(true);
  });

  it.each(["", "Firm supply", "firm supply (grid import + behind-the-meter)", "Something the engine invented", "constructor", "__proto__", "toString", "hasOwnProperty"])(
    "an unknown name (%j) links nowhere",
    async (name) => {
      const { constraintSlugsByName, slugForConstraint, constraintHref } = await import("@/lib/constraint-links");
      const slugs = constraintSlugsByName(ref as never);
      expect(slugForConstraint(slugs, name)).toBeNull();
      expect(constraintHref(slugs, name)).toBeNull();
    },
  );

  it("a non-string, an absent map and an absent reference link nowhere", async () => {
    const { constraintSlugsByName, slugForConstraint } = await import("@/lib/constraint-links");
    expect(slugForConstraint(constraintSlugsByName(ref as never), 5)).toBeNull();
    expect(slugForConstraint(constraintSlugsByName(ref as never), null)).toBeNull();
    expect(slugForConstraint(undefined, "Busway ampacity")).toBeNull();
    expect(constraintSlugsByName(null)).toEqual({});
    expect(constraintSlugsByName(undefined)).toEqual({});
  });

  it("an engine spelling whose constraint is not in the reference is dropped, never pointed at a page that does not exist", async () => {
    const { constraintSlugsByName } = await import("@/lib/constraint-links");
    const without = { constraints: constraints.filter((c) => c.id !== "grid_firm_capacity") };
    const slugs = constraintSlugsByName(without as never);
    expect(Object.values(slugs)).not.toContain("firm-supply-capacity");
    expect(slugs["Firm supply (grid import + behind-the-meter)"]).toBeUndefined();
  });
});

// ------------------------------------------------------------------------------------------------ the free qualifier's answer
const RESULT = {
  platform: { id: "gb300_nvl72", name: "NVIDIA GB300 NVL72", rack_kW: { value: 135, low: 120, high: 150, unit: "kW", evidence: "E3", label: "rack" }, gpus_per_rack: 72 },
  as_found: { racks: 0, it_load_kW: { value: 0, low: 0, high: 0, unit: "kW", evidence: "E0_ASSUMPTION", label: "IT" }, binding_constraint: "Firm supply (grid import + behind-the-meter)", domain: "electrical", basis: "headroom 0 kW" },
  after_relief: { racks: 28, architecture: "Full DLC", then_binds_on: null, sets_the_date: "Chilled-water plant capacity" },
  first_three_constraints: [
    { name: "Firm supply (grid import + behind-the-meter)", domain: "electrical", relief: "Grid reinforcement" },
    { name: "Busway ampacity", domain: "electrical", relief: "Busway upgrade" },
    { name: "Something the engine invented", domain: "physical", relief: null },
  ],
  intake: { completeness: 0.29, required_inputs_missing: 3, can_issue_a_study: false, warnings: [], gaps: [], recommended_engagement: "Sell the Density Screen." },
  notice: "n",
};

async function readout(slugs?: Record<string, string>): Promise<string> {
  const { QualifyReadout } = await import("@/components/CapacityQualifier");
  return text(
    renderToStaticMarkup(
      React.createElement(QualifyReadout, { result: RESULT as never, headline: "About 0 racks today.", share: null, qualificationId: null, qualificationToken: null, template: null, constraintSlugs: slugs }),
    ),
  );
}

describe("the qualifier result links the binding constraint and the what-has-to-move list", () => {
  it("links each known name to its page, and renders an unknown name as plain text", async () => {
    const { constraintSlugsByName } = await import("@/lib/constraint-links");
    const html = await readout(constraintSlugsByName(ref as never));
    // The binding constraint (the engine's spelling, which the reference does not use) and the first list item.
    expect([...html.matchAll(/href="\/constraints\/firm-supply-capacity"/g)]).toHaveLength(2);
    expect(html).toContain('href="/constraints/busway-ampacity"');
    expect(html).toContain("Something the engine invented");
    // The name an unknown constraint carries is never inside a link, and no link points at a page that is not a constraint page.
    const anchors = [...html.matchAll(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)];
    for (const [, href, inner] of anchors) {
      if (href.startsWith("/constraints/")) expect(constraints.map((c) => `/constraints/${c.slug}`), href).toContain(href);
      expect(inner).not.toContain("Something the engine invented");
    }
  });

  it("without a map it links no constraint at all (a page that did not pass one shows text, not broken links)", async () => {
    const html = await readout(undefined);
    expect(html).not.toContain("/constraints/");
    expect(html).toContain("Firm supply (grid import + behind-the-meter)");
    expect(html).toContain("Busway ampacity");
    expect(html).not.toContain("engineering reference");
  });

  it("with an empty map it links nothing either", async () => {
    expect(await readout({})).not.toContain("/constraints/");
  });

  it("the link is underlined, 44 px tall, and tells a screen reader where it goes", async () => {
    const { constraintSlugsByName } = await import("@/lib/constraint-links");
    const html = await readout(constraintSlugsByName(ref as never));
    const link = /<a [^>]*href="\/constraints\/busway-ampacity"[^>]*>[\s\S]*?<\/a>/.exec(html)![0];
    expect(link).toMatch(/class="[^"]*\bunderline\b/);
    expect(link).toMatch(/class="[^"]*\bmin-h-11\b/);
    expect(link).toContain('<span class="sr-only"> (engineering reference)</span>');
    // The visible name is the whole accessible name apart from that suffix, so a voice-control user can say what they see.
    expect(link.replace(/<[^>]+>/g, "")).toBe("Busway ampacity (engineering reference)");
  });
});

/** Depth-first search of a React element tree (a server component's return value) without rendering it. */
function findElements(node: unknown, match: (el: any) => boolean, out: any[] = []): any[] {
  if (Array.isArray(node)) {
    node.forEach((n) => findElements(n, match, out));
    return out;
  }
  if (node && typeof node === "object" && "props" in (node as object)) {
    const el = node as any;
    if (match(el)) out.push(el);
    findElements(el.props?.children, match, out);
  }
  return out;
}

describe("the /qualify page hands the qualifier the map", () => {
  it("passes every reference name and the engine's spellings, each to a real constraint page", async () => {
    delete process.env.GRIDFORGE_API_URL;
    const { default: Page } = await import("@/app/qualify/page");
    const { CapacityQualifier } = await import("@/components/CapacityQualifier");
    const tree = await Page();
    const [q] = findElements(tree, (el) => el.type === CapacityQualifier);
    expect(q, "the page renders the qualifier").toBeTruthy();
    const slugs = q.props.constraintSlugs as Record<string, string>;
    const pages = new Set(constraints.map((c) => c.slug));
    for (const c of constraints) expect(slugs[c.name]).toBe(c.slug);
    expect(slugs["Firm supply (grid import + behind-the-meter)"]).toBe("firm-supply-capacity");
    expect(slugs["CDU capacity (derated to site water temperature)"]).toBe("cdu-capacity-site-conditions");
    for (const slug of Object.values(slugs)) expect(pages.has(slug)).toBe(true);
  });
});

// ------------------------------------------------------------------------------------------------ the saved read
describe("the saved read (/q/<token>) finds the reference for the constraint the engine named", () => {
  let db: PostgrestFake;
  let undo: () => void;
  beforeEach(() => {
    process.env.SUPABASE_URL = "https://stub.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_test";
    db = new PostgrestFake(["qualifications"]);
    undo = db.install();
  });
  afterEach(() => undo());

  async function saved(binding: string): Promise<string> {
    db.tables.set("qualifications", []);
    db.seed("qualifications", [
      { token: "q-token-abcdefghijklmnop", site_name: "North Hall", hall_id: "H1", status: "scored", binding_constraint: binding, racks_as_found: 0, racks_after_relief: 28, intake_completeness: 0.5, platform: "NVIDIA GB300 NVL72" },
    ]);
    const { default: Page } = await import("@/app/q/[token]/page");
    return text(renderToStaticMarkup((await Page({ params: Promise.resolve({ token: "q-token-abcdefghijklmnop" }) })) as React.ReactElement));
  }

  it.each([
    ["Firm supply (grid import + behind-the-meter)", "firm-supply-capacity"],
    ["CDU capacity (derated to site water temperature)", "cdu-capacity-site-conditions"],
    ["Busway ampacity", "busway-ampacity"],
  ])("%s links the full engineering reference", async (binding, slug) => {
    const html = await saved(binding);
    expect(html).toContain(`href="/constraints/${slug}"`);
    expect(html).toContain("The full engineering reference for this constraint");
  });

  it("a name the reference does not know shows no reference section and no link", async () => {
    const html = await saved("Something the engine invented");
    expect(html).not.toContain("/constraints/");
    expect(html).not.toContain("The full engineering reference for this constraint");
  });
});

// ------------------------------------------------------------------------------------------------ the constraint pages
const blocks = (html: string) => [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1].replace(/\\u003c/g, "<")));

async function constraintPage(slug: string): Promise<string> {
  const mod = await import("@/app/constraints/[slug]/page");
  return renderToStaticMarkup((await mod.default({ params: Promise.resolve({ slug }) } as never)) as React.ReactElement);
}

describe("each constraint page", () => {
  it("has a recorded date for every constraint, so the dateModified checks below compare something", () => {
    const dates = pageDates.pages as Record<string, { lastmod: string }>;
    for (const c of constraints) expect(dates[`/constraints/${c.slug}`]?.lastmod, c.slug).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it.each(constraints.map((c) => [c.slug, c] as const))("%s: JSON-LD parses, carries dateModified from the manifest and a three-step breadcrumb", async (slug, c) => {
    const html = await constraintPage(slug);
    const ld = blocks(html);
    const article = ld.find((b) => b["@type"] === "TechArticle")!;
    expect(article.dateModified).toBe((pageDates.pages as Record<string, { lastmod: string }>)[`/constraints/${slug}`].lastmod);
    const crumbs = ld.find((b) => b["@type"] === "BreadcrumbList")!;
    expect(crumbs["@context"]).toBe("https://schema.org");
    expect(crumbs.itemListElement.map((i: { position: number; name: string; item: string }) => [i.position, i.name, i.item])).toEqual([
      [1, "Time to Power", siteUrl("/")],
      [2, "Constraints", siteUrl("/constraints")],
      [3, c.name, siteUrl(`/constraints/${slug}`)],
    ]);
  });

  it.each(constraints.map((c) => [c.slug, c] as const))("%s: in-content next steps (lead times where it has one, the Procurement Specification) and the qualify CTA", async (slug, c) => {
    const html = text(await constraintPage(slug));
    const start = html.indexOf('data-testid="constraint-next-steps"');
    expect(start, "the next-steps section").toBeGreaterThan(-1);
    const section = html.slice(html.lastIndexOf("<section", start), html.indexOf("</section>", start));
    expect(section).toContain('aria-labelledby="next-steps-h"');
    expect(section).toMatch(/<h2 id="next-steps-h"/);
    if (c.lead_time_weeks) {
      expect(section).toContain('href="/lead-times"');
      expect(section).toContain(`${c.lead_time_weeks.low}–${c.lead_time_weeks.high} weeks`);
    }
    if (c.specification_available) {
      expect(section).toContain('href="/products/procurement-specification"');
      expect(section).toContain("Procurement Specification");
    } else {
      // The relief is not a purchase (a commercial relief, or none at all): the engine cannot write a specification for it, so the page
      // does not send the reader to buy one. (It used to, on exactly these two pages.)
      expect(section).not.toContain("procurement-specification");
      expect(section).not.toContain("Procurement Specification");
    }
    // The existing CTA is unchanged.
    expect(html).toMatch(/href="\/qualify"/);
    // And the definition is still the first thing after the heading: the next steps are not above it.
    expect(html.indexOf("data-definition")).toBeLessThan(start);
  });

  it("a constraint with no lead time gets no lead-times step, and the Specification step remains", async () => {
    const { constraintNextSteps } = await import("@/lib/constraint-next-steps");
    const steps = constraintNextSteps({ name: "Something", lead_time_weeks: null, specification_available: true });
    expect(steps.map((s) => s.href)).toEqual(["/products/procurement-specification"]);
  });

  it("a constraint whose relief is not a purchase is never sent to the Procurement Specification (the engine cannot write one)", async () => {
    const { constraintNextSteps } = await import("@/lib/constraint-next-steps");
    for (const specification_available of [false, undefined as unknown as boolean]) {
      const steps = constraintNextSteps({ name: "Floor space", lead_time_weeks: { low: 8, high: 26 }, specification_available });
      expect(steps.map((s) => s.href)).toEqual(["/lead-times"]);
    }
  });

  it("across the 13 published constraints the Specification step appears exactly where the engine says a specification can be written", async () => {
    const { constraintNextSteps } = await import("@/lib/constraint-next-steps");
    expect(ref.constraints).toHaveLength(13);
    const without = ref.constraints.filter((c) => !constraintNextSteps(c).some((s) => s.href === "/products/procurement-specification")).map((c) => c.id).sort();
    expect(without).toEqual(["architecture_capability", "floor_space"]);
    for (const c of ref.constraints) expect(typeof c.specification_available, c.id).toBe("boolean");
  });

  it("the two pages that used to promise a specification no longer do", async () => {
    for (const slug of ["available-rack-positions", "cooling-architecture-capability"]) {
      const html = await constraintPage(slug);
      expect(html, slug).not.toMatch(/the specification is written for its relief/);
      expect(html, slug).not.toMatch(/href="\/products\/procurement-specification"/);
    }
    const ok = await constraintPage("transformer-capacity");
    expect(ok).toMatch(/href="\/products\/procurement-specification"/);
  });

  it("the steps read the catalogue: a renamed Specification changes the label, and a missing product page removes the step", async () => {
    vi.doMock("@/lib/products", async (orig) => {
      const real = await orig<typeof import("@/lib/products")>();
      return { ...real, PRODUCTS: { ...real.PRODUCTS, procurement_spec: { ...real.PRODUCTS.procurement_spec, name: "Renamed Specification" } } };
    });
    const { constraintNextSteps } = await import("@/lib/constraint-next-steps");
    expect(constraintNextSteps({ name: "X", lead_time_weeks: null, specification_available: true })[0].label).toBe("The Renamed Specification");
    vi.doUnmock("@/lib/products");
    vi.resetModules();
    vi.doMock("@/lib/product-pages", async (orig) => {
      const real = await orig<typeof import("@/lib/product-pages")>();
      return { ...real, PRODUCT_PAGES: real.PRODUCT_PAGES.filter((p) => p.productId !== "procurement_spec") };
    });
    const again = await import("@/lib/constraint-next-steps");
    expect(again.constraintNextSteps({ name: "X", lead_time_weeks: { low: 1, high: 2 }, specification_available: true }).map((s) => s.href)).toEqual(["/lead-times"]);
    vi.doUnmock("@/lib/product-pages");
  });

  it("dateModified follows the manifest: a changed date changes it, and a route with no recorded date carries none", async () => {
    vi.doMock("@/lib/page-lastmod.json", () => ({ default: { pages: { "/constraints/busway-ampacity": { lastmod: "2031-02-03" } } } }));
    const moved = blocks(await constraintPage("busway-ampacity")).find((b) => b["@type"] === "TechArticle")!;
    expect(moved.dateModified).toBe("2031-02-03");
    const undated = blocks(await constraintPage("floor-loading")).find((b) => b["@type"] === "TechArticle")!;
    expect("dateModified" in undated).toBe(false);
  });

  it("no date or euro amount is typed in the page, the next-steps module or the link map", () => {
    for (const f of ["app/constraints/[slug]/page.tsx", "lib/constraint-next-steps.ts", "lib/constraint-links.ts"]) {
      const code = fs.readFileSync(f, "utf8").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
      expect(code, `${f}: a date typed in the source`).not.toMatch(/\b20\d\d-\d\d-\d\d\b/);
      expect(code, `${f}: a euro amount typed in the source`).not.toMatch(/€\s?\d|\bEUR\s?\d/);
    }
  });
});
