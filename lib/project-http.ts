import { NextResponse } from "next/server";
import { getProjectByToken, type ProjectRow } from "@/lib/projects";

/** An honest failure body: the status the store/engine/guard gave, the reason, and
 * — when a write half-landed — `stored: true` so nobody reads it as "nothing happened". */
export function fail(r: { status: number; error: string; stored?: true; details?: unknown }) {
  return NextResponse.json(
    {
      ok: false,
      error: r.error,
      ...(r.stored ? { stored: true } : {}),
      ...(r.details !== undefined ? { details: r.details } : {}),
    },
    { status: r.status }
  );
}

export async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await req.json();
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export async function withProject(
  ctx: { params: Promise<{ token: string }> }
): Promise<{ ok: true; project: ProjectRow } | { ok: false; res: NextResponse }> {
  const { token } = await ctx.params;
  const found = await getProjectByToken(token);
  if (!found.ok) return { ok: false, res: fail(found) };
  return { ok: true, project: found.project };
}
