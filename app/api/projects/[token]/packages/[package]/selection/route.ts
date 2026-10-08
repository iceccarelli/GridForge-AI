import { NextResponse } from "next/server";
import { selectSupplier } from "@/lib/project-procurement";
import { fail, readJson, withProject } from "@/lib/project-http";

export const runtime = "nodejs";

// A person selects a supplier. Selection is a business decision recorded beside the
// comparison, never written into it.
export async function POST(
  req: Request,
  ctx: { params: Promise<{ token: string; package: string }> }
) {
  const p = await withProject(ctx);
  if (!p.ok) return p.res;
  const { package: packageToken } = await ctx.params;
  const body = await readJson(req);
  if (!body) return fail({ status: 400, error: "Expected { supplier, actor }." });
  const r = await selectSupplier(p.project, packageToken, { supplier: body.supplier, actor: body.actor });
  if (!r.ok) return fail(r);
  return NextResponse.json({
    ok: true,
    supplier: r.package.selected_supplier,
    rank_at_selection: r.rank_at_selection,
  });
}
