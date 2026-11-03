import fs from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import ForIndex from "@/app/for/page";
import AudiencePage, { generateMetadata, generateStaticParams } from "@/app/for/[slug]/page";
import sitemap from "@/app/sitemap";
import { resolveStep } from "@/lib/audience-links";
import { AUDIENCES, audienceBySlug } from "@/lib/audiences";
import { PRODUCTS, priceLine } from "@/lib/products";

const constraintSlugs = new Set(
  (JSON.parse(fs.readFileSync("public/reference/constraints.json", "utf8")) as { constraints: { slug: string }[] }).constraints.map((c) => c.slug)
);

const words = (s: string) => new Set(s.toLowerCase().match(/[a-z]{4,}/g) ?? []);
const jaccard = (a: Set<string>, b: Set<string>) => {
  const inter = [...a].filter((w) => b.has(w)).length;
  return inter / (a.size + b.size - inter);
};

describe("the seven buyer pages", () => {
  it("covers the seven buyers the brief names, once each", () => {
    expect(AUDIENCES.map((a) => a.slug).sort()).toEqual(
      ["advisors", "ai-operators", "colocation", "developers", "engineering-teams", "existing-owners", "investors"].sort()
    );
    expect(generateStaticParams()).toHaveLength(7);
    expect(audienceBySlug("nope")).toBeUndefined();
  });

  it("each is written from its own decision: no two share text, a first question, or a route", () => {
    const firsts = new Set(AUDIENCES.map((a) => a.firstQuestion));
    expect(firsts.size).toBe(AUDIENCES.length);
    const paths = new Set(AUDIENCES.map((a) => a.path.map((p) => p.kind).join(">")));
    expect(paths.size, "routes through the offers should differ between buyers").toBeGreaterThanOrEqual(5);
    for (let i = 0; i < AUDIENCES.length; i++)
      for (let j = i + 1; j < AUDIENCES.length; j++) {
        const a = AUDIENCES[i], b = AUDIENCES[j];
        expect(jaccard(words(a.situation.join(" ")), words(b.situation.join(" "))), `${a.slug} vs ${b.slug} situation`).toBeLessThan(0.3);
        expect(jaccard(words(a.decision), words(b.decision)), `${a.slug} vs ${b.slug} decision`).toBeLessThan(0.45);
        expect(a.headline).not.toBe(b.headline);
      }
  });

  it("every constraint it names exists in the public reference, with a reason specific to the buyer", () => {
    for (const a of AUDIENCES) {
      expect(a.constraints.length, a.slug).toBeGreaterThanOrEqual(2);
      for (const c of a.constraints) {
        expect(constraintSlugs.has(c.slug), `${a.slug}: ${c.slug}`).toBe(true);
        expect(c.why.length).toBeGreaterThan(40);
      }
    }
    const reasons = AUDIENCES.flatMap((a) => a.constraints.map((c) => c.why));
    expect(new Set(reasons).size, "the same reason is not reused across buyers").toBe(reasons.length);
  });

  it("every route starts from something free or a screen, never from an expensive step, and ends in the catalogue", () => {
    for (const a of AUDIENCES) {
      expect(["qualifier", "density_screen"], a.slug).toContain(a.path[0].kind);
      a.path.forEach((s, i) => {
        if (s.kind === "qualifier") expect(i, `${a.slug}: the qualifier is only ever first`).toBe(0);
        else expect(PRODUCTS[s.kind], `${a.slug}: ${s.kind}`).toBeDefined();
      });
    }
  });

  it("states no customer, result, saving, guarantee, equipment offer or typed price", () => {
    const all = JSON.stringify(AUDIENCES);
    expect(all).not.toMatch(/testimonial|trusted by|our clients|case study|saved|savings of|guarantee|award/i);
    expect(all).not.toMatch(/we (sell|install|supply|build|own|finance|operate)\b(?![^.]*\b(no|not|never)\b)/i);
    expect(all).not.toMatch(/[€$£]\s?\d|EUR\s?\d/);
    // The engineering buyer is told the calibration ledger is empty, in the same words the engine uses.
    expect(audienceBySlug("engineering-teams")!.notWhat.join(" ")).toMatch(/calibration ledger is empty/);
  });
});

describe("a step's price and turnaround are the catalogue's", () => {
  it("resolves every product step to its catalogue price line", () => {
    for (const a of AUDIENCES)
      for (const s of a.path) {
        const r = resolveStep(s);
        if (s.kind === "qualifier") {
          expect(r.price).toMatch(/Free/);
          expect(r.href).toBe("/qualify");
        } else {
          expect(r.price).toBe(priceLine(PRODUCTS[s.kind]));
          expect(r.href).toMatch(/^\/(products\/[a-z-]+|developers|pricing)$/);
        }
      }
    expect(resolveStep({ kind: "density_screen", why: "x" }).turnaround).toBe(`${PRODUCTS.density_screen.turnaroundDays} working days from a complete intake`);
    expect(resolveStep({ kind: "hall_watch", why: "x" }).turnaround).toBeNull();
  });
});

describe("the rendered pages", () => {
  const html = async (slug: string) => renderToStaticMarkup(await AudiencePage({ params: Promise.resolve({ slug }) })).replace(/&#x27;/g, "'").replace(/&amp;/g, "&");

  it("each renders one h1, the buyer's headline, a free first step, the live price and the limits", async () => {
    for (const a of AUDIENCES) {
      const out = await html(a.slug);
      expect(out.match(/<h1/g)).toHaveLength(1);
      expect(out).toContain(a.firstQuestion);
      expect(out).toContain(priceLine(PRODUCTS.density_screen));
      expect(out).toContain("What it is not");
      expect(out).toContain("sells no equipment");
      expect(out).toContain('application/ld+json');
      for (const c of a.constraints) expect(out).toContain(`/constraints/${c.slug}`);
    }
  });

  it("an unknown buyer is a 404, not an empty page", async () => {
    await expect(html("investor-relations")).rejects.toThrow();
  });

  it("metadata is canonical per page and names no price", async () => {
    for (const a of AUDIENCES) {
      const m = await generateMetadata({ params: Promise.resolve({ slug: a.slug }) });
      expect(m.alternates?.canonical).toBe(`/for/${a.slug}`);
      expect(String(m.description)).not.toMatch(/[€]\s?\d/);
    }
    expect(await generateMetadata({ params: Promise.resolve({ slug: "zz" }) })).toEqual({});
  });

  it("the index lists all seven and the sitemap lists the index and every page", async () => {
    const out = renderToStaticMarkup(React.createElement(ForIndex));
    for (const a of AUDIENCES) expect(out).toContain(`/for/${a.slug}`);
    const urls = (await sitemap()).map((s) => s.url);
    expect(urls.some((u) => u.endsWith("/for"))).toBe(true);
    for (const a of AUDIENCES) expect(urls.some((u) => u.endsWith(`/for/${a.slug}`))).toBe(true);
  });
});
