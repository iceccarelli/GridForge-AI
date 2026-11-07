import { HallBody, createHall, listHalls, pathId, reply, serveRead, serveWrite } from "@/lib/sites";

export const runtime = "nodejs";

// GET -> the site and its halls (any member of the site's organisation). POST { label } -> an editor or owner adds a hall.
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const raw = (await ctx.params).id;
  return serveRead(req, async (email) => {
    const site = pathId(raw);
    if (!site.ok) return site.response;
    const r = await listHalls(email, site.id);
    return r.ok ? reply({ ok: true, site: r.value.site, halls: r.value.halls }) : r.response;
  });
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const raw = (await ctx.params).id;
  return serveWrite(req, HallBody, async (email, body) => {
    const site = pathId(raw);
    if (!site.ok) return site.response;
    const r = await createHall(email, site.id, body);
    return r.ok ? reply({ ok: true, hall: r.value }, 201) : r.response;
  });
}
