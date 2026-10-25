import crypto from "node:crypto";
import fs from "node:fs";
import { ObsError } from "./errors.mjs";
import { realClock } from "./clock.mjs";

/**
 * Two-step publish gate.
 *   prepare  -> builds a plan (adapter, visibility, redacted target, scene URL, encoding), writes plan.json
 *               and a short-lived single-use approval code to approval-code.txt (0600). The code is NOT printed.
 *   publish  -> must present that code (`--approve <code>`); the plan fingerprint must still match what is being
 *               published; PUBLIC visibility additionally needs `--approve-public`.
 * A wrong code counts against a small attempt budget, after which the plan is locked and must be re-prepared.
 * The code is stored only as a salted hash inside plan.json; the readable copy lives in the code file and is deleted on use.
 */
export const DEFAULT_TTL_MS = 10 * 60 * 1000;
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
 * Stable fingerprint of what is being approved. The ingest target enters only as a salted hash, never as text.
 * @param {{ adapter: string, visibility: string, sourceUrl: string|null, targetDigest: string, encoding: object }} p
 */
export function planFingerprint(p) {
  return crypto.createHash("sha256").update(JSON.stringify([p.adapter, p.visibility, p.sourceUrl, p.targetDigest, p.encoding])).digest("hex");
}

/** Digest of the ingest target for fingerprinting: salted so the stored value cannot be used to recover a key. */
export function targetDigest(target, salt) {
  return crypto.createHash("sha256").update(`${salt}|${target ?? ""}`).digest("hex");
}

/**
 * @param {{ store: import("./state.mjs").StateStore, plan: { adapter: string, visibility: string, sourceUrl: string|null, encoding: object, target: string|null, targetDisplay: string, notes?: string[] }, clock?: { now: () => number }, ttlMs?: number, randomInt?: typeof crypto.randomInt }} o
 */
export async function createApproval({ store, plan, clock = realClock, ttlMs = DEFAULT_TTL_MS, randomInt = crypto.randomInt }) {
  if (!VISIBILITIES.includes(plan.visibility)) {
    throw new ObsError("bad_visibility", `visibility must be one of ${VISIBILITIES.join(", ")}`, { exitCode: 2 });
  }
  const code = generateCode(randomInt);
  const salt = crypto.randomBytes(16).toString("hex");
  const now = clock.now();
  const doc = {
    schema: "observatory-broadcast/plan/1",
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
      targetDisplay: plan.targetDisplay,
      targetDigest: targetDigest(plan.target, salt),
      fingerprint: "",
      notes: plan.notes ?? [],
    },
  };
  doc.plan.fingerprint = planFingerprint({ ...doc.plan, targetDigest: doc.plan.targetDigest });
  await store.locked(() => {
    store.writeJson("plan.json", doc);
    fs.writeFileSync(store.file("approval-code.txt"), code + "\n", { mode: 0o600 });
  });
  return { code, id: doc.id, expiresAt: doc.expiresAt, plan: doc.plan, codeFile: store.file("approval-code.txt") };
}

/**
 * Check an approval for a publish request. Throws ObsError(exit 3) with a precise code; on success the code is consumed.
 * @param {{ store: import("./state.mjs").StateStore, code?: string|null, approvePublic?: boolean, request: { adapter: string, visibility: string, sourceUrl: string|null, target: string|null, encoding: object }, clock?: { now: () => number } }} o
 */
export async function consumeApproval({ store, code, approvePublic = false, request, clock = realClock }) {
  /** @param {string} c @param {string} msg @param {string} [hint] */
  const refuse = (c, msg, hint) => new ObsError(c, msg, { exitCode: 3, hint });

  if (request.visibility === "public" && !approvePublic) {
    throw refuse("public_requires_approve_public", "public visibility needs --approve-public in addition to the approval code", "Re-run with --approve-public only if you intend this stream to be public.");
  }
  if (!code || !normalizeCode(code)) {
    throw refuse("approval_required", "publishing needs an approval code", "Run `obs prepare ...`, read the code from the approval-code.txt file it names, then `obs publish --approve <code>`.");
  }
  return store.locked(() => {
    const doc = store.readJson("plan.json");
    if (!doc || doc.schema !== "observatory-broadcast/plan/1") throw refuse("no_plan", "no prepared plan found", "Run `obs prepare` first.");
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
    const fp = planFingerprint({
      adapter: request.adapter,
      visibility: request.visibility,
      sourceUrl: request.sourceUrl,
      targetDigest: targetDigest(request.target, doc.salt),
      encoding: request.encoding,
    });
    if (fp !== doc.plan.fingerprint) {
      throw refuse("plan_mismatch", "what is being published differs from what was prepared (adapter, visibility, scene URL, ingest target or encoding changed)", "Run `obs prepare` again with the settings you intend to publish.");
    }
    doc.used = true;
    doc.usedAt = new Date(clock.now()).toISOString();
    store.writeJson("plan.json", doc);
    try { fs.unlinkSync(store.file("approval-code.txt")); } catch { /* already removed */ }
    return { id: doc.id, plan: doc.plan };
  });
}
