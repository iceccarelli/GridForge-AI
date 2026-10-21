import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { ADMIN_COOKIE, verifyAdminCookie } from "@/lib/admin";
import { calibrationExport } from "@/lib/project-observations";
import { fail } from "@/lib/project-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Read-only, admin-only. Returns ONLY observations that cleared every gate: verified by a reviewer who is not the
// submitter, as E5, as a measurement of a known kind, against an evidence artifact that is verified now, with the
// engine digest of the prediction. It imports nothing: save the response and run `gridforge calibrate import <file>`,
// which re-checks every row against the ledger's own policy. With nothing verified the list is empty.
export async function GET() {
  const store = await cookies();
  if (!verifyAdminCookie(store.get(ADMIN_COOKIE)?.value)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  const r = await calibrationExport();
  if (!r.ok) return fail(r);
  return NextResponse.json(
    { ok: true, schema: r.schema, count: r.count, rows: r.rows, reviewer_identity: r.reviewer_identity },
    { headers: { "Cache-Control": "no-store" } }
  );
}
