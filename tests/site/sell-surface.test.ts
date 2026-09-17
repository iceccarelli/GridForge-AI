/**
 * The sell surface may only sell what is for sale.
 *
 * For most of this repository's life the most prominent button on every page
 * opened a form for the Power Audit — a EUR 25k–45k engagement with no entry in
 * lib/products.ts, no Stripe price, no intake schema, no engine endpoint and no
 * deliverable. Nothing failed. There was nothing that could fail: no test in the
 * repository knew which products existed, so a CTA pointing at a product that did
 * not was indistinguishable from one pointing at a product that did.
 *
 * These tests are the check that was missing. They are deliberately source-level,
 * because the defect is source-level: the question is not "does this handler
 * behave" but "does any button on the site lead somewhere that cannot take money".
 *
 * The catalogue test beside it is the other half. A CTA that says EUR 4,500 while
 * checkout charges something else is a worse failure than a dead button, and the
 * only defence against it is that neither figure is ever typed.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { PRODUCTS, eurFromCents } from "@/lib/products";
import { DENSITY_SCREEN, DENSITY_SCREEN_CTA } from "@/lib/ui";
import { serviceCards } from "@/lib/site";
import robots from "@/app/robots";

const ROOT = path.resolve(__dirname, "../..");

/** Every .ts/.tsx under app/ and components/ — the surfaces a visitor can reach. */
function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (/\.tsx?$/.test(entry)) out.push(full);
    }
  };
  walk(path.join(ROOT, "app"));
  walk(path.join(ROOT, "components"));
  return out;
}

/**
 * Source with comments stripped.
 *
 * The history of a deleted product belongs in the comments — the reason the Power
 * Audit is gone is worth more to the next reader than the silence of it simply not
 * being there. So these tests read what ships, not what is explained.
 */
function code(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("no CTA leads to a product that does not exist", () => {
  const files = sourceFiles();

  it("finds some files to check, so a broken walk cannot pass silently", () => {
    expect(files.length).toBeGreaterThan(30);
  });

  it("openAudit() is called nowhere", () => {
    const offenders = files.filter((f) => code(f).includes("openAudit("));
    expect(offenders.map((f) => path.relative(ROOT, f))).toEqual([]);
  });

  it("the audit modal and its global event are gone", () => {
    const offenders = files.filter((f) => {
      const src = code(f);
      return src.includes("AuditModal") || src.includes("AUDIT_EVENT");
    });
    expect(offenders.map((f) => path.relative(ROOT, f))).toEqual([]);
  });

  it("no user-facing copy offers a Power Audit", () => {
    const offenders = files.filter((f) => /power audit/i.test(code(f)));
    expect(offenders.map((f) => path.relative(ROOT, f))).toEqual([]);
  });

  it("every product named in a CTA is one checkout can actually charge for", () => {
    const sellable = new Set(Object.keys(PRODUCTS));
    const quoted = new Set<string>();
    for (const f of files) {
      for (const m of code(f).matchAll(/productId=["']([a-z_]+)["']/g)) quoted.add(m[1]);
      for (const m of code(f).matchAll(/product:\s*["']([a-z_]+)["']/g)) quoted.add(m[1]);
    }
    expect([...quoted].filter((id) => !sellable.has(id))).toEqual([]);
    // And the one that must be there, or the primary CTA is not wired at all.
    expect(quoted.has(DENSITY_SCREEN)).toBe(true);
  });
});

describe("the price on a button is the price checkout charges", () => {
  it("the primary CTA label is assembled from the catalogue", () => {
    const p = PRODUCTS.density_screen;
    expect(DENSITY_SCREEN_CTA).toBe(
      `${p.name} — ${eurFromCents(p.amountCents)} · ${p.turnaroundDays} days`
    );
    // The figures the order fixed this CTA at. If the catalogue moves, this fails
    // and somebody decides on purpose rather than discovering it in production.
    expect(p.amountCents).toBe(450_000);
    expect(p.turnaroundDays).toBe(5);
    expect(DENSITY_SCREEN_CTA).toContain("4,500");
  });

  it("every home service card resolves against the catalogue", () => {
    const cards = serviceCards();
    expect(cards.length).toBeGreaterThan(0);
    for (const c of cards) {
      const p = PRODUCTS[c.productId];
      expect(p).toBeDefined();
      expect(c.title).toBe(p.name);
      expect(c.deliverable).toBe(p.deliverable);
      expect(c.price).toBe(eurFromCents(p.amountCents));
    }
    // The screen leads, and it is the only card that does.
    expect(cards.filter((c) => c.flagship).map((c) => c.productId)).toEqual([
      "density_screen",
    ]);
  });
});

describe("private surfaces stay out of the index", () => {
  const required = [
    "/intake/",
    "/deliverable/",
    "/watch/",
    "/api-access/",
    "/admin",
    "/account",
    "/q/",
    "/api/",
  ];

  it("every rule disallows every private path — the friendly crawlers included", () => {
    const rules = robots().rules;
    const list = Array.isArray(rules) ? rules : [rules];
    expect(list.length).toBeGreaterThan(1);
    for (const rule of list) {
      const disallow = ([] as string[]).concat(rule.disallow ?? []);
      for (const p of required) expect(disallow).toContain(p);
    }
  });
});
