// Translates the server's block contract (lib/ai/schemas.ts's AgentBlock,
// returned as JSON by /api/chat) into this directory's ResponseBlock
// contract (./types.ts), which every card in this directory renders.
//
// These are two real, independently-versioned contracts, not one schema
// duplicated by accident: the server's is the engine-honesty seam (every
// numeric field ties to a real tool call), the client's is the render seam
// (it also has to know which card to pick, and carries a couple of
// UI-only fields — metricKind, productId — the engine has no opinion on).
// This file is the one place they meet, and every block it builds is
// validated with this directory's own zod schemas before being handed to
// BlockRenderer, so a future drift between the two fails loudly (the block
// is dropped and logged) instead of rendering as nothing.
import {
  answerBlockSchema,
  commercialActionBlockSchema,
  constraintBlockSchema,
  evidenceBlockSchema,
  genericMetricSchema,
  missingInputBlockSchema,
  nextActionBlockSchema,
  type ResponseBlock,
} from "./types";

const DOMAINS = new Set(["electrical", "thermal", "physical", "economic"]);

const CALIBRATION_NOTE =
  "The calibration ledger is empty today: this engine has not yet been reconciled against " +
  "instrumented site data, so no accuracy record exists to quote. Every figure above is " +
  "modelled or measured at the class shown, not validated against a live site.";

/** Every paid next step the chat agent can offer today routes to the one
 *  Density Screen ladder step (lib/products.ts) — there is no second
 *  catalogue for the agent to pick from. */
const COMMERCIAL_PRODUCT_ID = "density_screen";

type ServerBlock = Record<string, unknown> & { type?: unknown };

function asString(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

export function adaptServerBlocks(raw: unknown): ResponseBlock[] {
  if (!Array.isArray(raw)) return [];
  const out: ResponseBlock[] = [];
  const evidenceItems: {
    label: string;
    evidenceClass: string;
    provenance: { digest: string; source: string };
  }[] = [];

  for (const entry of raw as ServerBlock[]) {
    if (!entry || typeof entry !== "object") continue;
    try {
      switch (entry.type) {
        case "answer": {
          out.push(answerBlockSchema.parse({ type: "answer", text: asString(entry.text, " ") || " " }));
          break;
        }
        case "metric": {
          const quantity = entry.quantity as Record<string, unknown> | undefined;
          if (!quantity || typeof quantity.value !== "number") break;
          out.push(
            genericMetricSchema.parse({
              type: "metric",
              metricKind: "generic",
              label: asString(entry.label, asString(quantity.label, "Value")),
              quantity: {
                value: quantity.value,
                low: typeof quantity.low === "number" ? quantity.low : undefined,
                high: typeof quantity.high === "number" ? quantity.high : undefined,
                unit: asString(quantity.unit),
                evidenceClass: quantity.evidence,
                provenance: {
                  digest: asString(quantity.digest, "not recorded"),
                  source: asString(entry.sourceTool, "gridforge"),
                },
                label: typeof quantity.label === "string" ? quantity.label : undefined,
              },
            })
          );
          break;
        }
        case "constraint": {
          const domainRaw = asString(entry.domain);
          out.push(
            constraintBlockSchema.parse({
              type: "constraint",
              id: asString(entry.id),
              name: asString(entry.name),
              domain: DOMAINS.has(domainRaw) ? domainRaw : "physical",
              basis: typeof entry.basis === "string" ? entry.basis : undefined,
              binding: Boolean(entry.binds),
            })
          );
          break;
        }
        case "missingInput": {
          out.push(
            missingInputBlockSchema.parse({
              type: "missingInput",
              input: asString(entry.field, "a required input"),
              required: true,
              whyItBinds: asString(entry.description, `Required by ${asString(entry.tool, "the engine")}.`),
              howToGetIt: "Share this value in the conversation and I will re-run the engine with it.",
            })
          );
          break;
        }
        case "evidence": {
          evidenceItems.push({
            label: asString(entry.label, "figure"),
            evidenceClass: asString(entry.evidence, "E0"),
            provenance: { digest: asString(entry.digest, "not recorded"), source: "gridforge engine" },
          });
          break;
        }
        case "commercialAction": {
          out.push(
            commercialActionBlockSchema.parse({
              type: "commercialAction",
              productId: COMMERCIAL_PRODUCT_ID,
              reason: asString(entry.label, "This is part of a paid engagement."),
              context: `chat-${asString(entry.reason, "engagement_offer")}`,
            })
          );
          break;
        }
        case "nextAction": {
          out.push(
            nextActionBlockSchema.parse({
              type: "nextAction",
              label: asString(entry.label),
              href: typeof entry.href === "string" ? entry.href : undefined,
            })
          );
          break;
        }
        default:
          break;
      }
    } catch (err) {
      // A block this directory's schema cannot validate is dropped, not
      // silently coerced and not allowed to crash the rest of the turn's
      // render — but it is not silent either.
      console.error("[GridForge] dropped unparseable response block", entry.type, err);
    }
  }

  if (evidenceItems.length > 0) {
    out.push(
      evidenceBlockSchema.parse({
        type: "evidence",
        items: evidenceItems,
        calibration: { empty: true, sampleSize: 0, note: CALIBRATION_NOTE },
      })
    );
  }

  return out;
}
