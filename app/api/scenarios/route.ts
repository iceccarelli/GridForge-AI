import { NextResponse } from "next/server";

export const runtime = "nodejs";

const SB = () => {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  const auth: Record<string, string> = key.startsWith("sb_secret_")
    ? { apikey: key }
    : { apikey: key, Authorization: `Bearer ${key}` };
  return { url, auth };
};

async function hasActiveSub(email: string): Promise<boolean> {
  const sb = SB();
  if (!sb || !email) return false;
  try {
    const r = await fetch(
      `${sb.url}/rest/v1/subscriptions?email=eq.${encodeURIComponent(email)}&status=eq.active&select=plan&limit=1`,
      { headers: { ...sb.auth, Accept: "application/json" } }
    );
    const rows = await r.json();
    return Array.isArray(rows) && rows.length > 0;
  } catch {
    return false;
  }
}

// GET ?email= -> list this subscriber's saved scenarios
export async function GET(req: Request) {
  const email = (new URL(req.url).searchParams.get("email") || "").trim().toLowerCase();
  if (!email || !(await hasActiveSub(email))) {
    return NextResponse.json({ ok: false, scenarios: [] }, { status: email ? 403 : 400 });
  }
  const sb = SB();
  if (!sb) return NextResponse.json({ ok: true, scenarios: [] });
  try {
    const r = await fetch(
      `${sb.url}/rest/v1/scenarios?email=eq.${encodeURIComponent(email)}&order=created_at.desc&select=*`,
      { headers: { ...sb.auth, Accept: "application/json" } }
    );
    const scenarios = await r.json();
    return NextResponse.json({ ok: true, scenarios: Array.isArray(scenarios) ? scenarios : [] });
  } catch {
    return NextResponse.json({ ok: true, scenarios: [] });
  }
}

// POST -> save a scenario
export async function POST(req: Request) {
  let b: Record<string, unknown> = {};
  try { b = await req.json(); } catch { return NextResponse.json({ ok: false }, { status: 400 }); }
  const email = String(b.email || "").trim().toLowerCase();
  if (!email || !(await hasActiveSub(email))) return NextResponse.json({ ok: false }, { status: 403 });
  const sb = SB();
  if (!sb) return NextResponse.json({ ok: false }, { status: 503 });
  try {
    const r = await fetch(`${sb.url}/rest/v1/scenarios`, {
      method: "POST",
      headers: { ...sb.auth, "Content-Type": "application/json", Prefer: "return=representation" },
      body: JSON.stringify({
        email,
        name: String(b.name || "Untitled site").slice(0, 80),
        mw: Number(b.mw) || 0,
        region_id: String(b.regionId || ""),
        value_per_mw_month: Number(b.valuePerMwMonth) || 0,
        months_saved: Number(b.monthsSaved) || 0,
        avoided_eur: Math.round(Number(b.avoidedEur) || 0),
      }),
    });
    const rows = await r.json();
    return NextResponse.json({ ok: true, scenario: Array.isArray(rows) ? rows[0] : rows });
  } catch {
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}

// DELETE ?email=&id= -> remove one
export async function DELETE(req: Request) {
  const sp = new URL(req.url).searchParams;
  const email = (sp.get("email") || "").trim().toLowerCase();
  const id = sp.get("id") || "";
  if (!email || !id || !(await hasActiveSub(email))) return NextResponse.json({ ok: false }, { status: 403 });
  const sb = SB();
  if (!sb) return NextResponse.json({ ok: false }, { status: 503 });
  try {
    await fetch(
      `${sb.url}/rest/v1/scenarios?id=eq.${encodeURIComponent(id)}&email=eq.${encodeURIComponent(email)}`,
      { method: "DELETE", headers: { ...sb.auth, Prefer: "return=minimal" } }
    );
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
