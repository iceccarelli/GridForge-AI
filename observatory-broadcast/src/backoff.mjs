/**
 * Bounded exponential backoff with jitter.
 *   delay(attempt) = min(maxMs, baseMs * factor^(attempt-1)) * (1 + jitter * (2*rand - 1)), then capped at maxMs.
 * `rand` is injected (0..1) so tests get an exact schedule; rand = 0.5 means "no jitter".
 *
 * @typedef {{ baseMs: number, factor: number, maxMs: number, jitter: number, maxAttempts: number }} BackoffConfig
 */
/** @type {BackoffConfig} */
export const DEFAULT_BACKOFF = Object.freeze({ baseMs: 2000, factor: 2, maxMs: 60_000, jitter: 0.25, maxAttempts: 6 });

/**
 * @param {number} attempt 1-based
 * @param {BackoffConfig} cfg
 * @param {() => number} [rand]
 */
export function backoffDelay(attempt, cfg, rand = Math.random) {
  const raw = Math.min(cfg.maxMs, cfg.baseMs * Math.pow(cfg.factor, Math.max(0, attempt - 1)));
  const jittered = raw * (1 + cfg.jitter * (2 * rand() - 1));
  return Math.max(0, Math.min(cfg.maxMs, Math.round(jittered)));
}

/** The whole schedule a budget of `cfg.maxAttempts` would produce (for display and tests). */
export function backoffSchedule(cfg, rand = () => 0.5) {
  return Array.from({ length: cfg.maxAttempts }, (_, i) => backoffDelay(i + 1, cfg, rand));
}

/** @param {Partial<BackoffConfig>} [over] @returns {BackoffConfig} */
export function resolveBackoff(over = {}) {
  const cfg = { ...DEFAULT_BACKOFF, ...over };
  for (const k of /** @type {const} */ (["baseMs", "factor", "maxMs", "maxAttempts"])) {
    if (!Number.isFinite(cfg[k]) || cfg[k] <= 0) throw new Error(`backoff.${k} must be a positive number`);
  }
  if (!(cfg.jitter >= 0 && cfg.jitter <= 1)) throw new Error("backoff.jitter must be between 0 and 1");
  return cfg;
}
