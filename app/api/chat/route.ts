import { LADDER_PRODUCTS, eurFromCents } from "@/lib/products";
import { SITE_URL, siteUrl } from "@/lib/site";
import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { scoreLead, parseCapacityMW, type LeadInput } from "@/lib/lead";
import { extractLead } from "@/lib/extract";

export const runtime = "nodejs";

/**
 * The scoping engineer's brief, built from the catalogue.
 *
 * This was a confident, detailed briefing for a company that no longer exists:
 * containerised hybrid microgrids to 120 MW, a 400-800 V DC bus, an EMS doing
 * FCR/aFRR, and a fee list — Power Audit EUR 25k-45k, Feasibility Study EUR
 * 45k-95k — that appears nowhere in the engine's commercial catalogue.
 *
 * An assistant is the worst place for a stale claim. A page can be skimmed; an
 * assistant answers the specific question a buyer actually asked, in a tone that
 * sounds like it knows. Every engagement it could quote is now generated from
 * lib/products.ts, so the prompt cannot drift from what checkout charges.
 */
function engagementBrief(): string {
  return LADDER_PRODUCTS.map((p) => {
    const band = p.opensBandCents
      ? `${eurFromCents(p.opensBandCents[0])}–${eurFromCents(p.opensBandCents[1])} ` +
        `(deposit ${eurFromCents(p.amountCents)})`
      : eurFromCents(p.amountCents) + (p.recurring ? " recurring" : "");
    const days = p.turnaroundDays ? `, ${p.turnaroundDays} working days` : "";
    return `- ${p.name} — ${band}${days} — ${p.deliverable}`;
  }).join("\n");
}

const SYSTEM = `You are the GridForge AI scoping engineer — an independent power and thermal engineer. You speak with colocation operators, neocloud operators and data-centre developers.

WHAT GRIDFORGE DOES
- Answers one question about an EXISTING data hall: how much AI compute it can carry, which of thirteen electrical, thermal and physical constraints binds first, and what each step of extra density costs.
- Quotes no equipment, takes no margin on hardware, owns no energy assets and funds no physical deployment. If somebody needs plant built, we are not who builds it.
- The engine solves the hall against all thirteen constraints at once. The binding one is usually electrical — tap-off rating or busway ampacity — not cooling.

WHAT WE DO NOT DO
- We do not build, own, finance or operate microgrids, gensets, fuel cells, batteries or DC distribution. Do not offer any of it, even if the caller asks. Say plainly that it is out of scope and that we specify duty and interfaces only.
- No behind-the-meter capacity is sold by the megawatt here. Behind-the-meter supply appears in a study only as one relief option for a grid constraint, priced and lead-timed like any other rung.

ENGAGEMENTS (this is what they buy)
${engagementBrief()}

THE FREE THING TO OFFER FIRST
- /qualify takes seven numbers they already know and names the constraint that binds their hall, free, no account. Offer it before any fee. It also produces a link they can send to whoever owns the capital budget.
- /constraints publishes all thirteen in full, and /reference publishes a complete worked study. Point at those rather than describing them.

HOW YOU HELP (max value, honest boundary)
- Give genuine DIRECTIONAL reads: what is likely to bind given what they have said, why, and what it would take to move. Real engineering value — that is what makes them choose us over a contact form.
- NEVER give a bankable number, a capital cost or a programme date for free. Those are the paid engagement, and the engine enforces it server-side.
- Every figure is modelled, not measured. Our accuracy record against instrumented sites is currently empty and we say so on every response; if you quote a number, carry that with it.
- If the honest answer is that their hall cannot take the density they want, say so. A credible no is worth as much as a yes, and it is the reason to trust the yes.
- Move toward a next step: get platform, contracted MW, current site peak, busway ampacity and tap-off rating, then send them to /qualify. Ask for name, company and work email only once there is something worth following up.

Keep replies short (2–4 sentences usually). You are an engineer, not a marketer.`;

async function persistLead(record: Record<string, unknown>): Promise<void> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return;
  const auth: Record<string, string> = key.startsWith("sb_secret_")
    ? { apikey: key }
    : { apikey: key, Authorization: `Bearer ${key}` };
  try {
    const res = await fetch(`${url}/rest/v1/leads`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify(record),
    });
    // PostgREST rejects with a status, not a throw. Without this the only lead the
    // agent ever captures is dropped in silence — the most expensive kind of
    // failure this site has, because nothing downstream knows the person existed.
    if (!res.ok) {
      console.error(
        "[GridForge] agent lead NOT persisted:",
        res.status,
        await res.text(),
        JSON.stringify(record)
      );
    }
  } catch (err) {
    console.error("[GridForge] agent lead persist error:", err, JSON.stringify(record));
  }
}

export async function POST(req: Request) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    return NextResponse.json({ ok: false, error: "Agent not configured" }, { status: 503 });
  }

  let body: { messages?: { role: "user" | "assistant"; content: string }[]; captured?: boolean } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid payload" }, { status: 400 });
  }
  const messages = Array.isArray(body.messages) ? body.messages.slice(-20) : [];
  if (messages.length === 0) {
    return NextResponse.json({ ok: false, error: "No messages" }, { status: 400 });
  }

  const anthropic = new Anthropic({ apiKey: key });

  // 1) Generate the engineer's reply
  let reply = "";
  try {
    const resp = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      system: SYSTEM,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    });
    reply = resp.content.map((b) => (b.type === "text" ? b.text : "")).filter(Boolean).join("\n");
  } catch (err) {
    console.error("[GridForge] chat agent error:", err);
    return NextResponse.json({ ok: false, error: "Agent unavailable" }, { status: 500 });
  }

  // 2) Try to qualify + capture (only after enough turns, only once per session)
  let lead: { tier: string; score: number; captured: boolean } | null = null;
  if (messages.length >= 3 && !body.captured) {
    const extracted = await extractLead(messages, key);
    if (extracted) {
      const input: LeadInput = {
        capacity: extracted.capacity,
        location: extracted.location || "Not specified",
        urgency: extracted.urgency,
        gridStatus: extracted.gridStatus,
        services: extracted.services.length ? extracted.services : ["Not sure yet — need a recommendation"],
        message: extracted.message || "Captured via scoping agent",
        name: extracted.name || "Scoping-agent prospect",
        company: extracted.company || "Unknown (via agent)",
        email: extracted.email || "no-email@scoping-agent.local",
      };
      const { score, tier, reasons } = scoreLead(input);
      await persistLead({
        name: input.name,
        company: input.company,
        email: input.email,
        location: input.location,
        capacity_mw: parseCapacityMW(input.capacity),
        urgency: input.urgency,
        grid_status: input.gridStatus,
        services: input.services,
        message: input.message,
        context: "scoping-agent",
        source: "scoping-agent",
        score,
        tier,
        reasons,
        status: "new",
      });
      // Send the lead a branded confirmation (agent path mirrors the form path)
      const rkey = process.env.RESEND_API_KEY;
      const from = process.env.LEAD_FROM_EMAIL || "GridForge AI <power@timetopower.ai>";
      const leadEmail = extracted.email;
      if (rkey && leadEmail && leadEmail.includes("@") && !leadEmail.endsWith("@scoping-agent.local")) {
        const hot = tier === "hot";
        const next = hot
          ? "Your site qualifies as a priority engagement. We will respond within 1 business day. Reserve your Power Audit now: ${siteUrl('/pricing')}"
          : "We will review your site and respond within 1 business day. Start with a Power Audit: ${siteUrl('/pricing')}";
        try {
          await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: { Authorization: `Bearer ${rkey}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              from,
              to: [leadEmail],
              reply_to: process.env.LEAD_TO_EMAIL || "power@timetopower.ai",
              subject: `GridForge AI \u2014 your ${extracted.capacity} site scoping`,
              text:
                `Thank you for scoping your site with our engineer.\n\n` +
                `${next}\n\n` +
                `All information is held in strict confidence. An NDA is available immediately on request.\n\n` +
                `\u2014 GridForge AI`,
            }),
          });
        } catch (err) {
          console.error("[GridForge] agent lead confirmation error:", err);
        }
      }
      lead = { tier, score, captured: true };
    }
  }

  return NextResponse.json({ ok: true, reply, lead });
}
