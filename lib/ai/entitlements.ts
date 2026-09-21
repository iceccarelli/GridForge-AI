// Server-side gate for paid tools, in front of the chat agent.
//
// This reuses the account/key model already defined in lib/api-access.ts —
// there is exactly one entitlement system in this product, and it is the one
// that mints and verifies gfk1.* keys for the metered API. The chat widget
// does not introduce a second one.
//
// gridforge_qualify is PUBLIC (tier "public", 0 units) and needs no
// entitlement at all — it is the free demo, same as the /qualify page and
// the MCP endpoint. Every other tool is "client" tier and metered, so it
// requires a live, non-expired API key tied to an account in good standing.
//
// The chat widget is anonymous — nobody types an API key into a corner
// widget. So in practice only gridforge_qualify ever actually runs from
// app/api/chat; the other seven are refused with a commercial-action block
// pointing at the paid engagement, exactly as the engine itself would refuse
// an unkeyed call with 402. That refusal is deliberately shaped as 402, not
// 429: a widget visitor without a key is not being rate limited, they need
// to buy the engagement.

import { inspectKey, keyLife } from "@/lib/api-access";
import type { ToolDef } from "./tools";

export interface EntitlementContext {
  /** A gfk1.* API key, if the caller supplied one. The chat widget never does
   *  today, but the loop is written so a future authenticated surface
   *  (e.g. the /workspace UI, owned by a different agent) can pass one. */
  apiKeyToken?: string | null;
}

export type EntitlementResult =
  | { allowed: true }
  | { allowed: false; status: 402; reason: "entitlement_required" | "quota_exceeded" | "key_expired"; detail: string };

/**
 * Is this caller entitled to call `tool`? Mirrors the engine's own
 * tier/metering semantics (gridforge/api/tiers.py, gridforge/api/metering.py):
 * PUBLIC tools need nothing, everything else needs a live key, and being
 * over quota — or having none at all — comes back as 402, never 429.
 */
export async function checkEntitlement(tool: ToolDef, ctx: EntitlementContext): Promise<EntitlementResult> {
  if (tool.tier === "public") return { allowed: true };

  const token = (ctx.apiKeyToken || "").trim();
  if (!token) {
    return {
      allowed: false,
      status: 402,
      reason: "entitlement_required",
      detail: `${tool.name} is a paid engine call. An active GridForge engagement or API key is required.`,
    };
  }

  const inspected = inspectKey(token);
  if (!inspected || !inspected.valid) {
    return {
      allowed: false,
      status: 402,
      reason: "entitlement_required",
      detail: "The supplied key does not verify.",
    };
  }

  const life = keyLife({ key_id: inspected.k, key_expires_at: inspected.e });
  if (life.expired) {
    return {
      allowed: false,
      status: 402,
      reason: "key_expired",
      detail: "This key has expired. Mint a fresh one from the account portal.",
    };
  }

  // A key that is unexpired and verifies is entitled to call the engine; the
  // engine's own metering (gridforge/api/metering.py) is the authority on
  // monthly quota, because it is the only place that sees actual usage this
  // month. If the caller is over quota the engine call itself will refuse
  // with 402, which callEngineTool (lib/ai/tools.ts) already surfaces as
  // reason "quota_exceeded" — this module does not duplicate that count.
  return { allowed: true };
}
