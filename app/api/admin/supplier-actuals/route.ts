import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { ADMIN_COOKIE, verifyAdminCookie } from "@/lib/admin";
import { supplierActualQueue } from "@/lib/supplier-reality";
import { fail } from "@/lib/project-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The review queue: delivery records awaiting a human decision (?state=all for every one).
export async function GET(req: Request) {
  const store = await cookies();
  if (!verifyAdminCookie(store.get(ADMIN_COOKIE)?.value)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  const state = new URL(req.url).searchParams.get("state") === "all" ? "all" : "pending";
  const r = await supplierActualQueue(state);
  if (!r.ok) return fail(r);
  return NextResponse.json({ ok: true, items: r.items });
}
