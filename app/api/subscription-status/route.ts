import { NextResponse } from "next/server";

export const runtime = "nodejs";

// Returns whether a given email has an active GridForge Intelligence subscription.
// Used by the /account dashboard to gate the live intelligence view.
export async function POST(req: Request) {
  let body: { email?: string } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, active: false }, { status: 400 });
  }
  const email = (body.email || "").trim().toLowerCase();
  if (!email) return NextResponse.json({ ok: true, active: false });

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return NextResponse.json({ ok: true, active: false });

  const auth: Record<string, string> = key.startsWith("sb_secret_")
    ? { apikey: key }
    : { apikey: key, Authorization: `Bearer ${key}` };

  try {
    const res = await fetch(
      `${url}/rest/v1/subscriptions?email=eq.${encodeURIComponent(email)}&status=eq.active&select=plan&limit=1`,
      { headers: { ...auth, Accept: "application/json" } }
    );
    if (!res.ok) return NextResponse.json({ ok: true, active: false });
    const rows = (await res.json()) as { plan: string }[];
    if (Array.isArray(rows) && rows.length > 0) {
      return NextResponse.json({ ok: true, active: true, plan: rows[0].plan });
    }
    return NextResponse.json({ ok: true, active: false });
  } catch {
    return NextResponse.json({ ok: true, active: false });
  }
}
