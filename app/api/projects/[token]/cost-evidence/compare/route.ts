import { NextResponse } from "next/server";
import { z } from "zod";
import { compareRequestSchema } from "@/lib/ttp-compare";
import { runCompare } from "@/lib/ttp-compare-server";
import { guardRequest } from "@/lib/rate-limit";
import { readBoundedJson } from "@/lib/http-body";
import { fail, withProject } from "@/lib/project-http";
import { acceptedQuotations } from "@/lib/project-quotations";
import { claimsFor } from "@/lib/project-quotation-claims";
import { backingLines } from "@/lib/comparison-evidence";
import { NO_EQUIPMENT_STATEMENT } from "@/lib/cost-evidence-claims";

export const runtime = "nodejs";
export const maxDuration = 60;

// What THIS project's accepted supplier quotations do to a comparison, as the engine answers it. Nothing is saved.
//
// The browser sends the REQUEST it already sent to /api/power/compare. The server reads the lines a named reviewer accepted for this
// project (lib/project-quotations.ts: accepted, this project's, EUR, not synthetic), hands them to the engine as `cost_evidence`, and returns
// the engine's own account: the capex before and after, the ladder steps that moved, and every line it IGNORED with its reason. Quotations that
// are not accepted are never sent to the engine; they come back as `claims` with the state and the reason they are not counted yet.
//
// When the project has no accepted quotation the engine is not asked again (it has nothing new to say): `offered` is 0 and `result` is null.
// The engine spends the platform key, so the request limit runs first and fails closed, exactly as for the comparison itself.
const MAX_BODY_BYTES = 64 * 1024;
const bodySchema = z.object({ compare: compareRequestSchema }).strict();
const NO_STORE = { "Cache-Control": "no-store" };

export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const p = await withProject(ctx);
  if (!p.ok) return p.res;
  const read = await readBoundedJson(req, MAX_BODY_BYTES);
  if (!read.ok) return fail({ status: read.status, error: read.error });
  const parsed = bodySchema.safeParse(read.value);
  if (!parsed.success) {
    return fail({ status: 422, error: "Validation failed", details: parsed.error.issues.map((i) => ({ field: i.path.join("."), problem: i.message })) });
  }

  const got = await acceptedQuotations(p.project);
  if (!got.ok) return fail(got);
  const claims = await claimsFor(p.project);
  // A project with no claims table yet (migration not applied) still answers for engagement quotations; the claims list is then empty, not an error.
  const claimList = claims.ok ? claims.claims : [];
  const base = { statement: NO_EQUIPMENT_STATEMENT, claims: claimList, excluded: got.set.excluded };

  if (got.set.entries.length === 0) {
    return NextResponse.json({ ok: true, offered: 0, applied: [], result: null, ...base }, { headers: NO_STORE });
  }

  const g = await guardRequest(req, "ttp_compare");
  if (g.denied) return g.denied;
  return g.run(async () => {
    const out = await runCompare(parsed.data.compare, got.set.entries);
    if (!out.ok) {
      return NextResponse.json({ ok: false, error: out.error, ...(out.detail ? { detail: out.detail } : {}) }, { status: out.status, headers: NO_STORE });
    }
    return NextResponse.json(
      { ok: true, offered: got.set.entries.length, applied: backingLines(out.result).map((l) => l.evidence_id), result: out.result, ...base },
      { headers: NO_STORE }
    );
  });
}
