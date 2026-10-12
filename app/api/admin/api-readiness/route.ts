import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { ADMIN_COOKIE, verifyAdminCookie } from "@/lib/admin";
import { apiSalesReadiness, resetApiReadinessCache } from "@/lib/api-readiness";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Operator-only: can this deployment honestly sell an API plan right now? A fresh probe against the
// engine (never cached), answered as a category. No secret, fingerprint or key is ever returned.
export async function GET() {
  const store = await cookies();
  if (!verifyAdminCookie(store.get(ADMIN_COOKIE)?.value)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  resetApiReadinessCache();
  const r = await apiSalesReadiness();
  return NextResponse.json({ ok: true, ready: r.ready, category: r.category, checked_at: r.checkedAt });
}
