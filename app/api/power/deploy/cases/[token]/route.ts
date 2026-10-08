import { NextResponse } from "next/server";
import {
  appendDeploymentRevision,
  deploymentCaseHistory,
  latestDeploymentCase,
  runDeploymentAssessment,
} from "@/lib/power-deploy";

export const runtime = "nodejs";
export const maxDuration = 60;

// GET  -> the case's latest revision (?history=1 for every revision).
// POST -> a changed input: re-run the engine, append a revision, and report
//         exactly which top-level fields moved since the last one — never a
//         fabricated narrative, only the fields that actually differ.
export async function GET(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const wantsHistory = new URL(req.url).searchParams.get("history");
  if (wantsHistory) {
    const history = await deploymentCaseHistory(token);
    if (!history.length) {
      return NextResponse.json({ ok: false, error: "Not found." }, { status: 404 });
    }
    return NextResponse.json({ ok: true, case_token: token, revisions: history });
  }
  const row = await latestDeploymentCase(token);
  if (!row) return NextResponse.json({ ok: false, error: "Not found." }, { status: 404 });
  return NextResponse.json({
    ok: true, case_token: row.case_token, revision: row.revision,
    result: row.result, changed_fields: row.changed_fields,
  });
}

export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const existing = await latestDeploymentCase(token);
  if (!existing) return NextResponse.json({ ok: false, error: "Not found." }, { status: 404 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body." }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return NextResponse.json({ ok: false, error: "Expected a deployment request object." }, {
      status: 400,
    });
  }
  const { email: confirmEmail, ...patch } = body as Record<string, unknown>;

  // A token alone is not sufficient authorization to mutate a case someone
  // registered an email against — a leaked or forwarded link would otherwise
  // let anyone rewrite the capacity/architecture inputs behind a customer's
  // back. An anonymous case (no email at creation) keeps the token as its
  // only access control, matching the rest of the site's magic-link model.
  if (existing.email) {
    const given = typeof confirmEmail === "string" ? confirmEmail.trim().toLowerCase() : "";
    if (given !== existing.email.trim().toLowerCase()) {
      return NextResponse.json(
        { ok: false, error: "This case is registered to a different email address." },
        { status: 403 }
      );
    }
  }

  // A partial update merges onto the case's own last request — a customer who
  // is only reporting "the battery quote came in at 30 weeks, not 44" should
  // not have to resend the load profile and every generator to say so.
  const request = { ...existing.request, ...patch };

  const assessed = await runDeploymentAssessment(request);
  if (!assessed.ok) {
    return NextResponse.json(
      { ok: false, error: `The engine could not re-solve this case: ${assessed.error}` },
      { status: 502 }
    );
  }

  const row = await appendDeploymentRevision(token, request, assessed.result);
  if (!row) {
    return NextResponse.json(
      { ok: false, error: "The case was re-solved but the new revision could not be saved." },
      { status: 502 }
    );
  }

  return NextResponse.json({
    ok: true, case_token: row.case_token, revision: row.revision,
    result: row.result, changed_fields: row.changed_fields,
    // Written in the same transaction as the revision, so present or absent — never partial.
    ...(row.project_events ? { project_history: "recorded" } : {}),
  });
}
