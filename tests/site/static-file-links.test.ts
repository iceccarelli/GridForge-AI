import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isStaticFileHref } from "@/lib/static-href";
import { PRODUCT_PAGES } from "@/lib/product-pages";

// A next/link to a file in public/ is prefetched as a route and 404s (console error on the live site: /reference, /products/*).
describe("links to static files are plain anchors", () => {
  it("tells a file from a route", () => {
    for (const h of ["/reference/density_screen.html", "/reference/density_screen.md#data-request", "/reference/model_pack.json?x=1", "/x/y.PDF"]) {
      expect(isStaticFileHref(h), h).toBe(true);
    }
    for (const h of ["/", "/products/density-screen", "/pricing#engagements", "/reference", "https://example.com/a.html", "//cdn.example.com/a.html", "mailto:a@b.c"]) {
      expect(isStaticFileHref(h), h).toBe(false);
    }
  });

  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      return statSync(p).isDirectory() ? (n === "node_modules" ? [] : walk(p)) : /\.tsx$/.test(n) ? [p] : [];
    });

  it("no <Link> in app/ or components/ has a literal href that is a file", () => {
    const offenders: string[] = [];
    for (const f of [...walk("app"), ...walk("components")]) {
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(/<Link\b[^>]*?\bhref=(?:\{\s*)?["'`]([^"'`]+)["'`]/g)) {
        if (isStaticFileHref(m[1])) offenders.push(`${f}: ${m[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the product page renders every sample / row link through FileAwareLink, and those hrefs are files", () => {
    const src = readFileSync("app/products/[slug]/page.tsx", "utf8");
    expect(src).toContain("<FileAwareLink\n            href={page.sample?.href");
    expect(src).toContain("<FileAwareLink href={row.link.href}");
    const files = PRODUCT_PAGES.filter((p) => p.sample).map((p) => p.sample!.href);
    expect(files.length).toBeGreaterThan(0);
    for (const h of files) expect(isStaticFileHref(h), h).toBe(true);
  });
});
