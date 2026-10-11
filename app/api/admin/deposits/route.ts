import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { ADMIN_COOKIE, verifyAdminCookie } from "@/lib/admin";
import { openDeposits } from "@/lib/deposits";
import { fail } from "@/lib/project-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The operator's work list for the deposits that open no object: oldest payment first,
// delivered ones hidden unless ?state=all.
export async function GET(req: Request) {
  const store = await cookies();
  if (!verifyAdminCookie(store.get(ADMIN_COOKIE)?.value)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  const r = await openDeposits(new URL(req.url).searchParams.get("state") === "all");
  if (!r.ok) return fail(r);
  return NextResponse.json({ ok: true, items: r.items });
}
