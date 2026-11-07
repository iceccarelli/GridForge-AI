import { CursorQuery, hallTimeline, pathId, reply, serveRead } from "@/lib/sites";

export const runtime = "nodejs";

// GET [?limit=1..500][&cursor=<nextCursor of the previous page, passed back verbatim>] -> what happened at the hall, newest first: figures recorded, the log of its attached projects, the
// delivery dates suppliers reported and the observations submitted. Every event says what it is and what stands behind it. Read only; no
// project link token, storage location or log payload is in it.
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const raw = (await ctx.params).id;
  const q = new URL(req.url).searchParams;
  const limit = Math.min(500, Math.max(1, Number.parseInt(q.get("limit") ?? "100", 10) || 100));
  const rawCursor = q.get("cursor");
  return serveRead(req, async (email) => {
    const hall = pathId(raw);
    if (!hall.ok) return hall.response;
    // The cursor is built by the database and handed back untouched: it is never parsed into a Date here (that would drop microseconds).
    let cursor: string | null = null;
    if (rawCursor !== null) {
      const c = CursorQuery.safeParse(rawCursor);
      if (!c.success) return reply({ ok: false, error: "That page marker is not valid.", reason: "invalid_cursor" }, 400);
      cursor = c.data;
    }
    const r = await hallTimeline(email, hall.id, limit, cursor);
    return r.ok ? reply({ ok: true, hall: r.value.hall, truncated: r.value.truncated, nextCursor: r.value.nextCursor, events: r.value.events }) : r.response;
  });
}
