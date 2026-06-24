import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { scoreLead, parseCapacityMW, type LeadInput } from "@/lib/lead";
import { extractLead } from "@/lib/extract";

export const runtime = "nodejs";

const SYSTEM = `You are the GridForge AI scoping engineer — a senior power-systems engineer for behind-the-meter (BTM) power serving AI data centers. You speak with data-center developers, neocloud operators, and hyperscaler procurement.

WHAT GRIDFORGE DOES
- Independent, vendor-neutral, physics-first power-systems engineering.
- Helps AI sites get energized in months, not the 5–8 years of an interconnection queue, via behind-the-meter hybrid microgrids.
- Reference architecture REF-01: containerized, skid-mounted hybrid topology — gas/fuel-cell baseload + BESS + on-site renewables, DC-native coupling, N+1 redundancy, sized for spiky GPU training loads up to ~120 MW/site. Bypasses the queue, fuel-flexible, phased capacity.
- Also: REF-02 high-voltage DC distribution (400–800V DC bus, direct-to-rack), removes AC↔DC conversion stages.
- The EMS is physics-informed: handles sub-second AI-training load transients via FCR/aFRR grid standby + fuel cell + BESS + DC bus coordination.

ENGAGEMENTS (this is what they buy)
- Power Audit & Site Assessment — €25k–45k, 10–14 days — go/no-go + preliminary sizing. The entry point; most clients start here.
- Feasibility Study & Financial Model — €45k–95k, 3–5 weeks — bankable LCOE/IRR model + offtake options.
- Integration Design & Engineering — scoped per site — single-line diagrams, protection coordination, EMS architecture, ready-to-permit package.
- Commissioning & EMS Tuning — engagement-based.

HOW YOU HELP (max value, honest boundary)
- Give genuine DIRECTIONAL first-pass reads: rough sizing logic, queue-bypass options, BTM-vs-grid tradeoffs, whether their situation looks viable. Real engineering value — this is what makes them choose GridForge over a contact form.
- NEVER give a bankable number, guaranteed LCOE/IRR, or a final design for free. That's the paid Audit/Feasibility. Say so plainly.
- Be concise, technical, honest. If BTM is the wrong answer, say so — that honesty is the brand.
- Always move toward a next step: collect site details (MW, location, timeline, grid status) and route to the right engagement. Once you have MW + timeline + grid status, tell them you can qualify their site and recommend the entry engagement, and ask for their name, company, and work email so the team can follow up.

Keep replies short (2–4 sentences usually). You are an engineer, not a marketer.`;

async function persistLead(record: Record<string, unknown>): Promise<void> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return;
  const auth: Record<string, string> = key.startsWith("sb_secret_")
    ? { apikey: key }
    : { apikey: key, Authorization: `Bearer ${key}` };
  try {
    await fetch(`${url}/rest/v1/leads`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify(record),
    });
  } catch (err) {
    console.error("[GridForge] agent lead persist error:", err);
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
      lead = { tier, score, captured: true };
    }
  }

  return NextResponse.json({ ok: true, reply, lead });
}
