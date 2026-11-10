import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { z } from "zod";
import { ADMIN_COOKIE, verifyAdminCookie, refuseCrossSiteWrite } from "@/lib/admin";
import { recordCalibrationPermission } from "@/lib/calibration-permissions";
import { fail, readJson } from "@/lib/project-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// An administrator records that the owner of a project granted, or withdrew, permission for its measurements to feed the shared
// calibration ledger. Append-only: a revocation is a new row.
//
// This is an ASSERTION-ONLY record. The system never holds, opens or verifies the signed document: the digest is whatever the
// administrator typed (only an obvious placeholder, 64 identical characters, is refused). The e-mail address is the owner's as typed and is
// not authenticated, and the administrator who records it is not identified: the admin console has one shared password. Revoking stops
// FUTURE exports only; rows already imported by `gridforge calibrate import` are not recalled.
const PERMISSION_NOTICE =
  "Recorded as an assertion: the system does not verify the document digest and the administrator is not identified (one shared admin password). " +
  "Revoking stops future exports only; rows already imported are not recalled.";

const body = z
  .object({
    project_id: z.string().uuid(),
    kind: z.enum(["granted", "revoked"]),
    granted_by_email: z.string().trim().toLowerCase().email().max(254),
    // Lower-case hex, 64 characters: the digest of the document, computed by whoever holds it.
    document_sha256: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[0-9a-f]{64}$/, "document_sha256 must be 64 hexadecimal characters")
      .refine((v) => !/^(.)\1{63}$/.test(v), "document_sha256 must be the digest of a document, not a repeated character"),
    note: z.string().trim().max(1000).optional(),
  })
  .strict();

export async function POST(req: Request) {
  const xs = refuseCrossSiteWrite(req);
  if (xs) return xs;
  const store = await cookies();
  if (!(await verifyAdminCookie(store.get(ADMIN_COOKIE)?.value))) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  const raw = await readJson(req);
  if (!raw) return fail({ status: 400, error: "Expected a JSON object." });
  const parsed = body.safeParse(raw);
  if (!parsed.success) {
    // Which fields were wrong, never the values.
    return fail({ status: 422, error: "The permission was refused.", details: parsed.error.issues.map((i) => ({ field: i.path.join("."), problem: i.message })) });
  }
  const r = await recordCalibrationPermission(parsed.data);
  if (!r.ok) return fail(r);
  return NextResponse.json({ ok: true, permission: r.permission, notice: PERMISSION_NOTICE }, { status: 201, headers: { "Cache-Control": "no-store" } });
}
