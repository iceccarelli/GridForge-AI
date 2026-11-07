import { AttachBody, attachProject, pathId, reply, serveWrite } from "@/lib/sites";

export const runtime = "nodejs";

// POST { projectToken } -> an editor or owner of the hall's organisation attaches an existing project to the hall. The project's link token is
// the proof that the caller may do so (it is the credential for that engagement) and is never returned. A project belongs to at most one hall,
// for good. Attaching it makes its history, supplier dates and observations appear on the hall's timeline.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const raw = (await ctx.params).id;
  return serveWrite(req, AttachBody, async (email, body) => {
    const hall = pathId(raw);
    if (!hall.ok) return hall.response;
    const r = await attachProject(email, hall.id, body);
    return r.ok ? reply({ ok: true, ...r.value }, r.value.alreadyAttached ? 200 : 201) : r.response;
  });
}
