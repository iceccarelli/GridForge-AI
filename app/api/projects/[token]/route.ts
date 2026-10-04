import { NextResponse } from "next/server";
import { getProjectState } from "@/lib/project-state";
import { fail } from "@/lib/project-http";

export const runtime = "nodejs";

// The project as stored — what ProjectPanel renders. Read-only; nothing is computed.
export async function GET(_req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const r = await getProjectState(token);
  if (!r.ok) return fail(r);
  return NextResponse.json({ ok: true, ...r.state });
}
