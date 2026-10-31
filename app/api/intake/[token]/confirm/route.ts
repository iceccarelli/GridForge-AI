import { paymentHoldAnswer } from "@/lib/one-time-holds";
import { NextResponse } from "next/server";
import { getByIntakeToken } from "@/lib/deliverables";
import { confirmValue, withdrawValue } from "@/lib/intake-evidence";
import { readBoundedJson } from "@/lib/http-body";
import { guardRequest } from "@/lib/rate-limit";

export const runtime = "nodejs";

// The buyer attests to a figure from one of their attached documents, or withdraws that (lib/intake-evidence.ts).
//   POST {"field": "firmCapacityMVA", "value": 40, "fileId": "<id>", "locator": "clause 4.2"}   -> confirm
//   POST {"field": "firmCapacityMVA", "withdraw": true}                                           -> withdraw
// The unit comes from the field and the attester from the engagement; the request cannot set either. Nothing here reads the document.

export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const row = await getByIntakeToken(token);
  if (!row) return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });
  // A refunded or disputed purchase is withheld (lib/one-time-holds.ts): the buyer is told why, not shown a 404, and nothing is generated.
  {
    const held = paymentHoldAnswer(row);
    if (held) return NextResponse.json(held.body, { status: held.status });
  }

  const read = await readBoundedJson(req, 4 * 1024);
  if (!read.ok) return NextResponse.json({ ok: false, error: read.status === 413 ? read.error : "Invalid payload" }, { status: read.status });
  const body = read.value;
  if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ ok: false, error: "Send a JSON object." }, { status: 422 });
  const b = body as Record<string, unknown>;

  const g = await guardRequest(req, "intake_evidence");
  if (g.denied) return g.denied;

  const r = b.withdraw === true
    ? await withdrawValue(row, b.field)
    : await confirmValue(row, { field: b.field, value: b.value, fileId: b.fileId, locator: b.locator });
  if (!r.ok) return NextResponse.json({ ok: false, error: r.error }, { status: r.status });
  return NextResponse.json({ ok: true, confirmed: r.confirmed });
}
