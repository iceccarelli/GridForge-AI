/**
 * The home page's first screen: the free check as the PRIMARY action, a sample deliverable as the secondary, the paid screen (the same checkout
 * button component, unchanged in behaviour) as the tertiary, an honest status dot, and a meta description that fits a search result. The H1 and
 * sub-copy are now the owner's wording (they were held back until it arrived); no price, name, interval or turnaround changes.
 */
import fs from "node:fs";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { PRODUCTS, eurFromCents } from "@/lib/products";

vi.mock("next/font/local", () => ({ default: () => ({ variable: "font-var", className: "font-cls" }) }));
vi.mock("next/navigation", () => ({ usePathname: () => "/", useRouter: () => ({ push: () => {}, replace: () => {} }) }));

const ROOT = path.resolve(__dirname, "../..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const hero = async () => renderToStaticMarkup(React.createElement((await import("@/components/home/Hero")).Hero));
const unesc = (s: string) => s.replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"');

describe("Hero call-to-action row", () => {
  it("keeps the paid CTA's checkout component, product and context: only its prominence changed (tertiary text button), with the price and turnaround from the catalogue", async () => {
    // Before: size="lg" and the default filled tone. Now tone="text" with the label "Order a Density Screen — <price> · <days> days". The component's
    // behaviour (components/CommissionScreen.tsx -> startCommission -> /api/checkout) is untouched; the checkout tests still guard it.
    expect(read("components/home/Hero.tsx")).toContain('<CommissionScreen productId="density_screen" context="hero" tone="text" label={PAID_LABEL} />');
    const html = unesc(await hero());
    const s = PRODUCTS.density_screen;
    expect(html).toContain(`Order a ${s.name} — ${eurFromCents(s.amountCents)} · ${s.turnaroundDays} days`);
  });

  it("orders the three actions primary (free check, filled), secondary (sample deliverable, outlined), tertiary (paid, text)", async () => {
    const html = await hero();
    const { QUALIFY_LINK } = await import("@/lib/nav");
    const free = html.indexOf(QUALIFY_LINK.label);
    const sample = html.indexOf("See a sample deliverable");
    const paid = unesc(html).indexOf("Order a Density Screen");
    expect(free).toBeGreaterThan(-1);
    expect(sample).toBeGreaterThan(free);
    expect(unesc(html).indexOf("Order a Density Screen")).toBeGreaterThan(unesc(html).indexOf("See a sample deliverable"));
    expect(paid).toBeGreaterThan(-1);
    expect(/<a[^>]*class="[^"]*btn-primary[^"]*"[^>]*href="\/qualify"|<a[^>]*href="\/qualify"[^>]*class="[^"]*btn-primary/.test(html)).toBe(true);
    expect(/<a[^>]*href="\/reference"[^>]*class="[^"]*btn-secondary|<a[^>]*class="[^"]*btn-secondary[^"]*"[^>]*href="\/reference"/.test(html)).toBe(true);
    expect(/<button[^>]*class="[^"]*btn-tertiary/.test(html)).toBe(true);
    // The paid button must not be a filled one.
    expect(/<button[^>]*class="[^"]*(bg-power|btn-primary)/.test(html)).toBe(false);
  });

  it("the free path is not amber: the 'delay / warning' token (queue) is not used on the first screen", async () => {
    const src = read("components/home/Hero.tsx");
    expect(src).not.toMatch(/eyebrow-queue|text-queue|bg-queue|border-queue|--queue/);
    const html = await hero();
    expect(html).not.toMatch(/eyebrow-queue|text-queue|bg-queue/);
  });

  it("links the free check once and the sample deliverable to a route that exists", async () => {
    const html = await hero();
    expect(new RegExp('<a[^>]*href="([^"]+)"[^>]*>See a sample deliverable').exec(html)?.[1]).toBe("/reference");
    expect(fs.existsSync(path.join(ROOT, "app", "reference", "page.tsx"))).toBe(true);
    expect(html).not.toContain("Try the free qualifier");
    const { QUALIFY_LINK } = await import("@/lib/nav");
    expect(html).toContain(QUALIFY_LINK.label);
    expect((html.match(/href="\/qualify"/g) ?? []).length).toBe(1);
  });

  it("the actions are real links and buttons with a comfortable touch target", async () => {
    const html = await hero();
    for (const label of ["See a sample deliverable", "Try the free capacity check"]) {
      const tag = new RegExp(`<a([^>]*)>${label}`).exec(html)?.[1] ?? "";
      expect(tag, label).toMatch(/min-h-11/);
    }
  });

  it("carries the owner's H1 and a sub-copy of at most 45 words that claims only what the software does", async () => {
    const html = unesc(await hero());
    expect(html).toContain("How many AI racks can your hall really power — and what unlocks more?");
    const { SUB } = await import("@/components/home/Hero");
    expect(html).toContain(SUB);
    expect(SUB.split(/\s+/).length).toBeLessThanOrEqual(45);
    expect(SUB).toMatch(/electrical or thermal limit that binds first/);
    expect(SUB).toMatch(/relief ladder with lead times/);
    expect(SUB).toMatch(/evidence behind every figure/);
    // Nothing that implies customers, traction or accuracy.
    expect(html).not.toMatch(/trusted by|customers? (include|use)|used by|accura(te|cy) of|case stud/i);
  });

  it("puts one audience line directly above the H1, and links it to the audience pages", async () => {
    const html = unesc(await hero());
    const { AUDIENCE } = await import("@/components/home/Hero");
    expect(AUDIENCE).toMatch(/operators/);
    expect(AUDIENCE).toMatch(/investors/);
    expect(AUDIENCE).toMatch(/engineers/);
    expect(html.indexOf(AUDIENCE)).toBeGreaterThan(-1);
    expect(html.indexOf(AUDIENCE)).toBeLessThan(html.indexOf("<h1"));
    expect(html).toMatch(/href="\/for"/);
    expect(fs.existsSync(path.join(ROOT, "app", "for", "page.tsx"))).toBe(true);
  });
});

describe("the PILOT-STAGE badge", () => {
  it("does not use the 'verified' (genuinely operational / confirmed) colour: a pilot-stage badge is not a confirmation", () => {
    const src = read("components/home/Hero.tsx");
    const badge = src.slice(src.indexOf("PILOT-STAGE") - 400, src.indexOf("PILOT-STAGE") + 80);
    expect(badge).not.toMatch(/verified/);
    expect(src).not.toMatch(/bg-verified|text-verified/);
    expect(read("tailwind.config.ts")).toMatch(/verified: "#34D399", \/\/ genuinely operational \/ confirmed/); // the token keeps its meaning elsewhere
  });
  it("still says what stage this is", async () => {
    expect(await hero()).toContain("PILOT-STAGE · FOUNDER-LED · EVIDENCE-GRADED");
  });
});

describe("the home meta description", () => {
  it("fits a search result (160 characters or fewer) and states what the product does, with no price, date, count or superlative", async () => {
    const { metadata } = await import("@/app/layout");
    const d = String(metadata.description);
    expect(d.length).toBeLessThanOrEqual(160);
    expect(d.length).toBeGreaterThan(80);
    expect(d).toMatch(/AI compute/);
    expect(d).toMatch(/evidence class/);
    expect(d).not.toMatch(/€|EUR|\d|best|leading|only|fastest|guarantee/i);
  });
  it("leaves the social description, the title and the keywords alone", async () => {
    const { metadata } = await import("@/app/layout");
    expect(String((metadata.title as { default: string }).default)).toBe("Time to Power — Power-Capacity Intelligence for AI Infrastructure");
    expect(String(metadata.openGraph?.description)).toMatch(/The bottleneck isn't chips/);
  });
});
