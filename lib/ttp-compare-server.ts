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
export async function runCompare(r: CompareRequest, costEvidence?: Record<string, unknown>[]): Promise<CompareOutcome> {
  const engineBody = toEngineBody(r, costEvidence);
  const out = await callEngine("/v1/compare", engineBody);
  if (out.ok) {
    if (out.body.schema !== TTP_COMPARE_SCHEMA) {
      console.error("[GridForge] compare: the engine answered with an unexpected schema version");
      return { ok: false, status: 502, error: "The comparison service answered in a form this site does not understand." };
    }
    const result = out.body as unknown as CompareResult;
    if (costEvidence?.length) {
      // The answer must account for every line it was handed, and only those: an engine that does not (an older build)
      // would otherwise return a library-priced comparison that the caller then stores as quotation-backed.
      const offered = new Set(costEvidence.map((e) => String(e.evidence_id)));
      const block = result.cost_evidence;
      const seen = block ? [...block.used.map((u) => String(u.evidence_id)), ...block.ignored.map((i) => String(i.evidence_id))] : [];
      if (!block || !block.effect || seen.some((id) => !offered.has(id)) || [...offered].some((id) => !seen.includes(id))) {
        console.error("[GridForge] compare: the engine did not account for the quotations it was given");
        return { ok: false, status: 502, error: "The comparison service did not report how it used the quotations, so no result was produced. Nothing was saved." };
      }
    }
    return { ok: true, result, engineBody };
  }
  if (out.status === 422) {
    const { error: _e, schema_version: _s, ...detail } = out.body as Record<string, unknown>;
    return { ok: false, status: 422, error: out.error, detail };
  }
  if (out.routeMissing) {
    return {
      ok: false,
      status: 503,
      error: "The scenario comparison is not available yet: the engine release that serves it has not been deployed. Nothing was calculated, saved or charged.",
    };
  }
  console.error("[GridForge] compare failed:", out.status, out.error);
  return {
    ok: false,
    status: 502,
    error: "The comparison service is temporarily unavailable, so no result was produced. Nothing was saved.",
  };
}
