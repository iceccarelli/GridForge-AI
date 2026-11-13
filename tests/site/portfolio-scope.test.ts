/**
 * How many halls a Portfolio Screen is: three numbers, said once (lib/portfolio-scope.ts), never contradicting each other.
 *
 *   SOLD   five to fifteen   the engagement as sold: the price band is for that range, the fee is agreed in writing
 *   FORM   two to fifteen    what the hall-list form accepts (two is the least a ranking means anything for)
 *   ENGINE up to 50          what one /v1/portfolio request may rank: a bound on the work, not a scope
 *   beyond fifteen halls is a separate engagement; with fewer than five the fee is agreed in writing for the halls listed (no price is stated)
 *
 * What is pinned: the numbers equal the code that enforces them (the form's schema, the engine's source); the canonical sentences are what the
 * founder decided and state no price; every customer-visible surface carries the right one of them; and no hall-count phrase is typed anywhere
 * else under app, lib or components, so a surface cannot drift to a different number.
 */
import fs from "node:fs";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import * as scope from "@/lib/portfolio-scope";
import {
  PORTFOLIO_ENGINE_MAX_HALLS, PORTFOLIO_ENGINE_SENTENCE, PORTFOLIO_FEWER_SENTENCE, PORTFOLIO_FORM_MAX_HALLS, PORTFOLIO_FORM_MIN_HALLS, PORTFOLIO_FORM_RANGE,
  PORTFOLIO_FORM_SENTENCE, PORTFOLIO_MORE_SENTENCE, PORTFOLIO_SOLD_MAX_HALLS, PORTFOLIO_SOLD_MIN_HALLS, PORTFOLIO_SOLD_RANGE, PORTFOLIO_SOLD_RANGE_CAP,
  PORTFOLIO_SOLD_SENTENCE,
} from "@/lib/portfolio-scope";
import { PORTFOLIO_MAX_HALLS, PORTFOLIO_MIN_HALLS, portfolioIntakeSchema } from "@/lib/engagement-intake";
import { PRODUCTS } from "@/lib/products";
import { PRODUCT_PAGES } from "@/lib/product-pages";
import { AUDIENCES } from "@/lib/audiences";
import { CAPABILITY_REGISTRY } from "@/lib/capability-registry";
import { EngagementLadder } from "@/components/EngagementLadder";
import { PortfolioIntake } from "@/components/PortfolioIntake";
import { FULL_ENGINE, stubEngine } from "./engine-stub";

vi.mock("next/font/local", () => ({ default: () => ({ variable: "", className: "" }) }));

const flat = (h: string) => h.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, " ").replace(/&#x27;|&apos;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const WORD: Record<number, string> = { 2: "two", 5: "five", 15: "fifteen", 50: "fifty" };

describe("the numbers are the ones the code enforces", () => {
  it("the words in the phrases are the numbers in the constants", () => {
    expect(PORTFOLIO_SOLD_RANGE).toBe(`${WORD[PORTFOLIO_SOLD_MIN_HALLS]} to ${WORD[PORTFOLIO_SOLD_MAX_HALLS]} halls`);
    expect(PORTFOLIO_SOLD_RANGE_CAP).toBe(PORTFOLIO_SOLD_RANGE.charAt(0).toUpperCase() + PORTFOLIO_SOLD_RANGE.slice(1));
    expect(PORTFOLIO_FORM_RANGE).toBe(`${WORD[PORTFOLIO_FORM_MIN_HALLS]} to ${WORD[PORTFOLIO_FORM_MAX_HALLS]} halls`);
    expect(PORTFOLIO_MORE_SENTENCE).toContain(`More than ${WORD[PORTFOLIO_SOLD_MAX_HALLS]} halls`);
    expect(PORTFOLIO_ENGINE_SENTENCE).toContain(`up to ${PORTFOLIO_ENGINE_MAX_HALLS} halls`);
    expect([PORTFOLIO_SOLD_MIN_HALLS, PORTFOLIO_SOLD_MAX_HALLS, PORTFOLIO_FORM_MIN_HALLS, PORTFOLIO_FORM_MAX_HALLS, PORTFOLIO_ENGINE_MAX_HALLS]).toEqual([5, 15, 2, 15, 50]);
  });

  it("the hall-list form takes exactly the form's range: two is accepted, one and sixteen are refused (values kept as decided)", () => {
    expect([PORTFOLIO_MIN_HALLS, PORTFOLIO_MAX_HALLS]).toEqual([PORTFOLIO_FORM_MIN_HALLS, PORTFOLIO_FORM_MAX_HALLS]);
    const hall = (i: number) => ({ siteName: `Site ${i}`, hallId: "H1", contractedMW: 10, currentPeakMW: 6, currentItLoadMW: 4, buswayAmpacityA: 800, tapoffMaxA: 400, plantSupplyC: 7, positionsAvailable: 50 });
    const halls = (n: number) => Array.from({ length: n }, (_, i) => hall(i + 1));
    expect(portfolioIntakeSchema.safeParse({ halls: halls(PORTFOLIO_FORM_MIN_HALLS) }).success).toBe(true);
    expect(portfolioIntakeSchema.safeParse({ halls: halls(PORTFOLIO_FORM_MIN_HALLS - 1) }).success).toBe(false);
    expect(portfolioIntakeSchema.safeParse({ halls: halls(PORTFOLIO_FORM_MAX_HALLS) }).success).toBe(true);
    expect(portfolioIntakeSchema.safeParse({ halls: halls(PORTFOLIO_FORM_MAX_HALLS + 1) }).success).toBe(false);
  });

  it("the engine's per-request bound is the one the engine enforces (read from its source), and is not the sold range", () => {
    // Defined once, in gridforge/api/metering.py (the handler, the estimator, the published input schema and the rate card all read it from there).
    const src = fs.readFileSync("gridforge/api/metering.py", "utf8");
    expect(Number(/^MAX_PORTFOLIO_HALLS\s*=\s*(\d+)/m.exec(src)![1])).toBe(PORTFOLIO_ENGINE_MAX_HALLS);
    expect(fs.readFileSync("gridforge/api/server.py", "utf8")).not.toMatch(/^MAX_PORTFOLIO_HALLS\s*=\s*\d+/m);
    expect(PORTFOLIO_ENGINE_MAX_HALLS).toBeGreaterThan(PORTFOLIO_SOLD_MAX_HALLS);
    expect(PORTFOLIO_FORM_MIN_HALLS).toBeLessThan(PORTFOLIO_SOLD_MIN_HALLS);
    expect(PORTFOLIO_FORM_MAX_HALLS).toBe(PORTFOLIO_SOLD_MAX_HALLS);
  });
});

describe("the canonical sentences", () => {
  it("the fewer-than-five sentence is the decided one, word for word", () => {
    expect(PORTFOLIO_FEWER_SENTENCE).toBe("Sold for five to fifteen halls. With fewer, tell us when we scope it: the fee is agreed in writing for the halls you list.");
  });

  it("sold and beyond-fifteen say what was decided", () => {
    expect(PORTFOLIO_SOLD_SENTENCE).toBe("The Portfolio Screen is sold for five to fifteen halls: the price band is for that range, and the fee is agreed in writing before work starts.");
    expect(PORTFOLIO_MORE_SENTENCE).toBe("More than fifteen halls is a separate engagement, scoped on its own.");
  });

  it("the form and engine sentences keep the three numbers apart", () => {
    expect(PORTFOLIO_FORM_SENTENCE).toBe("The hall-list form takes two to fifteen halls; two is the least a ranking means anything for.");
    expect(PORTFOLIO_ENGINE_SENTENCE).toMatch(/up to 50 halls in one request\. That is a limit on the work one request can demand, not the scope of the Portfolio Screen engagement, which is sold for five to fifteen halls\.$/);
  });

  it("none of them states a price, a euro figure, a duration or a percentage", () => {
    for (const [name, value] of Object.entries(scope)) {
      if (typeof value !== "string") continue;
      expect(value, name).not.toMatch(/[€$£%]|\bEUR\b|\d[\d,.]*\s?(?:k\b|euros?|days?|weeks?)/i);
    }
  });
});

describe("every customer-visible surface says the right one", () => {
  const portfolioPage = PRODUCT_PAGES.find((p) => p.slug === "portfolio-screen")!;

  it("the catalogue description says the sold range and nothing else", () => {
    const d = PRODUCTS.portfolio_screen_deposit.description;
    expect(d).toContain(`(${PORTFOLIO_SOLD_RANGE} ranked under one methodology)`);
    expect(d).not.toMatch(/two to fifteen|up to 50|\bfifty\b/i);
  });

  it("the product page: the sold range in the search description, the fewer sentence under what we need, sold and beyond-fifteen under what it is not", () => {
    expect(portfolioPage.metaDescription.startsWith(PORTFOLIO_SOLD_RANGE_CAP)).toBe(true);
    expect(portfolioPage.metaDescription.length).toBeLessThanOrEqual(160);
    expect(portfolioPage.inputs.join("\n")).toContain(PORTFOLIO_FEWER_SENTENCE);
    expect(portfolioPage.limits.join("\n")).toContain(PORTFOLIO_SOLD_SENTENCE);
    expect(portfolioPage.limits.join("\n")).toContain(PORTFOLIO_MORE_SENTENCE);
  });

  it("the investor's route says the sold range", () => {
    const why = AUDIENCES.flatMap((a) => a.path).filter((r) => r.kind === "portfolio_screen_deposit").map((r) => r.why);
    expect(why.length).toBeGreaterThan(0);
    expect(why.some((w) => w.includes(PORTFOLIO_SOLD_RANGE))).toBe(true);
    for (const w of why) expect(w).not.toMatch(/two to fifteen|up to 50/i);
    expect(why.every((w) => /halls/.test(w))).toBe(true);
  });

  it("the capability registry says the sold range, and points at this module for the other two numbers", () => {
    const c = CAPABILITY_REGISTRY.find((x) => x.capability_id === "portfolio_screen")!;
    expect(c.description).toContain(PORTFOLIO_SOLD_RANGE);
    expect(c.entitlement).toContain("lib/portfolio-scope.ts");
    expect(c.entitlement).not.toMatch(/\d+ halls|to fifteen/);
  });

  it("the ladder, before the visitor pays, carries the fewer sentence and the beyond-fifteen sentence under the Portfolio Screen", () => {
    const html = flat(renderToStaticMarkup(React.createElement(EngagementLadder)));
    expect(html).toContain(PORTFOLIO_FEWER_SENTENCE);
    expect(html).toContain(PORTFOLIO_MORE_SENTENCE);
    expect(html).toContain(PORTFOLIO_SOLD_RANGE);
    expect(html).not.toMatch(/two to fifteen/);
  });

  it("the hall-list form's own messages: the least a ranking needs, and the most one engagement is scoped for with what lies beyond it", () => {
    const html = flat(renderToStaticMarkup(React.createElement(PortfolioIntake, { token: "t", minHalls: PORTFOLIO_MIN_HALLS, maxHalls: PORTFOLIO_MAX_HALLS })));
    expect(html).toContain(`(${PORTFOLIO_MIN_HALLS} to ${PORTFOLIO_MAX_HALLS} halls)`);
    const src = fs.readFileSync("components/PortfolioIntake.tsx", "utf8");
    expect(src).toContain("PORTFOLIO_MORE_SENTENCE");
    expect(src).toContain("One portfolio is scoped for up to ${maxHalls} halls");
  });

  it("the intake page states sold, form and beyond-fifteen from the module", () => {
    const src = fs.readFileSync("app/intake/[token]/page.tsx", "utf8");
    expect(src).toMatch(/\{PORTFOLIO_SOLD_SENTENCE\} \{PORTFOLIO_FORM_SENTENCE\} \{PORTFOLIO_MORE_SENTENCE\}/);
    expect(src).toContain("minHalls={PORTFOLIO_MIN_HALLS} maxHalls={PORTFOLIO_MAX_HALLS}");
  });

  it("/llms.txt carries the fewer, beyond-fifteen, form and engine sentences together, once", async () => {
    const stop = stubEngine(FULL_ENGINE);
    try {
      const { GET } = await import("@/app/llms.txt/route");
      const body = (await (await GET()).text()).replace(/\s+/g, " ");
      const line = `Portfolio Screen scope: ${PORTFOLIO_FEWER_SENTENCE} ${PORTFOLIO_MORE_SENTENCE} ${PORTFOLIO_FORM_SENTENCE} ${PORTFOLIO_ENGINE_SENTENCE}`;
      expect(body).toContain(line);
      expect(body.split(line).length - 1).toBe(1);
    } finally {
      stop();
    }
  });

  it("/developers says the engine's bound is a work bound and not the scope, where the portfolio tool is listed", async () => {
    const stop = stubEngine(FULL_ENGINE);
    try {
      const html = flat(renderToStaticMarkup(await (await import("@/app/developers/page")).default()));
      expect(html).toContain(PORTFOLIO_ENGINE_SENTENCE);
      expect(html).not.toContain(PORTFOLIO_FEWER_SENTENCE); // the endpoint page does not sell the engagement
    } finally {
      stop();
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// The guard: no hall-count phrase is typed anywhere else, so no surface can say a number the module does not.
// ---------------------------------------------------------------------------------------------------------------------------------
const ROOTS = ["app", "lib", "components"];
const MODULE = path.join("lib", "portfolio-scope.ts");
/** A hall count written as a range, as the words, or as a limit: "five to fifteen", "5-15", "2 to 15", "up to 50 halls", "fifteen halls", "fifty halls". */
export const HALL_COUNT = new RegExp(
  [
    String.raw`\b(?:two|2|five|5)\s*(?:to|-|–|—)\s*(?:fifteen|15)\b`,
    String.raw`\bfifteen\b`,
    String.raw`\bfifty\b`,
    String.raw`\b(?:15|50)[\s-]*halls?\b`,
    String.raw`\b(?:up to|at most|a maximum of|maximum of|no more than|limit of)\s+(?:15|50|fifteen|fifty)\b`,
  ].join("|"),
  "i",
);

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name !== "node_modules" && e.name !== ".next") walk(p);
      } else if (/\.(?:tsx?|mjs|js)$/.test(e.name)) out.push(p);
    }
  };
  for (const r of ROOTS) if (fs.existsSync(r)) walk(r);
  return out.filter((f) => f !== MODULE).sort();
}

describe("no hall count is typed outside lib/portfolio-scope.ts", () => {
  it("scans the app, lib and components (and finds the files it is meant to)", () => {
    const files = sourceFiles();
    expect(files.length).toBeGreaterThan(200);
    for (const f of ["lib/products.ts", "lib/product-pages.ts", "components/EngagementLadder.tsx", "app/developers/page.tsx", "app/llms.txt/route.ts"]) expect(files, f).toContain(f);
    expect(files).not.toContain(MODULE);
  });

  it("finds none", () => {
    const hits: string[] = [];
    for (const f of sourceFiles()) {
      fs.readFileSync(f, "utf8").split("\n").forEach((line, i) => {
        if (HALL_COUNT.test(line)) hits.push(`${f}:${i + 1} ${line.trim().slice(0, 100)}`);
      });
    }
    expect(hits, "a hall count typed in a sentence: import the phrase or sentence from lib/portfolio-scope.ts").toEqual([]);
  });

  // The scan itself: a check that cannot fail is not a check.
  it.each([
    ["Five to fifteen halls ranked on deliverable compute", true],
    ["portfolio screen (five to fifteen halls ranked under one methodology)", true],
    ["description: \"5-15 halls ranked by deployable compute\"", true],
    ["(2 to 15 halls) -> /v1/portfolio", true],
    ["the form takes two to fifteen halls", true],
    ["a forty-hall portfolio run", false],
    ["POST /v1/portfolio ranks up to 50 halls", true],
    ["fifteen is the most one engagement is scoped for", true],
    ["send the rest as further requests", false],
    ["`${minHalls} to ${maxHalls} halls`", false],
    ["Reason (required, up to 500 characters)", false],
  ])("%s -> %s", (line, hit) => {
    expect(HALL_COUNT.test(line)).toBe(hit);
  });
});
