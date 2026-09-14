import { NextResponse } from "next/server";
import { constraintBySlug, constraintReference } from "@/lib/constraints";

export const dynamic = "force-static";

/**
 * The constraint reference as data.
 *
 * A crawler scraping rendered HTML gets our prose and loses the evidence class, the
 * lead time and the arithmetic. This hands over the structure instead. Same file
 * the pages render from, so the two cannot disagree.
 *
 * ?slug= returns one constraint; without it, all of them.
 */
export async function GET(req: Request) {
  const slug = new URL(req.url).searchParams.get("slug");
  if (slug) {
    const c = await constraintBySlug(slug);
    if (!c) {
      const ref = await constraintReference();
      return NextResponse.json(
        { error: "unknown constraint", available: (ref?.constraints ?? []).map((x) => x.slug) },
        { status: 404 }
      );
    }
    return NextResponse.json(c, {
      headers: { "Cache-Control": "public, max-age=3600, s-maxage=86400" },
    });
  }
  const ref = await constraintReference();
  if (!ref) return NextResponse.json({ error: "not built" }, { status: 503 });
  return NextResponse.json(ref, {
    headers: { "Cache-Control": "public, max-age=3600, s-maxage=86400" },
  });
}
