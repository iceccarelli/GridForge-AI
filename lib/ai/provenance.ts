// Pull evidence classes and provenance digests out of a raw engine response —
// never synthesize either. If the engine didn't say E0-E7 for a number, this
// module will not invent a class for it, and if the engine didn't supply a
// digest, `digest` comes back null rather than a locally-computed hash that
// would look load-bearing but proves nothing.

import { EVIDENCE_CLASSES, type EvidenceClass, type Quantity } from "./schemas";

const EVIDENCE_SET = new Set<string>(EVIDENCE_CLASSES);

/**
 * The engine's own evidence enum (gridforge/validation/evidence.py's
 * EvidenceClass) serializes over the wire as its full Python member name —
 * `_q()` in gridforge/serialize.py writes `q.evidence.name`, e.g.
 * "E0_ASSUMPTION", not the short "E0" this contract's own schema
 * (lib/ai/schemas.ts's EVIDENCE_CLASSES) uses. Every member name starts with
 * its short code followed by "_", so the code is always the text before the
 * first underscore — normalize to that before validating. A string that
 * isn't one of E0..E7 after normalizing is never coerced into one.
 */
function shortEvidenceCode(v: unknown): EvidenceClass | null {
  if (typeof v !== "string") return null;
  const short = v.split("_", 1)[0];
  return EVIDENCE_SET.has(short) ? (short as EvidenceClass) : null;
}

function isEvidenceClass(v: unknown): v is EvidenceClass {
  return shortEvidenceCode(v) !== null;
}

/** Does this object look like one of the engine's own quantity DTOs
 *  (lib/qualify.ts's QuantityDTO, or gridforge/serialize.py's `_q()` shape)? */
function looksLikeQuantity(v: unknown): v is Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  return typeof o.value === "number" && isEvidenceClass(o.evidence);
}

/** Normalize one engine quantity object into the block-ready shape. Passes
 *  digest and label through unchanged; never fills a missing digest. The
 *  evidence class is normalized to its short E0..E7 code (see
 *  shortEvidenceCode above) — everything else is passed through unchanged. */
export function toQuantity(raw: Record<string, unknown>): Quantity {
  return {
    value: raw.value as number,
    low: typeof raw.low === "number" ? raw.low : null,
    high: typeof raw.high === "number" ? raw.high : null,
    unit: typeof raw.unit === "string" ? raw.unit : "",
    evidence: shortEvidenceCode(raw.evidence) as EvidenceClass,
    digest: typeof raw.digest === "string" ? raw.digest : null,
    label: typeof raw.label === "string" ? raw.label : undefined,
  };
}

export interface FoundQuantity {
  /** Dotted path inside the engine response, e.g. "platform.rack_kW". */
  path: string;
  quantity: Quantity;
}

/**
 * Walk an arbitrary engine JSON payload and collect every quantity-shaped
 * leaf, with the path it was found at. Depth-bounded so a pathological
 * payload cannot make this loop forever; that bound is well above anything
 * the engine's own model pack nests to.
 */
export function extractQuantities(payload: unknown, maxDepth = 12): FoundQuantity[] {
  const out: FoundQuantity[] = [];
  function walk(node: unknown, path: string, depth: number) {
    if (depth > maxDepth || node === null || node === undefined) return;
    if (looksLikeQuantity(node)) {
      out.push({ path, quantity: toQuantity(node) });
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((v, i) => walk(v, `${path}[${i}]`, depth + 1));
      return;
    }
    if (typeof node === "object") {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        walk(v, path ? `${path}.${k}` : k, depth + 1);
      }
    }
  }
  walk(payload, "", 0);
  return out;
}

/** The weakest (numerically lowest) evidence class among a set of quantities —
 *  the same "arithmetic propagates the weakest input class" rule the engine's
 *  own report gates enforce (gridforge/reporting/gates.py). Used only to
 *  describe a bundle of figures to the reader, never to compute a new one. */
export function weakestEvidence(qs: Quantity[]): EvidenceClass | null {
  if (qs.length === 0) return null;
  return qs.reduce<EvidenceClass>((worst, q) => (q.evidence < worst ? q.evidence : worst), qs[0].evidence);
}

/** Standing disclosure: the calibration ledger is empty today. Every study
 *  section 14, /v1/calibration and every agent response that carries a
 *  number must say so — this is that sentence, in one place. */
export const CALIBRATION_NOTICE =
  "The calibration ledger is empty today: this engine has not yet been reconciled against " +
  "instrumented site data, so no accuracy record exists to quote. Every figure above is " +
  "modelled or measured at the class shown, not validated against a live site.";
