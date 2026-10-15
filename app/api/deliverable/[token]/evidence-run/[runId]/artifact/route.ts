import { NextResponse } from "next/server";
import { getByToken } from "@/lib/deliverables";
import { runArtifact } from "@/lib/cost-evidence";
import { ARTIFACT_MEDIA_TYPE } from "@/lib/artifact-store";

export const runtime = "nodejs";

/**
 * The exact document of one cost-evidence run, as stored.
 *
 * Authorised by the engagement's document token; the run is looked up UNDER the engagement that token resolves, so a
 * run id from another engagement (or a guessed one) is indistinguishable from no run at all. The bytes are read from
 * private storage and re-hashed against the digest and length on the run's record; if they do not match, nothing is
 * served. A download, not an inline page: this is a generated HTML file, not part of the site.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ token: string; runId: string }> }) {
  const { token, runId } = await ctx.params;
  const row = await getByToken(token);
  if (!row) return NextResponse.json({ ok: false, error: "Not found" }, { status: 404, headers: { "Cache-Control": "private, no-store" } });
  const r = await runArtifact(row, runId);
  if (!r.ok) {
    return NextResponse.json({ ok: false, error: r.error }, { status: r.status, headers: { "Cache-Control": "private, no-store" } });
  }
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
