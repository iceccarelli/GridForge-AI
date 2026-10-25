import fs from "node:fs";
import path from "node:path";
import { ObsError } from "../errors.mjs";
import { Redactor, createLogger } from "../redact.mjs";
import { realClock } from "../clock.mjs";
import { FfmpegEncoder } from "../encoder.mjs";
import { ffmpegHas, requireFfmpeg } from "../ffmpeg.mjs";
import { checkDiskSpace } from "../safety.mjs";

/**
 * STAGE 3: PUBLISH. Every platform sits behind ONE interface:
 *
 *   { name, validateConfig(env), preflight(), start(stream), status(), stop() }
 *
 * plus `verify()` (the only road to state "live") and `markState()` (the supervisor's narrow way to report
 * reconnecting / fallback_slate / stopped; it can never set "live").
 *
 * STATE VOCABULARY (the only values status().state can take):
 *   not_configured | configured_unverified | preflight_failed | ready | starting | live | reconnecting | stopped | fallback_slate
 *
 * HONESTY RULES
 *  - `verified:true` and state "live" come only from the injected `verifier` callback returning ok with evidence. The encoder
 *    running, ffmpeg exiting 0, or a socket staying open is NOT verification of what a platform shows its viewers.
 *  - Adapters with no verifier (generic RTMP, YouTube, Kick in this build) therefore never reach "live"; status() says so.
 *  - No adapter here calls a platform API or opens a connection to a platform; preflight is local checks only.
 */
export const PLATFORM_STATES = Object.freeze([
  "not_configured", "configured_unverified", "preflight_failed", "ready", "starting", "live", "reconnecting", "stopped", "fallback_slate",
]);

/**
 * @typedef {{ mode: "scene"|"slate", source: any, encoding: import("../ffmpeg.mjs").Encoding, runId: string, visibility?: string }} StreamSpec
 * @typedef {{ ok: boolean, evidence?: string }} Verification
 * @typedef {{
 *   env?: Record<string, string | undefined>, redactor?: Redactor, logger?: ReturnType<typeof createLogger>, clock?: { now: () => number },
 *   spawn?: any, encoderFactory?: (spec: any) => any,
 *   verifier?: (ctx: { adapter: string, stream: StreamSpec|null }) => Promise<Verification>|Verification,
 *   checkFfmpeg?: () => string, hasFfmpegFeature?: (kind: "protocol"|"muxer", name: string) => boolean,
 *   statfs?: any, defaultSinkDir?: string, startSceneFeed?: any,
 * }} AdapterDeps
 */

/**
 * Read a secret from `NAME` or from the file named by `NAME_FILE`. Values never appear in errors.
 * @param {Record<string, string | undefined>} env
 * @param {string} name
 * @returns {{ present: boolean, value?: string, source?: "env"|"file", error?: string }}
 */
export function readSecret(env, name) {
  const direct = env[name];
  const file = env[`${name}_FILE`];
  if (direct && file) return { present: true, error: `set only one of ${name} and ${name}_FILE` };
  if (direct) return { present: true, value: direct.trim(), source: "env" };
  if (file) {
    try {
      if (!path.isAbsolute(file)) return { present: true, error: `${name}_FILE must be an absolute path` };
      const st = fs.statSync(file);
      if (!st.isFile()) return { present: true, error: `${name}_FILE is not a regular file` };
      if (st.mode & 0o077) return { present: true, error: `${name}_FILE is readable by group/others; run chmod 600 on it` };
      const v = fs.readFileSync(file, "utf8").trim();
      if (!v) return { present: true, error: `${name}_FILE is empty` };
      return { present: true, value: v, source: "file" };
    } catch (e) {
      return { present: true, error: `${name}_FILE could not be read (${/** @type {any} */ (e).code ?? "error"})` };
    }
  }
  return { present: false };
}

export class BaseAdapter {
  /**
   * @param {string} name
   * @param {AdapterDeps} [deps]
   */
  constructor(name, deps = {}) {
    this.name = name;
    this.redactor = deps.redactor ?? new Redactor();
    this.logger = deps.logger ?? createLogger({ redactor: this.redactor });
    this.clock = deps.clock ?? realClock;
    this.deps = deps;
    /** Whether `obs publish` demands an approval code for this adapter (false only where nothing leaves the machine). */
    this.requiresApproval = true;
    /** Whether this adapter's output puts a secret on the ffmpeg command line. */
    this.keyOnArgv = false;
    /** Whether the platform-side visibility is beyond this tool (then --approve-public is required whatever --visibility says). */
    this.treatAsPublic = false;
    /** @type {string} */ this._state = "not_configured";
    this._verified = false;
    /** @type {string} */ this._detail = "not configured";
    /** @type {string|null} */ this._evidence = null;
    this._updatedAt = this.clock.now();
    /** @type {any} */ this.encoder = null;
    /** @type {StreamSpec|null} */ this.lastStream = null;
    this.runCounter = 0;
    /** True once the config was validated successfully. */
    this.configured = false;
  }

  /** @protected @param {string} state @param {string} detail @param {{ verified?: boolean }} [o] */
  _set(state, detail, o = {}) {
    if (!PLATFORM_STATES.includes(state)) throw new Error(`unknown state ${state}`);
    this._state = state;
    this._verified = o.verified === true;
    this._detail = detail;
    this._updatedAt = this.clock.now();
  }

  /** Does this adapter have a way to verify a live stream at all? */
  get canVerify() { return typeof this.deps.verifier === "function"; }

  /**
   * @param {Record<string, string | undefined>} _env
   * @returns {{ ok: boolean, errors: string[], warnings: string[], summary: Record<string, unknown> }}
   */
  validateConfig(_env) { throw new Error("validateConfig not implemented"); }

  /** @param {StreamSpec} _stream @returns {{ args: string[], display: string }} */
  outputSpec(_stream) { throw new Error("outputSpec not implemented"); }

  /** Notes preflight adds that are specific to the platform. @returns {string[]} */
  platformNotes() { return []; }

  /** Whether preflight alone may mark this adapter `ready` (true only where the sink itself is checked locally). */
  get locallyVerifiable() { return false; }

  /**
   * Local checks only. Never contacts a platform. Result is honest about what was NOT checked.
   * @param {{ diskDir?: string, neededBytes?: number }} [ctx]
   */
  async preflight(ctx = {}) {
    /** @type {{ name: string, ok: boolean, detail: string }[]} */ const checks = [];
    if (!this.configured) {
      checks.push({ name: "config", ok: false, detail: "not configured: run validateConfig / set the environment variables" });
      this._set("not_configured", "not configured");
      return { ok: false, verified: false, state: this._state, checks, notes: this.platformNotes() };
    }
    checks.push({ name: "config", ok: true, detail: "configuration is present and well-formed" });
    try {
      const v = (this.deps.checkFfmpeg ?? (() => requireFfmpeg(this.deps.env)))();
      checks.push({ name: "ffmpeg", ok: true, detail: String(v) });
    } catch (e) {
      checks.push({ name: "ffmpeg", ok: false, detail: /** @type {Error} */ (e).message });
    }
    for (const [kind, nameOf] of /** @type {const} */ ([["muxer", this.requiredMuxer()]])) {
      if (!nameOf) continue;
      const has = (this.deps.hasFfmpegFeature ?? ((k, n) => ffmpegHas(k, n, this.deps.env)))(kind, nameOf);
      checks.push({ name: `ffmpeg ${kind} ${nameOf}`, ok: has, detail: has ? "available" : "missing from this ffmpeg build" });
    }
    for (const proto of this.requiredProtocols()) {
      const has = (this.deps.hasFfmpegFeature ?? ((k, n) => ffmpegHas(k, n, this.deps.env)))("protocol", proto);
      checks.push({ name: `ffmpeg protocol ${proto}`, ok: has, detail: has ? "available" : "missing from this ffmpeg build" });
    }
    if (ctx.diskDir) {
      try {
        const d = checkDiskSpace(ctx.diskDir, ctx.neededBytes ?? 64 * 1024 * 1024, { statfs: this.deps.statfs });
        checks.push({ name: "disk", ok: d.ok, detail: `${Math.floor(d.freeBytes / 1e6)} MB free` });
      } catch (e) {
        checks.push({ name: "disk", ok: false, detail: /** @type {Error} */ (e).message });
      }
    }
    const extra = await this.localChecks();
    checks.push(...extra);
    const ok = checks.every((c) => c.ok);
    if (!ok) {
      this._set("preflight_failed", `preflight failed: ${checks.filter((c) => !c.ok).map((c) => c.name).join(", ")}`);
      return { ok: false, verified: false, state: this._state, checks, notes: this.platformNotes() };
    }
    if (this.locallyVerifiable) {
      this._set("ready", "local checks passed (the sink is on this machine, so they are real)", { verified: true });
      return { ok: true, verified: true, state: this._state, checks, notes: this.platformNotes() };
    }
    this._set("configured_unverified", "local checks passed; the platform was NOT contacted, so the ingest is unverified");
    return {
      ok: true, verified: false, state: this._state, checks,
      notes: ["unverified: this build never contacts the platform, so credentials, channel state and ingest acceptance are untested", ...this.platformNotes()],
    };
  }

  /** @returns {string|null} */ requiredMuxer() { return null; }
  /** @returns {string[]} */ requiredProtocols() { return []; }
  /** @returns {Promise<{ name: string, ok: boolean, detail: string }[]>} */ async localChecks() { return []; }

  /**
   * Start an encoder for the given stream. Returns the started encoder (an EventEmitter, see encoder.mjs).
   * @param {StreamSpec} stream
   */
  async start(stream) {
    if (!this.configured || this._state === "not_configured" || this._state === "preflight_failed") {
      throw new ObsError("not_startable", `${this.name} is ${this._state}; it cannot start`, { exitCode: 2, hint: "Fix the configuration and run preflight first." });
    }
    this.lastStream = stream;
    this.runCounter += 1;
    const out = this.outputSpec(stream);
    const spec = { mode: stream.mode, source: stream.source, encoding: stream.encoding, output: out, runId: stream.runId };
    const enc = (this.deps.encoderFactory ?? ((s) => new FfmpegEncoder(s, { spawn: this.deps.spawn, env: this.deps.env, redactor: this.redactor, startSceneFeed: this.deps.startSceneFeed })))(spec);
    this.encoder = enc;
    this.logger.info("adapter_start", { adapter: this.name, mode: stream.mode, output: out.display });
    await enc.start();
    if (this._state === "ready" || this._state === "configured_unverified" || this._state === "stopped") this._set("starting", `encoder started (${stream.mode}); not yet verified`);
    return enc;
  }

  /**
   * The ONLY way to reach "live": run the verification callback. Without a verifier this reports, honestly, that it cannot.
   * @returns {Promise<{ ok: boolean, supported: boolean, message: string, evidence?: string }>}
   */
  async verify() {
    if (!this.deps.verifier) {
      const message = `live status cannot be verified for ${this.name} in this build`;
      return { ok: false, supported: false, message };
    }
    let r;
    try { r = await this.deps.verifier({ adapter: this.name, stream: this.lastStream }); } catch (e) {
      r = { ok: false, evidence: `verifier error: ${this.redactor.redact(/** @type {Error} */ (e))}` };
    }
    if (r && r.ok === true && typeof r.evidence === "string" && r.evidence.length > 0) {
      this._set("live", `verified: ${r.evidence}`, { verified: true });
      this._evidence = r.evidence;
      return { ok: true, supported: true, message: "verified", evidence: r.evidence };
    }
    if (this._state === "live") this._set("starting", "verification lost");
    this._evidence = null;
    return { ok: false, supported: true, message: r?.evidence ? String(r.evidence) : "verifier did not confirm the ingest" };
  }

  /**
   * Supervisor-facing state report. Cannot set "live" (only verify() can) and cannot claim verification.
   * @param {"starting"|"reconnecting"|"fallback_slate"|"stopped"|"configured_unverified"|"ready"|"preflight_failed"} state
   * @param {string} detail
   */
  markState(state, detail) {
    if (/** @type {string} */ (state) === "live") throw new ObsError("live_requires_verification", 'state "live" can only be produced by a verification callback', { exitCode: 1 });
    if (!PLATFORM_STATES.includes(state)) throw new ObsError("bad_state", `unknown state ${state}`);
    const keepVerified = state === "ready" && this.locallyVerifiable;
    this._set(state, detail, { verified: keepVerified });
    this._evidence = null;
  }

  status() {
    const unverifiable = !this.canVerify;
    return {
      adapter: this.name,
      state: this._state,
      verified: this._verified === true,
      detail: this._detail,
      evidence: this._evidence,
      liveVerifiable: !unverifiable,
      message: unverifiable ? `live status cannot be verified for ${this.name} in this build; an encoder that is running is not proof that viewers can see it` : undefined,
      updatedAt: new Date(this._updatedAt).toISOString(),
    };
  }

  async stop() {
    const enc = this.encoder;
    this.encoder = null;
    if (enc) {
      try { await enc.stop(); } catch (e) { this.logger.warn("adapter_stop_error", { adapter: this.name, error: String(e) }); }
    }
    this._set("stopped", "stopped by operator or supervisor");
  }
}

/** Assert an object satisfies the adapter interface. Used by tests and by the registry. */
export function assertAdapterInterface(a) {
  for (const m of ["validateConfig", "preflight", "start", "status", "stop"]) {
    if (typeof a?.[m] !== "function") throw new Error(`adapter ${a?.name ?? "?"} lacks ${m}()`);
  }
  if (typeof a.name !== "string" || !a.name) throw new Error("adapter needs a name");
  return a;
}
