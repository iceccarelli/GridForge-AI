/**
 * A turnaround is the catalogue's number, written by one formatter.
 *
 * "five working days" was typed into lib/site.ts (twice), app/api/audit/route.ts (twice) and lib/products.ts, while tests/test_catalogue_single_source.py
 * and tests/site/billing-catalogue.test.ts pin only the NUMBER, `turnaroundDays`, to the engine's `turnaround_days`. Change the catalogue and the
 * sentences stayed behind. Every such sentence now calls workingDays() (lib/turnaround.ts) with the catalogue's number, and this file fails if a
 * duration in working days is typed in the site's source anywhere else.
 *
 * The scan reads the real syntax tree and looks only at string literals, template text and JSX text, so a comment explaining the history
 * ("said '5 working days' in one file") is not copy and is not flagged, and a template such as `${p.turnaroundDays} working days` is not a
 * typed duration.
 */
import fs from "node:fs";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { workingDays } from "@/lib/turnaround";

// ------------------------------------------------------------------------------------------------ the formatter
describe("workingDays", () => {
  it.each([
    [5, "five working days"],
    [1, "one working day"],
    [2, "two working days"],
    [10, "ten working days"],
    [11, "11 working days"],
    [25, "25 working days"],
    [45, "45 working days"],
  ])("%i -> %s", (n, text) => expect(workingDays(n)).toBe(text));

  it("falls back to digits for anything that is not a whole number of days", () => {
    expect(workingDays(2.5)).toBe("2.5 working days");
    expect(workingDays(-1)).toBe("-1 working days");
    expect(workingDays(Number.NaN)).toBe("NaN working days");
  });
});

// ------------------------------------------------------------------------------------------------ the scan
const NUMBER_WORDS = "zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty(?:[- ](?:one|two|three|four|five|six|seven|eight|nine))?|thirty|forty(?:[- ](?:five))?|fifty|sixty";
/** A duration typed as words or digits, e.g. "five working days", "5 working days", "25-working-day", "twelve working days". */
export const TYPED_DURATION = new RegExp(`(?<![\\w$])(?:\\d+(?:\\.\\d+)?|${NUMBER_WORDS})[\\s-]+working[\\s-]+days?\\b`, "i");

const ROOTS = ["app", "lib", "components", "scripts"];
const FORMATTER = path.join("lib", "turnaround.ts");

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
  return out.filter((f) => f !== FORMATTER).sort();
}

/** Every piece of text the file can show: string literals, template text and JSX text. Comments are not among them. */
export function literalTexts(file: string, source: string): { text: string; line: number }[] {
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : file.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
  const out: { text: string; line: number }[] = [];
  const add = (node: ts.Node, text: string) => out.push({ text, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1 });
  const visit = (n: ts.Node) => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) add(n, n.text);
    else if (ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) add(n, n.text);
    else if (ts.isJsxText(n)) add(n, n.text);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

export function typedDurations(file: string, source: string): string[] {
  return literalTexts(file, source)
    .filter((t) => TYPED_DURATION.test(t.text))
    .map((t) => `${file}:${t.line} ${JSON.stringify(t.text.slice(0, 90))}`);
}

describe("no duration in working days is typed outside the formatter", () => {
  it("scans the app, lib, components and scripts (and finds the files it is meant to)", () => {
    const files = sourceFiles();
    expect(files.length).toBeGreaterThan(200);
    for (const f of ["lib/site.ts", "lib/products.ts", "app/api/audit/route.ts", "app/layout.tsx"]) expect(files, f).toContain(f);
    expect(files).not.toContain(FORMATTER);
  });

  it("finds none", () => {
    const hits = sourceFiles().flatMap((f) => typedDurations(f, fs.readFileSync(f, "utf8")));
    expect(hits, "a duration typed in a sentence: build it with workingDays(<catalogue turnaroundDays>) from lib/turnaround.ts").toEqual([]);
  });

  // The scan itself: a check that cannot fail is not a check.
  it.each([
    ['const a = "one hall, five working days from a complete intake";', 1],
    ['const a = "delivered 5 working days after";', 1],
    ["const a = `the Density Screen (five working days): what binds`;", 1],
    ['const a = "a 5-working-day turnaround";', 1],
    ['const a = "twelve working days from a complete intake";', 1],
    ['const a = "25 working days";', 1],
    ["const a = <p>One hall, five working days.</p>;", 1],
    ["const a = `${p.turnaroundDays} working days from a complete intake`;", 0],
    ["const a = `${workingDays(5)} from a complete intake`;", 0],
    ["// it used to say five working days here\nconst a = 1;", 0],
    ["/* said '5 working days' in one file */ const a = 1;", 0],
    ['const a = "working days are counted from intake";', 0],
    ['const a = "the working days after a complete intake";', 0],
  ])("flags %j: %i", (src, expected) => {
    expect(typedDurations("x.tsx", src as string)).toHaveLength(expected as number);
  });
});

// ------------------------------------------------------------------------------------------------ the sentences follow the catalogue
describe("every sentence that names the Density Screen's turnaround follows the catalogue", () => {
  afterEach(() => {
    vi.doUnmock("@/lib/products");
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  /** The catalogue with the Density Screen's turnaround changed, which the engine-parity tests would refuse in production but a mock may try. */
  function perturb(days: number) {
    vi.doMock("@/lib/products", async (orig) => {
      const real = await orig<typeof import("@/lib/products")>();
      // Property descriptors, not a spread: a spread would freeze the description getter at the old value, which is the failure being tested for.
      const screen = Object.defineProperties({}, { ...Object.getOwnPropertyDescriptors(real.PRODUCTS.density_screen), turnaroundDays: { value: days, enumerable: true, writable: true, configurable: true } }) as typeof real.PRODUCTS.density_screen;
      const PRODUCTS = { ...real.PRODUCTS, density_screen: screen };
      return { ...real, PRODUCTS, PRODUCT_BY_KIND: Object.fromEntries(Object.values(PRODUCTS).map((p) => [p.kind, p])) };
    });
  }

  it("the catalogue's own description says it, in words, from turnaroundDays", async () => {
    vi.resetModules();
    const { PRODUCTS } = await import("@/lib/products");
    expect(PRODUCTS.density_screen.turnaroundDays).toBe(5);
    expect(PRODUCTS.density_screen.description).toContain("delivered five working days after a complete intake");
    // The description is read as an ordinary string property by checkout, JSON-LD and llms.txt.
    expect(typeof PRODUCTS.density_screen.description).toBe("string");
    expect(JSON.parse(JSON.stringify(PRODUCTS.density_screen)).description).toBe(PRODUCTS.density_screen.description);
    expect({ ...PRODUCTS.density_screen }.description).toBe(PRODUCTS.density_screen.description);
  });

  it("lib/site.ts (the home card and the FAQ answer) follows a changed turnaround", async () => {
    perturb(7);
    vi.resetModules();
    const site = await import("@/lib/site");
    const card = site.SERVICES.find((s) => s.productId === "density_screen")!;
    expect(card.desc).toContain("One hall, seven working days from a complete intake.");
    expect(card.desc).not.toMatch(/five working days/);
    const faq = site.FAQ.find((f) => f.q === "What can I actually buy today?")!;
    expect(faq.a).toContain("one hall, seven working days from a complete intake:");
    expect(faq.a).not.toMatch(/five working days/);
  });

  it("the Density Screen's description follows it too", async () => {
    perturb(7);
    vi.resetModules();
    const { PRODUCTS } = await import("@/lib/products");
    expect(PRODUCTS.density_screen.description).toContain("delivered seven working days after a complete intake");
    expect(PRODUCTS.density_screen.description).not.toContain("five");
  });

  it("the enquiry confirmation email (app/api/audit/route.ts) is built from it", () => {
    const src = fs.readFileSync("app/api/audit/route.ts", "utf8");
    expect(src).toContain("workingDays(PRODUCTS.density_screen.turnaroundDays)");
    expect(src).toContain("${screenDays}");
  });

  it("the root layout's social description is built from it", async () => {
    const src = fs.readFileSync("app/layout.tsx", "utf8");
    expect(src).toContain("workingDays(SCREEN.turnaroundDays)");
    expect(src).not.toMatch(/turnaroundDays === 5/);
    // Rendered, the same sentence as before (the day count did not change; only where it comes from).
    const { PRODUCTS, eurFromCents } = await import("@/lib/products");
    expect(src).toContain("${SCREEN_PRICE}, ${SCREEN_DAYS} from a complete intake.");
    expect(PRODUCTS.density_screen.turnaroundDays).toBe(5);
    expect(eurFromCents(PRODUCTS.density_screen.amountCents)).toContain("4,500");
  });

  it("unchanged copy: the home card renders exactly the sentence it did before", async () => {
    vi.resetModules();
    const site = await import("@/lib/site");
    const html = renderToStaticMarkup(React.createElement("p", null, site.SERVICES[0].desc));
    expect(html).toContain("One hall, five working days from a complete intake.");
  });
});
