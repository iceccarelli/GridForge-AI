import { NextResponse } from "next/server";
import { readBoundedJson } from "@/lib/http-body";
import { guardRequest } from "@/lib/rate-limit";
import { inviteMember, ownerContext, revokeInvitation } from "@/lib/team";

export const runtime = "nodejs";

const MAX_BODY_BYTES = 2 * 1024;

// POST { email } -> invite somebody to a seat. Billing owner only.
export async function POST(req: Request) {
  const ctx = await ownerContext(req);
  if (!ctx.ok) return ctx.response;

  const read = await readBoundedJson(req, MAX_BODY_BYTES);
  if (!read.ok) return NextResponse.json({ ok: false, error: read.status === 413 ? read.error : "Invalid payload" }, { status: read.status });
  const body = (read.value && typeof read.value === "object" && !Array.isArray(read.value) ? read.value : {}) as { email?: unknown };

  // Admitted only once the caller is a verified owner and the body is well-formed, so a refused request spends nobody's allowance.
  const g = await guardRequest(req, "team_invite", { account: { verifiedEmail: ctx.email, policy: "team_invite_account" } });
  if (g.denied) return g.denied;

  const r = await inviteMember(ctx.email, body.email);
  if (!r.ok) return NextResponse.json({ ok: false, error: r.error, reason: r.reason }, { status: r.status });
  return NextResponse.json({ ok: true, invitationId: r.invitationId, expiresAt: r.expiresAt, delivery: r.delivery }, { status: 201 });
}

// DELETE ?id= -> withdraw an open invitation. Billing owner only; scoped to the owner inside the database statement.
export async function DELETE(req: Request) {
  const ctx = await ownerContext(req);
  if (!ctx.ok) return ctx.response;
  const id = (new URL(req.url).searchParams.get("id") || "").trim();
  const r = await revokeInvitation(ctx.email, id);
  if (!r.ok) return NextResponse.json({ ok: false, error: r.error }, { status: r.status });
  return NextResponse.json({ ok: true });
}
