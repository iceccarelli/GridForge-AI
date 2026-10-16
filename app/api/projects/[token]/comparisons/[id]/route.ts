import { NextResponse } from "next/server";
import { getComparison } from "@/lib/project-comparisons";
import { fail, withProject } from "@/lib/project-http";

export const runtime = "nodejs";

// One saved comparison, exactly as stored: the request, the engine's answer and its provenance. Read-only; nothing is
// recomputed. Reached only with this project's token, and only for a record that belongs to this project.
export async function GET(_req: Request, ctx: { params: Promise<{ token: string; id: string }> }) {
  const p = await withProject(ctx);
  if (!p.ok) return p.res;
  const { id } = await ctx.params;
  const r = await getComparison(p.project, id);
  if (!r.ok) return fail(r);
  return NextResponse.json({ ok: true, comparison: r.comparison }, { headers: { "Cache-Control": "no-store" } });
}
