import { NextResponse } from "next/server";
import { listComparisons, saveComparison } from "@/lib/project-comparisons";
import { compareRequestSchema } from "@/lib/ttp-compare";
import { fail, withProject } from "@/lib/project-http";

export const runtime = "nodejs";
export const maxDuration = 60;

// Save a Time-to-Power scenario comparison to this project, and list the ones saved.
//
// Needs the project token (this URL). The body is the same comparison request /api/power/compare takes, plus an
// idempotency_key the caller keeps across retries, an optional label, the result digest the customer reviewed, and
// optionally evidence:"project" to price it with the project's accepted supplier quotations (gathered here, never
// taken from the client).
// The engine is asked again for exactly that request and its answer is what is stored; if it differs from the
// reviewed one the save is refused. Nothing is recorded unless the database confirms the row and its event.
const MAX_BODY_BYTES = 64 * 1024;

export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const p = await withProject(ctx);
  if (!p.ok) return p.res;
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) {
    return fail({ status: 413, error: "Request too large." });
  }
  const text = await req.text().catch(() => "");
  if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) return fail({ status: 413, error: "Request too large." });
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return fail({ status: 400, error: "Invalid JSON body." });
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail({ status: 400, error: "Expected an object." });
  const body = raw as Record<string, unknown>;
  const parsed = compareRequestSchema.safeParse(body.request);
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
  const r = await saveComparison(p.project, {
    request: parsed.data,
    idempotency_key: typeof body.idempotency_key === "string" ? body.idempotency_key : "",
    label: typeof body.label === "string" ? body.label : null,
    reviewed_result_digest: typeof body.reviewed_result_digest === "string" ? body.reviewed_result_digest : null,
    evidence: body.evidence === "project" ? "project" : null,
  });
  if (!r.ok) return fail(r);
  const { request: _req, result: _res, ...summary } = r.comparison;
  void _req;
  void _res;
  return NextResponse.json(
    { ok: true, created: r.created, reason: r.reason, comparison: summary },
    { status: r.created ? 201 : 200, headers: { "Cache-Control": "no-store" } }
  );
}

export async function GET(_req: Request, ctx: { params: Promise<{ token: string }> }) {
  const p = await withProject(ctx);
  if (!p.ok) return p.res;
  const r = await listComparisons(p.project);
  if (!r.ok) return fail(r);
  return NextResponse.json({ ok: true, comparisons: r.comparisons }, { headers: { "Cache-Control": "no-store" } });
}
