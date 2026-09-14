import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { ADMIN_COOKIE, verifyAdminCookie } from "@/lib/admin";
import { createDeliverable } from "@/lib/deliverables";
import { toEngineBody, type QualifyInput } from "@/lib/qualify";

export const runtime = "nodejs";
export const maxDuration = 120;

const ENGAGEMENTS = ["density_screen", "envelope_study", "portfolio_screen"] as const;

// Turn a qualified hall into a priced proposal with a real finding in it.
//
// The engine has already solved this hall, so the proposal opens with the binding
// constraint and the rack counts before it names a price. A consultancy's proposal
// cannot do that, because producing the finding IS their engagement.
//
// The result is stored as a deliverable with its own link, so it can be emailed.
export async function POST(req: Request) {
  const store = await cookies();
  if (!verifyAdminCookie(store.get(ADMIN_COOKIE)?.value)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  let body: { inputs?: Partial<QualifyInput>; engagement?: string; company?: string; email?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid payload" }, { status: 400 });
  }

  const engagement = ENGAGEMENTS.includes(body.engagement as (typeof ENGAGEMENTS)[number])
    ? body.engagement
    : "density_screen";
  if (!body.inputs) {
    return NextResponse.json({ ok: false, error: "inputs required" }, { status: 422 });
  }

  const base = process.env.GRIDFORGE_API_URL;
  const key = process.env.GRIDFORGE_API_KEY;
  if (!base || !key) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "Proposals need the engine's paid endpoints. Set GRIDFORGE_API_URL and GRIDFORGE_API_KEY.",
      },
      { status: 503 }
    );
  }

  const engineIntake = toEngineBody(body.inputs as QualifyInput);

  try {
    const call = async (format: "html" | "md") => {
      const res = await fetch(`${base.replace(/\/$/, "")}/v1/proposal`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-Key": key },
        body: JSON.stringify({ intake: qualifyToIntake(engineIntake), engagement, format }),
        signal: AbortSignal.timeout(120_000),
        cache: "no-store",
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload?.error ?? `engine ${res.status}`);
      return payload as { title: string; document: string };
    };
    const [html, md] = await Promise.all([call("html"), call("md")]);

    const row = await createDeliverable({
      kind: "proposal",
      status: "released",
      email: body.email ?? null,
      company: body.company ?? null,
      title: html.title,
      document_html: html.document,
      document_md: md.document,
      released_at: new Date().toISOString(),
    });

    return NextResponse.json({
      ok: true,
      title: html.title,
      token: row?.token ?? null,
      url: row?.token ? `/deliverable/${row.token}` : null,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "engine unreachable" },
      { status: 502 }
    );
  }
}

/** The engine's /v1/qualify expands the short form into a sparse intake; /v1/proposal
 *  wants the intake itself, so do the same expansion here. Kept deliberately close to
 *  qualify_to_intake in gridforge/api/server.py. */
function qualifyToIntake(b: Record<string, unknown>): Record<string, unknown> {
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const grid: Record<string, unknown> = {
    contracted_MW: n(b.contracted_MW),
    current_site_peak_MW: n(b.current_site_peak_MW),
    current_it_load_MW: n(b.current_it_load_MW),
  };
  const contracted = n(b.contracted_MW);
  if (contracted !== undefined) grid.firm_capacity_MVA = contracted / 0.97;
  return {
    project: { client: String(b.client ?? "Qualified hall"), reference: "web" },
    site: { name: b.site_name, metro: b.metro, country: b.country },
    hall: { id: b.hall_id ?? "HALL-1", positions_available: n(b.positions_available) },
    grid,
    lv: { busway_ampacity_A: n(b.busway_ampacity_A), tapoff_max_A: n(b.tapoff_max_A) },
    thermal: { plant: { design_supply_C: n(b.plant_supply_C) } },
    compute: { platform: b.platform ?? "gb300_nvl72" },
    scenarios: ["hybrid_dlc", "full_dlc", "full_dlc_btm"],
  };
}
