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

  // Next replaces a page's openGraph object instead of merging it, so a page that sets one must name the image.
  it("every page that sets its own openGraph also sets openGraph images", () => {
    const walk = (d: string): string[] =>
      fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name === "page.tsx" ? [path.join(d, e.name)] : []));
    const missing = walk("app")
      .filter((f) => /openGraph:\s*\{/.test(read(f)))
      .filter((f) => {
        const s = read(f);
        const block = s.slice(s.search(/openGraph:\s*\{/));
        return !/^openGraph:\s*\{[^]*?\bimages:\s*(OG_IMAGES|\[)/.test(block.slice(0, 700));
      });
    expect(missing).toEqual([]);
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
