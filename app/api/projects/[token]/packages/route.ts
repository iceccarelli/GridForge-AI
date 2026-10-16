import { NextResponse } from "next/server";
import { generateRfqPackage } from "@/lib/project-procurement";
import { guardRequest } from "@/lib/rate-limit";
import { fail, readJson, withProject } from "@/lib/project-http";

export const runtime = "nodejs";
export const maxDuration = 60;

// Generate the BTM RFQ package for one architecture of an attached case, from the
// existing spec engine. Refused (409, with the engine's blocking information) unless
// the architecture is rfq_ready. No price, SKU or checkout is involved.
export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const p = await withProject(ctx);
  if (!p.ok) return p.res;
  const body = await readJson(req);
  const case_token = typeof body?.case_token === "string" ? body.case_token : "";
  const architecture = typeof body?.architecture === "string" ? body.architecture : "";
  if (!case_token || !architecture) {
    return fail({ status: 422, error: "case_token and architecture are required." });
  }
  // The project token has been resolved and the body validated: admit the request, then every engine call inside `run` is
  // counted against the caller's provider budget. A project is free to create, so its token is not a reason to skip this.
  const g = await guardRequest(req, "project_rfq");
  if (g.denied) return g.denied;
  return g.run(async () => {
    const r = await generateRfqPackage(p.project, { case_token, architecture });
    if (!r.ok) return fail(r);
    return NextResponse.json({ ok: true, package: r.package }, { status: 201 });
  });
}
