import { NextResponse } from "next/server";
import { z } from "zod";
import { compareRequestSchema } from "@/lib/ttp-compare";
import { runCompare } from "@/lib/ttp-compare-server";
import { enforceRateLimit } from "@/lib/rate-limit";
import { saveComparison, type SaveTarget } from "@/lib/project-comparisons";
import { getProjectByToken } from "@/lib/projects";

export const runtime = "nodejs";
export const maxDuration = 60;

// Save a Time-to-Power comparison to a project.
//
// The browser sends the REQUEST, never a result: the engine is asked again here and what is stored is its answer, so a
// saved comparison is always something the engine said. With `project.project_token` the comparison is added to that
// project; without it a new project is created in the same transaction (a failure leaves neither), and the response
// carries the new project's token, the only time the server hands it out.
//
// Public and unauthenticated like the comparison itself, and it spends the platform engine key, so the rate limit runs
// before the engine and fails closed (lib/rate-limit.ts).
const MAX_BODY_BYTES = 64 * 1024;

const saveSchema = z
  .object({
    compare: compareRequestSchema,
    project: z
      .object({
        project_name: z.string().trim().min(1).max(200).optional(),
        company: z.string().trim().max(200).optional(),
        project_token: z.string().min(1).max(200).optional(),
      })
      .strict(),
  })
  .strict()
  .superRefine((b, ctx) => {
    if (!b.project.project_token && !b.project.project_name) {
      ctx.addIssue({ code: "custom", path: ["project", "project_name"], message: "Name the project, or give the token of an existing one." });
    }
  });

const NO_STORE = { "Cache-Control": "no-store" };

export async function POST(req: Request) {
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) {
    return NextResponse.json({ ok: false, error: "Request too large." }, { status: 413, headers: NO_STORE });
  }
  const text = await req.text().catch(() => "");
  if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) {
    return NextResponse.json({ ok: false, error: "Request too large." }, { status: 413, headers: NO_STORE });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body." }, { status: 400, headers: NO_STORE });
  }
  const parsed = saveSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      {
        ok: false,
        error: "Validation failed",
        problems: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      },
      { status: 422, headers: NO_STORE }
    );
  }

  const limited = await enforceRateLimit(req, "ttp_compare_save");
  if (limited) return limited;

  let target: SaveTarget;
  if (parsed.data.project.project_token) {
    const found = await getProjectByToken(parsed.data.project.project_token);
    if (!found.ok) {
      return NextResponse.json(
        { ok: false, error: found.status === 404 ? "That project was not found." : found.error },
        { status: found.status, headers: NO_STORE }
      );
    }
    target = { kind: "existing", project: found.project };
  } else {
    target = { kind: "new", project_name: parsed.data.project.project_name!, company: parsed.data.project.company || null };
  }

  const out = await runCompare(parsed.data.compare);
  if (!out.ok) {
    return NextResponse.json(
      { ok: false, error: out.error, ...(out.detail ? { detail: out.detail } : {}) },
      { status: out.status, headers: NO_STORE }
    );
  }

  const saved = await saveComparison(target, out.engineBody, out.result);
  if (!saved.ok) {
    return NextResponse.json({ ok: false, error: saved.error }, { status: saved.status, headers: NO_STORE });
  }
  const token = saved.project_token ?? (target.kind === "existing" ? target.project.project_token : null);
  return NextResponse.json(
    {
      ok: true,
      created: saved.created,
      comparison_id: saved.comparison_id,
      request_digest: out.result.request_digest,
      project_name: target.kind === "existing" ? target.project.project_name : target.project_name,
      // Only a project created by this call hands its token back; an existing project's holder already has it.
      ...(saved.project_token ? { project_token: saved.project_token } : {}),
      workspace_path: token ? `/workspace?project=${encodeURIComponent(token)}` : null,
    },
    { status: saved.created ? 201 : 200, headers: NO_STORE }
  );
}
