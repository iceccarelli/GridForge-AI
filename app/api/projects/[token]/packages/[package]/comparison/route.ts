import { NextResponse } from "next/server";
import { runPackageComparison } from "@/lib/project-procurement";
import { fail, withProject } from "@/lib/project-http";

export const runtime = "nodejs";
export const maxDuration = 60;

// Compare every stored response with the existing engine comparison and persist the
// result. Each run is a new immutable record; earlier ones are kept.
export async function POST(
  _req: Request,
  ctx: { params: Promise<{ token: string; package: string }> }
) {
  const p = await withProject(ctx);
  if (!p.ok) return p.res;
  const { package: packageToken } = await ctx.params;
  const r = await runPackageComparison(p.project, packageToken);
  if (!r.ok) return fail(r);
  return NextResponse.json({ ok: true, comparison_id: r.comparison.id, result: r.comparison.result }, { status: 201 });
}
