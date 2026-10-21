import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { verifyAdminCookie, ADMIN_COOKIE } from "@/lib/admin";
import { MONTH, utcMonth } from "@/lib/payg";
import { economicsReport, engineEconomicsFetcher } from "@/lib/payg-analytics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET ?month=YYYY-MM (default: this UTC month) -> pay-as-you-go revenue beside the engine's MEASURED compute, and what is not in
// either. No margin is claimed: compute is wall-clock time, not money, and fixed infrastructure, Stripe fees and LLM cost are not
// included; the response says so in `margin`, `not_included` and `unknown`. If the engine cannot answer, the compute half says why
// rather than being guessed. Admin-only.
export async function GET(req: Request) {
  const store = await cookies();
  if (!verifyAdminCookie(store.get(ADMIN_COOKIE)?.value)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401, headers: { "Cache-Control": "no-store" } });
  }
  const raw = new URL(req.url).searchParams.get("month");
  const month = raw === null || raw === "" ? utcMonth(new Date()) : raw;
  if (!MONTH.test(month)) return NextResponse.json({ ok: false, error: "month must be YYYY-MM" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  const report = await economicsReport(month, engineEconomicsFetcher());
  if (!report.ok) return NextResponse.json(report, { status: 503, headers: { "Cache-Control": "no-store" } });
  return NextResponse.json(report, { headers: { "Cache-Control": "no-store" } });
}
