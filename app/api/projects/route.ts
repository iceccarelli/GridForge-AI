import { NextResponse } from "next/server";
import { createProject } from "@/lib/projects";
import { fail, readJson } from "@/lib/project-http";
import { guardRequest } from "@/lib/rate-limit";
import { recordFunnelEvent } from "@/lib/funnel";

export const runtime = "nodejs";

// Create a project: the canonical record a BTM case, its RFQ, supplier responses
// and evidence attach to. Not an engine call and it creates no engineering object —
// a project with nothing attached is a valid, honest, empty record.
export async function POST(req: Request) {
  const body = await readJson(req);
  if (!body) return fail({ status: 400, error: "Expected a JSON object." });
  // Anyone can create a project (there are no accounts), so creation is bounded per caller address. Counted after the body
  // is read and before anything is written, so a malformed request never uses the allowance.
  const g = await guardRequest(req, "project_create");
  if (g.denied) return g.denied;
  const made = await createProject(body);
  if (!made.ok) return fail(made);
  // Counted, never described: no project name, token or content goes into the product event.
  await recordFunnelEvent("project_created");
  return NextResponse.json(
    { ok: true, project_token: made.project.project_token, project_name: made.project.project_name },
    { status: 201 }
  );
}
