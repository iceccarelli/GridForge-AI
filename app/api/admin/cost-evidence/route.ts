import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { ADMIN_COOKIE, verifyAdminCookie } from "@/lib/admin";
import { evidenceQueue } from "@/lib/cost-evidence";
import { fail } from "@/lib/project-http";

export const runtime = "nodejs";

// The administrator's queue of supplier quotation lines. Supplier pricing is confidential: signed-in administrators only.
export async function GET(req: Request) {
  const store = await cookies();
  if (!verifyAdminCookie(store.get(ADMIN_COOKIE)?.value)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  const state = new URL(req.url).searchParams.get("state") === "all" ? "all" : "pending";
  const r = await evidenceQueue(state);
  if (!r.ok) return fail(r);
  return NextResponse.json({ ok: true, items: r.items }, { headers: { "Cache-Control": "no-store" } });
}
