import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { ADMIN_COOKIE, verifyAdminCookie } from "@/lib/admin";
import { withdrawEvidence } from "@/lib/cost-evidence";
import { fail, readJson } from "@/lib/project-http";

export const runtime = "nodejs";

// Withdraw an ACCEPTED quotation (the supplier retracted it, or it was found wrong). It stops influencing any
// new run at once; runs already recorded keep naming it, because they were true when they ran.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const store = await cookies();
  if (!verifyAdminCookie(store.get(ADMIN_COOKIE)?.value)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await ctx.params;
  const body = await readJson(req);
  if (!body) return fail({ status: 400, error: "Expected a JSON object." });
  const r = await withdrawEvidence({ ...body, evidence_id: id });
  if (!r.ok) return fail(r);
  return NextResponse.json({ ok: true, id: r.id }, { status: 201 });
}
