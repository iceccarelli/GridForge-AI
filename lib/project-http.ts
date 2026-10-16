import { NextResponse } from "next/server";
import { getProjectByToken, type ProjectRow } from "@/lib/projects";
import { ENGINE_BODY_MAX_BYTES, readBoundedJson } from "@/lib/http-body";

/** An honest failure body: the status the store/engine/guard gave, and the reason. A write
 * is atomic with its history event, so a failure here means nothing was recorded. */
export function fail(r: { status: number; error: string; details?: unknown }) {
  return NextResponse.json(
    {
      ok: false,
      error: r.error,
      ...(r.details !== undefined ? { details: r.details } : {}),
    },
    { status: r.status }
  );
}

/** A JSON object body of at most the engine's own ceiling (a larger one is refused as if it were not an object). */
export async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  const read = await readBoundedJson(req, ENGINE_BODY_MAX_BYTES);
  if (!read.ok) return null;
  const body = read.value;
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
}

export async function withProject(
  ctx: { params: Promise<{ token: string }> }
): Promise<{ ok: true; project: ProjectRow } | { ok: false; res: NextResponse }> {
  const { token } = await ctx.params;
  const found = await getProjectByToken(token);
  if (!found.ok) return { ok: false, res: fail(found) };
  return { ok: true, project: found.project };
}
