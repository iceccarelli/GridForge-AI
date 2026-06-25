import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { SITING_REGIONS, sitingScore } from "@/lib/siting";

export const runtime = "nodejs";

// Subscriber-only AI siting analyst. Takes a site brief (MW, region pref,
// timeline, workload) and returns a deep regional recommendation grounded in
// the siting dataset + GridForge REF-01 engineering. Directional, not bankable.
export async function POST(req: Request) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return NextResponse.json({ ok: false, error: "Analyst unavailable" }, { status: 503 });

  // Gate: require an active subscription (email passed from the authed client).
  let body: { email?: string; brief?: string } = {};
  try { body = await req.json(); } catch {
    return NextResponse.json({ ok: false, error: "Invalid payload" }, { status: 400 });
  }
  const email = (body.email || "").trim().toLowerCase();
  const brief = (body.brief || "").trim();
  if (!email || !brief) return NextResponse.json({ ok: false, error: "Missing input" }, { status: 400 });

  // Verify active subscription server-side.
  const url = process.env.SUPABASE_URL;
  const skey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (url && skey) {
    const auth: Record<string, string> = skey.startsWith("sb_secret_")
      ? { apikey: skey } : { apikey: skey, Authorization: `Bearer ${skey}` };
    try {
      const r = await fetch(
        `${url}/rest/v1/subscriptions?email=eq.${encodeURIComponent(email)}&status=eq.active&select=plan&limit=1`,
        { headers: { ...auth, Accept: "application/json" } }
      );
      const rows = await r.json();
      if (!Array.isArray(rows) || rows.length === 0) {
        return NextResponse.json({ ok: false, error: "No active subscription" }, { status: 403 });
      }
    } catch {
      return NextResponse.json({ ok: false, error: "Auth check failed" }, { status: 500 });
    }
  }

  const ranked = [...SITING_REGIONS]
    .map((r) => ({ ...r, score: sitingScore(r) }))
    .sort((a, b) => b.score - a.score);

  const dataset = ranked
    .map(
      (r) =>
        `${r.market} / ${r.region}: score ${r.score}, power ~EUR${r.powerCost}/MWh (${r.powerCostProvenance}), ` +
        `queue ~${r.queueWaitMonths}mo, BTM ~${r.btmMonths}mo, renewables ${r.renewablePct}% (${r.renewableProvenance}), ` +
        `congestion ${r.congestion}/100. ${r.note}`
    )
    .join("\n");

  const system = `You are the GridForge Intelligence siting analyst — a senior power-systems engineer producing a directional behind-the-meter (BTM) siting recommendation for an AI data center.

Use ONLY this regional dataset (mix of live + modeled figures; respect the provenance labels):
${dataset}

Rules:
- Give a clear recommendation: rank the top 2-3 regions for THIS specific brief and say why.
- Always frame BTM as the queue-bypass: compare the modeled interconnection-queue wait vs the BTM time-to-energized.
- Distinguish LIVE vs MODELED figures explicitly where it matters ("Germany's cost is live EPEX; US figures are modeled estimates").
- This is DIRECTIONAL, not bankable. End by pointing to a paid Power Audit for site-specific confirmation.
- Be concise and technical: ~4-6 short paragraphs. You are an engineer, not a marketer.`;

  try {
    const anthropic = new Anthropic({ apiKey: key });
    const resp = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1200,
      system,
      messages: [{ role: "user", content: brief }],
    });
    const text = resp.content.map((b) => (b.type === "text" ? b.text : "")).filter(Boolean).join("\n");
    return NextResponse.json({ ok: true, analysis: text });
  } catch (err) {
    console.error("[GridForge] siting analysis error:", err);
    return NextResponse.json({ ok: false, error: "Analyst error" }, { status: 500 });
  }
}
