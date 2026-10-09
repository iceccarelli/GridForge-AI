import { NextResponse } from "next/server";
import { submitSupplierActual } from "@/lib/supplier-reality";
import { fail, readJson, withProject } from "@/lib/project-http";

export const runtime = "nodejs";

// Report what happened after the selected supplier was chosen. The quote is copied by the database from
// the stored selected response, never from this body; every delivery fact may be left out as unknown; a
// correction names the record it supersedes. Nothing here reaches costs, rankings or calibration.
export async function POST(
  req: Request,
  ctx: { params: Promise<{ token: string; package: string }> }
) {
  const p = await withProject(ctx);
  if (!p.ok) return p.res;
  const { package: packageToken } = await ctx.params;
  const body = await readJson(req);
  if (!body) return fail({ status: 400, error: "Expected a JSON object." });
  const r = await submitSupplierActual(p.project, packageToken, body);
  if (!r.ok) return fail(r);
  return NextResponse.json({ ok: true, actual: { id: r.actual.id, supplier: r.actual.supplier, state: "submitted" } }, { status: 201 });
}
