import { hallTimeline, pathId, reply, serveRead } from "@/lib/sites";

export const runtime = "nodejs";

// GET [?limit=1..500][&before=<ISO time>] -> what happened at the hall, newest first: figures recorded, the log of its attached projects, the
// delivery dates suppliers reported and the observations submitted. Every event says what it is and what stands behind it. Read only; no
// project link token, storage location or log payload is in it.
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const raw = (await ctx.params).id;
  const q = new URL(req.url).searchParams;
  const limit = Math.min(500, Math.max(1, Number.parseInt(q.get("limit") ?? "100", 10) || 100));
  const rawBefore = q.get("before");
  return serveRead(req, async (email) => {
    const hall = pathId(raw);
    if (!hall.ok) return hall.response;
    let before: string | null = null;
    if (rawBefore) {
      const t = new Date(rawBefore);
      if (Number.isNaN(t.getTime())) return reply({ ok: false, error: "before must be a time." }, 400);
      before = t.toISOString();
    }
    const r = await hallTimeline(email, hall.id, limit, before);
    return r.ok ? reply({ ok: true, hall: r.value.hall, truncated: r.value.truncated, events: r.value.events }) : r.response;
  });
}
