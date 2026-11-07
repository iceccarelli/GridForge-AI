import { SiteBody, createSite, listSites, pathId, reply, serveRead, serveWrite } from "@/lib/sites";

export const runtime = "nodejs";

// GET [?org=<id>] -> the sites of every organisation the VERIFIED caller belongs to (or of one of them). POST { orgId, name, country?, dataOrigin }
// -> an editor or owner adds a site. `dataOrigin` is required: production (a real asset), test or synthetic, and is fixed once written.
export async function GET(req: Request) {
  const raw = (new URL(req.url).searchParams.get("org") || "").trim();
  return serveRead(req, async (email) => {
    let org: string | null = null;
    if (raw) {
      const p = pathId(raw);
      if (!p.ok) return p.response;
      org = p.id;
    }
    const r = await listSites(email, org);
    return r.ok ? reply({ ok: true, sites: r.value }) : r.response;
  });
}

export async function POST(req: Request) {
  return serveWrite(req, SiteBody, async (email, body) => {
    const r = await createSite(email, body);
    return r.ok ? reply({ ok: true, site: r.value.site }, 201) : r.response;
  });
}
