/**
 * The Observatory pages read public/observatory/scenarios.json at run time. Next's file tracing cannot see a path built at run
 * time, so the routes must name it in outputFileTracingIncludes or their serverless functions ship without it (production then
 * shows "the demonstration data cannot be shown" while `next start` on a developer machine works). CI also checks the build's own
 * trace (scripts/check-runtime-files.mjs); this pins the configuration and the checker itself.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import nextConfig from "../../next.config";
import { REQUIRED, missing } from "../../scripts/check-runtime-files.mjs";

describe("run-time file reads are traced", () => {
  it("next.config names the scenario file for both Observatory routes", () => {
    const inc = (nextConfig as { outputFileTracingIncludes?: Record<string, string[]> }).outputFileTracingIncludes ?? {};
    for (const route of ["/observatory", "/observatory/presenter"]) {
      expect(inc[route], route).toContain("./public/observatory/scenarios.json");
    }
  });

  it("the checker covers the same routes", () => {
    expect(REQUIRED.map((r: { route: string }) => r.route).sort()).toEqual(["app/observatory/page.js.nft.json", "app/observatory/presenter/page.js.nft.json"]);
  });

  it("the checker fails a trace that lacks the file, and passes one that has it", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "nft-"));
    for (const r of REQUIRED as { route: string; file: string }[]) {
      const m = path.join(root, r.route);
      mkdirSync(path.dirname(m), { recursive: true });
      writeFileSync(m, JSON.stringify({ version: 1, files: ["../../../package.json"] }));
    }
    expect(missing(root, REQUIRED)).toHaveLength(REQUIRED.length);
    for (const r of REQUIRED as { route: string; file: string }[]) {
      writeFileSync(path.join(root, r.route), JSON.stringify({ version: 1, files: [`../../../../${r.file}`] }));
    }
    expect(missing(root, REQUIRED)).toEqual([]);
    expect(missing(path.join(root, "nowhere"), REQUIRED)).toHaveLength(REQUIRED.length); // no manifest is a failure, not a pass
  });
});
