import { NextResponse } from "next/server";
import { createDeploymentCase, runDeploymentAssessment } from "@/lib/power-deploy";
import { attachCase, getProjectByToken } from "@/lib/projects";
import { enforceRateLimit, policyFor } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_BODY_BYTES = 2 * 1024 * 1024;

// Create a BTM Power Deployment Case.
//
// gridforge/reporting/btm_assessment.py already composes a load profile and
// declared generation/BESS units into one architecture comparison, and it is
// already callable over the CLI, REST (/v1/power/deploy/assess) and MCP. What
// was missing on the site side was anywhere for the result to live between one
// visit and the next — every call composed fresh and vanished. This route is
// the first write: it runs the engine once, exactly like the raw endpoint
// does, and additionally keeps the request/result pair as revision 1 of a case
// a customer can come back to.
//
// No entitlement gate here yet, deliberately: there is no Stripe product for
// this capability. Gating it behind a fake paywall would be worse than no gate
// at all — see HANDOFF.md on inventing billing products before the capability
// they meter is real.
export async function POST(req: Request) {
  // A deployment request can carry an interval load profile, so the cap is generous; it exists so an oversized body
  // cannot be used to burn parse time and engine capacity before any other check.
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) {
    return NextResponse.json({ ok: false, error: "Request too large." }, { status: 413 });
  }
  let body: unknown;
  try {
    const text = await req.text();
    if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) {
      return NextResponse.json({ ok: false, error: "Request too large." }, { status: 413 });
    }
    body = JSON.parse(text);
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body." }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return NextResponse.json({ ok: false, error: "Expected a deployment request object." }, {
      status: 400,
    });
  }
  const { email, company, project_name, project_token, ...request } = body as Record<string, unknown>;

  // Optional: create the case straight into an existing project. Resolved BEFORE the
  // engine runs, so a wrong project token costs nothing and creates nothing.
  let project = null;
  if (project_token !== undefined && project_token !== null && project_token !== "") {
    const found = await getProjectByToken(typeof project_token === "string" ? project_token : "");
    if (!found.ok) {
      return NextResponse.json({ ok: false, error: found.error }, { status: found.status });
    }
    project = found.project;
  }

  // The decision is made before the engine is asked; a denied or undecidable request never reaches it.
  const gate = await enforceRateLimit(req, policyFor("deploy"));
  if (!gate.ok) return gate.response;

  const assessed = await runDeploymentAssessment(request);
  if (!assessed.ok) {
    // Engine and configuration detail (env var names, upstream URLs) is for the
    // server log, not the person filling in the form.
    console.error("[GridForge] power deploy assessment failed:", assessed.error);
    return NextResponse.json(
      {
        ok: false,
        error:
          "The assessment service is temporarily unavailable, so no result was produced. Nothing was saved. Please try again later.",
      },
      { status: 502 }
    );
  }

  const row = await createDeploymentCase({
    request,
    result: assessed.result,
    email: typeof email === "string" ? email : null,
    company: typeof company === "string" ? company : null,
    project_name: typeof project_name === "string" ? project_name : null,
  });
  if (!row) {
    return NextResponse.json(
      {
        ok: false,
        error: "The assessment ran, but the case could not be saved. Nothing was invented — "
          + "retry, or read the result below without a token to come back to.",
        result: assessed.result,
      },
      { status: 502 }
    );
  }

  if (project) {
    // The case exists and stands on its own; say explicitly whether the attachment landed.
    const attached = await attachCase(project, row.case_token, typeof email === "string" ? email : null);
    if (!attached.ok) {
      return NextResponse.json(
        { ok: true, case_token: row.case_token, revision: row.revision, result: row.result,
          project_attached: false, project_error: attached.error },
        { status: 207 }
      );
    }
    return NextResponse.json({ ok: true, case_token: row.case_token, revision: row.revision,
      result: row.result, project_attached: true });
  }

  return NextResponse.json({ ok: true, case_token: row.case_token, revision: row.revision,
    result: row.result });
}
