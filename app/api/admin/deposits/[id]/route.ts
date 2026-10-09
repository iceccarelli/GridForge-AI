import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { ADMIN_COOKIE, verifyAdminCookie } from "@/lib/admin";
import { advanceDeposit } from "@/lib/deposits";
import { fail, readJson } from "@/lib/project-http";

export const runtime = "nodejs";

// Move a paid deposit forward exactly one step. paid -> contacted needs `owner`; contacted -> scoped
// needs `scope_note`; scoped -> delivered needs `delivery_ref`. Steps are never skipped or reversed.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const store = await cookies();
  if (!verifyAdminCookie(store.get(ADMIN_COOKIE)?.value)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await ctx.params;
  const body = await readJson(req);
  if (!body) return fail({ status: 400, error: "Expected a JSON object." });
  const r = await advanceDeposit(id, body);
  if (!r.ok) return fail(r);
  return NextResponse.json({ ok: true, deposit: r.deposit });
}
