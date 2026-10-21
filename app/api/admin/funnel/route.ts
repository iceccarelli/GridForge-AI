import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { verifyAdminCookie, ADMIN_COOKIE } from "@/lib/admin";
import { funnelReport } from "@/lib/payg-analytics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET ?days=30 -> the adoption funnel, measured: step counts, denominators and conversion rates (null, never 0%, when there is
// nothing to divide by), each step labelled as measured from events or derived from another record, and an `unmeasured` list naming what
// this site cannot see. Admin-only, like every route under /api/admin. Accounts appear only as anonymous references; no event or
// response here can carry an email, a token, a site input or free text.
export async function GET(req: Request) {
  const store = await cookies();
  if (!verifyAdminCookie(store.get(ADMIN_COOKIE)?.value)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401, headers: { "Cache-Control": "no-store" } });
  }
  const raw = new URL(req.url).searchParams.get("days");
  const days = raw === null ? 30 : Number(raw);
  if (!Number.isInteger(days) || days < 1 || days > 365) {
    return NextResponse.json({ ok: false, error: "days must be a whole number from 1 to 365" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
  const report = await funnelReport(days);
  if (!report.ok) return NextResponse.json(report, { status: 503, headers: { "Cache-Control": "no-store" } });
  return NextResponse.json(report, { headers: { "Cache-Control": "no-store" } });
}
