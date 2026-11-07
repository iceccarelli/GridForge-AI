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

  it("each platform has one that carries only the library's own figures", () => {
    expect(platforms.length).toBeGreaterThan(1);
    for (const p of platforms) {
      const d = platformDefinition(p);
      expect(d.startsWith(p.name)).toBe(true);
      expect(d).toContain(`${p.rack_kW} kW per rack`);
      expect(d).toContain(`${(p.liquid_fraction * 100).toFixed(0)}% of that heat`);
      expect(d).toContain(`${p.gpus_per_rack} GPUs`);
      expect(d).toContain("as published by its manufacturer");
      expect(d).not.toMatch(BANNED);
    }
    expect(platformDefinition({ ...platforms[0], generic: true })).toContain("generic archetype with no manufacturer");
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
