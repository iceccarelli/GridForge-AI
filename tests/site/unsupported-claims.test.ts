/**
 * No claim about what halls, operators or buildings "usually", "rarely" or "mostly" do, and nobody-in-the-building generalisations, in the copy a
 * visitor reads on the home page, the audience pages, the qualifier and the shared site copy. The product has no evidence for a prevalence it
 * has not measured (the calibration ledger is empty); a question or a conditional ("it may be...", "can it be...?") says what is true.
 * Sourced market figures are not covered: they carry their source and how strongly it was checked (lib/market-evidence.ts).
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../..");
const walk = (dir: string): string[] =>
  fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith(".tsx") || e.name.endsWith(".ts") ? [path.join(dir, e.name)] : []));

const FILES = ["lib/audiences.ts", "lib/site.ts", "app/qualify/page.tsx", ...walk("app/for"), ...walk("components/home")];
const BANNED = /most halls|usually leads to|rarely the one|nobody in the building|(?<![a-z])usually(?![a-z])|(?<![a-z])rarely(?![a-z])|most operators|most owners|halls (typically|commonly|often)/i;

describe("unsupported prevalence claims", () => {
  it("none of the home, audience, qualifier and shared-copy files makes one", () => {
    const offenders: string[] = [];
    for (const f of FILES) {
      fs.readFileSync(path.join(ROOT, f), "utf8").split("\n").forEach((line, i) => {
        // the grep patterns in this very rule and code comments naming the rule are not copy
        if (BANNED.test(line)) offenders.push(`${f}:${i + 1}: ${line.trim().slice(0, 140)}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it("covers the audience pages, the home sections, the qualifier and the shared copy (the files exist and were read)", () => {
    expect(FILES.length).toBeGreaterThan(8);
    for (const f of FILES) expect(fs.existsSync(path.join(ROOT, f)), f).toBe(true);
    expect(FILES).toEqual(expect.arrayContaining(["lib/audiences.ts", "lib/site.ts", "app/qualify/page.tsx", "app/for/page.tsx", "components/home/Sections.tsx"]));
  });

  it("the deposit cards say where the clock starts with the engagement terms' own wording", async () => {
    const { serviceCards } = await import("@/lib/site");
    const { DEPOSIT_CLOCK_START, depositTerms } = await import("@/lib/engagement-state");
    const { PRODUCTS } = await import("@/lib/products");
    const deposits = serviceCards().filter((c) => PRODUCTS[c.productId].opensBandCents);
    expect(deposits.length).toBeGreaterThan(0);
    for (const c of deposits) {
      expect(c.timeline).toContain(DEPOSIT_CLOCK_START);
      expect(depositTerms(PRODUCTS[c.productId].kind)!.timing).toContain(DEPOSIT_CLOCK_START);
    }
    expect(DEPOSIT_CLOCK_START).toBe("from a complete intake and the scoping call");
  });
});
