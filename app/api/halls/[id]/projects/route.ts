import { AttachBody, attachProject, detachProject, pathId, reply, serveWrite } from "@/lib/sites";

export const runtime = "nodejs";

// POST { projectToken, confirmNonProductionSite? } -> an authenticated editor or owner of the hall's organisation attaches an existing project to
// the hall. The project's link token is the proof of which project (it is the credential for that engagement) and is never returned; it is NOT
// enough on its own: the caller must also hold the role. A project belongs to at most one hall, for good. Attaching it makes its history, supplier
// dates and observations appear on the hall's timeline. When the hall's site is test or synthetic the attachment permanently keeps the project's
// observations out of the shared calibration ledger (0052), so the request is refused with 422, before anything is written, unless
// confirmNonProductionSite is exactly true (see attachProject in lib/sites.ts).
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const raw = (await ctx.params).id;
  return serveWrite(req, AttachBody, async (email, body) => {
    const hall = pathId(raw);
    if (!hall.ok) return hall.response;
    const r = await attachProject(email, hall.id, body);
    return r.ok ? reply({ ok: true, ...r.value }, r.value.alreadyAttached ? 200 : 201) : r.response;
  });
}

// DELETE ?project=<project id> -> an OWNER of the hall's organisation takes a project out of the hall. Recorded, logged in the project's own log, and the hall's
// timeline stops showing the project's log from then on (the attach and detach stay in its history). The project can then be attached to another hall.
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const raw = (await ctx.params).id;
  const rawProject = (new URL(req.url).searchParams.get("project") || "").trim();
  return serveWrite(req, null, async (email) => {
    const hall = pathId(raw);
    if (!hall.ok) return hall.response;
    const project = pathId(rawProject);
    if (!project.ok) return project.response;
    const r = await detachProject(email, hall.id, project.id);
    return r.ok ? reply({ ok: true }) : r.response;
  });
}
