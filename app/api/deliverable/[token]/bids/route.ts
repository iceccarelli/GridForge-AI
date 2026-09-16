import { NextResponse } from "next/server";
import { compareBids, getByToken, updateByToken } from "@/lib/deliverables";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * The third thing a Procurement Specification promises.
 *
 * Its catalogue entry has always stated the deliverable as three things:
 * "Technical specification (HTML + Markdown), a machine-readable response
 * schedule, and a bid comparison against the capacity model showing what each
 * response does to the energisation date." The site delivered the first two. The
 * third had no surface anywhere — the engine has been able to do it since before
 * this product was priced, and nothing called it.
 *
 * So a customer paid for it, received a specification and a response schedule,
 * collected four supplier quotes, and then had nowhere to put them.
 *
 * Addressed by the engagement's own document token, which is what the customer
 * holds. The comparison is judged against the relief the specification was WRITTEN
 * for — carried on the engagement — not against whatever binds the hall by the time
 * the quotes come back.
 */

/** Enough to be a completed response schedule, and not so much that it is a DoS. */
const MAX_RESPONSES = 20;

export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const row = await getByToken(token);
  if (!row) return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });

  if (row.kind !== "procurement_spec") {
    return NextResponse.json(
      {
        ok: false,
        error:
          "Bid comparison is part of the Procurement Specification. This engagement is a " +
          `${row.kind.replace(/_/g, " ")}.`,
      },
      { status: 409 }
    );
  }
  if (row.status !== "released") {
    return NextResponse.json(
      { ok: false, error: "The specification has not been released yet." },
      { status: 409 }
    );
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid payload" }, { status: 400 });
  }

  const responses = body?.responses;
  if (!Array.isArray(responses) || responses.length === 0) {
    return NextResponse.json(
      { ok: false, error: "Send the completed response schedules as { responses: [ ... ] }." },
      { status: 422 }
    );
  }
  if (responses.length > MAX_RESPONSES) {
    return NextResponse.json(
      { ok: false, error: `That is more than ${MAX_RESPONSES} responses.` },
      { status: 422 }
    );
  }
  const shaped = responses.every(
    (r) => r && typeof r === "object" && !Array.isArray(r) && typeof (r as { supplier?: unknown }).supplier === "string"
  );
  if (!shaped) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "Each response must be a completed response_template.json with the supplier named. " +
          "Download the schedule from this engagement and have each supplier fill it in.",
      },
      { status: 422 }
    );
  }

  const out = await compareBids(row, responses as unknown[]);
  if (!out.ok) {
    return NextResponse.json({ ok: false, error: out.error }, { status: out.status });
  }

  // Kept with the engagement, as a working file, so it downloads through the same
  // route as everything else the customer bought and survives them closing the tab.
  const stored = await updateByToken(row.token, {
    working_files: {
      ...(row.working_files ?? {}),
      "bid_comparison.json": JSON.stringify(
        { relief: out.relief, sized_for_racks: out.sized_for_racks, ranked: out.ranked, note: out.note },
        null,
        2
      ),
    },
  });
  if (!stored) {
    // The comparison is still correct and still worth returning; say plainly that
    // it was not kept rather than implying they can come back to it.
    console.error("[GridForge] bid comparison not persisted for", row.token);
  }

  return NextResponse.json({
    ok: true,
    relief: out.relief,
    sized_for_racks: out.sized_for_racks,
    ranked: out.ranked,
    leading: out.leading,
    note: out.note,
    saved: stored,
  });
}
