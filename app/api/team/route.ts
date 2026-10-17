import { NextResponse } from "next/server";
import { ownerContext, teamOverview } from "@/lib/team";

export const runtime = "nodejs";

// GET -> the billing owner's seats: who holds one, what is pending, and how many remain.
//
// There is no id, email or plan in the request. The owner is the verified bearer token's address, the subscription is the
// one the store holds for it, and a member of somebody else's subscription is refused (403) rather than shown its roster.
export async function GET(req: Request) {
  const ctx = await ownerContext(req);
  if (!ctx.ok) return ctx.response;
  const r = await teamOverview(ctx.email);
  if (!r.ok) return NextResponse.json({ ok: false, error: r.error }, { status: r.status });
  return NextResponse.json({ ok: true, team: r.overview });
}
