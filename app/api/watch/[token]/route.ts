import { NextResponse } from "next/server";
import { engagementIntakeSchema, toIntakeDocument } from "@/lib/engagement-intake";
import { getWatch, nextRun, notesFor, recordNote, runWatch, updateWatch } from "@/lib/watches";
import { guardRequest } from "@/lib/rate-limit";
import { readBoundedJson } from "@/lib/http-body";

/** The same outer wall as the engagement intake: the schema bounds every field. */
const MAX_INTAKE_BYTES = 128 * 1024;

export const runtime = "nodejs";
export const maxDuration = 300;

// A watched hall.
//
// GET  -> the watch and its change notes.
// POST -> the client updated an input. Re-solve immediately and say what moved;
//         waiting for the next quarter to tell someone their answer changed would
//         be withholding the thing they are paying for.
export async function GET(_req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const w = await getWatch(token);
  if (!w) return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });
  const notes = w.id === "local" ? [] : await notesFor(w.id);
  return NextResponse.json({
    ok: true,
    watch: {
      status: w.status,
      cadence: w.cadence,
      site_name: w.site_name,
      hall_id: w.hall_id,
      company: w.company,
      has_intake: Boolean(w.intake),
      last_run_at: w.last_run_at,
      next_run_at: w.next_run_at,
    },
    notes: notes.map((n) => ({
      created_at: n.created_at,
      material: n.material,
      headline: n.headline,
      racks_delta: n.racks_delta,
      trigger: n.trigger,
    })),
  });
}

export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const w = await getWatch(token);
  if (!w) return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });
  if (w.status !== "active") {
    return NextResponse.json({ ok: false, error: "This watch is not active." }, { status: 409 });
  }

  const read = await readBoundedJson(req, MAX_INTAKE_BYTES);
  if (!read.ok) {
    return NextResponse.json({ ok: false, error: read.status === 413 ? read.error : "Invalid payload" }, { status: read.status });
  }
  const raw = read.value;
  const parsed = engagementIntakeSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: "Validation failed", issues: parsed.error.flatten() },
      { status: 422 }
    );
  }
  // The token (a purchase) has been resolved and the input validated. Admit the request against the CUSTOMER budgets, then
  // every engine call inside `run` is counted individually; anonymous traffic cannot starve this, nor this that.
  const g = await guardRequest(req, "customer_generate", { cls: "customer" });
  if (g.denied) return g.denied;
  return g.run(async () => {
    const doc = toIntakeDocument(parsed.data, w.company ?? undefined);

    // Compare the hall as it was on record against the hall as it is now, so the
    // note can name the input that moved rather than only the size of the move.
    const out = await runWatch(doc, w.last_state, w.intake ?? undefined);
    if (!out.ok) {
      // intake and last_state move together or not at all. Saving the new intake
      // here without a matching last_state would make the NEXT change be diffed
      // against a baseline from a different hall, and misattributed.
      return NextResponse.json(
        {
          ok: false,
          error:
            "The model could not be re-solved just now, so your updated numbers were NOT saved " +
            "and your watch still shows the previous ones. Nothing was invented — please submit again shortly.",
          detail: out.error,
        },
        { status: 502 }
      );
    }

    const d = out.diff;
    if (w.id !== "local") {
      const noted = await recordNote({
        watch_id: w.id,
        material: Boolean(d.material),
        headline: d.headline,
        racks_delta: d.racks_delta,
        weeks_delta: d.weeks_delta,
        binding_moved: d.binding_moved,
        document_html: (d.document_full as string) ?? (d.document as string) ?? null,
        document_md: d.markdown ?? null,
        change: d,
        trigger: "inputs_updated",
      });
      if (!noted) {
        return NextResponse.json(
          { ok: false, error: "We could not record the change note just now, so nothing was saved. Please submit again shortly." },
          { status: 503 }
        );
      }
    }
    const saved = await updateWatch(token, {
      intake: doc,
      last_state: d.after,
      last_run_at: new Date().toISOString(),
      next_run_at: nextRun(new Date(), w.cadence),
      site_name: parsed.data.siteName,
      hall_id: parsed.data.hallId,
    });
    if (!saved) {
      return NextResponse.json(
        { ok: false, error: "We could not save your updated numbers just now. Please submit again shortly." },
        { status: 503 }
      );
    }

    return NextResponse.json({ ok: true, headline: d.headline, material: d.material });
  });
}
