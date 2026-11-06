/**
 * The home page's first screen: two SECONDARY routes beside the unchanged paid CTA, an honest status dot, and a meta description that fits a search
 * result. The H1 and the one-line proposition wait for the owner's wording and must not move; no price, name, interval or turnaround changes.
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
  it("keeps the paid CTA exactly as it was: the same component, product, context and size, with the price and turnaround from the catalogue", async () => {
    expect(read("components/home/Hero.tsx")).toContain('<CommissionScreen productId="density_screen" context="hero" size="lg" />');
    const html = unesc(await hero());
    const s = PRODUCTS.density_screen;
    expect(html).toContain(eurFromCents(s.amountCents));
    expect(html).toContain(`${s.turnaroundDays} working days from a complete intake`);
  });

  it("adds two secondary links with the wanted labels to routes that exist", async () => {
    const html = await hero();
    const link = (label: string) => new RegExp(`<a[^>]*href="([^"]+)"[^>]*>${label}`).exec(html)?.[1];
    expect(link("Try the free qualifier")).toBe("/qualify");
    expect(link("See a sample deliverable")).toBe("/reference");
    for (const r of ["qualify", "reference"]) expect(fs.existsSync(path.join(ROOT, "app", r, "page.tsx")), r).toBe(true);
  });

  it("the secondary links are real links (not buttons that act), with a comfortable touch target", async () => {
    const html = await hero();
    for (const label of ["Try the free qualifier", "See a sample deliverable"]) {
      const tag = new RegExp(`<a([^>]*)>${label}`).exec(html)?.[1] ?? "";
      expect(tag, label).toMatch(/min-h-11/);
    }
  });

  it("leaves the H1 and the one-line proposition as they were, to wait for the owner's wording", async () => {
    const html = unesc(await hero());
    expect(html).toContain("The bottleneck<br/>isn't chips.<br/><span class=\"text-power\">It&#x27;s power.</span>".replace("&#x27;", "'"));
    expect(html).toContain("Time to Power evaluates how much useful AI compute an existing data-centre hall can support, identifies the binding electrical or thermal constraint, and shows what it takes to unlock additional capacity, with cost, lead time and the evidence behind every number.");
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
