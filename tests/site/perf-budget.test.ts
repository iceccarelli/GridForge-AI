import fs from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

// Per-route first-load JavaScript budget (transferred kB, 375 px mobile viewport, cold cache, production build).
//
// The baseline is scripts/perf-budget.json: each route's measured value plus 10%. It is a RATCHET: a number goes down when a route gets
// lighter, and goes up only by a deliberate, reviewed edit of that file. The comparison against a live build runs when PERF_BASE_URL
// points at one (`npm run build && npx next start -p 3140`, then
// `PERF_BASE_URL=http://localhost:3140 NODE_PATH=/opt/node-tools/node_modules npx vitest run tests/site/perf-budget.test.ts`).
//
// ON A DEVELOPER MACHINE without PERF_BASE_URL the live comparison is SKIPPED, and this file says so below rather than passing silently.
// IN CI it may not be skipped: when CI is set and PERF_BASE_URL is not, the "is measured in CI" test below FAILS. That is how the
// /pricing overrun got through: the comparison skipped itself everywhere it was not run by hand. The `site` job measures in a dedicated
// step (it starts the production server and sets PERF_BASE_URL); the one earlier step that runs the whole suite (`npm test`, before there
// is a build to measure) says so explicitly with PERF_BUDGET_DEFERRED=1, and tests/test_ops_ci_workflow.py pins both. These are lab
// bytes, not Core Web Vitals.

export type LiveDecision = "run" | "skip" | "fail";

/** What to do about the live comparison, given an environment. Pure, so the CI rule is itself tested. */
export function liveDecision(env: Record<string, string | undefined>): LiveDecision {
  if (env.PERF_BASE_URL) return "run";
  const ci = !!env.CI && env.CI !== "false" && env.CI !== "0";
  if (ci && env.PERF_BUDGET_DEFERRED !== "1") return "fail";
  return "skip";
}

const BASE = process.env.PERF_BASE_URL;
const DECISION = liveDecision(process.env);
const budget = JSON.parse(fs.readFileSync("scripts/perf-budget.json", "utf8")) as { routes: Record<string, number> };

if (DECISION === "skip") {
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

  it("lists exactly the routes scripts/measure-bundles.mjs measures by default", () => {
    // A route measured but unbudgeted (or budgeted but never measured) is a gap the live comparison would only report as a mismatch.
    const src = fs.readFileSync("scripts/measure-bundles.mjs", "utf8");
    const block = /const DEFAULT_ROUTES = \[([\s\S]*?)\];/.exec(src);
    expect(block, "DEFAULT_ROUTES not found in scripts/measure-bundles.mjs").not.toBeNull();
    const measured = [...block![1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect([...measured].sort()).toEqual(Object.keys(budget.routes).sort());
  });

  it("decides the live comparison from the environment: CI may defer it only by saying so, never by omission", () => {
    expect(liveDecision({ PERF_BASE_URL: "http://localhost:3140" })).toBe("run");
    expect(liveDecision({ CI: "true", PERF_BASE_URL: "http://localhost:3140" })).toBe("run");
    expect(liveDecision({})).toBe("skip");
    expect(liveDecision({ CI: "false" })).toBe("skip");
    expect(liveDecision({ CI: "true" })).toBe("fail");
    expect(liveDecision({ CI: "1", PERF_BASE_URL: "" })).toBe("fail");
    expect(liveDecision({ CI: "true", PERF_BUDGET_DEFERRED: "1" })).toBe("skip");
    expect(liveDecision({ CI: "true", PERF_BUDGET_DEFERRED: "yes" })).toBe("fail");
  });

  it("is measured in CI: with CI set and no PERF_BASE_URL this file FAILS instead of skipping", () => {
    if (DECISION === "fail") {
      throw new Error(
        "perf-budget: CI is set but PERF_BASE_URL is not, so the per-route JavaScript budget would not be measured. " +
          "In CI the `site` job's production-server step must set PERF_BASE_URL (see .github/workflows/gridforge.yml). " +
          "A step that runs this file before there is a build to measure must say so with PERF_BUDGET_DEFERRED=1.",
      );
    }
    if (process.env.PERF_GUARD_CHILD) return; // the run below is the child; do not recurse
    // End to end: run this very file the way a CI step with the variable missing would, and require it to fail loudly.
    const env: NodeJS.ProcessEnv = { ...process.env, CI: "true", PERF_GUARD_CHILD: "1" };
    delete env.PERF_BASE_URL;
    delete env.PERF_BUDGET_DEFERRED;
    const r = spawnSync("npx", ["vitest", "run", "tests/site/perf-budget.test.ts"], { encoding: "utf8", env, timeout: 120_000 });
    expect(r.status, `a CI run without PERF_BASE_URL passed:\n${r.stdout}\n${r.stderr}`).not.toBe(0);
    expect(`${r.stdout}\n${r.stderr}`).toContain("PERF_BASE_URL is not, so the per-route JavaScript budget would not be measured");
  }, 130_000);

  it.skipIf(DECISION !== "run")(
    "no route transfers more first-load JavaScript than its budget",
    () => {
      const routes = Object.keys(budget.routes);
      const out = execFileSync("node", ["scripts/measure-bundles.mjs", "--base", BASE!, "--routes", routes.join(",")], {
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        timeout: 540_000,
      });
      const measured = JSON.parse(out).measured as { route: string; status: number; js_kb: number }[];
      expect(measured.map((m) => m.route).sort()).toEqual(routes.sort());
      const over = measured
        .filter((m) => m.js_kb > budget.routes[m.route])
        .map((m) => `${m.route}: ${m.js_kb} kB > budget ${budget.routes[m.route]} kB (over by ${Math.round((m.js_kb - budget.routes[m.route]) * 10) / 10} kB)`);
      expect(over).toEqual([]);
      for (const m of measured) expect(m.status, m.route).toBe(200);
    },
    600_000,
  );
});
