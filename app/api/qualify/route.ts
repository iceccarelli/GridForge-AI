import { NextResponse } from "next/server";
import { engineUnavailableMessage } from "./unavailable-message";
import { callEngine, headline, newQualificationToken, qualifySchema } from "@/lib/qualify";
import { guardRequest, spendRefused } from "@/lib/rate-limit";
import { readBoundedJson } from "@/lib/http-body";

/** The seven numbers and a few short strings: the schema bounds every field, so anything near this size is not a hall. */
const MAX_BODY_BYTES = 32 * 1024;

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
  const body = await readBoundedJson(req, MAX_BODY_BYTES);
  if (!body.ok) {
    return NextResponse.json({ ok: false, error: body.status === 413 ? body.error : "Invalid payload" }, { status: body.status });
  }
  const raw = body.value;

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

  // Free-tier engine call, but still the company's engine: admitted by the request limit first (fails closed), and the call
  // itself is counted against the caller's provider budget and the shared free-tier ceiling.
  const g = await guardRequest(req, "qualify");
  if (g.denied) return g.denied;
  return g.run(async () => {
    // Minted before the engine runs, so a result that fails to persist still has an
    // identity and an unreachable engine still produces a row we can come back to.
    const token = newQualificationToken();

    const outcome = await callEngine(input);

    if (!outcome.ok) {
      // Never invent a number when the engine is unavailable. Capture the enquiry
      // and say plainly what happened.
      // A refusal by the spend gate is not an engine outage and is not a lead to chase: nothing is stored for it.
      const persisted = spendRefused()
        ? false
        : await persist(input, null, token).then(
            () => true,
            () => false
          );
      const status = outcome.reason === "unconfigured" ? 503 : 502;
      return NextResponse.json(
        {
          ok: false,
          error: engineUnavailableMessage(persisted, Boolean(input.email)),
          saved: persisted,
          reason: outcome.reason,
        },
        { status }
      );
    }

    const qualificationId = await persist(input, outcome.result, token).catch(() => undefined);
    const stored = qualificationId !== undefined;

    return NextResponse.json({
      ok: true,
      headline: headline(outcome.result),
      result: outcome.result,
      // Only offered when the row actually landed. A share link to a row that was
      // never written is a 404 sent to somebody's director.
      share: stored ? `/q/${token}` : null,
      // So a purchase made from this tab carries the read it came from. The id is
      // not a credential — the token in `share` is — and /q/ already renders it.
      qualificationId: qualificationId ?? null,
    });
  });
}

/**
 * Store the qualification and return its id.
 *
 * The id is what joins a later purchase to this read: checkout carries it, the
 * webhook writes it to `deliverables.qualification_id`, and the intake form seeds
 * itself from the numbers already typed here. Without it the customer who buys
 * from this very tab — the commonest path there is — opens an empty form and
 * retypes the seven numbers they just entered, after paying.
 *
 * Throws when the row did not land, which is what makes the caller return
 * `share: null` rather than a link to nothing.
 */
async function persist(
  input: Record<string, unknown>,
  result:
    | {
        as_found?: { racks?: number; binding_constraint?: string };
        after_relief?: { racks?: number };
        intake?: { completeness?: number };
      }
    | null,
  token: string
): Promise<string | null> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const record = {
    token,
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
    // Not persisted means not shareable. Throwing here is what makes the caller
    // return share: null rather than a link to nothing.
    throw new Error("supabase not configured");
  }
  const auth: Record<string, string> = key.startsWith("sb_secret_")
    ? { apikey: key }
    : { apikey: key, Authorization: `Bearer ${key}` };
  const res = await fetch(`${url}/rest/v1/qualifications`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json", Prefer: "return=representation" },
    body: JSON.stringify(record),
  });
  if (!res.ok) {
    const detail = await res.text();
    console.error("[GridForge] Supabase insert failed:", detail);
    throw new Error(detail);
  }
  // The id is a convenience for the join. A row that landed but whose id we could
  // not read back is still a stored qualification — the share link works, and the
  // purchase simply arrives unattached.
  try {
    const rows = (await res.json()) as { id?: string }[];
    return rows?.[0]?.id ?? null;
  } catch {
    return null;
  }
}
