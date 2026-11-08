/**
 * The suites that run the REAL Python engine use `describe.runIf(hasPython)` so a laptop without Python still runs the rest. CI must not
 * get that silence: when GRIDFORGE_REQUIRE_ENGINE=1 or CI=true, a missing python3 FAILS (see `engineGuard`), instead of skipping them.
 */
export const engineRequired = (): boolean => process.env.GRIDFORGE_REQUIRE_ENGINE === "1" || process.env.CI === "true";

export function engineAvailable(hasPython: boolean, required: boolean = engineRequired()): { ok: boolean; reason: string } {
  if (hasPython) return { ok: true, reason: "python3 is available" };
  return required
    ? { ok: false, reason: "python3 is missing but GRIDFORGE_REQUIRE_ENGINE=1 or CI=true says the real-engine suites must run: they would otherwise be skipped silently" }
    : { ok: true, reason: "python3 is missing and not required here: the real-engine suites are skipped" };
}
