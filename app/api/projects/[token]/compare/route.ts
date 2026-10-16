import { NextResponse } from "next/server";
import { compareForProject } from "@/lib/project-comparisons";
import { compareRequestSchema } from "@/lib/ttp-compare";
import { fail, withProject } from "@/lib/project-http";
import { enforceRateLimit, policyFor } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const maxDuration = 60;

// Compare one hall with THIS project's accepted supplier quotations priced in. Nothing is saved; the person reads the
// priced answer first and saves it (POST ../comparisons with evidence:"project") if they want it kept. Only lines a
// named reviewer has accepted reach a price; the engine says which it used and which it ignored, and why. The request
// returned carries those lines, so the same answer reproduces at the API or the CLI.
const MAX_BODY_BYTES = 64 * 1024;

export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const p = await withProject(ctx);
  if (!p.ok) return p.res;
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) return fail({ status: 413, error: "Request too large." });
  const text = await req.text().catch(() => "");
  if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) return fail({ status: 413, error: "Request too large." });
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return fail({ status: 400, error: "Invalid JSON body." });
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail({ status: 400, error: "Expected an object." });
  const parsed = compareRequestSchema.safeParse((raw as Record<string, unknown>).request);
  if (!parsed.success) {
    return NextResponse.json(
      {
        ok: false,
        error: "Validation failed",
        problems: parsed.error.issues.map((i) => ({ path: ["request", ...i.path].join("."), message: i.message })),
      },
      { status: 422 }
    );
  }
  // A project token is free to obtain (POST /api/projects), so this is as public an engine proxy as /api/power/compare
  // and shares its limits. The engine is asked only after the guard decides.
  const gate = await enforceRateLimit(req, policyFor("compare"));
  if (!gate.ok) return gate.response;
  const r = await compareForProject(p.project, parsed.data);
  if (!r.ok) return fail(r);
  return NextResponse.json(
    { ok: true, result: r.result, result_digest: r.result_digest, request: r.engineBody, evidence: r.evidence },
    { headers: { "Cache-Control": "no-store", ...gate.headers } }
  );
}
