import { describe, expect, it } from "vitest";
import sitemap from "@/app/sitemap";
import { computeHashes, readManifest, stale } from "../../scripts/page-lastmod.mjs";

describe("sitemap lastmod", () => {
  it("is not the build time: no URL claims a change that did not happen", async () => {
    const before = Date.now();
    const urls = await sitemap();
    expect(urls.length).toBeGreaterThan(10);
    for (const u of urls) {
      if (!u.lastModified) continue;
      const t = new Date(u.lastModified).getTime();
      expect(t, u.url).toBeLessThan(before - 60_000);
      expect(new Date(u.lastModified).toISOString().endsWith("T00:00:00.000Z"), u.url).toBe(true);
    }
  });

  it("every sitemap URL has a recorded date, and every recorded date is still a public route", async () => {
    const urls = (await sitemap()).map((u) => new URL(u.url).pathname.replace(/\/$/, "") || "/");
    const recorded = Object.keys(readManifest().pages);
    expect(urls.filter((p) => !recorded.includes(p))).toEqual([]);
    expect(recorded.filter((p) => !urls.includes(p))).toEqual([]);
  });

  it("the recorded hashes match the page content (run: node scripts/page-lastmod.mjs --write)", () => {
    expect(stale(readManifest(), computeHashes())).toEqual([]);
  });

  it("a changed page is detected", () => {
    const m = readManifest();
    const tampered = { pages: { ...m.pages, "/pricing": { ...m.pages["/pricing"], hash: "0".repeat(64) } } };
    expect(stale(tampered, computeHashes()).join()).toContain("/pricing: content changed");
  });
});
