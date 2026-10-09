import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { ADMIN_COOKIE, verifyAdminCookie } from "@/lib/admin";
import { reviewSupplierActual } from "@/lib/supplier-reality";
import { fail, readJson } from "@/lib/project-http";

export const runtime = "nodejs";

// A person verifies (naming exactly which facts) or rejects (with a reason) one delivery record.
// Immutable, once. Verification does not reach costs, rankings or the calibration ledger.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const store = await cookies();
  if (!verifyAdminCookie(store.get(ADMIN_COOKIE)?.value)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await ctx.params;
  const body = await readJson(req);
  if (!body) return fail({ status: 400, error: "Expected a JSON object." });
  const r = await reviewSupplierActual({
    actual_id: id,
    decision: body.decision,
    verified_fields: body.verified_fields,
    reviewer: body.reviewer,
    reason: body.reason,
  });
  if (!r.ok) return fail(r);
  return NextResponse.json({ ok: true, review: r.review }, { status: 201 });
}
