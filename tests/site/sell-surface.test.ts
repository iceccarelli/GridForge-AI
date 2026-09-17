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

describe("no fabricated customer, project or metric reaches the product UI", () => {
  const files = sourceFiles();

  /**
   * The names and figures that stood in app/dashboard/page.tsx.
   *
   * Three invented customers, a pilot with an invented efficiency and uptime, and
   * metric tiles reading 105 MW and $2.9M — each with a sparkline generated from a
   * seeded PRNG so the invented numbers moved convincingly. A PREVIEW ribbon sat
   * over all of it, which is not a defence: a screenshot does not carry the ribbon,
   * and this practice has no delivered projects, no uptime record and no savings.
   */
  const FABRICATIONS = [
    "Texas AI training cluster",
    "Northern Virginia expansion",
    "Frankfurt pilot site",
    "Demo HyperScale",
    "Sample Client",
    "demo@gridforge.ai",
    "demo2026",
    "gridforge_demo",
    "99.87%",
    "99.99%",
    "$1.84M",
    "$2.9M",
  ];

  it("none of the retired fabrications is anywhere in app/ or components/", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = code(f);
      for (const lie of FABRICATIONS) {
        if (src.includes(lie)) offenders.push(`${path.relative(ROOT, f)}: ${lie}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("no currency figure in dollars appears in the product UI at all", () => {
    // Everything this business charges is in euro and comes from lib/products.ts.
    // A dollar figure on a page is, by construction, one nothing can check —
    // which is exactly what "$2.9M energy savings YTD" was.
    const offenders: string[] = [];
    for (const f of files) {
      for (const m of code(f).matchAll(/\$\s?\d[\d,.]*\s?[kKmMbB]?/g)) {
        offenders.push(`${path.relative(ROOT, f)}: ${m[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the portal renders no hardcoded engagement — every row comes from the API", () => {
    const src = code(path.join(ROOT, "app/dashboard/page.tsx"));
    // It reads its rows from the route and nowhere else.
    expect(src).toContain('fetch("/api/engagements"');
    // And it says the honest thing when there are none.
    expect(src).toContain("No engagements yet");
    // A literal array of engagements or projects is how the fiction got in.
    expect(src).not.toMatch(/const\s+(projects|reports|pilot|metricCards)\s*[:=]/);
  });

  it("the portal is gated on a verified identity, not a client-side flag", () => {
    const page = code(path.join(ROOT, "app/dashboard/page.tsx"));
    expect(page).not.toContain("sessionStorage");
    const route = code(path.join(ROOT, "app/api/engagements/route.ts"));
    // The email is taken from the verified session, never from the request.
    expect(route).toContain("identify(req)");
    expect(route).not.toMatch(/body\.email|body\?\.email/);
  });

  it("the navbar no longer ships a hardcoded password", () => {
    const src = code(path.join(ROOT, "components/Navbar.tsx"));
    expect(src).not.toContain("LoginModal");
    expect(src).not.toContain("password");
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
