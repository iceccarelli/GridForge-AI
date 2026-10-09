import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { ADMIN_COOKIE, verifyAdminCookie } from "@/lib/admin";
import { reviewObservation } from "@/lib/project-observations";
import { fail, readJson } from "@/lib/project-http";

export const runtime = "nodejs";

// A person verifies or rejects one observation and states its evidence class. Immutable, once.
// This does NOT add anything to the calibration ledger: a verified observation of class E5 or above
// is what `gridforge calibrate add` accepts, and that stays a deliberate human step.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const store = await cookies();
  if (!verifyAdminCookie(store.get(ADMIN_COOKIE)?.value)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await ctx.params;
  const body = await readJson(req);
  if (!body) return fail({ status: 400, error: "Expected a JSON object." });
  const r = await reviewObservation({
    observation_id: id,
    decision: body.decision,
    evidence_class: body.evidence_class,
    reviewer: body.reviewer,
    reason: body.reason,
  });
  if (!r.ok) return fail(r);
  return NextResponse.json({ ok: true, review: r.review }, { status: 201 });
}
