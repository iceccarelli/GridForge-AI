/**
 * Every site test that runs the REAL Python engine must be unable to skip silently where the engine is required.
 *
 * A `describe.runIf(hasPython)` / `it.runIf(hasPython)` suite is skipped when python3 is missing. That is right on a laptop and wrong in CI: a green
 * run that quietly skipped every real-engine test proves nothing about the engine. tests/site/_engine-guard.ts is the fix (a test that FAILS when
 * GRIDFORGE_REQUIRE_ENGINE=1 or CI=true and python3 is missing); a file that uses python3 must import it.
 *
 * KNOWN_UNGUARDED is the list of files that predate this rule and still skip silently. It may only SHRINK: a new file that spawns python3 without
 * the guard fails here, and a file on the list that gains the guard must be removed from it. Each belongs to a stream other than the one that
 * introduced this test, and is named so it can be fixed there.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const DIR = __dirname;
const USES_ENGINE = /spawn(?:Sync)?\(\s*["']python3["']|\bhasPython\b/;
const GUARDED = /from\s+["']\.\/_engine-guard["']/;

const KNOWN_UNGUARDED: readonly string[] = [
  "api-readiness.test.ts",
  "buyer-history.test.ts",
  "buyer-page.test.ts",
  "delivery-handoff.test.ts",
  "delivery-lifecycle.test.ts",
  "money-path-truth.test.ts",
  "study-board-pack.test.ts",
  "subscription-lifecycle.test.ts",
  "ttp-quotation-backed.test.ts",
  "verified-power-record.test.ts",
];

// *.realdb.test.ts are the real-database journeys: they have their own switch (GF_REQUIRE_REALDB=1 fails a missing stack, python3 included).
const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".test.ts") && !f.endsWith(".realdb.test.ts") && f !== path.basename(__filename));
const engineFiles = files.filter((f) => USES_ENGINE.test(fs.readFileSync(path.join(DIR, f), "utf8")));
const unguarded = engineFiles.filter((f) => !GUARDED.test(fs.readFileSync(path.join(DIR, f), "utf8")));

describe("real-engine tests are guarded against silent skips", () => {
  it("finds the real-engine test files (the scan itself works)", () => {
    expect(engineFiles.length).toBeGreaterThan(10);
    expect(engineFiles).toContain("evidence-ladder.test.ts");
  });

  it("no real-engine test file outside the known list lacks the guard", () => {
    expect(unguarded.filter((f) => !KNOWN_UNGUARDED.includes(f)), "import { engineAvailable } from './_engine-guard' and assert it, as evidence-ladder.test.ts does").toEqual([]);
  });

  it("the known list only shrinks: every entry is still unguarded (remove a file from KNOWN_UNGUARDED once it gains the guard)", () => {
    expect(KNOWN_UNGUARDED.filter((f) => !unguarded.includes(f))).toEqual([]);
  });

  it("the files this change owns are guarded", () => {
    for (const f of ["ttp-compare.test.ts", "adversarial-compare-route.test.ts", "existing-flow-intake.test.ts", "existing-non-it-heat-intake.test.ts", "honest-intake-defaults.test.ts", "qualify-presets.test.ts", "hall-presets.test.ts", "evidence-ladder.test.ts"]) {
      expect(engineFiles, f).toContain(f);
      expect(unguarded, f).not.toContain(f);
    }
  });
});
