import { NextResponse } from "next/server";
import { compareRequestSchema } from "@/lib/ttp-compare";
import { runCompare } from "@/lib/ttp-compare-server";
import { guardRequest } from "@/lib/rate-limit";
import { readBoundedJson } from "@/lib/http-body";

export const runtime = "nodejs";
export const maxDuration = 60;

// Time-to-Power scenario comparison.
//
// Free to use and deliberately not behind a checkout: there is no product to buy here, only an engine answer that
// says what it can and cannot defend. Nothing is persisted. The result carries the digest of the question asked and
// the engine provenance, and the request is returned in the form `POST /v1/compare` or `gridforge compare` accepts,
// so the same numbers can be reproduced outside the site.
const MAX_BODY_BYTES = 64 * 1024;

export async function POST(req: Request) {
  const body = await readBoundedJson(req, MAX_BODY_BYTES);
  if (!body.ok) return NextResponse.json({ ok: false, error: body.error }, { status: body.status });
  const raw = body.value;
  const parsed = compareRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      {
        ok: false,
        error: "Validation failed",
        issues: parsed.error.flatten(),
        problems: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      },
      { status: 422 }
    );
  }
  // Spends the platform engine key for an anonymous visitor: admitted by the request limit first (fails closed), and every
  // engine call made inside `run` is counted against the caller's provider budget and the shared ceiling.
  const g = await guardRequest(req, "ttp_compare");
  if (g.denied) return g.denied;
  return g.run(async () => {
    const out = await runCompare(parsed.data);
    if (!out.ok) {
      return NextResponse.json(
        { ok: false, error: out.error, ...(out.detail ? { detail: out.detail } : {}) },
        { status: out.status, headers: { "Cache-Control": "no-store" } }
      );
    }
    return NextResponse.json(
      { ok: true, result: out.result, request: out.engineBody },
      { headers: { "Cache-Control": "no-store" } }
    );
  });
}
