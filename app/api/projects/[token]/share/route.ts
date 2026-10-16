import { NextResponse } from "next/server";
import { fail, withProject } from "@/lib/project-http";
import { issueShare, revokeShare, shareStatus } from "@/lib/project-share";

export const runtime = "nodejs";

// The project's read-only buyer link. The project token is the authority for all three verbs.
//
// POST issues a link and retires the previous one in the same transaction. The link's secret is in this response and
// nowhere else: the database keeps only its hash, so it cannot be shown again, only replaced (POST) or revoked (DELETE).
const NO_STORE = { "Cache-Control": "no-store" };

export async function GET(_req: Request, ctx: { params: Promise<{ token: string }> }) {
  const p = await withProject(ctx);
  if (!p.ok) return p.res;
  const s = await shareStatus(p.project.id);
  if (!s.ok) return fail(s);
  return NextResponse.json({ ok: true, active: s.active, issued_at: s.issued_at }, { headers: NO_STORE });
}

export async function POST(_req: Request, ctx: { params: Promise<{ token: string }> }) {
  const p = await withProject(ctx);
  if (!p.ok) return p.res;
  const made = await issueShare(p.project);
  if (!made.ok) return fail(made);
  return NextResponse.json(
    { ok: true, share_path: `/p/${made.share_token}`, replaced_previous: made.replaced_previous },
    { status: 201, headers: NO_STORE }
  );
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ token: string }> }) {
  const p = await withProject(ctx);
  if (!p.ok) return p.res;
  const r = await revokeShare(p.project);
  if (!r.ok) return fail(r);
  return NextResponse.json({ ok: true, revoked: r.revoked }, { headers: NO_STORE });
}
