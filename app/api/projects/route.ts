import { NextResponse } from "next/server";
import { createProject } from "@/lib/projects";
import { fail, readJson } from "@/lib/project-http";

export const runtime = "nodejs";

// Create a project: the canonical record a BTM case, its RFQ, supplier responses
// and evidence attach to. Not an engine call and it creates no engineering object —
// a project with nothing attached is a valid, honest, empty record.
export async function POST(req: Request) {
  const body = await readJson(req);
  if (!body) return fail({ status: 400, error: "Expected a JSON object." });
  const made = await createProject(body);
  if (!made.ok) return fail(made);
  return NextResponse.json(
    { ok: true, project_token: made.project.project_token, project_name: made.project.project_name },
    { status: 201 }
  );
}
