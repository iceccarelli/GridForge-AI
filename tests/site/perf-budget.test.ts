import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

// Per-route first-load JavaScript budget (transferred kB, 375 px mobile viewport, cold cache, production build).
//
// The baseline is scripts/perf-budget.json: each route's measured value plus 10%. The comparison against a live build runs only when
// PERF_BASE_URL points at one (`npm run build && npx next start -p 3140`, then
// `PERF_BASE_URL=http://localhost:3140 NODE_PATH=/opt/node-tools/node_modules npx vitest run tests/site/perf-budget.test.ts`).
// Without it the live comparison is SKIPPED, and this file says so below rather than passing silently. These are lab bytes,
// not Core Web Vitals.

const BASE = process.env.PERF_BASE_URL;
const budget = JSON.parse(fs.readFileSync("scripts/perf-budget.json", "utf8")) as { routes: Record<string, number> };

if (!BASE) {
  console.info("perf-budget: PERF_BASE_URL is not set, so the per-route JavaScript budget is NOT being measured in this run (skipped).");
}

describe("the committed per-route JavaScript budget", () => {
  it("is well formed and covers the heaviest public routes", () => {
    for (const r of ["/", "/workspace", "/intelligence", "/dashboard", "/pricing", "/qualify", "/developers"]) {
      expect(budget.routes[r], r).toBeGreaterThan(0);
    }
    for (const [route, kb] of Object.entries(budget.routes)) {
      expect(route.startsWith("/"), route).toBe(true);
      expect(Number.isFinite(kb) && kb > 0, route).toBe(true);
    }
  });

  it.skipIf(!BASE)(
    "no route transfers more first-load JavaScript than its budget",
    () => {
      const routes = Object.keys(budget.routes);
      const out = execFileSync("node", ["scripts/measure-bundles.mjs", "--base", BASE!, "--routes", routes.join(",")], {
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        timeout: 280_000,
      });
      const measured = JSON.parse(out).measured as { route: string; status: number; js_kb: number }[];
      expect(measured.map((m) => m.route).sort()).toEqual(routes.sort());
      const over = measured
        .filter((m) => m.js_kb > budget.routes[m.route])
        .map((m) => `${m.route}: ${m.js_kb} kB > budget ${budget.routes[m.route]} kB`);
      expect(over).toEqual([]);
      for (const m of measured) expect(m.status, m.route).toBe(200);
    },
    300_000,
  );
});
