import { backoffDelay, resolveBackoff } from "./backoff.mjs";
import { realClock } from "./clock.mjs";

/**
 * Health + reconnect supervisor. It owns one adapter and decides, on a tick, whether what is being sent is healthy.
 *
 * WHAT IS WATCHED (per encoder): ffmpeg progress heartbeat, the frame counter advancing (stall = no new frame for
 * `stallTimeoutMs`), and, on the scene, an instantaneous bitrate floor (`minBitrateKbps` sustained for `lowBitrateWindowMs`).
 *
 * WHAT HAPPENS ON FAILURE
 *   encoder exit / start failure / stall / low bitrate:
 *     -> state `reconnecting`, kill the encoder AND the scene (they are one unit), wait backoffDelay(attempt) (bounded exponential
 *        with jitter), relaunch. After `maxAttempts` consecutive failed relaunches ->
 *     -> `fallback_slate`: the generated slate loop is sent instead (no data, no customer information).
 *   scene unhealthy (sceneProbe fails `sceneFailThreshold` times in a row) while the encoder looks fine ->
 *     -> `fallback_slate` immediately: a healthy encoder pushing a broken page is still a broken stream.
 *   while on the slate: the scene is probed every `recoveryProbeIntervalMs`; after `recoveryHealthyProbes` healthy probes in a
 *     row the scene is relaunched (`starting`). That relaunch gets only `recoveryRetries` retry before falling back again, so
 *     a flapping scene does not bounce the stream; a full budget returns once the scene has been stable for `stableMs`.
 *   slate encoder itself failing past its budget -> `stopped` (reason output_failed): there is nothing left to show.
 *
 * "live" is NEVER set here. Only adapter.verify() (the injected verification callback) can produce it, and it is only asked
 * while the scene is the active source and the encoder looks healthy.
 *
 * @typedef {{
 *   checkIntervalMs: number, stallTimeoutMs: number, minBitrateKbps: number, lowBitrateWindowMs: number, stableMs: number,
 *   verifyIntervalMs: number, sceneProbeIntervalMs: number, sceneFailThreshold: number,
 *   recoveryProbeIntervalMs: number, recoveryHealthyProbes: number, recoveryRetries: number
 * }} HealthConfig
 */
/** @type {HealthConfig} */
export const DEFAULT_HEALTH = Object.freeze({
  checkIntervalMs: 1000,
  stallTimeoutMs: 10_000,
  minBitrateKbps: 20,
  lowBitrateWindowMs: 15_000,
  stableMs: 20_000,
  verifyIntervalMs: 3000,
  sceneProbeIntervalMs: 5000,
  sceneFailThreshold: 2,
  recoveryProbeIntervalMs: 10_000,
  recoveryHealthyProbes: 2,
  recoveryRetries: 1,
});

export class Supervisor {
  /**
   * @param {{
   *   adapter: any, streamFor: (mode: "scene"|"slate") => any,
   *   clock?: { now: () => number, setTimeout: (fn: () => void, ms: number) => any, clearTimeout: (h: any) => void },
   *   logger?: { info: Function, warn: Function, error: Function }, health?: Partial<HealthConfig>, backoff?: Partial<import("./backoff.mjs").BackoffConfig>,
   *   rand?: () => number, sceneProbe?: () => Promise<boolean>|boolean, onStatus?: (s: any) => void,
   *   pollControl?: () => { forceSlate?: boolean }|null|undefined,
   * }} o
   */
  constructor(o) {
    this.adapter = o.adapter;
    this.streamFor = o.streamFor;
    this.clock = o.clock ?? realClock;
    const noop = () => {};
    this.logger = o.logger ?? { info: noop, warn: noop, error: noop };
    this.health = { ...DEFAULT_HEALTH, ...(o.health ?? {}) };
    this.backoff = resolveBackoff(o.backoff);
    this.rand = o.rand ?? Math.random;
    this.sceneProbe = o.sceneProbe ?? (() => true);
    this.onStatus = o.onStatus ?? noop;
    this.pollControl = o.pollControl ?? (() => null);

    /** @type {"scene"|"slate"} */ this.phase = "scene";
    this.stopped = false;
    this.failing = false;
    this.ticking = false;
    this.gen = 0;
    /** @type {any} */ this.enc = null;
    /** @type {any} */ this.tickTimer = null;
    /** @type {any} */ this.retryTimer = null;
    this.attempts = 0;
    this.budget = this.backoff.maxAttempts;
    this.nextRetryAt = /** @type {number|null} */ (null);
    this.sceneFails = 0;
    this.recoveryOk = 0;
    this.lastRecoveryProbe = 0;
    this.lastSceneProbe = 0;
    this.lastVerify = 0;
    this.forced = false;
    this.frame = 0;
    this.lastFrame = -1;
    this.lastFrameAdvanceAt = 0;
    this.lastProgressAt = 0;
    this.encStartedAt = 0;
    this.healthySince = 0;
    this.bitrateKbps = /** @type {number|null} */ (null);
    this.lowSince = /** @type {number|null} */ (null);
    /** @type {{ at: string, from: string, to: string, detail: string }[]} */ this.transitions = [];
    this.stopReason = /** @type {string|null} */ (null);
    this.slateReason = "";
    /** @type {Promise<void>|null} */ this.stopPromise = null;
  }

  now() { return this.clock.now(); }
  iso(/** @type {number|null} */ t) { return t == null ? null : new Date(t).toISOString(); }

  async start() {
    this.stopped = false;
    this.transition("starting", "supervisor started");
    this.scheduleTick();
    await this.launch("scene");
    this.publish();
  }

  /** @param {string} state @param {string} detail @param {Record<string, unknown>} [extra] */
  transition(state, detail, extra = {}) {
    const prev = this.adapter.status().state;
    this.adapter.markState(state, detail);
    if (prev !== state) {
      const rec = { at: this.iso(this.now()) ?? "", from: prev, to: state, detail };
      this.transitions.push(rec);
      if (this.transitions.length > 50) this.transitions.shift();
      this.logger.info("transition", { from: prev, to: state, detail, phase: this.phase, ...extra });
    }
    this.publish();
  }

  /** Record a state change caused by adapter.verify() (the only road to or from "live"). */
  syncAfterVerify(/** @type {string} */ prev) {
    const st = this.adapter.status();
    if (st.state !== prev) {
      this.transitions.push({ at: this.iso(this.now()) ?? "", from: prev, to: st.state, detail: st.detail });
      if (this.transitions.length > 50) this.transitions.shift();
      this.logger.info("transition", { from: prev, to: st.state, detail: st.detail, phase: this.phase });
    }
  }

  scheduleTick() {
    if (this.stopped) return;
    this.tickTimer = this.clock.setTimeout(() => { void this.tick(); }, this.health.checkIntervalMs);
  }

  async retire() {
    const enc = this.enc;
    this.enc = null;
    this.gen += 1;
    if (enc) { try { await enc.stop(); } catch (e) { this.logger.warn("encoder_stop_error", { error: String(e) }); } }
  }

  /** @param {"scene"|"slate"} phase */
  async launch(phase) {
    if (this.stopped) return;
    const gen = ++this.gen;
    this.phase = phase;
    let enc;
    try {
      enc = await this.adapter.start(this.streamFor(phase));
    } catch (e) {
      if (this.stopped || gen !== this.gen) return;
      await this.fail("start_failed", e instanceof Error ? e.message : String(e));
      return;
    }
    if (this.stopped || gen !== this.gen) { try { await enc.stop(); } catch { /* gone */ } return; }
    this.enc = enc;
    const now = this.now();
    this.encStartedAt = now;
    this.lastFrame = -1;
    this.frame = 0;
    this.lastFrameAdvanceAt = now;
    this.lastProgressAt = now;
    this.healthySince = now;
    this.bitrateKbps = null;
    this.lowSince = null;
    this.nextRetryAt = null;
    enc.on("progress", (/** @type {any} */ p) => {
      if (gen !== this.gen) return;
      const t = this.now();
      this.lastProgressAt = t;
      this.bitrateKbps = p.bitrateKbps ?? null;
      this.frame = p.frame;
      if (p.frame > this.lastFrame) { this.lastFrame = p.frame; this.lastFrameAdvanceAt = t; }
    });
    enc.on("log", (/** @type {any} */ l) => { if (gen === this.gen) this.logger.debug?.("encoder_log", { line: l.line, mode: phase }); });
    enc.on("exit", (/** @type {any} */ e) => {
      if (gen !== this.gen || e.expected) return;
      const why = Array.isArray(e.tail) && e.tail.length ? ` | ${e.tail[e.tail.length - 1]}` : "";
      void this.fail("encoder_exit", `ffmpeg exited (code ${e.code}, signal ${e.signal})${e.error ? ": " + e.error : ""}${why}`);
    });
    this.transition(phase === "slate" ? "fallback_slate" : "starting", phase === "slate" ? `sending the fallback slate: ${this.slateReason}` : "scene encoder started; not yet verified");
  }

  /** @param {string} reason @param {string} detail */
  async fail(reason, detail) {
    if (this.stopped || this.failing) return;
    this.failing = true;
    try {
      await this.retire();
      if (this.stopped) return;
      this.attempts += 1;
      this.logger.warn("encoder_failure", { reason, detail, attempt: this.attempts, budget: this.budget, phase: this.phase });
      if (this.attempts > this.budget) {
        if (this.phase === "scene") await this.switchToSlate(`retries exhausted after ${this.budget} reconnect attempts (${reason})`);
        else await this.terminate("output_failed", `the fallback slate could not be kept running (${reason})`);
        return;
      }
      const delay = backoffDelay(this.attempts, this.backoff, this.rand);
      this.nextRetryAt = this.now() + delay;
      this.transition("reconnecting", `${reason}: attempt ${this.attempts}/${this.budget} in ${delay} ms`, { reason, attempt: this.attempts, delayMs: delay });
      this.retryTimer = this.clock.setTimeout(() => { this.retryTimer = null; void this.launch(this.phase); }, delay);
    } finally { this.failing = false; }
  }

  /** @param {string} reason */
  async switchToSlate(reason) {
    if (this.stopped) return;
    await this.retire();
    if (this.retryTimer) { this.clock.clearTimeout(this.retryTimer); this.retryTimer = null; }
    this.phase = "slate";
    this.slateReason = reason;
    this.attempts = 0;
    this.budget = this.backoff.maxAttempts;
    this.sceneFails = 0;
    this.recoveryOk = 0;
    this.lastRecoveryProbe = this.now();
    this.transition("fallback_slate", reason);
    await this.launch("slate");
  }

  async switchToScene() {
    if (this.stopped) return;
    await this.retire();
    this.phase = "scene";
    this.attempts = 0;
    this.budget = this.health.recoveryRetries;
    this.sceneFails = 0;
    this.recoveryOk = 0;
    this.transition("starting", "scene probes healthy again; switching back from the slate");
    await this.launch("scene");
  }

  /** Operator: cut to the slate (true) or release it (false). */
  async forceSlate(/** @type {boolean} */ on) {
    if (on === this.forced) return;
    this.forced = on;
    this.logger.info("force_slate", { on });
    if (on && this.phase === "scene") await this.switchToSlate("operator cut to the slate");
    if (!on) this.lastRecoveryProbe = 0; // probe on the next tick
    this.publish();
  }

  async tick() {
    if (this.stopped) return;
    if (this.ticking) { this.scheduleTick(); return; }
    this.ticking = true;
    try {
      const ctl = this.pollControl();
      if (ctl && typeof ctl.forceSlate === "boolean" && ctl.forceSlate !== this.forced) await this.forceSlate(ctl.forceSlate);
      if (this.enc && !this.failing && !this.stopped) await this.checkEncoder();
    } catch (e) {
      this.logger.error("tick_error", { error: e instanceof Error ? e.message : String(e) });
    } finally {
      this.ticking = false;
      this.publish();
      this.scheduleTick();
    }
  }

  async checkEncoder() {
    const now = this.now();
    const h = this.health;
    const sinceAdvance = now - this.lastFrameAdvanceAt;
    if (sinceAdvance > h.stallTimeoutMs) { await this.fail("stall", `no new frame for ${sinceAdvance} ms (timeout ${h.stallTimeoutMs} ms)`); return; }
    if (this.phase === "scene" && h.minBitrateKbps > 0 && this.bitrateKbps != null && this.bitrateKbps < h.minBitrateKbps) {
      this.lowSince ??= now;
      if (now - this.lowSince >= h.lowBitrateWindowMs) { await this.fail("low_bitrate", `bitrate ${Math.round(this.bitrateKbps)} kbps below the ${h.minBitrateKbps} kbps floor for ${now - this.lowSince} ms`); return; }
    } else this.lowSince = null;

    if (now - this.healthySince >= h.stableMs && (this.attempts > 0 || this.budget !== this.backoff.maxAttempts)) {
      this.logger.info("stable", { phase: this.phase, afterAttempts: this.attempts });
      this.attempts = 0;
      this.budget = this.backoff.maxAttempts;
    }

    if (this.phase === "scene") {
      if (now - this.lastVerify >= h.verifyIntervalMs) {
        this.lastVerify = now;
        const prev = this.adapter.status().state;
        await this.adapter.verify();
        this.syncAfterVerify(prev);
      }
      if (now - this.lastSceneProbe >= h.sceneProbeIntervalMs) {
        this.lastSceneProbe = now;
        let ok = false;
        try { ok = !!(await this.sceneProbe()); } catch { ok = false; }
        this.sceneFails = ok ? 0 : this.sceneFails + 1;
        if (!ok) this.logger.warn("scene_probe_failed", { consecutive: this.sceneFails });
        if (this.sceneFails >= h.sceneFailThreshold) await this.switchToSlate(`scene unhealthy (${this.sceneFails} failed probes in a row)`);
      }
    } else if (!this.forced && now - this.lastRecoveryProbe >= h.recoveryProbeIntervalMs) {
      this.lastRecoveryProbe = now;
      let ok = false;
      try { ok = !!(await this.sceneProbe()); } catch { ok = false; }
      this.recoveryOk = ok ? this.recoveryOk + 1 : 0;
      this.logger.info("recovery_probe", { ok, consecutive: this.recoveryOk, needed: h.recoveryHealthyProbes });
      if (this.recoveryOk >= h.recoveryHealthyProbes) await this.switchToScene();
    }
  }

  /**
   * Terminal failure: nothing left to show. Resolves when everything is actually down.
   * @param {string} reason @param {string} detail
   */
  terminate(reason, detail) {
    if (!this.stopPromise) this.stopPromise = this.shutdown(reason, detail);
    return this.stopPromise;
  }

  /** Graceful stop. Idempotent: every caller gets the same promise, which resolves only once encoder and adapter are down. */
  stop(reason = "operator") {
    if (!this.stopPromise) this.stopPromise = this.shutdown(reason, null);
    return this.stopPromise;
  }

  /** @param {string} reason @param {string|null} detail */
  async shutdown(reason, detail) {
    this.stopReason = reason;
    this.stopped = true;
    if (this.tickTimer) this.clock.clearTimeout(this.tickTimer);
    if (this.retryTimer) this.clock.clearTimeout(this.retryTimer);
    await this.retire();
    const prev = this.adapter.status().state;
    try { await this.adapter.stop(); } catch { /* best effort */ }
    this.transitions.push({ at: this.iso(this.now()) ?? "", from: prev, to: "stopped", detail: detail ? `${reason}: ${detail}` : reason });
    if (detail) this.logger.warn("terminated", { reason, detail });
    else this.logger.info("transition", { from: prev, to: "stopped", detail: reason });
    this.publish();
  }

  snapshot() {
    const st = this.adapter.status();
    return {
      adapter: st.adapter,
      state: st.state,
      verified: st.verified,
      detail: st.detail,
      evidence: st.evidence,
      message: st.message,
      phase: this.phase,
      forcedSlate: this.forced,
      attempts: this.attempts,
      budget: this.budget,
      maxAttempts: this.backoff.maxAttempts,
      nextRetryAt: this.iso(this.nextRetryAt),
      stopReason: this.stopReason,
      encoder: this.enc ? {
        pid: this.enc.pid ?? null, mode: this.enc.mode ?? this.phase, frame: this.frame, bitrateKbps: this.bitrateKbps,
        startedAt: this.iso(this.encStartedAt), lastFrameAdvanceAt: this.iso(this.lastFrameAdvanceAt), lastProgressAt: this.iso(this.lastProgressAt),
      } : null,
      transitions: this.transitions.slice(-20),
      heartbeatAt: this.iso(this.now()),
    };
  }

  publish() { try { this.onStatus(this.snapshot()); } catch { /* status sink must never break the broadcast */ } }
}
