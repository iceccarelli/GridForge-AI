import { NextResponse } from "next/server";
import { getWatch, notesFor } from "@/lib/watches";

export const runtime = "nodejs";

// One change note, by its own id, behind the watch's unguessable token.
export async function GET(
  req: Request,
  ctx: { params: Promise<{ token: string; noteId: string }> }
) {
  const { token, noteId } = await ctx.params;
  const w = await getWatch(token);
  if (!w) return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });
  const note = (await notesFor(w.id, 50)).find((n) => n.id === noteId);
  if (!note) return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });

  if (new URL(req.url).searchParams.get("format") === "md") {
    return new NextResponse(note.document_md ?? "", {
      headers: { "Content-Type": "text/markdown; charset=utf-8", "Cache-Control": "no-store" },
    });
  }
  return new NextResponse(note.document_html ?? "", {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}
