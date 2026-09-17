// Lead model, validation schema, and scoring.
//
// NO LONGER A SELL SURFACE. This was the contract between the Power Audit form
// and /api/audit. The form is gone and the audit route is closed to the public:
// everything a visitor can press now commissions the Density Screen through
// Stripe, because that is the only thing on this site that is actually for sale.
//
// What survives is enquiry classification for the scoping assistant, which still
// wants to know whether the person it is talking to has a site or is browsing.
// The service list below is the catalogue, not the old consultancy's menu — an
// assistant that classifies an enquiry into "Feasibility Study & Financial Model"
// is classifying it into something nobody can buy.

import * as z from "zod";
import { LADDER_PRODUCTS, PRODUCTS } from "@/lib/products";

/**
 * What can actually be bought, for classifying an enquiry.
 *
 * Derived from the catalogue rather than typed, so a product added to
 * lib/products.ts is one the assistant can classify an enquiry into. The previous
 * list named four engagements — Power Audit, Feasibility Study, Integration
 * Design, Commissioning & EMS Tuning — none of which has a price, an intake, an
 * engine endpoint or a deliverable anywhere in this repository.
 */
export const SERVICE_OPTIONS = [
  ...LADDER_PRODUCTS.map((p) => p.name),
  "Not sure yet — need a recommendation",
] as const;

export const URGENCY_OPTIONS = ["immediate", "90days", "exploratory"] as const;
export const GRID_STATUS_OPTIONS = [
  "no_application",
  "in_queue",
  "study_phase",
  "offer_received",
  "unknown",
] as const;

// --- Validation schema (per-step fields grouped; one schema validates all) ---
export const leadSchema = z.object({
  // Step 1 — project shape
  capacity: z.string().min(1, "Approximate MW helps us size the read"),
  location: z.string().min(3, "Where is the site? (city / ISO / country)"),
  urgency: z.enum(URGENCY_OPTIONS),
  gridStatus: z.enum(GRID_STATUS_OPTIONS),
  // Step 2 — needs
  services: z.array(z.string()).min(1, "Pick at least one"),
  message: z.string().min(10, "A line or two about the project"),
  // Step 3 — contact
  name: z.string().min(2, "Your name"),
  company: z.string().min(2, "Company or organization"),
  email: z.string().email("A valid work email"),
});

export type LeadInput = z.infer<typeof leadSchema>;

/** Server-enriched record (what gets persisted / emailed). */
export interface LeadRecord extends LeadInput {
  context: string;
  source: string;
  capacityMW: number | null;
  score: number;
  tier: LeadTier;
  reasons: string[];
  createdAt: string;
}

export type LeadTier = "hot" | "warm" | "exploratory";

/** Parse a free-text capacity ("48 MW", "~120mw", "30") into a number. */
export function parseCapacityMW(raw: string | undefined | null): number | null {
  if (!raw) return null;
  const m = String(raw).replace(/,/g, "").match(/(\d+(\.\d+)?)/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return Number.isFinite(n) ? n : null;
}

/**
 * Score a lead 0–100 and bucket it. Pure function — no I/O, fully testable.
 * Signal weighting reflects what actually predicts a real BTM engagement:
 * scale (MW), urgency, whether they're already stuck in a queue, and service fit.
 */
export function scoreLead(input: LeadInput): {
  score: number;
  tier: LeadTier;
  reasons: string[];
} {
  const reasons: string[] = [];
  let score = 0;

  const mw = parseCapacityMW(input.capacity);
  if (mw !== null) {
    if (mw >= 100) {
      score += 35;
      reasons.push(`Hyperscale-class load (~${mw} MW)`);
    } else if (mw >= 30) {
      score += 25;
      reasons.push(`Material load (~${mw} MW)`);
    } else if (mw >= 10) {
      score += 12;
      reasons.push(`Mid-size load (~${mw} MW)`);
    } else {
      score += 4;
      reasons.push(`Small load (~${mw} MW)`);
    }
  }

  // Urgency — a selected site with a near date is the strongest buying signal.
  if (input.urgency === "immediate") {
    score += 30;
    reasons.push("Site selected, immediate timeline");
  } else if (input.urgency === "90days") {
    score += 18;
    reasons.push("Active this quarter");
  } else {
    score += 4;
    reasons.push("Exploratory timeline");
  }

  // Grid status — being stuck in a queue is exactly the pain BTM solves.
  switch (input.gridStatus) {
    case "in_queue":
    case "study_phase":
      score += 20;
      reasons.push("Already in the interconnection queue");
      break;
    case "offer_received":
      score += 14;
      reasons.push("Has an interconnection offer to beat");
      break;
    case "no_application":
      score += 10;
      reasons.push("No grid application yet — greenfield BTM");
      break;
    default:
      break;
  }

  // Service fit, against the catalogue. Named interest in a deeper engagement is
  // closer to revenue than interest in the entry product, which is closer than
  // "not sure yet".
  const wants = (id: keyof typeof PRODUCTS) =>
    input.services.some((s) => s.startsWith(PRODUCTS[id].name));
  if (wants("procurement_spec") || wants("portfolio_screen_deposit")) {
    score += 10;
    reasons.push("Wants a tender-stage or portfolio engagement");
  } else if (wants("envelope_study_deposit")) {
    score += 8;
    reasons.push("Wants the full envelope study");
  } else if (wants("density_screen")) {
    score += 6;
    reasons.push("Entry-point screen interest");
  }

  score = Math.min(100, score);

  const tier: LeadTier = score >= 65 ? "hot" : score >= 40 ? "warm" : "exploratory";
  return { score, tier, reasons };
}
