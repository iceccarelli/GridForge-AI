// Client-safe rules for the administrator's cost-evidence review screen. No I/O. These mirror — never replace — the
// rules the API and database enforce (lib/cost-evidence.ts, 0022): the screen only offers a control the server will
// accept, and the server still refuses the rest.

import type { EvidenceRow, EvidenceState } from "@/lib/cost-evidence";

export const REVIEW_BASES = ["budgetary_quote", "firm_quote", "contracted"] as const;
export const COMPARABILITIES = ["exact", "limited"] as const;

export const STATE_META: Record<EvidenceState, { label: string; tone: string; influences: boolean; meaning: string }> = {
  validated: {
    label: "validated",
    tone: "text-queue border-queue/50",
    influences: false,
    meaning: "Passed the engine's checks. Awaiting a decision. Influences no run.",
  },
  invalid: {
    label: "invalid",
    tone: "text-flag border-flag/50",
    influences: false,
    meaning: "Failed the engine's checks. Kept so the problem is visible. It can never be accepted or applied.",
  },
  accepted: {
    label: "accepted",
    tone: "text-verified border-verified/50",
    influences: true,
    meaning: "Accepted by a named reviewer. Offered to the next run for this engagement.",
  },
  rejected: {
    label: "rejected",
    tone: "text-mute border-line",
    influences: false,
    meaning: "Rejected by a named reviewer. Never applied. The decision is final.",
  },
  superseded: {
    label: "superseded",
    tone: "text-faint border-line border-dashed",
    influences: false,
    meaning: "Replaced by a newer accepted quotation for the same cost line. No longer applied; earlier runs still name it.",
  },
  withdrawn: {
    label: "withdrawn",
    tone: "text-flag border-flag/50 border-dashed",
    influences: false,
    meaning: "Withdrawn after acceptance. No longer applied; earlier runs still name it.",
  },
};

const today = () => new Date().toISOString().slice(0, 10);

export interface Eligibility {
  accept: boolean;
  reject: boolean;
  withdraw: boolean;
  /** Why accept is not offered, when the line is awaiting a decision but cannot be accepted. */
  blocked?: string;
}

/** What may be done to a line, from its state alone. */
export function eligibility(item: Pick<EvidenceRow, "state" | "valid_until" | "validation_status">, now = today()): Eligibility {
  if (item.state === "accepted") return { accept: false, reject: false, withdraw: true };
  if (item.state !== "validated") return { accept: false, reject: false, withdraw: false };
  const expired = !!item.valid_until && item.valid_until < now;
  return {
    accept: !expired,
    reject: true,
    withdraw: false,
    ...(expired ? { blocked: `Expired on ${item.valid_until}: it can be rejected but not accepted.` } : {}),
  };
}

export interface ReviewForm {
  decision: "accepted" | "rejected";
  reviewer: string;
  basis: string;
  comparability: string;
  region: string;
  includes: string;
  reason: string;
}

type Built = { ok: true; body: Record<string, unknown> } | { ok: false; error: string };

/** The body the review route takes, or the first thing missing. Nothing is defaulted. */
export function reviewBody(f: ReviewForm): Built {
  const reviewer = f.reviewer.trim();
  if (!reviewer) return { ok: false, error: "Your name is required: the person taking this decision." };
  if (f.decision === "rejected") {
    return { ok: true, body: { decision: "rejected", reviewer, reason: f.reason.trim() || undefined } };
  }
  if (!(REVIEW_BASES as readonly string[]).includes(f.basis)) return { ok: false, error: "Choose the basis of this quotation." };
  if (!(COMPARABILITIES as readonly string[]).includes(f.comparability)) return { ok: false, error: "Choose its comparability." };
  const includes_keys = f.includes.split(",").map((k) => k.trim()).filter(Boolean);
  if (includes_keys.length > 20) return { ok: false, error: "At most 20 included cost keys." };
  return {
    ok: true,
    body: {
      decision: "accepted",
      reviewer,
      basis: f.basis,
      comparability: f.comparability,
      includes_keys,
      region: f.region.trim(),
      reason: f.reason.trim() || undefined,
    },
  };
}

export function withdrawBody(f: { by: string; reason: string }): Built {
  const by = f.by.trim();
  if (!by) return { ok: false, error: "Your name is required: the person withdrawing this quotation." };
  return { ok: true, body: { retired_by: by, reason: f.reason.trim() || undefined } };
}
