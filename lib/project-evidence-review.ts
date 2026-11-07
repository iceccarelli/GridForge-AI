// Server-only: the one place an evidence file becomes verified or rejected (migration 0048).
//
// A file is verified only after THIS server has read the stored object back from the private bucket and computed its SHA-256; that digest,
// not anything a browser sent, is what is passed to the database, which compares the CLAIMED digest with the one recorded at upload
// (gf_review_evidence refuses a mismatch). The database never sees the bytes, so it cannot tell that this route really hashed them: the
// hash is route-computed. What a verification therefore establishes is that the bytes in the private bucket are unchanged since upload.
// The reviewer is vouching for the file's provenance and relevance, which this code does not inspect. A decision is recorded once, with a
// name and a reason, and cannot be changed. The name is the text the reviewer typed under one shared admin password: recorded as typed,
// not an authenticated identity.
//
// What a caller gets back is a whitelist: the decision and the digest. The file's storage path and the service credentials that read it
// never leave this module.

import crypto from "node:crypto";
import { creds, ev, rest, rpc, STORE_UNCONFIGURED, EVIDENCE_BUCKET, EVIDENCE_MAX_BYTES, type Result } from "@/lib/projects";
import { missingFunction } from "@/lib/calibration-permissions";

export type EvidenceDecision = "verified" | "rejected";

export interface EvidenceReview {
  id: string;
  evidence_id: string;
  decision: EvidenceDecision;
  reviewer: string;
  reason: string;
  sha256_confirmed: string | null;
  reviewed_at: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The object paths lib/projects.ts attachEvidence writes: '<bucket>/<project uuid>/<sha256>-<safe name>'. Anything else is never fetched. */
const REF = new RegExp(`^${EVIDENCE_BUCKET}/[0-9a-f-]{36}/[0-9a-f]{64}-[A-Za-z0-9._-]{1,120}$`);

export const ALREADY_REVIEWED_MESSAGE = "This file has already been reviewed: a decision is recorded once and is final.";

/** The longest the read-back may take, headers and body together. */
export const READ_BACK_TIMEOUT_MS = 20_000;
const ERROR_BODY_MAX = 2048;

/** At most `max` bytes of a response body as text; the rest is cancelled unread. */
async function readCapped(res: Response, max: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
      if (total >= max) {
        await reader.cancel();
        break;
      }
    }
  } catch {
    return "";
  }
  return Buffer.concat(chunks).subarray(0, max).toString("utf8");
}

function parseErrorBody(text: string): { code?: unknown; error?: unknown; statusCode?: unknown } {
  try {
    const j = JSON.parse(text);
    return j && typeof j === "object" ? j : {};
  } catch {
    return {};
  }
}

type ReadBack =
  | { ok: true; sha256: string; bytes: number }
  | { ok: false; kind: "missing" | "unavailable" | "too_large" };

/**
 * Read the stored object (at most EVIDENCE_MAX_BYTES + 1 bytes, so a swapped-in giant file costs a bounded read) and hash it.
 * Never logs a path or a body: a status and a code only.
 */
export async function hashStoredObject(ref: string): Promise<ReadBack> {
  const c = creds();
  if (!c) return { ok: false, kind: "unavailable" };
  if (!REF.test(ref)) return { ok: false, kind: "missing" };
  const { "Content-Type": _json, ...auth } = c.headers;
  void _json;
  try {
    const res = await fetch(`${c.url}/storage/v1/object/authenticated/${ref}`, {
      headers: auth,
      cache: "no-store",
      signal: AbortSignal.timeout(READ_BACK_TIMEOUT_MS),
    });
    if (res.status === 404 || res.status === 400) {
      // Supabase Storage answers a missing object with HTTP 400 and the real status in the body. Only the first 2 KB of an error body is read.
      const body = parseErrorBody(await readCapped(res, ERROR_BODY_MAX));
      if (body.code === "NoSuchKey" || (body.code === undefined && (res.status === 404 || String(body.statusCode) === "404") && body.error === "not_found")) {
        return { ok: false, kind: "missing" };
      }
    }
    if (!res.ok || !res.body) {
      // The status only: an error body is neither read nor logged.
      console.error(`[GridForge] evidence read-back failed: HTTP ${res.status}`);
      void res.body?.cancel().catch(() => undefined);
      return { ok: false, kind: "unavailable" };
    }
    const hash = crypto.createHash("sha256");
    const reader = res.body.getReader();
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > EVIDENCE_MAX_BYTES) {
        await reader.cancel();
        return { ok: false, kind: "too_large" };
      }
      hash.update(value);
    }
    return { ok: true, sha256: hash.digest("hex"), bytes: total };
  } catch (err) {
    console.error("[GridForge] evidence store unreachable:", err instanceof Error ? err.name : "error");
    return { ok: false, kind: "unavailable" };
  }
}

export async function reviewEvidence(input: {
  evidence_id: string;
  decision: EvidenceDecision;
  reviewer: string;
  reason: string;
}): Promise<Result<{ review: EvidenceReview }>> {
  if (!creds()) return STORE_UNCONFIGURED;
  if (!UUID.test(input.evidence_id)) return { ok: false, status: 404, error: "Not found." };

  // Never `*`: the row holds the private storage path.
  const row = await rest<{ id: string; sha256: string; storage_ref: string; review_status: string }[]>(
    "GET",
    `project_evidence?id=eq.${encodeURIComponent(input.evidence_id)}&select=id,sha256,storage_ref,review_status&limit=1`
  );
  if (!row.ok) return { ok: false, status: 502, error: "The file could not be looked up. Nothing was recorded." };
  const file = row.data?.[0];
  if (!file) return { ok: false, status: 404, error: "Not found." };
  if (file.review_status !== "unverified") return { ok: false, status: 409, error: ALREADY_REVIEWED_MESSAGE };

  let confirmed: string | undefined;
  if (input.decision === "verified") {
    // The server proves the bytes. A rejection needs no read: refusing a file is always possible, even one that cannot be fetched.
    const back = await hashStoredObject(file.storage_ref);
    if (!back.ok) {
      return {
        ok: false,
        status: back.kind === "unavailable" ? 502 : 409,
        error:
          back.kind === "unavailable"
            ? "The stored file could not be read back to check it. Nothing was recorded."
            : back.kind === "too_large"
              ? "The stored file is larger than any file this system accepts, so it cannot be the file that was uploaded. Reject it."
              : "The stored file is missing, so it cannot be verified. Reject it.",
      };
    }
    confirmed = back.sha256;
  }

  const done = await rpc<EvidenceReview>("gf_review_evidence", {
    p: {
      evidence_id: file.id,
      decision: input.decision,
      reviewer: input.reviewer,
      reason: input.reason,
      ...(confirmed ? { sha256_confirmed: confirmed } : {}),
    },
    p_event: ev("evidence_reviewed", input.reviewer, {}),
  });
  if (!done.ok || !done.data) {
    if (done.ok === false) {
      if (missingFunction(done.code)) {
        return { ok: false, status: 503, error: "Reviewing files is not available yet: its database migration has not been applied. Nothing was recorded." };
      }
      if (done.code === "GF007") {
        return {
          ok: false,
          status: 409,
          error: "The stored file no longer matches the digest recorded when it was uploaded, so it cannot be verified. Reject it.",
        };
      }
      if (done.code === "GF008" || done.code === "23505") return { ok: false, status: 409, error: ALREADY_REVIEWED_MESSAGE };
      if (done.code === "23503") return { ok: false, status: 404, error: "Not found." };
      if (done.code === "23514" || done.code === "23502") {
        return { ok: false, status: 422, error: "The decision was refused: it needs a decision, a reviewer and a reason within their limits." };
      }
    }
    return { ok: false, status: 502, error: "The decision could not be saved. Nothing was recorded." };
  }
  // A whitelist: nothing the database row carries beyond the decision itself.
  const r = done.data;
  return {
    ok: true,
    review: {
      id: r.id, evidence_id: r.evidence_id, decision: r.decision, reviewer: r.reviewer, reason: r.reason,
      sha256_confirmed: r.sha256_confirmed ?? null, reviewed_at: r.reviewed_at,
    },
  };
}
