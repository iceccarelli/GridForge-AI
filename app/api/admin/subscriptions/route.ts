import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { verifyAdminCookie, ADMIN_COOKIE } from "@/lib/admin";
import { subscriptionOverview } from "@/lib/subscribers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET -> how many Intelligence subscription rows exist per plan and status, and when the newest was written. Admin-cookie gated
// like every other /api/admin route. It returns counts only: no address, no Stripe identifier. A store that cannot be read is a 503
// that says so, never an empty list (an empty list would read as "no subscribers").
export async function GET() {
  const store = await cookies();
  if (!verifyAdminCookie(store.get(ADMIN_COOKIE)?.value)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  const overview = await subscriptionOverview();
  if (!overview) {
    return NextResponse.json({ ok: false, error: "Subscription store unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  return NextResponse.json({ ok: true, ...overview }, { headers: { "Cache-Control": "no-store" } });
}
