// Server-only, pure: the identity of a cost-evidence run.
//
// A run's identity is a versioned, canonical fingerprint of everything that can change the document it produces:
//
//   engagement (deliverable)            WHICH engagement it belongs to
//   intake digest                       the exact cleaned intake the engine is given
//   accepted-snapshot digest            EVERY accepted line handed to the engine, including any it then ignores
//   engine fingerprint                  the engine build + cost library + calibration ledger that produced it
//   request options                     the engine request options that shape the output
//
// It deliberately does NOT cover the evidence the engine reported USING (that is a result, not an input; deriving the
// identity from it is what let a changed engine or an ignored line collide with an old run), nor the wall clock (the
// date printed on a document is recorded beside the run, not inside its identity).

import crypto from "node:crypto";

export const RUN_IDENTITY_VERSION = "gridforge/cost-evidence-run/1";

/** The engine request options that materially shape the document. Frozen into every identity. */
export const RUN_REQUEST_OPTIONS = { endpoint: "/v1/study", format: "html", evidence: "accepted-overlay" } as const;

/**
 * Deterministic JSON: object keys sorted, no whitespace, `undefined` object members omitted. Array order is preserved
 * (callers sort a collection only where its semantics are a set). Non-finite numbers are refused, never coerced.
 */
export function canonical(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? "null" : canonical(x))).join(",")}]`;
  switch (typeof v) {
    case "number":
      if (!Number.isFinite(v)) throw new Error("canonical: a non-finite number has no canonical form");
      return JSON.stringify(v);
    case "string":
    case "boolean":
      return JSON.stringify(v);
    case "object": {
      const o = v as Record<string, unknown>;
      return `{${Object.keys(o)
        .filter((k) => o[k] !== undefined)
        .sort()
        .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
        .join(",")}}`;
    }
    default:
      throw new Error(`canonical: cannot represent a ${typeof v}`);
  }
}

export const sha256Hex = (data: string | Uint8Array): string =>
  crypto.createHash("sha256").update(data).digest("hex");

export const digestOf = (v: unknown): string => sha256Hex(canonical(v));

export interface RunIdentityInput {
  deliverable_id: string;
  intake_digest: string;
  accepted_snapshot_digest: string;
  engine_fingerprint: string;
}

export function runFingerprint(i: RunIdentityInput): string {
  return digestOf({
    identity: RUN_IDENTITY_VERSION,
    deliverable_id: i.deliverable_id,
    intake_digest: i.intake_digest,
    accepted_snapshot_digest: i.accepted_snapshot_digest,
    engine_fingerprint: i.engine_fingerprint,
    options: RUN_REQUEST_OPTIONS,
  });
}

/** The accepted lines as a SET: ordered by evidence id so the same set is always the same bytes, here and at the engine. */
export function sortSnapshot<T extends { evidence_id?: unknown }>(entries: T[]): T[] {
  return [...entries].sort((a, b) => String(a.evidence_id).localeCompare(String(b.evidence_id)));
}
