import { NextResponse } from "next/server";
import { getPackage } from "@/lib/project-procurement";
import { fail, withProject } from "@/lib/project-http";

export const runtime = "nodejs";

// The package itself. `?format=md|html` returns the tender document to send suppliers;
// otherwise the summary and the response template each supplier fills in.
export async function GET(
  req: Request,
  ctx: { params: Promise<{ token: string; package: string }> }
) {
  const p = await withProject(ctx);
  if (!p.ok) return p.res;
  const { package: packageToken } = await ctx.params;
  const r = await getPackage(p.project, packageToken);
  if (!r.ok) return fail(r);
  const format = new URL(req.url).searchParams.get("format");
  if (format === "md") {
    return new Response(r.pkg.document_md, { headers: { "content-type": "text/markdown; charset=utf-8" } });
  }
  if (format === "html") {
    return new Response(r.pkg.document_html, { headers: { "content-type": "text/html; charset=utf-8" } });
  }
  const { document_md: _m, document_html: _h, ...summary } = r.pkg;
  void _m;
  void _h;
  return NextResponse.json({ ok: true, package: summary });
}
