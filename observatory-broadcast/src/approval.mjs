import crypto from "node:crypto";
import fs from "node:fs";
import { ObsError } from "./errors.mjs";
import { realClock } from "./clock.mjs";

/**
 * Two-step publish gate.
 *   prepare  -> builds a plan (adapter, visibility, redacted target, scene URL, encoding, source/slate files), writes
 *               plan.json and a short-lived single-use approval code to approval-code.txt (0600). The code is NOT printed.
 *   publish  -> must present that code (`--approve <code>`); what is being published must still match the plan;
 *               PUBLIC visibility (and every adapter whose visibility this tool cannot set or verify) additionally needs
 *               `--approve-public`.
 * A wrong code counts against a small attempt budget, after which the plan is locked and must be re-prepared.
 * The code is stored only as a salted hash inside plan.json; the readable copy lives in the code file and is deleted on use.
 *
 * The plan fingerprint is an HMAC keyed by the approval code over everything that was approved, INCLUDING the ingest target
 * (which carries the stream key). The code is not stored, so plan.json holds nothing from which the key can be tested;
 * only someone presenting the code can reproduce (and so compare) the fingerprint.
 */
export const DEFAULT_TTL_MS = 10 * 60 * 1000;
export const MAX_TTL_MS = 60 * 60 * 1000;
export const MAX_ATTEMPTS = 5;
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I

export const VISIBILITIES = Object.freeze(["private", "unlisted", "public"]);

/** @param {string} code */
export function normalizeCode(code) { return String(code ?? "").toUpperCase().replace(/[\s-]/g, ""); }

/** @param {string} salt @param {string} code */
const hashCode = (salt, code) => crypto.createHash("sha256").update(`${salt}:${normalizeCode(code)}`).digest("hex");

export function generateCode(randomInt = crypto.randomInt) {
  let s = "";
  for (let i = 0; i < 8; i++) s += ALPHABET[randomInt(0, ALPHABET.length)];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

/**
 * @typedef {{
 *   adapter: string, visibility: string, sourceUrl: string|null, target: string|null, encoding: object,
 *   sourceFile?: { path: string, sha256: string }|null, slateFile?: { path: string, sha256: string }|null,
 * }} ApprovalRequest
 */

/**
 * HMAC keyed by the approval code over the canonical request (including the secret-bearing target).
 * @param {string} code @param {ApprovalRequest} r
 */
export function planFingerprint(code, r) {
  const canon = JSON.stringify([r.adapter, r.visibility, r.sourceUrl, r.target ?? "", r.encoding, r.sourceFile ?? null, r.slateFile ?? null]);
  return crypto.createHmac("sha256", normalizeCode(code)).update(canon).digest("hex");
}

/** An approval lifetime outside (0, MAX_TTL_MS] is refused. Called before any preflight so a bad argument never reads as an environment fault. */
export function assertTtl(ttlMs) {
  if (!(ttlMs > 0) || ttlMs > MAX_TTL_MS) {
    throw new ObsError("bad_ttl", `the approval lifetime must be between 1 second and ${MAX_TTL_MS / 1000} seconds`, { exitCode: 2, hint: "A code is meant to be used within minutes; run `obs prepare` again later instead of keeping one alive." });
  }
}

/**
 * @param {{ store: import("./state.mjs").StateStore, plan: ApprovalRequest & { targetDisplay: string, notes?: string[] }, clock?: { now: () => number }, ttlMs?: number, randomInt?: typeof crypto.randomInt }} o
 */
export async function createApproval({ store, plan, clock = realClock, ttlMs = DEFAULT_TTL_MS, randomInt = crypto.randomInt }) {
  if (!VISIBILITIES.includes(plan.visibility)) {
    throw new ObsError("bad_visibility", `visibility must be one of ${VISIBILITIES.join(", ")}`, { exitCode: 2 });
  }
  assertTtl(ttlMs);
  const code = generateCode(randomInt);
  const salt = crypto.randomBytes(16).toString("hex");
  const now = clock.now();
  const doc = {
    schema: "observatory-broadcast/plan/2",
    id: crypto.randomBytes(6).toString("hex"),
    createdAt: new Date(now).toISOString(),
    expiresAtMs: now + ttlMs,
    expiresAt: new Date(now + ttlMs).toISOString(),
    salt,
    codeHash: hashCode(salt, code),
    attempts: 0,
    maxAttempts: MAX_ATTEMPTS,
    used: false,
    plan: {
      adapter: plan.adapter,
      visibility: plan.visibility,
      sourceUrl: plan.sourceUrl,
      encoding: plan.encoding,
      sourceFile: plan.sourceFile ?? null,
      slateFile: plan.slateFile ?? null,
      targetDisplay: plan.targetDisplay,
      fingerprint: planFingerprint(code, plan),
      notes: plan.notes ?? [],
    },
  };
  await store.locked(() => {
    store.writeJson("plan.json", doc);
    store.writeSecretFile("approval-code.txt", code + "\n");
  });
  return { code, id: doc.id, expiresAt: doc.expiresAt, plan: doc.plan, codeFile: store.file("approval-code.txt") };
}

/**
 * Check an approval for a publish request. Throws ObsError(exit 3) with a precise code; on success the code is consumed.
 * @param {{ store: import("./state.mjs").StateStore, code?: string|null, approvePublic?: boolean, treatAsPublic?: boolean, request: ApprovalRequest, clock?: { now: () => number } }} o
 */
export async function consumeApproval({ store, code, approvePublic = false, treatAsPublic = false, request, clock = realClock }) {
  /** @param {string} c @param {string} msg @param {string} [hint] */
  const refuse = (c, msg, hint) => new ObsError(c, msg, { exitCode: 3, hint });

  if ((request.visibility === "public" || treatAsPublic) && !approvePublic) {
    throw refuse("public_requires_approve_public",
      request.visibility === "public"
        ? "public visibility needs --approve-public in addition to the approval code"
        : `${request.adapter} publishes to a platform whose visibility this tool cannot set or verify, so it counts as PUBLIC and needs --approve-public in addition to the approval code`,
      "Re-run with --approve-public only if you accept that the stream may be publicly visible.");
  }
  if (!code || !normalizeCode(code)) {
    throw refuse("approval_required", "publishing needs an approval code", "Run `obs prepare ...`, read the code from the approval-code.txt file it names, then `obs publish --approve <code>`.");
  }
  return store.locked(() => {
    const doc = store.readJson("plan.json");
    if (!doc || doc.schema !== "observatory-broadcast/plan/2") throw refuse("no_plan", "no prepared plan found", "Run `obs prepare` first.");
    if (doc.used) throw refuse("approval_used", "this approval code was already used", "Run `obs prepare` again.");
    if (clock.now() > doc.expiresAtMs) throw refuse("approval_expired", `the approval code expired at ${doc.expiresAt}`, "Run `obs prepare` again for a fresh code.");
    if (doc.attempts >= doc.maxAttempts) throw refuse("approval_locked", "too many wrong codes; this plan is locked", "Run `obs prepare` again.");
    const a = Buffer.from(hashCode(doc.salt, code), "hex");
    const b = Buffer.from(doc.codeHash, "hex");
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      doc.attempts += 1;
      store.writeJson("plan.json", doc);
      throw refuse("wrong_code", `wrong approval code (${doc.maxAttempts - doc.attempts} attempts left)`);
    }
    const fp = Buffer.from(planFingerprint(code, request), "hex");
    const want = Buffer.from(doc.plan.fingerprint, "hex");
    if (fp.length !== want.length || !crypto.timingSafeEqual(fp, want)) {
      throw refuse("plan_mismatch", "what is being published differs from what was prepared (adapter, visibility, scene URL, source or slate file, ingest target or encoding changed)", "Run `obs prepare` again with the settings you intend to publish.");
    }
    doc.used = true;
    doc.usedAt = new Date(clock.now()).toISOString();
    store.writeJson("plan.json", doc);
    try { fs.unlinkSync(store.file("approval-code.txt")); } catch { /* already removed */ }
    return { id: doc.id, plan: doc.plan };
  });
}
