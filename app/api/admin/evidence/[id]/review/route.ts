import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { z } from "zod";
import { ADMIN_COOKIE, verifyAdminCookie, refuseCrossSiteWrite } from "@/lib/admin";
import { reviewEvidence } from "@/lib/project-evidence-review";
import { fail, readJson } from "@/lib/project-http";

export const runtime = "nodejs";
export const maxDuration = 30;

// A person verifies or rejects ONE evidence file, once. Verifying makes THIS server read the stored file back and hash it; the database
// compares that digest with the one recorded at upload and refuses a mismatch. The reviewer name is the text typed under the one shared
// admin password: recorded as typed. No bulk action, no default, no automatic verification. The response carries the decision and the
// digest only: never the file's storage path, and never a token or a credential.
const body = z
  .object({
    decision: z.enum(["verified", "rejected"]),
    reviewer: z.string().trim().min(1).max(120),
    reason: z.string().trim().min(1).max(500),
  })
  .strict();

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const xs = refuseCrossSiteWrite(req);
  if (xs) return xs;
  const store = await cookies();
  if (!(await verifyAdminCookie(store.get(ADMIN_COOKIE)?.value))) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await ctx.params;
  const raw = await readJson(req);
  if (!raw) return fail({ status: 400, error: "Expected a JSON object." });
  const parsed = body.safeParse(raw);
  if (!parsed.success) {
    return fail({ status: 422, error: "The decision was refused.", details: parsed.error.issues.map((i) => ({ field: i.path.join("."), problem: i.message })) });
  }
  const r = await reviewEvidence({ evidence_id: id, ...parsed.data });
  if (!r.ok) return fail(r);
  return NextResponse.json({ ok: true, review: r.review }, { status: 201, headers: { "Cache-Control": "no-store" } });
}
