import { NextResponse } from "next/server";
import { callEngine, headline, qualifySchema } from "@/lib/qualify";

export const runtime = "nodejs";

// Capacity qualifier. Seven numbers in, a real binding constraint out.
//
// What this is NOT: a lead form with a score attached. It runs the same engine
// that produces the paid deliverable, on the same constraint set, and returns the
// directional half of it — the binding constraint, the rack counts, and the list
// of inputs nobody has measured. Capital cost, programme duration and the full
// ladder stay behind the engagement; the engine enforces that server-side, not
// this route.
export async function POST(req: Request) {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid payload" }, { status: 400 });
  }

  const parsed = qualifySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: "Validation failed", issues: parsed.error.flatten() },
      { status: 422 }
    );
  }
  const input = parsed.data;

  if (input.currentPeakMW > input.contractedMW) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "Peak demand exceeds contracted capacity. Check the figures — if that is genuinely the case, the site is already over its contract and that is the first conversation to have.",
      },
      { status: 422 }
    );
  }

  const outcome = await callEngine(input);

  if (!outcome.ok) {
    // Never invent a number when the engine is unavailable. Capture the enquiry
    // and say plainly what happened.
    await persist(input, null).catch(() => undefined);
    const status = outcome.reason === "unconfigured" ? 503 : 502;
    return NextResponse.json(
      {
        ok: false,
        error:
          "The capacity engine could not be reached, so no result was produced. Your figures were saved and we will come back with the read.",
        reason: outcome.reason,
      },
      { status }
    );
  }

  await persist(input, outcome.result).catch(() => undefined);

  return NextResponse.json({
    ok: true,
    headline: headline(outcome.result),
    result: outcome.result,
  });
}

async function persist(
  input: Record<string, unknown>,
  result:
    | {
        as_found?: { racks?: number; binding_constraint?: string };
        after_relief?: { racks?: number };
        intake?: { completeness?: number };
      }
    | null
): Promise<void> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const record = {
    site_name: input.siteName ?? null,
    hall_id: input.hallId ?? null,
    metro: input.metro ?? null,
    country: input.country ?? null,
    platform: input.platform ?? null,
    inputs: input,
    racks_as_found: result?.as_found?.racks ?? null,
    racks_after_relief: result?.after_relief?.racks ?? null,
    binding_constraint: result?.as_found?.binding_constraint ?? null,
    intake_completeness: result?.intake?.completeness ?? null,
    name: input.name ?? null,
    company: input.company ?? null,
    email: input.email ?? null,
    source: "gridforge.ai/qualifier",
    status: result ? "scored" : "engine_unavailable",
  };
  if (!url || !key) {
    console.log(
      "[GridForge] qualification (not persisted — Supabase unset):",
      JSON.stringify(record)
    );
    return;
  }
  const auth: Record<string, string> = key.startsWith("sb_secret_")
    ? { apikey: key }
    : { apikey: key, Authorization: `Bearer ${key}` };
  const res = await fetch(`${url}/rest/v1/qualifications`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify(record),
  });
  if (!res.ok) console.error("[GridForge] Supabase insert failed:", await res.text());
}
