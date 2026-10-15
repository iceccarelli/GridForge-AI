import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { ADMIN_COOKIE, verifyAdminCookie } from "@/lib/admin";
import { adminRuns } from "@/lib/cost-evidence";
import { fail } from "@/lib/project-http";

export const runtime = "nodejs";

// The administrator's audit of cost-evidence runs: identity, provenance and document integrity per run. No storage
// reference is returned; a document is fetched through the verified artifact route.
export async function GET() {
  const store = await cookies();
  if (!verifyAdminCookie(store.get(ADMIN_COOKIE)?.value)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  const r = await adminRuns();
  if (!r.ok) return fail(r);
  return NextResponse.json(
    {
      ok: true,
      runs: r.runs.map((x) => ({
        id: x.id,
        deliverable_id: x.deliverable_id,
        project_id: x.project_id,
        created_at: x.created_at,
        legacy: x.legacy,
        run_fingerprint: x.run_fingerprint,
        accepted_snapshot_digest: x.accepted_snapshot_digest,
        accepted_evidence_ids: x.accepted_evidence_ids,
        used_evidence_ids: x.evidence_ids,
        ignored: x.ignored,
        engine_fingerprint: x.engine_fingerprint,
        engine_version: x.engine_provenance?.engine_version ?? null,
        report_date: x.report_date,
        artifact_sha256: x.artifact_sha256,
        artifact_bytes: x.artifact_bytes === null ? null : Number(x.artifact_bytes),
        artifact: x.legacy || !x.artifact_storage_ref ? "legacy_unavailable" : "stored",
      })),
    },
    { headers: { "Cache-Control": "private, no-store" } }
  );
}
