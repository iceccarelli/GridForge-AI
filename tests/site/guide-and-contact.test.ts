import fs from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import Guide, { metadata as guideMeta } from "@/app/guides/nameplate-vs-useful-compute/page";
import Contact, { metadata as contactMeta } from "@/app/contact/page";
import sitemap from "@/app/sitemap";
import { GUIDE_SCENARIO_ID, guideScenario, modelPack, orderedConstraints } from "@/lib/guide-data";
import { SITE } from "@/lib/site";

const unesc = (s: string) =>
  s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&").replace(/&nbsp;/g, "\u00a0");

describe("the nameplate-against-useful-compute guide", () => {
  it("prints exactly what the engine's published pack says, for the scenario it names", async () => {
    const pack = (await modelPack())!;
    const s = guideScenario(pack)!;
    expect(s.id).toBe(GUIDE_SCENARIO_ID);
    const html = unesc(renderToStaticMarkup(await Guide()));
    expect(html).toContain(`<strong>${s.as_found.racks} racks</strong>`);
    expect(html).toContain(s.as_found.binding_name);
    expect(html).toContain(`<strong>${s.after_ladder.racks}</strong>`);
    const o = orderedConstraints(s);
    for (const c of [...o.gates, ...o.counted]) {
      expect(html, c.id).toContain(c.name);
      expect(html, c.id).toContain(unesc(c.basis.replace(/&/g, "&")));
    }
  });

  it("orders the table so the smallest ceiling is read first, with gates (zero racks) on top", async () => {
    const o = orderedConstraints(guideScenario((await modelPack())!)!);
    const counts = o.counted.map((c) => c.racks_permitted as number);
    expect([...counts].sort((a, b) => a - b)).toEqual(counts);
    for (const g of o.gates) expect(g.racks_permitted).toBe(0);
    for (const u of o.uncounted) expect(u.racks_permitted).toBeNull();
  });

  it("labels the hall synthetic, discloses the empty calibration ledger and says it sells no equipment", async () => {
    const html = unesc(renderToStaticMarkup(await Guide()));
    expect(html).toMatch(/synthetic<\/strong>/);
    expect(html).toContain("calibration ledger is empty");
    expect(html).toContain("sells no equipment");
    expect(html).toMatch(/never treated as zero and never produces a date|never treated as zero/);
    expect(html).not.toMatch(/customer (result|case)|our clients|testimonial/i);
  });

  it("is answer-first, has one h1, a dated author, a TechArticle that matches the page, and links the reference it is built on", async () => {
    const html = renderToStaticMarkup(await Guide());
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(html.indexOf("THE SHORT ANSWER")).toBeLessThan(html.indexOf("The method"));
    const ld = [...html.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/g)].map((m) => JSON.parse(m[1].replace(/\\u003c/g, "<")));
    const article = ld.find((j) => j["@type"] === "TechArticle")!;
    expect(article.headline).toBe(guideMeta.title);
    expect(article.datePublished).toBe("2026-11-03");
    expect(html).toMatch(/datetime="2026-11-03"/i);
    expect(article.author["@id"]).toMatch(/#founder$/);
    expect(article.isBasedOn).toMatch(/model_pack\.json$/);
    const crumb = ld.find((j) => j["@type"] === "BreadcrumbList")!;
    for (const it of crumb.itemListElement) expect(["/", "/guides/nameplate-vs-useful-compute"]).toContain(new URL(it.item).pathname);
    expect(html).toContain("/reference/model_pack.json");
  });

  it("is in the sitemap and the footer navigation", async () => {
    expect((await sitemap()).some((s) => s.url.endsWith("/guides/nameplate-vs-useful-compute"))).toBe(true);
    expect(fs.readFileSync("lib/nav.ts", "utf8")).toContain("/guides/nameplate-vs-useful-compute");
  });
});

describe("the contact page", () => {
  const html = unesc(renderToStaticMarkup(Contact()));

  it("gives the one real address and invents no phone, address or social account", () => {
    expect(html).toContain(`mailto:${SITE.email}`);
    expect(html).not.toMatch(/\+\d{1,3}[\s\d()-]{6,}|tel:|linkedin\.com|twitter\.com|x\.com\//i);
    expect(Object.values(SITE.social).every((v) => v === "")).toBe(true);
  });

  it("promises no reply time and states that an email is not an engagement or an opinion", () => {
    expect(html).toContain("We make no promise about when we will reply");
    expect(html).not.toMatch(/within \d|business days?|24 hours|same day/i);
    expect(html).toContain("is not an engagement");
    expect(html).toMatch(/not an engineering opinion/);
  });

  it("is a ContactPage with the organisation referenced by id, and indexable", () => {
    const ld = [...renderToStaticMarkup(Contact()).matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
    const page = ld.find((j) => j["@type"] === "ContactPage")!;
    expect(page.mainEntity["@id"]).toMatch(/#organization$/);
    expect(page.mainEntity.contactPoint.email).toBe(SITE.email);
    expect((contactMeta.robots as { index?: boolean } | undefined)?.index).not.toBe(false);
    expect(contactMeta.alternates?.canonical).toBe("/contact");
  });
});
