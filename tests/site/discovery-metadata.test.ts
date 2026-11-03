import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const read = (f: string) => fs.readFileSync(path.join(process.cwd(), f), "utf8");

describe("discovery metadata", () => {
  it.each(["app/account/layout.tsx", "app/dashboard/layout.tsx", "app/admin/login/layout.tsx"])(
    "%s keeps signed-in and operator screens out of the index, not only out of robots.txt",
    (f) => {
      expect(read(f)).toMatch(/robots:\s*\{\s*index:\s*false/);
    }
  );

  // Next replaces a page's openGraph object instead of merging it, so a page that sets one must repeat the site name, type and locale
  // (OG_BASE) AND name its own card: the root's card is replaced along with the rest. A page gets its card from the registry
  // (`pageImages("id")`, lib/page-cards.ts) or from an opengraph-image file in its own segment (the dynamic pages, and the home page at the
  // root). tests/site/share-cards.test.ts and scripts/check-share-cards.mjs prove the result.
  it("every page that sets its own openGraph spreads the shared base and has a card", () => {
    const walk = (d: string): string[] =>
      fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name === "page.tsx" ? [path.join(d, e.name)] : []));
    const sets = walk("app").filter((f) => /openGraph:\s*\{/.test(read(f)));
    expect(sets.length).toBeGreaterThan(10);
    const bad = sets.filter((f) => {
      const s = read(f);
      const block = s.slice(s.search(/openGraph:\s*\{/), s.search(/openGraph:\s*\{/) + 900);
      const spreads = /openGraph:\s*\{\s*\.\.\.OG_BASE/.test(block);
      const ownFile = fs.existsSync(path.join(path.dirname(f), "opengraph-image.tsx"));
      const registry = /images:\s*pageImages\("[a-z-]+"\)/.test(block);
      const staleImage = /OG_IMAGES|\/og\.png/.test(s);
      return !spreads || staleImage || (!ownFile && !registry);
    });
    expect(bad).toEqual([]);
  });

  it("every sitemap page declares its own canonical", () => {
    for (const f of ["app/power/compare/page.tsx", "app/power/deploy/page.tsx", "app/legal/privacy/page.tsx", "app/legal/terms/page.tsx", "app/legal/security/page.tsx"]) {
      expect(read(f), f).toMatch(/alternates:\s*\{\s*canonical:/);
    }
  });

  it("the layout's twitter block does not hand every page the homepage title", () => {
    const layout = read("app/layout.tsx");
    const tw = layout.slice(layout.indexOf("twitter:"), layout.indexOf("robots:"));
    expect(tw).not.toMatch(/title:|description:/);
  });
});
