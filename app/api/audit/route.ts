import { SITE_URL, siteUrl } from "@/lib/site";
import { NextResponse } from "next/server";
import { leadSchema, scoreLead, parseCapacityMW, type LeadRecord } from "@/lib/lead";

export const runtime = "nodejs";

// Lead-capture route. Validates with the shared schema, scores server-side
// (never trusts a client-supplied score for routing), then:
//   • persists to Supabase if SUPABASE_* env vars are set, and
//   • notifies via Resend / Slack for hot leads if configured.
// If nothing is configured it logs server-side and still returns ok, so the
// UX never silently fails. The form ALWAYS posts here; Formspree (if set) is a
// redundant server-side forward, not a bypass.
export async function POST(req: Request) {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid payload" }, { status: 400 });
  }

  const parsed = leadSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: "Validation failed", issues: parsed.error.flatten() },
      { status: 422 }
    );
  }
  const data = parsed.data;
  const meta = (raw ?? {}) as Record<string, unknown>;

  const { score, tier, reasons } = scoreLead(data);
  const record: LeadRecord = {
    ...data,
    context: typeof meta.context === "string" ? meta.context : "general",
    source: typeof meta.source === "string" ? meta.source : "gridforge.ai",
    capacityMW: parseCapacityMW(data.capacity),
    score,
    tier,
    reasons,
    createdAt: new Date().toISOString(),
  };

  await Promise.allSettled([persist(record), notify(record), forwardFormspree(record)]);

  // Don't leak internal scoring to the client.
  return NextResponse.json({ ok: true, tier });
}

// --- Optional Formspree forward (redundant email/archive; never the primary
// path). Reads either a dedicated server var or your existing public id, so
// submissions keep reaching Formspree without bypassing Supabase/scoring. -----
async function forwardFormspree(record: LeadRecord): Promise<void> {
  const id = process.env.FORMSPREE_FORWARD_ID || process.env.NEXT_PUBLIC_FORMSPREE_ID;
  if (!id) return;
  try {
    await fetch(`https://formspree.io/f/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        name: record.name,
        company: record.company,
        email: record.email,
        location: record.location,
        capacity: record.capacity,
        urgency: record.urgency,
        gridStatus: record.gridStatus,
        services: record.services.join(", "),
        tier: record.tier,
        score: record.score,
        source: record.context,
        message: record.message,
      }),
    });
  } catch (err) {
    console.error("[GridForge] Formspree forward error:", err);
  }
}

// --- Persistence (Supabase REST; no SDK dependency needed) -------------------
async function persist(record: LeadRecord): Promise<void> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.log("[GridForge] lead (not persisted — Supabase unset):", JSON.stringify(record));
    return;
  }
  // New secret keys (sb_secret_…) go on apikey only; legacy service_role JWTs
  // also need the Bearer header to elevate past RLS.
  const auth: Record<string, string> = key.startsWith("sb_secret_")
    ? { apikey: key }
    : { apikey: key, Authorization: `Bearer ${key}` };
  try {
    const res = await fetch(`${url}/rest/v1/leads`, {
      method: "POST",
      headers: {
        ...auth,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({
        name: record.name,
        company: record.company,
        email: record.email,
        location: record.location,
        capacity_mw: record.capacityMW,
        urgency: record.urgency,
        grid_status: record.gridStatus,
        services: record.services,
        message: record.message,
        context: record.context,
        source: record.source,
        score: record.score,
        tier: record.tier,
        reasons: record.reasons,
        status: "new",
      }),
    });
    if (!res.ok) console.error("[GridForge] Supabase insert failed:", await res.text());
  } catch (err) {
    console.error("[GridForge] Supabase insert error:", err);
  }
}

// --- Notification (Resend email always; Slack ping for hot leads) ------------
async function notify(record: LeadRecord): Promise<void> {
  const lines = [
    `Tier: ${record.tier.toUpperCase()}  (score ${record.score}/100)`,
    `Why: ${record.reasons.join("; ")}`,
    "",
    `Name:     ${record.name}`,
    `Company:  ${record.company}`,
    `Email:    ${record.email}`,
    `Location: ${record.location}`,
    `Capacity: ${record.capacity}`,
    `Timeline: ${record.urgency}`,
    `Grid:     ${record.gridStatus}`,
    `Services: ${record.services.join(", ")}`,
    `Source:   ${record.context}`,
    "",
    record.message,
  ].join("\n");

  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.LEAD_TO_EMAIL;
  const from = process.env.LEAD_FROM_EMAIL || "GridForge AI <onboarding@resend.dev>";
  if (apiKey && to) {
    try {
      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from,
          to: [to],
          reply_to: record.email,
          subject: `[${record.tier.toUpperCase()}] Audit — ${record.company} (${record.capacity})`,
          text: `New audit request via timetopower.ai\n\n${lines}`,
        }),
      });
    } catch (err) {
      console.error("[GridForge] Resend error:", err);
    }
  }

  // Confirmation email to the lead — closes the loop with a branded acknowledgment.
  const realEmail =
    record.email &&
    record.email.includes("@") &&
    !record.email.endsWith("@scoping-agent.local");
  if (apiKey && realEmail) {
    const hot = record.tier === "hot";
    const nextSteps = hot
      ? "Your site qualifies as a priority engagement. We will respond within 1 business day.\n\nYou can reserve your Power Audit now \u2014 a fully-credited deposit secures senior engineering capacity, and the Founding Partner credit applies while slots remain:\n${siteUrl('/pricing')}"
      : "We will review your site and respond within 1 business day.\n\nThe entry point is a Power Audit & Site Assessment (10\u201314 days): a clear go / no-go plus preliminary sizing. Details and pricing:\n${siteUrl('/pricing')}";
    try {
      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from,
          to: [record.email],
          reply_to: process.env.LEAD_TO_EMAIL || "power@timetopower.ai",
          subject: `GridForge AI \u2014 audit request received (${record.capacity} site)`,
          text:
            `Thank you for your request.\n\n` +
            `We received your submission for a ${record.capacity} site in ${record.location}.\n\n` +
            `${nextSteps}\n\n` +
            `All information is held in strict confidence. An NDA is available immediately on request.\n\n` +
            `\u2014 GridForge AI\nIndependent \u00b7 physics-first behind-the-meter power for AI`,
        }),
      });
    } catch (err) {
      console.error("[GridForge] Lead confirmation Resend error:", err);
    }
  }
  // Slack: only ping for hot leads, so the channel stays signal not noise.
  const slack = process.env.SLACK_WEBHOOK_URL;
  if (slack && record.tier === "hot") {
    try {
      await fetch(slack, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: `🔥 *HOT lead* — ${record.company} (${record.capacity})\n${record.reasons.join(
            "; "
          )}\n${record.email} · ${record.location}`,
        }),
      });
    } catch (err) {
      console.error("[GridForge] Slack error:", err);
    }
  }

  if (!apiKey || !to) {
    console.log("[GridForge] lead (no email provider set):", JSON.stringify(record));
  }
}
