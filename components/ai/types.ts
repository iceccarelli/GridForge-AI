import { z } from "zod";

// The shared response-block contract.
//
// This mirrors reports/TTP-AI-AGENT-PLAN.md's "shared contract" section, which
// Agent 2 (branch agent/ttp-ai-core, not merged yet) implements on the server as
// the producer, and this file implements as the consumer. It is deliberately a
// local copy rather than an import from lib/ai/** — that directory is owned by
// the parallel core agent and out of scope here. When PR1 (core) lands, the real
// /api/chat route should emit JSON matching these shapes; only components/ai/mock.ts
// and the fetch call in Conversation.tsx need to change, not the card components.
//
// Non-negotiable rules encoded in these types (see reports/TTP-AI-AUDIT.md and
// the gridforge honesty-kernel skill):
//   - every numeric field for capacity/racks/MW/dates must carry an evidence
//     class (E0 assumed .. E7 observed in operation) and a provenance digest —
//     there is no numeric field in this file without one;
//   - calibration state is a required, non-optional field on the evidence
//     block — "empty" must be rendered, never omitted;
//   - commercialAction only ever carries a ProductId from lib/products.ts, never
//     a free-floating price or label.

export const EVIDENCE_CLASSES = [
  "E0",
  "E1",
  "E2",
  "E3",
  "E4",
  "E5",
  "E6",
  "E7",
] as const;
export type EvidenceClass = (typeof EVIDENCE_CLASSES)[number];

export const EVIDENCE_CLASS_LABEL: Record<EvidenceClass, string> = {
  E0: "Assumed",
  E1: "Modelled",
  E2: "Simulated",
  E3: "Estimated",
  E4: "Validated against test data",
  E5: "Measured at site (customer data)",
  E6: "Field-validated",
  E7: "Observed in operation",
};

const evidenceClassSchema = z.enum(EVIDENCE_CLASSES);

const provenanceSchema = z.object({
  /** Short content digest identifying exactly which engine call produced this number. */
  digest: z.string(),
  /** Which gridforge_* tool / engine endpoint produced it. */
  source: z.string(),
});
export type Provenance = z.infer<typeof provenanceSchema>;

/** A number that came from the engine, never from LLM prose. */
export const quantitySchema = z.object({
  value: z.number(),
  low: z.number().optional(),
  high: z.number().optional(),
  unit: z.string(),
  evidenceClass: evidenceClassSchema,
  provenance: provenanceSchema,
  label: z.string().optional(),
});
export type Quantity = z.infer<typeof quantitySchema>;

// --- answer -------------------------------------------------------------

export const answerBlockSchema = z.object({
  type: z.literal("answer"),
  text: z.string(),
});
export type AnswerBlock = z.infer<typeof answerBlockSchema>;

// --- metric ---------------------------------------------------------------
// One block type, several rendering shapes. `metricKind` picks the card:
// capacity -> CapacityCard, headroomLadder -> HeadroomLadderCard,
// timeToPower -> TimeToPowerCard, generic -> a plain metric tile.

export const capacityMetricSchema = z.object({
  type: z.literal("metric"),
  metricKind: z.literal("capacity"),
  hallLabel: z.string(),
  platform: z.string(),
  racksAsFound: quantitySchema,
  racksAfterRelief: quantitySchema.optional(),
  itLoadKW: quantitySchema.optional(),
});
export type CapacityMetricBlock = z.infer<typeof capacityMetricSchema>;

export const headroomStepSchema = z.object({
  step: z.number().int(),
  label: z.string(),
  racks: quantitySchema,
  reliefDescription: z.string().optional(),
  capexEur: quantitySchema.optional(),
  leadTimeWeeks: quantitySchema.optional(),
});
export type HeadroomStep = z.infer<typeof headroomStepSchema>;

export const headroomLadderMetricSchema = z.object({
  type: z.literal("metric"),
  metricKind: z.literal("headroomLadder"),
  hallLabel: z.string(),
  steps: z.array(headroomStepSchema).min(1),
});
export type HeadroomLadderMetricBlock = z.infer<typeof headroomLadderMetricSchema>;

export const timeToPowerPointSchema = z.object({
  month: z.number(),
  queueMW: z.number().nullable().optional(),
  onSiteMW: z.number().nullable().optional(),
});

export const timeToPowerMetricSchema = z.object({
  type: z.literal("metric"),
  metricKind: z.literal("timeToPower"),
  hallLabel: z.string(),
  queueMonths: quantitySchema,
  onSiteMonths: quantitySchema,
  monthsRecovered: quantitySchema,
  series: z.array(timeToPowerPointSchema).optional(),
});
export type TimeToPowerMetricBlock = z.infer<typeof timeToPowerMetricSchema>;

export const genericMetricSchema = z.object({
  type: z.literal("metric"),
  metricKind: z.literal("generic"),
  label: z.string(),
  quantity: quantitySchema,
});
export type GenericMetricBlock = z.infer<typeof genericMetricSchema>;

export const metricBlockSchema = z.discriminatedUnion("metricKind", [
  capacityMetricSchema,
  headroomLadderMetricSchema,
  timeToPowerMetricSchema,
  genericMetricSchema,
]);
export type MetricBlock = z.infer<typeof metricBlockSchema>;

// --- constraint -------------------------------------------------------------

export const constraintBlockSchema = z.object({
  type: z.literal("constraint"),
  id: z.string(),
  name: z.string(),
  domain: z.enum(["electrical", "thermal", "physical", "economic"]),
  basis: z.string(),
  maxRacks: quantitySchema,
  binding: z.boolean(),
  relief: z
    .object({
      description: z.string(),
      capexEur: quantitySchema.optional(),
      leadTimeWeeks: quantitySchema.optional(),
    })
    .optional(),
});
export type ConstraintBlock = z.infer<typeof constraintBlockSchema>;

// --- missingInput -------------------------------------------------------------

export const missingInputBlockSchema = z.object({
  type: z.literal("missingInput"),
  input: z.string(),
  unit: z.string().optional(),
  required: z.boolean(),
  assumed: z.string().optional(),
  whyItBinds: z.string(),
  howToGetIt: z.string(),
});
export type MissingInputBlock = z.infer<typeof missingInputBlockSchema>;

// --- evidence -----------------------------------------------------------------

export const calibrationStateSchema = z.object({
  /** True today: the calibration ledger is empty. Must always be rendered, never hidden. */
  empty: z.boolean(),
  sampleSize: z.number().int().nonnegative(),
  note: z.string(),
});
export type CalibrationState = z.infer<typeof calibrationStateSchema>;

export const evidenceItemSchema = z.object({
  label: z.string(),
  evidenceClass: evidenceClassSchema,
  provenance: provenanceSchema,
});

export const evidenceBlockSchema = z.object({
  type: z.literal("evidence"),
  items: z.array(evidenceItemSchema),
  calibration: calibrationStateSchema,
});
export type EvidenceBlock = z.infer<typeof evidenceBlockSchema>;

// --- commercialAction -----------------------------------------------------------

export const productIdSchema = z.enum([
  "density_screen",
  "envelope_study_deposit",
  "portfolio_screen_deposit",
  "hall_watch",
  "procurement_spec",
  "api_triage",
  "api_scale",
  "api_platform",
]);

export const commercialActionBlockSchema = z.object({
  type: z.literal("commercialAction"),
  productId: productIdSchema,
  reason: z.string(),
  /** Free-text attribution tag carried to Stripe metadata.service. */
  context: z.string().optional(),
});
export type CommercialActionBlock = z.infer<typeof commercialActionBlockSchema>;

// --- nextAction -----------------------------------------------------------------

export const nextActionBlockSchema = z.object({
  type: z.literal("nextAction"),
  label: z.string(),
  description: z.string().optional(),
  href: z.string().optional(),
  /** A follow-up prompt to send back into the conversation, when there is no href. */
  prompt: z.string().optional(),
});
export type NextActionBlock = z.infer<typeof nextActionBlockSchema>;

// --- union -----------------------------------------------------------------

export const responseBlockSchema = z.union([
  answerBlockSchema,
  metricBlockSchema,
  constraintBlockSchema,
  missingInputBlockSchema,
  evidenceBlockSchema,
  commercialActionBlockSchema,
  nextActionBlockSchema,
]);
export type ResponseBlock =
  | AnswerBlock
  | MetricBlock
  | ConstraintBlock
  | MissingInputBlock
  | EvidenceBlock
  | CommercialActionBlock
  | NextActionBlock;

// --- tool activity -----------------------------------------------------------------
// Not itself a response block in the shared contract — a transport-level record of
// which gridforge_* tool the server called to back the blocks in a turn. Shown by
// ToolActivity so the workspace never presents a number without saying which real
// tool produced it.

export const toolCallSchema = z.object({
  tool: z.enum([
    "gridforge_qualify",
    "gridforge_screen",
    "gridforge_study",
    "gridforge_portfolio",
    "gridforge_diff",
    "gridforge_spec",
    "gridforge_bids",
    "gridforge_proposal",
  ]),
  status: z.enum(["running", "ok", "error"]),
  detail: z.string().optional(),
  durationMs: z.number().optional(),
});
export type ToolCall = z.infer<typeof toolCallSchema>;

// --- the chat turn -----------------------------------------------------------------

export const assistantTurnSchema = z.object({
  toolCalls: z.array(toolCallSchema).default([]),
  blocks: z.array(responseBlockSchema).default([]),
});
export type AssistantTurn = z.infer<typeof assistantTurnSchema>;

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  turn?: AssistantTurn;
}
