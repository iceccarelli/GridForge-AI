import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { PlatformEntry } from "@/lib/constraints";
import { PLATFORM_CONSTRAINT_SLUGS, derive, pageablePlatforms } from "@/lib/platform-pages";
import sitemap from "@/app/sitemap";

const lib = JSON.parse(readFileSync("public/reference/platforms.json", "utf8")) as { platforms: PlatformEntry[] };

describe("per-platform pages", () => {
  it("exist only for sourced platforms that are not generic archetypes", () => {
    const ids = pageablePlatforms(lib.platforms).map((p) => p.id);
    expect(ids.length).toBeGreaterThan(0);
    for (const p of lib.platforms) {
      expect(ids.includes(p.id)).toBe(!p.generic && p.sources.length > 0);
    }
  });

  it("derive only arithmetic that reproduces the library's own figures", () => {
    for (const p of pageablePlatforms(lib.platforms)) {
      const d = derive(p);
      // The library states the residual air load; rack power minus the liquid-captured share must agree with it.
      expect(p.rack_kW - d.liquid_kW).toBeCloseTo(p.residual_air_kW, 0);
      // The library states floor loading as mass over footprint.
      expect(d.mass_over_footprint_kg_per_m2).toBeCloseTo(p.floor_loading_kg_per_m2, -1);
      expect(d.racks_per_MW_it * p.rack_kW).toBeLessThanOrEqual(1000);
      expect((d.racks_per_MW_it + 1) * p.rack_kW).toBeGreaterThan(1000);
    }
  });

  it("link only to constraint pages that exist", () => {
    for (const c of PLATFORM_CONSTRAINT_SLUGS) {
      expect(() => readFileSync(`public/reference/constraints/${c.slug}.json`, "utf8")).not.toThrow();
    }
  });

  it("are in the sitemap", async () => {
    const urls = (await sitemap()).map((e) => e.url);
    for (const p of pageablePlatforms(lib.platforms)) expect(urls.some((u) => u.endsWith(`/platforms/${p.id}`))).toBe(true);
  });

  it("never invent a number: the page source types no rack figure", () => {
    const src = readFileSync("app/platforms/[id]/page.tsx", "utf8") + readFileSync("lib/platform-pages.ts", "utf8");
    expect(src).not.toMatch(/\b(132|135|1889)\b/);
  });
});
