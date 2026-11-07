import { OrgBody, createOrg, myOrgs, reply, serveRead, serveWrite } from "@/lib/sites";

export const runtime = "nodejs";

// GET  -> the organisations the VERIFIED caller is a member of, with their role in each. No id, email or role is read from the request.
// POST { name } -> register an organisation; the caller becomes its owner. An organisation is a group of people who share a registry of
// sites and halls. It is not a billing entity and has nothing to do with a subscription's seats.
export async function GET(req: Request) {
  return serveRead(req, async (email) => {
    const r = await myOrgs(email);
    return r.ok ? reply({ ok: true, orgs: r.value }) : r.response;
  });
}

export async function POST(req: Request) {
  return serveWrite(req, OrgBody, async (email, body) => {
    const r = await createOrg(email, body);
    return r.ok ? reply({ ok: true, org: r.value }, 201) : r.response;
  });
}
