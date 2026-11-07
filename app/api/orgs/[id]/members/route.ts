import { MemberBody, addMember, orgMembers, pathId, reply, removeMember, serveRead, serveWrite } from "@/lib/sites";

export const runtime = "nodejs";

// GET -> who is in the organisation (any member may read). POST { email, role } -> add a person (owners only), by the address they sign in
// with: nothing is emailed, they see the organisation when they next sign in with that address. DELETE ?id=<membership id> -> an owner
// removes a member, or anyone removes themselves; the last owner can never be removed.
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const raw = (await ctx.params).id;
  return serveRead(req, async (email) => {
    const org = pathId(raw);
    if (!org.ok) return org.response;
    const r = await orgMembers(email, org.id);
    return r.ok ? reply({ ok: true, members: r.value }) : r.response;
  });
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const raw = (await ctx.params).id;
  return serveWrite(req, MemberBody, async (email, body) => {
    const org = pathId(raw);
    if (!org.ok) return org.response;
    const r = await addMember(email, org.id, body);
    return r.ok ? reply({ ok: true, memberId: r.value.memberId }, 201) : r.response;
  });
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const raw = (await ctx.params).id;
  const rawMember = (new URL(req.url).searchParams.get("id") || "").trim();
  return serveWrite(req, null, async (email) => {
    const org = pathId(raw);
    if (!org.ok) return org.response;
    const member = pathId(rawMember);
    if (!member.ok) return member.response;
    const r = await removeMember(email, org.id, member.id);
    return r.ok ? reply({ ok: true }) : r.response;
  });
}
