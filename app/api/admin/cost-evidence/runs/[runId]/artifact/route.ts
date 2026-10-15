import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { ADMIN_COOKIE, verifyAdminCookie } from "@/lib/admin";
import { adminRunArtifact } from "@/lib/cost-evidence";
import { ARTIFACT_MEDIA_TYPE } from "@/lib/artifact-store";

export const runtime = "nodejs";

// A run's stored document for an administrator, re-hashed against the recorded digest and length before it is served.
export async function GET(_req: Request, ctx: { params: Promise<{ runId: string }> }) {
  const store = await cookies();
  if (!verifyAdminCookie(store.get(ADMIN_COOKIE)?.value)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  const { runId } = await ctx.params;
  const r = await adminRunArtifact(runId);
  if (!r.ok) return NextResponse.json({ ok: false, error: r.error }, { status: r.status, headers: { "Cache-Control": "private, no-store" } });
  return new Response(new Uint8Array(r.bytes), {
    status: 200,
    headers: {
      "Content-Type": ARTIFACT_MEDIA_TYPE,
      "Content-Length": String(r.bytes.byteLength),
      "Content-Disposition": `attachment; filename="gridforge-evidence-run-${(r.run.run_fingerprint ?? r.run.id).slice(0, 12)}.html"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox; default-src 'none'",
      "X-Artifact-SHA256": r.run.artifact_sha256 ?? "",
    },
  });
}
