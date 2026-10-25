/**
 * Secret redaction. Every log line, error, status file and manifest this tool writes passes through a Redactor.
 * Registered secrets are removed by value (raw, URL-encoded and base64); independently, any rtmp(s)/srt/rtsp URL
 * loses its path (where ingest URLs carry the stream key) and any `key=value` pair that names a secret loses its
 * value. Defence in depth: a secret that was never registered still does not survive the URL / key=value patterns.
 */
export const REDACTED = "[REDACTED]";

const INGEST_URL = /\b(rtmps?|rtsp|srt|rtp):\/\/([^\s/'"]*)(\/[^\s'"]*)?/gi;
const SECRET_PAIR = /\b(stream[_-]?key|streamkey|secret|token|password|passwd|authorization)(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;&'"]+)/gi;

export class Redactor {
  /** @type {Set<string>} */
  #secrets = new Set();

  /** @param {Iterable<string>} [secrets] */
  constructor(secrets = []) {
    for (const s of secrets) this.add(s);
  }

  /**
   * Register a secret. Values shorter than 4 characters are ignored (they would shred ordinary text).
   * @param {unknown} secret
   */
  add(secret) {
    if (typeof secret !== "string" || secret.length < 4) return this;
    this.#secrets.add(secret);
    try { this.#secrets.add(encodeURIComponent(secret)); } catch { /* lone surrogate: raw form already registered */ }
    this.#secrets.add(Buffer.from(secret).toString("base64"));
    return this;
  }

  get size() { return this.#secrets.size; }

  /** @param {unknown} input @returns {string} */
  redact(input) {
    let text = typeof input === "string" ? input : input instanceof Error ? `${input.name}: ${input.message}` : String(input);
    const ordered = [...this.#secrets].sort((a, b) => b.length - a.length);
    for (const s of ordered) text = text.split(s).join(REDACTED);
    text = text.replace(INGEST_URL, (_m, scheme, host, path) => {
      const safeHost = String(host).replace(/^[^@]*@/, `${REDACTED}@`);
      return path && path !== "/" ? `${scheme}://${safeHost}/${REDACTED}` : `${scheme}://${safeHost}`;
    });
    text = text.replace(SECRET_PAIR, (_m, k, sep) => `${k}${sep}${REDACTED}`);
    return text;
  }

  /**
   * Deep copy with every string (and object key) redacted.
   * @param {any} value
   * @param {number} [depth]
   * @returns {any}
   */
  redactDeep(value, depth = 0) {
    if (depth > 10) return REDACTED;
    if (typeof value === "string") return this.redact(value);
    if (value instanceof Error) return this.redact(value);
    if (Array.isArray(value)) return value.map((v) => this.redactDeep(v, depth + 1));
    if (value && typeof value === "object") {
      /** @type {Record<string, any>} */
      const out = {};
      for (const [k, v] of Object.entries(value)) out[this.redact(k)] = this.redactDeep(v, depth + 1);
      return out;
    }
    return value;
  }
}

/**
 * Structured logger. One JSON object per line; nothing is written that has not been redacted.
 * @param {{ redactor: Redactor, write?: (line: string) => void, now?: () => number, level?: "debug"|"info"|"warn"|"error" }} opts
 */
export function createLogger({ redactor, write = (l) => process.stderr.write(l + "\n"), now = () => Date.now(), level = "info" }) {
  /** @type {Record<string, number>} */
  const order = { debug: 10, info: 20, warn: 30, error: 40 };
  const min = order[level] ?? 20;
  /** @param {string} lvl @param {string} event @param {Record<string, unknown>} [fields] */
  const emit = (lvl, event, fields) => {
    if (order[lvl] < min) return;
    const rec = { ts: new Date(now()).toISOString(), level: lvl, event, ...(fields ? redactor.redactDeep(fields) : {}) };
    write(redactor.redact(JSON.stringify(rec)));
  };
  return {
    /** @param {string} e @param {Record<string, unknown>} [f] */
    debug: (e, f) => emit("debug", e, f),
    /** @param {string} e @param {Record<string, unknown>} [f] */
    info: (e, f) => emit("info", e, f),
    /** @param {string} e @param {Record<string, unknown>} [f] */
    warn: (e, f) => emit("warn", e, f),
    /** @param {string} e @param {Record<string, unknown>} [f] */
    error: (e, f) => emit("error", e, f),
  };
}
