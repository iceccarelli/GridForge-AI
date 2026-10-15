import { NextResponse } from "next/server";
import { getByToken } from "@/lib/deliverables";
import { runWithEvidence } from "@/lib/cost-evidence";
import { fail } from "@/lib/project-http";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * Re-run this engagement's study with the quotations a reviewer has ACCEPTED. The document names the evidence it
 * used and what each line changed; the stored deliverable and every earlier run are untouched. Retrying with the
 * same accepted set returns the same recorded run.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const row = await getByToken(token);
  if (!row) return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });
  const r = await runWithEvidence(row, "customer");
  if (!r.ok) return fail(r);
  return NextResponse.json(
    {
      ok: true,
      created: r.result.created,
      evidence_ids: r.result.evidence_ids,
      effect: r.result.effect,
      ignored: r.result.ignored,
      document_sha256: r.result.document_sha256,
      document: r.result.document,
    },
    { status: r.result.created ? 201 : 200, headers: { "Cache-Control": "no-store" } }
  );
}
