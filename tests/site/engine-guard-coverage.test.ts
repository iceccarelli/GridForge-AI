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
// A file that runs python3 through execFile/exec AND can skip a test on the result (it.skipIf / it.runIf) skips silently when the engine is missing:
// payg-hardening.test.ts read the engine's billing rule that way and `it.skipIf(engineText === null)` quietly dropped the check. A bare execFileSync
// with no skip throws when python3 is missing, which is loud, so it is not a silent-skip risk and is not flagged.
const EXEC_PYTHON = /exec(?:File)?(?:Sync)?\(\s*["']python3?["']/;
const CAN_SKIP = /\.(?:skipIf|runIf)\(/;
const usesEngineSilently = (src: string) => USES_ENGINE.test(src) || (EXEC_PYTHON.test(src) && CAN_SKIP.test(src));
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
const engineFiles = files.filter((f) => usesEngineSilently(fs.readFileSync(path.join(DIR, f), "utf8")));
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

  it("the scan sees the exec-and-skip pattern (the hole that hid payg-hardening.test.ts) and ignores a bare exec that throws when python3 is missing", () => {
    expect(usesEngineSilently('execFileSync("python3", ["-c", "x"]); it.skipIf(engineText === null)("x", () => {})')).toBe(true);
    expect(usesEngineSilently('execSync("python3 -c x"); it.runIf(ok)("x", () => {})')).toBe(false);          // a shell string is not matched: add the form if it appears
    expect(usesEngineSilently('execFileSync("python3", ["-I", "-c", code])')).toBe(false);
    expect(usesEngineSilently("spawnSync('python3', ['--version'])")).toBe(true);
    expect(engineFiles).toContain("payg-hardening.test.ts");
  });

  it("the files this change owns are guarded", () => {
    for (const f of ["payg-hardening.test.ts", "ttp-compare.test.ts", "adversarial-compare-route.test.ts", "existing-flow-intake.test.ts", "existing-non-it-heat-intake.test.ts", "honest-intake-defaults.test.ts", "qualify-presets.test.ts", "hall-presets.test.ts", "evidence-ladder.test.ts"]) {
      expect(engineFiles, f).toContain(f);
      expect(unguarded, f).not.toContain(f);
    }
  });
});
