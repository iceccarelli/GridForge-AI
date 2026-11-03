import fs from "node:fs";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import Page from "@/app/page";
import { glance } from "@/components/home/Hero";
import { FAQ } from "@/lib/site";
import { PRODUCTS, eurFromCents } from "@/lib/products";
import { homeSource } from "./_home";

const read = (f: string) => fs.readFileSync(f, "utf8");
const homeFiles = fs.readdirSync("components/home").filter((f) => f.endsWith(".tsx")).map((f) => path.join("components/home", f));
const firstLine = (f: string) => read(f).split("\n").find((l) => l.trim() && !l.trim().startsWith("//") && !l.trim().startsWith("/*") && !l.trim().startsWith("*"));

describe("the homepage is a Server Component with client islands only where the browser is needed", () => {
  it("the page and every section but the lazy loader render on the server", () => {
    expect(firstLine("app/page.tsx")).not.toMatch(/use client/);
    const clientFiles = homeFiles.filter((f) => /^["']use client["']/.test(firstLine(f) ?? ""));
    expect(clientFiles).toEqual([path.join("components/home", "LazyIsland.tsx")]);
  });

  it("no home section pulls in the animation, charting or 3D libraries, or the live feeds, statically", () => {
    for (const f of ["app/page.tsx", ...homeFiles]) {
      const t = read(f);
      expect(t, f).not.toMatch(/from "framer-motion"|from "recharts"|from "three"|from "jspdf"/);
      if (f !== path.join("components/home", "LazyIsland.tsx")) {
        expect(t, f).not.toMatch(/from "@\/components\/(LiveConsole|TimeToPowerComparator|BindingConstraintInsights|TimeToPower)"/);
      }
    }
  });

  it("the heavy tools are dynamic imports that mount only near the viewport, and reserve their height", () => {
    const t = read("components/home/LazyIsland.tsx");
    for (const name of ["LiveConsole", "TimeToPowerComparator", "BindingConstraintInsights", "TimeToPower"]) expect(t).toContain(`import("@/components/${name}")`);
    expect(t).toContain("IntersectionObserver");
    expect(t).toContain("minHeight");
    expect(t).toMatch(/ssr: false/);
  });

  it("the chat assistant's conversation code is not in the shell: only the launcher is, and the panel loads on intent", () => {
    const layout = read("app/layout.tsx");
    expect(layout).toContain("ScopingAgent");
    expect(layout).not.toContain("ScopingAgentPanel");
    const launcher = read("components/ScopingAgent.tsx");
    expect(launcher).toMatch(/dynamic\(loadPanel, \{ ssr: false \}\)/);
    expect(launcher).not.toMatch(/fetch\(|\/api\/chat/);
    expect(launcher).toMatch(/onPointerEnter/);
    expect(read("components/ScopingAgentPanel.tsx")).toContain("/api/chat");
  });

  it("the chat panel is a labelled dialog that takes focus, closes on Escape and returns focus", () => {
    const panel = read("components/ScopingAgentPanel.tsx");
    expect(panel).toContain('role="dialog"');
    expect(panel).toMatch(/aria-label="Scoping engineer"/);
    expect(panel).toMatch(/e\.key === "Escape"/);
    expect(panel).toMatch(/inputRef\.current\?\.focus\(\)/);
    expect(panel).toContain('role="log"');
    expect(read("components/ScopingAgent.tsx")).toMatch(/launcher\.current\?\.focus\(\)/);
  });

  it("the questions accordion is native <details>, needing no script", () => {
    const t = read("components/home/Faq.tsx");
    expect(t).toContain("<details");
    expect(t).toContain("<summary");
    expect(t).not.toMatch(/useState|framer-motion|aria-expanded/);
  });
});

describe("the first screen answers the seven buyer questions, from the catalogue", () => {
  it("states who, which decision, what is needed, what is received, what to buy, what is free and why to trust it", () => {
    expect(glance().map((g) => g.k)).toEqual(["Who it is for", "The decision", "What we need", "What you get", "Buy now", "Free now", "Why trust it"]);
  });

  it("the paid offer's price and turnaround are the catalogue's, never typed", () => {
    const buy = glance().find((g) => g.k === "Buy now")!.v;
    expect(buy).toContain(eurFromCents(PRODUCTS.density_screen.amountCents));
    expect(buy).toContain(`${PRODUCTS.density_screen.turnaroundDays} working days from a complete intake`);
    expect(homeSource()).not.toMatch(/[€]\s?\d|\bEUR\s?\d/);
  });

  it("says what the free path does with the numbers and what it does not require", () => {
    const html = renderToStaticMarkup(React.createElement(Page)).replace(/&#x27;/g, "'");
    expect(html).toContain("no card, no call");
    expect(html).toContain("/legal/privacy");
    expect(html).toContain("directional");
  });
});

describe("the rendered homepage", () => {
  const html = renderToStaticMarkup(React.createElement(Page));

  it("has exactly one h1 and keeps the line the brand is built on", () => {
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(html).toContain("isn&#x27;t chips.");
    expect(html).toMatch(/It&#x27;s power\./);
  });

  it("carries every anchor the section navigation and the header point at, in reading order", () => {
    const ids = ["audiences", "market", "intelligence", "qualify", "developers-free", "services", "technology", "evidence", "about", "faq", "final-cta"];
    let at = -1;
    for (const id of ids) {
      const i = html.indexOf(`id="${id}"`);
      expect(i, id).toBeGreaterThan(at);
      at = i;
    }
  });

  it("renders every question and answer in the markup a crawler reads, and the FAQ markup is made from the same list", () => {
    const faqSection = html.slice(html.indexOf('id="faq"'), html.indexOf('id="final-cta"'));
    expect(faqSection.match(/<details/g)).toHaveLength(FAQ.length);
    const text = html.replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"');
    for (const f of FAQ) expect(text).toContain(f.q);
    const ld = [...html.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/g)].map((m) => m[1]).join("");
    for (const f of FAQ) expect(ld).toContain(JSON.stringify(f.q).slice(1, -1).replace(/</g, "\\u003c"));
  });

  it("states every market figure with its source and how strongly it was checked, and none that was withdrawn", () => {
    expect(html).toContain("Confirmed in press coverage; the original was not opened");
    expect(html).toContain("Read at the publisher");
    expect(html).not.toMatch(/160\+|fewer than 4%|Data Center Knowledge/);
  });

  it("makes no claim to sell equipment, and labels reference photography", () => {
    expect(html).toContain("We sell no equipment");
    expect(html).toContain("Reference photography");
    expect(html).not.toMatch(/megawatts in months|we install|we supply/i);
  });

  it("links every buyer page and the evidence page", () => {
    expect(html).toContain('href="/for"');
    expect(html).toContain('href="/for/colocation"');
    expect(html).toContain("/evidence#market-figures");
  });

  it("does not render the heavy tools on the server: only their placeholders", () => {
    expect(html).toContain("loads as you scroll to it");
    expect(html).not.toMatch(/recharts|EPEX day-ahead price/);
  });
});
