// Server-only half of the Time-to-Power comparison: the one function that asks the engine.
// Kept apart from lib/ttp-compare.ts because that file is imported by the browser component.

import { callEngine } from "@/lib/power-deploy";
import { TTP_COMPARE_SCHEMA, toEngineBody, type CompareRequest, type CompareResult } from "@/lib/ttp-compare";

export type CompareOutcome =
  | { ok: true; result: CompareResult; engineBody: Record<string, unknown> }
  | { ok: false; status: number; error: string; detail?: Record<string, unknown> };

/**
 * Ask the engine. A request the engine cannot answer without inventing something comes back as its own 422, with the
 * message that says what to supply; that is passed through because the person can act on it. Anything else (engine
 * unconfigured, unreachable, refusing our key) is ours to fix, so it is logged and reported without internal detail.
 */
export async function runCompare(r: CompareRequest): Promise<CompareOutcome> {
  const engineBody = toEngineBody(r);
  const out = await callEngine("/v1/compare", engineBody);
  if (out.ok) {
    if (out.body.schema !== TTP_COMPARE_SCHEMA) {
      console.error("[GridForge] compare: the engine answered with an unexpected schema version");
      return { ok: false, status: 502, error: "The comparison service answered in a form this site does not understand." };
    }
    return { ok: true, result: out.body as unknown as CompareResult, engineBody };
  }
  if (out.status === 422) {
    const { error: _e, schema_version: _s, ...detail } = out.body as Record<string, unknown>;
    return { ok: false, status: 422, error: out.error, detail };
  }
  console.error("[GridForge] compare failed:", out.status, out.error);
  return {
    ok: false,
    status: 502,
    error: "The comparison service is temporarily unavailable, so no result was produced. Nothing was saved.",
  };
}
