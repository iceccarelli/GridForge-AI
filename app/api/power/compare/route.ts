import { NextResponse } from "next/server";
import { compareRequestSchema } from "@/lib/ttp-compare";
import { resultDigest, runCompare } from "@/lib/ttp-compare-server";
import { enforceRateLimit, policyFor } from "@/lib/rate-limit";

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
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) {
    return NextResponse.json({ ok: false, error: "Request too large." }, { status: 413 });
  }
  const text = await req.text().catch(() => "");
  if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) {
    return NextResponse.json({ ok: false, error: "Request too large." }, { status: 413 });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body." }, { status: 400 });
  }
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
  // Last gate before the engine is asked: everything above is free to refuse and costs no engine unit. A denied or
  // undecidable request returns here and the engine is never called (lib/rate-limit.ts).
  const gate = await enforceRateLimit(req, policyFor("compare"));
  if (!gate.ok) return gate.response;
  const out = await runCompare(parsed.data);
  if (!out.ok) {
    return NextResponse.json(
      { ok: false, error: out.error, ...(out.detail ? { detail: out.detail } : {}) },
      { status: out.status, headers: { "Cache-Control": "no-store" } }
    );
  }
  return NextResponse.json(
    { ok: true, result: out.result, result_digest: resultDigest(out.result), request: out.engineBody },
    { headers: { "Cache-Control": "no-store", ...gate.headers } }
  );
}
