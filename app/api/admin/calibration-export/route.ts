import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { ADMIN_COOKIE, verifyAdminCookie } from "@/lib/admin";
import { calibrationExport } from "@/lib/project-observations";
import { fail } from "@/lib/project-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Read-only, admin-only. Returns ONLY the rows calibration_ledger_rows returns (the single gate the importer trusts): verified by a
// reviewer who is not the submitter, as E5, as a measurement of a known kind, against a file with a verified decision on record
// (0048), a forecast that was frozen and made before the outcome and that still holds the predicted value (0046), a production
// data origin and a project whose latest permission is a grant (0047). It imports nothing: save the response and run
// `gridforge calibrate import <file>`, which re-checks every row against the ledger's own policy. With nothing eligible the list is empty.
//
// What this does NOT give you, exactly: the gate is evaluated when the export is read. Permission revoked later stops FUTURE exports only:
// it does not recall a row already imported (the ledger keeps no link back to the permission, and the import marks it published).
// There is no withdrawal of a mistaken verdict: a file or observation decision is recorded once and is final. Reviewer names are
// self-typed under one shared password, and the permission record is an assertion of a document the system never opens.
//
// `tombstones` (additive) is the list of observations withdrawn together with their organisation's consent (0056), each as the sha256 of its id and
// nothing more. When an operator imports this export, `gridforge calibrate import` RECORDS them in a side file beside the private ledger; from then on the
// ledger leaves those observations out of every read and the importer refuses an export that contains one. That happens only when someone runs the import
// (or `gridforge calibrate withdraw <hash>`): the importer reads no network, so the ledger keeps counting what it holds until then, and an export saved
// before a withdrawal is refused only once its tombstones were recorded. The list is read in full or the export fails (a truncated list would let one
// return); on a database where 0056 is not applied there is no such table, no withdrawal, and the list is empty.
export async function GET() {
  const store = await cookies();
  if (!(await verifyAdminCookie(store.get(ADMIN_COOKIE)?.value))) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  const r = await calibrationExport();
  if (!r.ok) return fail(r);
  return NextResponse.json(
    { ok: true, schema: r.schema, count: r.count, rows: r.rows, tombstones: r.tombstones, reviewer_identity: r.reviewer_identity },
    { headers: { "Cache-Control": "no-store" } }
  );
}
