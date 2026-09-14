import { NextResponse } from "next/server";
import { getByToken } from "@/lib/deliverables";

export const runtime = "nodejs";

// Read a released deliverable. A draft is never served: generation is automated,
// release is a human act.
export async function GET(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const row = await getByToken(token);
  if (!row) return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });

  if (row.status !== "released") {
    return NextResponse.json(
      {
        ok: false,
        status: row.status,
        error:
          row.status === "awaiting_intake"
            ? "This engagement is waiting on the hall's numbers."
            : "The document is with a senior engineer for review. You will be told when it is released.",
      },
      { status: 409 }
    );
  }

  const format = new URL(req.url).searchParams.get("format");
  if (format === "deck") {
    if (!row.deck_html) {
      return NextResponse.json(
        { ok: false, error: "No walkthrough deck was produced for this engagement." },
        { status: 404 }
      );
    }
    return new NextResponse(row.deck_html, {
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    });
  }
  if (format === "md") {
    return new NextResponse(row.document_md ?? "", {
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition": `attachment; filename="${(row.title ?? "deliverable").replace(/[^a-z0-9]+/gi, "_")}.md"`,
        "Cache-Control": "no-store",
      },
    });
  }
  return NextResponse.json({
    ok: true,
    title: row.title,
    html: row.document_html,
    released_at: row.released_at,
  });
}
