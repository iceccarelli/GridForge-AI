import { NextResponse } from "next/server";
import { submitObservation } from "@/lib/project-observations";
import { fail, readJson, withProject } from "@/lib/project-http";

export const runtime = "nodejs";

// Report what was measured against an exact stored prediction. The expected value is read from the
// engine's stored result, never from this body; the submission carries no evidence class — only an
// admin's separate review does — and it never touches the calibration ledger.
export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const p = await withProject(ctx);
  if (!p.ok) return p.res;
  const body = await readJson(req);
  if (!body) return fail({ status: 400, error: "Expected a JSON object." });
  const r = await submitObservation(p.project, body);
  if (!r.ok) return fail(r);
  const o = r.observation;
  return NextResponse.json(
    {
      ok: true,
      observation: {
        id: o.id, prediction_ref: o.prediction_ref, predicted_value: o.predicted_value,
        observed_value: o.observed_value, delta_value: o.delta_value, delta_pct: o.delta_pct,
        state: "submitted",
      },
    },
    { status: 201 }
  );
}
