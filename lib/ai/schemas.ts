// Zod schemas for the structured blocks the chat agent may attach to a reply.
//
// The honesty kernel's rule is simple to state and easy to violate: a numeric
// figure never appears without the evidence class and provenance it carried
// out of the engine. These schemas are the seam that enforces that in code —
// a block that cannot be built from a real tool response cannot be built at
// all, because `evidence` and (where the engine supplied one) `digest` are
// required fields, not decorations.

import { z } from "zod";

/** E0 assumed … E7 observed in operation. Straight from the engine's own
 *  evidence ladder — see gridforge/validation/provenance.py. */
export const EVIDENCE_CLASSES = ["E0", "E1", "E2", "E3", "E4", "E5", "E6", "E7"] as const;
export const evidenceClassSchema = z.enum(EVIDENCE_CLASSES);
export type EvidenceClass = z.infer<typeof evidenceClassSchema>;

/**
 * A quantity as the engine reports it. `digest` is optional because not every
 * engine payload carries one (the lean /v1/qualify DTO does not; the model
 * pack and screen/study payloads do) — but where the engine supplied a
 * digest, it must be carried through unchanged, never regenerated here.
 */
export const quantitySchema = z.object({
  value: z.number(),
  low: z.number().nullable().optional(),
  high: z.number().nullable().optional(),
  unit: z.string(),
  evidence: evidenceClassSchema,
  digest: z.string().nullable().optional(),
  label: z.string().optional(),
});
export type Quantity = z.infer<typeof quantitySchema>;

/** Plain prose, with no numeric claim of its own — narration bound to
 *  whatever tool result produced it, or a scoping question. */
export const answerBlockSchema = z.object({
  type: z.literal("answer"),
  text: z.string().min(1),
});

/** One number, always carrying the evidence class and digest it left the
 *  engine with. */
export const metricBlockSchema = z.object({
  type: z.literal("metric"),
  label: z.string(),
  quantity: quantitySchema,
  /** Which tool call this metric was read from. */
  sourceTool: z.string(),
});

/** One of the thirteen physical constraints the engine evaluates. */
export const constraintBlockSchema = z.object({
  type: z.literal("constraint"),
  id: z.string(),
  name: z.string(),
  domain: z.string(),
  binds: z.boolean(),
  evidence: evidenceClassSchema.optional(),
  sourceTool: z.string(),
});

/** A required input the model does not have and must not guess. This is the
 *  block produced instead of a fabricated number. */
export const missingInputBlockSchema = z.object({
  type: z.literal("missingInput"),
  tool: z.string(),
  field: z.string(),
  description: z.string().optional(),
});

/** The provenance record for one quantity, surfaced on its own when the
 *  reader asks "how do you know that" rather than "what is it". */
export const evidenceBlockSchema = z.object({
  type: z.literal("evidence"),
  evidence: evidenceClassSchema,
  digest: z.string().nullable(),
  label: z.string(),
  calibrationNotice: z.string(),
});

/** A paid engagement or account action the reader can take — never a number,
 *  only a pointer to where the number would be bought. */
export const commercialActionBlockSchema = z.object({
  type: z.literal("commercialAction"),
  tool: z.string().optional(),
  reason: z.enum(["entitlement_required", "quota_exceeded", "engagement_offer"]),
  label: z.string(),
  href: z.string(),
});

/** A concrete next step, not tied to a purchase (e.g. "run /qualify", "share
 *  the busway ampacity"). */
export const nextActionBlockSchema = z.object({
  type: z.literal("nextAction"),
  label: z.string(),
  href: z.string().optional(),
});

export const agentBlockSchema = z.discriminatedUnion("type", [
  answerBlockSchema,
  metricBlockSchema,
  constraintBlockSchema,
  missingInputBlockSchema,
  evidenceBlockSchema,
  commercialActionBlockSchema,
  nextActionBlockSchema,
]);
export type AgentBlock = z.infer<typeof agentBlockSchema>;

/** One recorded tool call in a turn — what was asked of the engine and what
 *  came back, kept alongside the blocks so "no number without a tool call in
 *  this turn" is checkable by a caller, not just asserted. */
export const toolCallRecordSchema = z.object({
  tool: z.string(),
  args: z.record(z.string(), z.unknown()),
  ok: z.boolean(),
  status: z.number(),
  /** Present only on a successful call; never fabricated for a failed one. */
  digestOf: z.array(z.string()).optional(),
});
export type ToolCallRecord = z.infer<typeof toolCallRecordSchema>;

export const agentTurnResultSchema = z.object({
  reply: z.string(),
  blocks: z.array(agentBlockSchema).default([]),
  toolCalls: z.array(toolCallRecordSchema).default([]),
});
export type AgentTurnResult = z.infer<typeof agentTurnResultSchema>;
