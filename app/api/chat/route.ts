import { siteUrl } from "@/lib/site";
import { NextResponse } from "next/server";
import { scoreLead, parseCapacityMW, type LeadInput } from "@/lib/lead";
import { extractLead } from "@/lib/extract";
import { runTurn } from "@/lib/ai/agent";
import { normalizeTranscript } from "@/lib/ai/context";
import type { AgentBlock, ToolCallRecord } from "@/lib/ai/schemas";

export const runtime = "nodejs";

/**
 * The scoping engineer, now bound to the real engine.
 *
 * This used to call Anthropic directly with a hand-written system prompt and
 * return raw prose — every "directional read" was LLM narration, never a
 * tool result, which is exactly the honesty-kernel violation this product
 * exists to prevent everyone else from committing. It now runs the same
 * tool-calling orchestration loop as lib/ai/agent.ts: the model chooses a
 * GridForge tool, we call the real engine over HTTP (lib/ai/tools.ts,
 * following the callEngine() pattern in lib/qualify.ts), and only a real
 * tool result can produce a numeric claim in the reply.
 *
 * The response contract is unchanged: { ok, reply, lead }. ScopingAgent.tsx
 * (the corner widget) only reads those three fields and must keep working
 * without modification. `blocks` and `toolCalls` are additive — structured
 * data for a future or parallel surface to render, never required by the
 * widget.
 */
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

  let body: { messages?: unknown; captured?: boolean } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid payload" }, { status: 400 });
  }
  const messages = normalizeTranscript(body.messages);
  if (messages.length === 0) {
    return NextResponse.json({ ok: false, error: "No messages" }, { status: 400 });
  }

  // 1) Run the tool-calling loop. Every number in `reply` is bound to a real
  // engine call recorded in `toolCalls` — see lib/ai/agent.ts.
  let reply = "";
  let blocks: AgentBlock[] = [];
  let toolCalls: ToolCallRecord[] = [];
  try {
    const turn = await runTurn({ apiKey: key, messages });
    reply = turn.reply;
    blocks = turn.blocks;
    toolCalls = turn.toolCalls;
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
      const from = process.env.LEAD_FROM_EMAIL || "Time to Power <power@timetopower.ai>";
      const leadEmail = extracted.email;
      if (rkey && leadEmail && leadEmail.includes("@") && !leadEmail.endsWith("@scoping-agent.local")) {
        const hot = tier === "hot";
        // Template literals, not the double-quoted strings this used to be: those
        // mailed the characters ${siteUrl('/pricing')} to the customer verbatim.
        const next = hot
          ? `Your site qualifies as a priority engagement. We will respond within 1 business day. Commission the Density Screen now: ${siteUrl('/pricing')}`
          : `We will review your site and respond within 1 business day. Start with the Density Screen: ${siteUrl('/pricing')}`;
        try {
          await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: { Authorization: `Bearer ${rkey}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              from,
              to: [leadEmail],
              reply_to: process.env.LEAD_TO_EMAIL || "power@timetopower.ai",
              subject: `Time to Power — your ${extracted.capacity} site scoping`,
              text:
                `Thank you for scoping your site with our engineer.\n\n` +
                `${next}\n\n` +
                `All information is held in strict confidence. An NDA is available immediately on request.\n\n` +
                `— Time to Power`,
            }),
          });
        } catch (err) {
          console.error("[GridForge] agent lead confirmation error:", err);
        }
      }
      lead = { tier, score, captured: true };
    }
  }

  return NextResponse.json({ ok: true, reply, lead, blocks, toolCalls });
}
