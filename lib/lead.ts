// Lead model, validation schema, and scoring — the shared contract between the
// audit form (client) and the /api/audit route (server). Keeping it in one
// place means the form and the API can never disagree about the shape or the
// score, and the scoring stays a pure, unit-testable function.

import * as z from "zod";

/** The four real, sellable services (mirrors SERVICES in lib/site.ts). */
export const SERVICE_OPTIONS = [
  "Power Audit & Site Assessment",
  "Feasibility Study & Financial Model",
  "Integration Design & Engineering",
  "Commissioning & EMS Tuning",
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

  // Service fit — design/feasibility intent is closer to revenue than browsing.
  if (input.services.some((s) => s.startsWith("Integration Design"))) {
    score += 10;
    reasons.push("Wants integration design (near-build)");
  } else if (input.services.some((s) => s.startsWith("Feasibility"))) {
    score += 8;
    reasons.push("Wants a bankable feasibility model");
  } else if (input.services.some((s) => s.startsWith("Power Audit"))) {
    score += 6;
    reasons.push("Entry-point audit interest");
  }

  score = Math.min(100, score);

  const tier: LeadTier = score >= 65 ? "hot" : score >= 40 ? "warm" : "exploratory";
  return { score, tier, reasons };
}
