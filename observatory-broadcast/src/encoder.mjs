import { spawn as nodeSpawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { buildAudioArgs, buildVideoArgs, ffmpegPath, INPUT_FILE_MP4, INPUT_PIPE, ProgressParser, silentAudioInput } from "./ffmpeg.mjs";
import { minimalEnv } from "./env.mjs";
import { startSceneFeed } from "./capture.mjs";

/**
 * A live encoder: one ffmpeg process turning a SOURCE (the scene in Chromium, or the looping slate file) into an
 * OUTPUT (arguments supplied by a platform adapter). It is the unit the supervisor starts, watches and restarts.
 *
 * Events:  "progress" {frame,totalSize,bitrateKbps,outTimeMs,speed}   "log" {line}   "exit" {code,signal,expected,tail}
 *
 * @typedef {{
 *   mode: "scene"|"slate",
 *   source: { kind: "scene", url: string, allow?: readonly string[], viewport: { width: number, height: number } } | { kind: "file", file: string },
 *   encoding: import("./ffmpeg.mjs").Encoding,
 *   output: { args: string[], display: string },
 *   runId: string,
 * }} EncoderSpec
 */

/**
 * The full ffmpeg argument vector (pure; exported so it can be asserted and recorded without starting anything).
 * @param {EncoderSpec} spec
 */
export function buildLiveArgs(spec) {
  const e = spec.encoding;
  const src = spec.source;
  const input = src.kind === "scene"
    // analyzeduration/probesize are small on purpose: ffmpeg otherwise waits ~5 s of wall-clock input before it writes anything.
    ? ["-fflags", "nobuffer", "-probesize", "1000000", "-analyzeduration", "1", "-use_wallclock_as_timestamps", "1", "-thread_queue_size", "64", ...INPUT_PIPE, "-f", "image2pipe", "-c:v", "mjpeg", "-i", "pipe:0"]
    : ["-re", "-stream_loop", "-1", ...INPUT_FILE_MP4, "-i", src.file];
  // JPEG frames are full-range; say so, or the swscaler guesses (and warns on every frame batch).
  const range = src.kind === "scene" ? ":in_range=full:out_range=limited" : "";
  return [
    "-hide_banner", ...(src.kind === "scene" ? [] : ["-nostdin"]), "-loglevel", "warning", "-nostats", "-progress", "pipe:1",
    ...input,
    ...silentAudioInput(0, { realtime: true }),
    "-map", "0:v:0", "-map", "1:a:0",
    "-vf", `scale=${e.width}:${e.height}:flags=bicubic${range},fps=${e.fps},format=yuv420p`,
    ...buildVideoArgs(e), "-tune", "zerolatency",
    ...buildAudioArgs(e),
    // -shortest: when the scene feed closes, the (endless) silent audio must not keep the process alive.
    "-shortest", "-metadata", `comment=observatory-broadcast run ${spec.runId} ${spec.mode}`,
    ...spec.output.args,
  ];
}

export class FfmpegEncoder extends EventEmitter {
  /**
   * @param {EncoderSpec} spec
   * @param {{ spawn?: typeof nodeSpawn, env?: Record<string, string | undefined>, redactor: import("./redact.mjs").Redactor, startSceneFeed?: typeof startSceneFeed, now?: () => number }} deps
   */
  constructor(spec, deps) {
    super();
    this.spec = spec;
    this.deps = deps;
    /** @type {import("node:child_process").ChildProcess|null} */ this.child = null;
    /** @type {any} */ this.feed = null;
    this.stopping = false;
    this.exited = false;
    /** @type {Promise<void>|null} */ this.exitPromise = null;
    this.tail = [];
    this.frame = 0;
  }
  get pid() { return this.child?.pid ?? null; }
  get mode() { return this.spec.mode; }
  /** Redacted description of the command, safe to log or write to a manifest. */
  describe() {
    return this.deps.redactor.redact(["ffmpeg", ...buildLiveArgs(this.spec)].join(" "));
  }

  async start() {
    const { redactor } = this.deps;
    const spawn = this.deps.spawn ?? nodeSpawn;
    const args = buildLiveArgs(this.spec);
    const usesPipe = this.spec.source.kind === "scene";
    // minimal environment: the ingest URL is on argv (an ffmpeg limit), but no other secret rides along in the environment
    const child = spawn(ffmpegPath(this.deps.env), args, { stdio: [usesPipe ? "pipe" : "ignore", "pipe", "pipe"], env: minimalEnv(this.deps.env ?? process.env) });
    this.child = child;
    const parser = new ProgressParser(this.deps.now);
    child.stdout?.on("data", (d) => {
      for (const p of parser.feed(d)) { this.frame = p.frame; this.emit("progress", p); }
    });
    let errBuf = "";
    child.stderr?.on("data", (d) => {
      errBuf += d.toString();
      let nl;
      while ((nl = errBuf.indexOf("\n")) >= 0) {
        const line = redactor.redact(errBuf.slice(0, nl).trim());
        errBuf = errBuf.slice(nl + 1);
        if (!line) continue;
        this.tail.push(line); if (this.tail.length > 20) this.tail.shift();
        this.emit("log", { line });
      }
    });
    this.exitPromise = new Promise((resolve) => {
      let done = false;
      const finish = (/** @type {number|null} */ code, /** @type {string|null} */ signal, /** @type {string|undefined} */ error) => {
        if (done) return; done = true; this.exited = true;
        Promise.resolve(this.feed?.stop?.()).catch(() => {}).finally(() => {
          this.emit("exit", { code, signal, expected: this.stopping, tail: this.tail.slice(-5), error: error ? redactor.redact(error) : undefined });
          resolve();
        });
      };
      child.on("error", (e) => finish(null, null, e.message));
      child.on("close", (code, signal) => finish(code, signal));
    });

    if (usesPipe && child.stdin) {
      const stdin = child.stdin;
      stdin.on("error", () => { /* ffmpeg exited: reported through its exit event */ });
      const src = /** @type {{ kind: "scene", url: string, allow?: readonly string[], viewport: { width: number, height: number } }} */ (this.spec.source);
      try {
        this.feed = await (this.deps.startSceneFeed ?? startSceneFeed)({
          url: src.url, allow: src.allow, fps: this.spec.encoding.fps, viewport: src.viewport, env: this.deps.env,
          write: (b) => { if (this.exited || stdin.destroyed || stdin.writableLength > 4 * 1024 * 1024) return false; stdin.write(b); return true; },
          onError: (e) => this.emit("log", { line: redactor.redact(`scene feed error: ${e.message}`) }),
        });
      } catch (e) {
        // The scene could not even be opened: take the encoder down so the supervisor sees a failed start.
        this.emit("log", { line: redactor.redact(`scene start failed: ${/** @type {Error} */ (e).message}`) });
        this.stopping = false;
        child.kill("SIGKILL");
        await this.exitPromise;
        throw e;
      }
    }
  }

  /** Graceful stop: close the input and let ffmpeg finish, then escalate. Resolves once the process is gone. */
  async stop({ graceMs = 2500 } = {}) {
    if (!this.child || this.exited) { await this.exitPromise; return; }
    this.stopping = true;
    try { await this.feed?.stop?.(); } catch { /* browser already gone */ }
    this.feed = null;
    try { this.child.stdin?.end(); } catch { /* no stdin */ }
    const child = this.child;
    if (this.spec.source.kind !== "scene") child.kill("SIGINT");
    const t1 = setTimeout(() => { if (!this.exited) child.kill("SIGTERM"); }, graceMs);
    const t2 = setTimeout(() => { if (!this.exited) child.kill("SIGKILL"); }, graceMs * 2);
    await this.exitPromise;
    clearTimeout(t1); clearTimeout(t2);
  }
}
