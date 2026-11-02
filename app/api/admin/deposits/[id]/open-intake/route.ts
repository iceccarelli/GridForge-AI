import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { ADMIN_COOKIE, verifyAdminCookie } from "@/lib/admin";
import { openDepositIntake } from "@/lib/deposits";
import { fail } from "@/lib/project-http";

export const runtime = "nodejs";

// Open the intake for a SCOPED Envelope Study or Portfolio Screen deposit: one engagement, linked to the deposit, and the buyer's private
// intake link emailed. Repeating the call never opens a second one; it re-ensures the email. The deposit becomes `delivered` by itself when the
// study is released (app/api/admin/deliverables), with the engagement as its delivery reference.
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const store = await cookies();
  if (!verifyAdminCookie(store.get(ADMIN_COOKIE)?.value)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await ctx.params;
  const r = await openDepositIntake(id);
  if (!r.ok) return fail(r);
  return NextResponse.json({ ok: true, deliverable_id: r.deliverable_id, created: r.created, intake_email: r.emailed });
}
