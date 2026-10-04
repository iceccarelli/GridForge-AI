import { NextResponse } from "next/server";
import { submitSupplierResponse } from "@/lib/project-procurement";
import { fail, readJson, withProject } from "@/lib/project-http";

export const runtime = "nodejs";
export const maxDuration = 60;

// One supplier's completed response schedule. Validated by the engine's own
// SupplierResponse parsing before it is stored; never completed on their behalf.
export async function POST(
  req: Request,
  ctx: { params: Promise<{ token: string; package: string }> }
) {
  const p = await withProject(ctx);
  if (!p.ok) return p.res;
  const { package: packageToken } = await ctx.params;
  const body = await readJson(req);
  if (!body) return fail({ status: 400, error: "Expected the response schedule as a JSON object." });
  const r = await submitSupplierResponse(p.project, packageToken, body);
  if (!r.ok) return fail(r);
  return NextResponse.json({ ok: true, response_id: r.response.id, supplier: r.response.supplier }, { status: 201 });
}
