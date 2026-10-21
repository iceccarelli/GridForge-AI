import { NextResponse } from "next/server";
import { ownerContext, removeMember } from "@/lib/team";

export const runtime = "nodejs";

// DELETE ?id= -> take a seat back. Billing owner only.
//
// A member is addressed by the id of their seat, which the owner's roster carries. The billing owner has no seat row, so there is
// nothing here that can remove them: their control of the subscription does not depend on this route being careful. The seat is
// released in the same statement that checks it belongs to this owner, and the member's access ends on their next request,
// because every protected route reads the seat from the database rather than trusting a session.
export async function DELETE(req: Request) {
  const ctx = await ownerContext(req);
  if (!ctx.ok) return ctx.response;
  const id = (new URL(req.url).searchParams.get("id") || "").trim();
  const r = await removeMember(ctx.email, id);
  if (!r.ok) return NextResponse.json({ ok: false, error: r.error }, { status: r.status });
  return NextResponse.json({ ok: true });
}
