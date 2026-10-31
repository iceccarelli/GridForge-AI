import { paymentHoldAnswer } from "@/lib/one-time-holds";
import { NextResponse } from "next/server";
import { getByToken } from "@/lib/deliverables";
import { evidenceFor, submitQuotes, type EvidenceRow } from "@/lib/cost-evidence";
import { fail, readJson } from "@/lib/project-http";
import { guardRequest } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * Where a customer's supplier quotations enter the evidence loop.
 *
 * Addressed by the engagement's own document token, which the customer holds, so only they (and an administrator)
 * can see what suppliers quoted them. Receiving a quotation records it as VALIDATED or INVALID against the
 * specification it answers and nothing more: it influences no run until a named person accepts it.
 */

/** What the holder of the engagement may see of each line: their own submission and its state. */
function view(r: EvidenceRow) {
  return {
    id: r.id,
    state: r.state,
    cost_key: r.cost_key,
    supplier: r.supplier,
    value: r.value,
    unit: r.unit,
    currency: r.currency,
    quoted_quantity: r.quoted_quantity,
    quoted_quantity_unit: r.quoted_quantity_unit,
    received_on: r.received_on,
    valid_until: r.valid_until,
    comparability: r.state === "accepted" ? r.reviewed_comparability : r.comparability,
    problems: r.problems,
    limitations: r.limitations,
    synthetic: r.synthetic,
  };
}

export async function GET(_req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const row = await getByToken(token);
  if (!row) return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });
  // A refunded or disputed purchase is withheld (lib/one-time-holds.ts): the buyer is told why, not shown a 404, and nothing is generated.
  {
    const held = paymentHoldAnswer(row);
    if (held) return NextResponse.json(held.body, { status: held.status });
  }
  const r = await evidenceFor(row.id);
  if (!r.ok) return fail(r);
  return NextResponse.json({ ok: true, items: r.items.map(view) }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const row = await getByToken(token);
  if (!row) return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });
  // A refunded or disputed purchase is withheld (lib/one-time-holds.ts): the buyer is told why, not shown a 404, and nothing is generated.
  {
    const held = paymentHoldAnswer(row);
    if (held) return NextResponse.json(held.body, { status: held.status });
  }
  const body = await readJson(req);
  if (!body) return fail({ status: 400, error: "Invalid payload" });
  // The token (a purchase) has been resolved and the input validated. Admit the request against the CUSTOMER budgets, then
  // every engine call inside `run` is counted individually; anonymous traffic cannot starve this, nor this that.
  const g = await guardRequest(req, "customer_generate", { cls: "customer" });
  if (g.denied) return g.denied;
  return g.run(async () => {
    const r = await submitQuotes(row, body.responses as unknown[], {
      synthetic: body.synthetic === true,
      submitted_by: typeof body.submitted_by === "string" ? body.submitted_by : "",
    });
    if (!r.ok) return fail(r);
    const items = await evidenceFor(row.id);
    const byId = new Map((items.ok ? items.items : []).map((i) => [i.id, i]));
    return NextResponse.json(
      {
        ok: true,
        note: "Recorded as received. A quotation influences no study until a named reviewer accepts it.",
        lines: r.lines.map((l) => ({ created: l.created, ...(byId.get(l.id) ? view(byId.get(l.id)!) : { id: l.id }) })),
      },
      { status: r.lines.some((l) => l.created) ? 201 : 200, headers: { "Cache-Control": "no-store" } }
    );
  });
}
