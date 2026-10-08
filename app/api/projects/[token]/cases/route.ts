import { NextResponse } from "next/server";
import { attachCase } from "@/lib/projects";
import { fail, readJson, withProject } from "@/lib/project-http";

export const runtime = "nodejs";

// Attach an EXISTING BTM case to this project. Needs the project token (this URL)
// AND the case's own token, plus the case's email when it is registered to one —
// neither token alone can reach into the other object.
export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const p = await withProject(ctx);
  if (!p.ok) return p.res;
  const body = await readJson(req);
  const case_token = typeof body?.case_token === "string" ? body.case_token : "";
  if (!case_token) return fail({ status: 422, error: "case_token is required." });
  const r = await attachCase(p.project, case_token, typeof body?.email === "string" ? body.email : null);
  if (!r.ok) return fail(r);
  return NextResponse.json({ ok: true, attached: r.created, revision: r.revision });
}
