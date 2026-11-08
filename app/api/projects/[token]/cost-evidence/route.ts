import { NextResponse } from "next/server";
import { fail, readJson, withProject } from "@/lib/project-http";
import { guardRequest } from "@/lib/rate-limit";
import { claimsFor, submitClaim } from "@/lib/project-quotation-claims";
import { claimSchema, checkClaim, NO_EQUIPMENT_STATEMENT } from "@/lib/cost-evidence-claims";

export const runtime = "nodejs";
export const maxDuration = 30;

// The supplier quotations of ONE project, addressed by its token.
//
//   GET   -> this project's quotation claims, each beside the standing of its file. Another project's quotations are never selected.
//   POST  -> record the claims about a quotation document already uploaded to this project (POST /api/projects/{token}/evidence).
//            Stored UNVERIFIED and unaccepted: it changes no number until a reviewer has verified the file and accepted the record.
//
// What the caller can say is the claim itself (price, unit, supplier, dates, lead time, scope). There is no field for a state, a review, a basis
// or an evidence class, and the response never carries a storage path. The statement in the body is the same one every surface carries.
const NO_STORE = { "Cache-Control": "no-store" };

export async function GET(_req: Request, ctx: { params: Promise<{ token: string }> }) {
  const p = await withProject(ctx);
  if (!p.ok) return p.res;
  const r = await claimsFor(p.project);
  if (!r.ok) return fail(r);
  return NextResponse.json({ ok: true, claims: r.claims, statement: NO_EQUIPMENT_STATEMENT }, { headers: NO_STORE });
}

export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const p = await withProject(ctx);
  if (!p.ok) return p.res;
  const body = await readJson(req);
  if (!body) return fail({ status: 400, error: "Expected a JSON object." });

  // Validated before any allowance is spent, so a malformed request costs nobody anything.
  const parsed = claimSchema.safeParse(body);
  if (!parsed.success) {
    return fail({ status: 422, error: parsed.error.issues[0]?.message ?? "The quotation was refused.", details: parsed.error.issues.map((i) => ({ field: i.path.join("."), problem: i.message })) });
  }
  const problems = checkClaim(parsed.data, new Date().toISOString().slice(0, 10));
  if (problems.length) {
    return fail({ status: 422, error: problems[0].message, details: problems.map((x) => ({ field: x.path, problem: x.message })) });
  }

  const g = await guardRequest(req, "project_quotation");
  if (g.denied) return g.denied;
  const r = await submitClaim(p.project, body);
  if (!r.ok) return fail(r as typeof r & { details?: unknown });
  if (!r.created) {
    // Byte-identical to a claim already recorded: nothing was stored, and the answer says what became of it.
    return NextResponse.json(
      {
        ok: true,
        id: r.id,
        created: false,
        state: r.state === "validated" ? "received" : r.state,
        note:
          `An identical quotation is already recorded (it is ${r.state === "validated" ? "awaiting a reviewer" : r.state}). Nothing new was stored, and your entry changed nothing. ` +
          "To record a different quotation, change what differs (the figure, the dates, the notes, the reference or the document). A decision is final: a rejected " +
          "quotation is not re-opened, and a corrected one is recorded afresh and reviewed as a new record.",
      },
      { status: 200, headers: NO_STORE }
    );
  }
  return NextResponse.json(
    { ok: true, id: r.id, created: true, state: "received", counted: false, note: "Recorded and not yet counted: a reviewer must verify the file and accept this record before it changes any number." },
    { status: 201, headers: NO_STORE }
  );
}
