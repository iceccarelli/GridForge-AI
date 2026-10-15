import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { ADMIN_COOKIE, verifyAdminCookie } from "@/lib/admin";
import { reviewEvidence } from "@/lib/cost-evidence";
import { fail, readJson } from "@/lib/project-http";

export const runtime = "nodejs";

// A person accepts or rejects one validated quotation line, stating what kind of quotation it is. Immutable, once.
// Accepting a newer line for the same cost key retires the older accepted one in the same transaction.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const store = await cookies();
  if (!verifyAdminCookie(store.get(ADMIN_COOKIE)?.value)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await ctx.params;
  const body = await readJson(req);
  if (!body) return fail({ status: 400, error: "Expected a JSON object." });
  const r = await reviewEvidence({ ...body, evidence_id: id });
  if (!r.ok) return fail(r);
  return NextResponse.json({ ok: true, review: r.review, superseded: r.superseded }, { status: 201 });
}
