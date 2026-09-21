// Builders that turn a real engine response (or the refusal to call one)
// into the structured blocks defined in schemas.ts. Every builder here reads
// a value out of the engine's own JSON or out of a typed refusal reason — it
// never invents a number, a label or an evidence class.

import type { EngineCallOutcome } from "./tools";
import { CALIBRATION_NOTICE, extractQuantities, weakestEvidence } from "./provenance";
import type { AgentBlock } from "./schemas";
import {
  commercialActionBlockSchema,
  constraintBlockSchema,
  evidenceBlockSchema,
  metricBlockSchema,
  missingInputBlockSchema,
} from "./schemas";
import { PRODUCTS, eurFromCents } from "@/lib/products";

/** One metric block per quantity-shaped leaf in the tool's response, labelled
 *  by its path in the payload. Keeps every value's evidence class and digest
 *  exactly as the engine reported them. */
export function metricsFromEngineResponse(toolName: string, body: unknown): AgentBlock[] {
  return extractQuantities(body).map(({ path, quantity }) =>
    metricBlockSchema.parse({
      type: "metric",
      label: quantity.label || path,
      quantity,
      sourceTool: toolName,
    })
  );
}

/** One evidence block per distinct evidence class found in the response, each
 *  carrying the always-true calibration disclosure. Used when the reader asks
 *  "how sure are you", not attached to every reply. */
export function evidenceSummary(toolName: string, body: unknown): AgentBlock[] {
  void toolName;
  const seen = new Set<string>();
  const out: AgentBlock[] = [];
  for (const { quantity } of extractQuantities(body)) {
    const key = `${quantity.evidence}|${quantity.digest ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(
      evidenceBlockSchema.parse({
        type: "evidence",
        evidence: quantity.evidence,
        digest: quantity.digest ?? null,
        label: quantity.label || "figure",
        calibrationNotice: CALIBRATION_NOTICE,
      })
    );
  }
  return out;
}

export function missingInputBlock(toolName: string, field: string, description?: string): AgentBlock {
  return missingInputBlockSchema.parse({ type: "missingInput", tool: toolName, field, description });
}

function slugId(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

/** The binding constraint the engine named for this hall, as a constraint
 *  block. Only /v1/qualify's `as_found.binding_constraint` carries this — a
 *  payload without it (a different tool, or a malformed response) yields no
 *  block rather than a guessed one. */
export function constraintFromQualify(toolName: string, body: unknown): AgentBlock[] {
  if (!body || typeof body !== "object") return [];
  const asFound = (body as Record<string, unknown>).as_found;
  if (!asFound || typeof asFound !== "object") return [];
  const af = asFound as Record<string, unknown>;
  const name = typeof af.binding_constraint === "string" ? af.binding_constraint : null;
  if (!name) return [];
  const domain = typeof af.domain === "string" ? af.domain : "unspecified";
  const basis = typeof af.basis === "string" ? af.basis : undefined;
  const evidence = weakestEvidence(extractQuantities(af).map((f) => f.quantity)) ?? undefined;
  return [
    constraintBlockSchema.parse({
      type: "constraint",
      id: slugId(name),
      name,
      domain,
      basis,
      binds: true,
      evidence,
      sourceTool: toolName,
    }),
  ];
}

/** The paid next step once a free qualify has named a binding constraint:
 *  Density Screen, priced from the one catalogue every checkout and every
 *  page reads (lib/products.ts) — never a number typed here, and never a
 *  second product list. */
export function engagementOfferBlock(toolName: string): AgentBlock {
  const product = PRODUCTS.density_screen;
  const creditsAgainst = product.creditsAgainst ? PRODUCTS[product.creditsAgainst] : null;
  const credit = creditsAgainst
    ? ` Credits in full against the ${creditsAgainst.name} if you go further.`
    : "";
  return commercialActionBlockSchema.parse({
    type: "commercialAction",
    tool: toolName,
    reason: "engagement_offer",
    label:
      `Commission the ${product.name} (${eurFromCents(product.amountCents)}) — the ${product.turnaroundDays}-day ` +
      `read on what binds this hall, racks as found and after the costed ladder, and what sets the date.${credit}`,
    href: "/pricing",
  });
}

/** Turn a refused engine call into the block the reader sees, matching the
 *  engine's own 402-not-429 semantics: quota/entitlement problems become a
 *  commercialAction pointing at the paid ladder, never a guessed answer. */
export function blockFromRefusal(toolName: string, outcome: Extract<EngineCallOutcome, { ok: false }>): AgentBlock {
  if (outcome.reason === "quota_exceeded") {
    return commercialActionBlockSchema.parse({
      type: "commercialAction",
      tool: toolName,
      reason: "quota_exceeded",
      label: "Over quota for this tier — the paid engagement covers this call.",
      href: "/pricing",
    });
  }
  return commercialActionBlockSchema.parse({
    type: "commercialAction",
    tool: toolName,
    reason: "entitlement_required",
    label: `${toolName} is part of a paid engagement.`,
    href: "/pricing",
  });
}
