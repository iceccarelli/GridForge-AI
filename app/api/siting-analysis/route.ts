import { NextResponse } from "next/server";
import { identify } from "@/lib/portal";
import { lookupSubscription, subscriptionsConfigured } from "@/lib/subscribers";
import Anthropic from "@anthropic-ai/sdk";
import { SITING_REGIONS, sitingScore } from "@/lib/siting";
import { anthropicFetch, guardRequest } from "@/lib/rate-limit";
import { readBoundedJson } from "@/lib/http-body";

/** A site brief is a few sentences. The ceiling bounds what a subscriber can make the paid model read. */
const MAX_BRIEF_CHARS = 4000;
const MAX_BODY_BYTES = 16 * 1024;

export const runtime = "nodejs";

// Subscriber-only AI siting analyst. Takes a site brief (MW, region pref,
// timeline, workload) and returns a deep regional recommendation grounded in
// the siting dataset + GridForge REF-01 engineering. Directional, not bankable.
export async function POST(req: Request) {
  // Identity first: the email comes from the verified Supabase bearer token. A
  // caller-supplied `email` is ignored (it used to be the credential, so knowing a
  // subscriber's address let anyone spend their LLM analyst).
  const who = await identify(req);
  if (!who.ok) return NextResponse.json({ ok: false, error: who.error }, { status: who.status });
  const email = who.email;

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return NextResponse.json({ ok: false, error: "Analyst unavailable" }, { status: 503 });

  const read = await readBoundedJson(req, MAX_BODY_BYTES);
  if (!read.ok) {
    return NextResponse.json({ ok: false, error: read.status === 413 ? read.error : "Invalid payload" }, { status: read.status });
  }
  const body = (read.value && typeof read.value === "object" ? read.value : {}) as { brief?: unknown };
  const brief = (typeof body.brief === "string" ? body.brief : "").trim();
  if (!brief) return NextResponse.json({ ok: false, error: "Missing input" }, { status: 400 });
  if (brief.length > MAX_BRIEF_CHARS) {
    return NextResponse.json({ ok: false, error: `The brief is too long (at most ${MAX_BRIEF_CHARS} characters).` }, { status: 413 });
  }

  // Verify the subscription server-side, through the one module that knows how.
  //
  // This gate used to be wrapped in `if (url && skey)`, which meant that with
  // Supabase unconfigured it was not a gate at all: the paid analyst answered
  // anybody who posted an email address. A gate that disappears when its
  // dependency is missing is worse than no gate, because the surface still reads
  // as protected. It fails closed now.
  if (!subscriptionsConfigured()) {
    return NextResponse.json(
      { ok: false, error: "Analyst unavailable" },
      { status: 503 }
    );
  }
  const found = await lookupSubscription(email);
  if (!found.reachable) {
    // Denied either way, but 402 would be a claim about this customer and the
    // fault is ours.
    return NextResponse.json({ ok: false, error: "Analyst unavailable" }, { status: 503 });
  }
  if (!found.subscription) {
    return NextResponse.json(
      { ok: false, error: "An active GridForge Intelligence subscription is required." },
      { status: 402 }
    );
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
- This is DIRECTIONAL, not bankable. End by pointing to the paid Density Screen for hall-specific confirmation.
- Be concise and technical: ~4-6 short paragraphs. You are an engineer, not a marketer.`;

  // Identity is verified and the subscription is active. Only now is the request admitted: per caller address AND per verified
  // account (so one subscriber cannot multiply the analyst budget across addresses), and the model call itself is counted
  // against the customer Anthropic budget.
  const g = await guardRequest(req, "siting", { cls: "customer", account: { verifiedEmail: email, policy: "siting_account" } });
  if (g.denied) return g.denied;
  return g.run(async () => {
    try {
      const anthropic = new Anthropic({ apiKey: key, fetch: anthropicFetch });
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
  });
}
