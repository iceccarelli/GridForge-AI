import { NextResponse } from "next/server";
import { getByToken } from "@/lib/deliverables";
import { currentRunFingerprint, runView, runWithEvidence, runsFor } from "@/lib/cost-evidence";
import { fail } from "@/lib/project-http";

export const runtime = "nodejs";
export const maxDuration = 120;

const NO_STORE = { "Cache-Control": "private, no-store" };
const artifactUrl = (token: string, runId: string) => `/api/deliverable/${token}/evidence-run/${runId}/artifact`;

/**
 * This engagement's cost-evidence runs, newest first, from the database — never from a previous POST. Each run says
 * what identity it has, which evidence it was offered and which it used or ignored, what built it, and whether its
 * document is stored (with the digest it will be verified against) or is a legacy run whose document was never kept.
 * Addressed by the engagement's own document token; nothing about another engagement is reachable from here.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const row = await getByToken(token);
  if (!row) return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });
  const runs = await runsFor(row.id);
  if (!runs.ok) return fail(runs);
  const current = await currentRunFingerprint(row);
  return NextResponse.json(
    {
      ok: true,
      current_run_fingerprint: current,
      runs: runs.runs.map((r) => ({
        ...runView(r, current),
        artifact_url: r.artifact_storage_ref ? artifactUrl(token, r.id) : null,
      })),
    },
    { headers: NO_STORE }
  );
}

/**
 * Re-run this engagement's study with the quotations a reviewer has ACCEPTED. A success means the run is recorded and
 * its document is stored privately and verified. The stored deliverable and every earlier run are untouched. Repeating
 * the request for the same inputs returns the SAME recorded run and its original document.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const row = await getByToken(token);
  if (!row) return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });
  const r = await runWithEvidence(row, "customer");
  if (!r.ok) return fail(r);
  const { result } = r;
  return NextResponse.json(
    {
      ok: true,
      created: result.created,
      run: { ...runView(result.run, result.run.run_fingerprint), artifact_url: artifactUrl(token, result.run.id) },
      evidence_ids: result.evidence_ids,
      accepted_evidence_ids: result.accepted_evidence_ids,
      effect: result.effect,
      ignored: result.ignored,
      document_sha256: result.document_sha256,
      document: result.document,
      ...(result.determinism_warning
        ? { warning: "A concurrent request produced a different document for this identity. The persisted one is returned." }
        : {}),
    },
    { status: result.created ? 201 : 200, headers: NO_STORE }
  );
}
