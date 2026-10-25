import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { ObsError } from "./errors.mjs";
import { Redactor, createLogger } from "./redact.mjs";
import { TOOL_NAME, TOOL_VERSION } from "./version.mjs";
import { StateStore, defaultStateDir } from "./state.mjs";
import { pidAlive, procHidesOtherUsers } from "./proc.mjs";
import { allowListFromEnv, assertAllowedUrl, checkDiskSpace } from "./safety.mjs";
import { parseCueJson, validateVtt } from "./captions.mjs";
import { mp4Problem, parseBitrateKbps, parseSize, requireFfmpeg, resolveEncoding, sha256File } from "./ffmpeg.mjs";
import { record } from "./record.mjs";
import { generateSlate } from "./slate.mjs";
import { createAdapter, ADAPTER_NAMES } from "./adapters/index.mjs";
import { VISIBILITIES, createApproval, consumeApproval, DEFAULT_TTL_MS } from "./approval.mjs";
import { runPublish } from "./publish.mjs";
import { realClock } from "./clock.mjs";

const HELP = `${TOOL_NAME} ${TOOL_VERSION} - GridForge Observatory broadcast pipeline (scene -> capture/encode -> publish)

usage: obs <command> [options]            (global: --state-dir DIR, --json)

  record   --url URL --out FILE.mp4 [--duration 10] [--fps 25] [--size 1280x720] [--bitrate 2500k]
           [--mode stepped|realtime] [--cues cues.json | --vtt file.vtt] [--captions soft|burn|both|none] [--hls]
  prepare  --adapter local|rtmp|youtube|kick (--url URL | --source-file F) [--visibility private|unlisted|public] [--ttl-sec 600]
  publish  --adapter A (--url URL | --source-file F) [--slate-file F] [--approve CODE] [--visibility V] [--approve-public]
           [--accept-argv-exposure] [--max-runtime-sec N]   (rtmp/youtube/kick count as PUBLIC; the key rides on ffmpeg's argv)
  status   show the broadcast state (never prints "live" unless a verification callback confirmed it)
  stop     graceful stop of the running broadcast
  slate    generate --out FILE | on | off     (cut the running broadcast to the fallback slate, or release it)
  health   exit 0 ok / 1 degraded / 2 down

Ingest URLs and stream keys are NEVER accepted as arguments. Set them in the environment (or *_FILE secret files):
  OBS_RTMP_URL [OBS_RTMP_KEY]   OBS_YOUTUBE_STREAM_KEY [OBS_YOUTUBE_INGEST_URL]   OBS_KICK_INGEST_URL OBS_KICK_STREAM_KEY
  OBS_LOCAL_SINK_DIR            OBS_STATE_DIR   OBS_ALLOW_URLS   PLAYWRIGHT_MODULE   CHROMIUM   OBS_FFMPEG   OBS_FFPROBE
`;

const FORBIDDEN_FLAG = /^--(stream-?key|key|rtmp-?url|ingest(-?url)?|secret|token|password)(=|$)/i;
const INGEST_LIKE = /\b(rtmps?|srt|rtsp):\/\//i;

/**
 * @param {string[]} argv
 * @param {{ env?: Record<string, string | undefined>, stdout?: (s: string) => void, stderr?: (s: string) => void, clock?: any, adapterDeps?: any, installSignalHandlers?: boolean, sceneProbe?: any, health?: any, backoff?: any, signal?: AbortSignal, procMounts?: string }} [io]
 * @returns {Promise<number>} exit code
 */
export async function main(argv, io = {}) {
  const env = io.env ?? process.env;
  const redactor = new Redactor();
  const rawOut = io.stdout ?? ((s) => process.stdout.write(s));
  const rawErr = io.stderr ?? ((s) => process.stderr.write(s));
  const out = (/** @type {string} */ s) => rawOut(redactor.redact(s) + "\n");
  const err = (/** @type {string} */ s) => rawErr(redactor.redact(s) + "\n");
  const logger = createLogger({ redactor, write: (l) => rawErr(l + "\n") });
  const json = argv.includes("--json");
  /** @param {any} v */ const emit = (v) => out(JSON.stringify(redactor.redactDeep(v), null, 2));

  try {
    // Secrets never ride on argv: refuse before doing anything else.
    for (const a of argv) {
      if (FORBIDDEN_FLAG.test(a) || INGEST_LIKE.test(a)) {
        throw new ObsError("secret_in_argv", "ingest URLs and stream keys are never accepted as arguments (they would land in shell history and the process table)", {
          exitCode: 2,
          hint: "Export OBS_RTMP_URL / OBS_YOUTUBE_STREAM_KEY / OBS_KICK_STREAM_KEY (or the matching *_FILE variable pointing at a 0600 file) and re-run without the argument.",
        });
      }
    }
    const [cmd, ...rest] = argv.filter((a) => a !== "--json");
    if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") { out(HELP); return cmd ? 0 : 2; }
    if (cmd === "--version") { out(`${TOOL_NAME} ${TOOL_VERSION}`); return 0; }

    const handlers = { record: cmdRecord, prepare: cmdPrepare, publish: cmdPublish, status: cmdStatus, stop: cmdStop, slate: cmdSlate, health: cmdHealth };
    const fn = /** @type {Record<string, Function>} */ (handlers)[cmd];
    if (!fn) throw new ObsError("unknown_command", `unknown command "${cmd}"`, { exitCode: 2, hint: "Run `obs help`." });
    return await fn(rest, { env, out, err, emit, json, redactor, logger, io });
  } catch (e) {
    return reportError(e, { err, json, emit });
  }
}

/** @param {unknown} e */
function reportError(e, { err, json, emit }) {
  if (e instanceof ObsError) {
    if (json) emit({ ok: false, error: { code: e.code, message: e.message, hint: e.hint ?? null } });
    else err(`error [${e.code}]: ${e.message}${e.hint ? `\n  hint: ${e.hint}` : ""}`);
    return e.exitCode;
  }
  const msg = e instanceof Error ? e.message : String(e);
  if (json) emit({ ok: false, error: { code: "internal", message: msg } });
  else err(`error [internal]: ${msg}`);
  return 1;
}

/** @param {string[]} args @param {Record<string, any>} options */
function parse(args, options) {
  try {
    return parseArgs({ args, options: { "state-dir": { type: "string" }, ...options }, allowPositionals: true, strict: true });
  } catch (e) {
    throw new ObsError("bad_option", /** @type {Error} */ (e).message, { exitCode: 2, hint: "Run `obs help`." });
  }
}

const num = (/** @type {string|undefined} */ v, /** @type {string} */ name, /** @type {number} */ dflt) => {
  if (v === undefined) return dflt;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new ObsError("bad_option", `--${name} must be a positive number`, { exitCode: 2 });
  return n;
};

/** @param {string[]} rest */
function encodingFromOptions(values) {
  const over = /** @type {Partial<import("./ffmpeg.mjs").Encoding>} */ ({});
  if (values.size) Object.assign(over, parseSize(values.size));
  if (values.fps) over.fps = Math.round(num(values.fps, "fps", 25));
  if (values.bitrate) over.videoBitrateKbps = parseBitrateKbps(values.bitrate);
  const { encoding, errors } = resolveEncoding(over);
  if (errors.length) throw new ObsError("bad_encoding", `invalid encoding settings: ${errors.join("; ")}`, { exitCode: 2 });
  return encoding;
}

function loadCues(values) {
  if (values.cues && values.vtt) throw new ObsError("bad_option", "give --cues or --vtt, not both", { exitCode: 2 });
  if (values.cues) return parseCueJson(fs.readFileSync(values.cues, "utf8"));
  if (values.vtt) {
    const v = validateVtt(fs.readFileSync(values.vtt, "utf8"));
    if (!v.valid) throw new ObsError("captions_invalid", `${values.vtt} is not valid WebVTT: ${v.errors.slice(0, 5).join("; ")}`, { exitCode: 2 });
    return v.cues;
  }
  return null;
}

// ------------------------------------------------------------------------------------------------------ record
async function cmdRecord(args, c) {
  const { values } = parse(args, {
    url: { type: "string" }, out: { type: "string" }, duration: { type: "string" }, fps: { type: "string" }, size: { type: "string" }, bitrate: { type: "string" },
    mode: { type: "string" }, cues: { type: "string" }, vtt: { type: "string" }, captions: { type: "string" }, hls: { type: "boolean" },
  });
  if (!values.url || !values.out) throw new ObsError("bad_option", "record needs --url and --out", { exitCode: 2 });
  const ac = new AbortController();
  const onSig = () => ac.abort();
  process.on("SIGINT", onSig); process.on("SIGTERM", onSig);
  try {
    const r = await record({
      url: values.url, out: values.out, durationSec: num(values.duration, "duration", 10), mode: /** @type {any} */ (values.mode), captions: /** @type {any} */ (values.captions),
      cues: loadCues(values) ?? undefined, hls: !!values.hls, encoding: encodingFromOptions(values), allow: allowListFromEnv(c.env), env: c.env, signal: c.io.signal ?? ac.signal,
    });
    const m = r.manifest;
    if (c.json) c.emit({ ok: true, out: r.out, manifest: r.manifestPath, sidecar: r.sidecar, summary: m.output });
    else {
      c.out(`recorded ${r.out}`);
      c.out(`  ${m.output.video.codec} ${m.output.video.width}x${m.output.video.height} @ ${m.output.video.fps.toFixed(2)} fps, ${m.output.durationSec.toFixed(2)} s, ${m.output.frames} frames; audio ${m.output.audio?.codec ?? "none"}; subtitle streams: ${m.output.subtitleStreams.length}`);
      c.out(`  sha256 ${m.output.sha256}`);
      c.out(`  manifest ${r.manifestPath}${r.sidecar ? `\n  captions ${r.sidecar}` : ""}`);
      for (const w of m.warnings) c.out(`  warning: ${w}`);
    }
    return 0;
  } catch (e) {
    if (e instanceof ObsError && e.code === "aborted") { c.err("record aborted; partial output removed"); return 130; }
    throw e;
  } finally { process.off("SIGINT", onSig); process.off("SIGTERM", onSig); }
}

// ------------------------------------------------------------------------------------------------ adapter setup
function setupAdapter(name, c) {
  if (!name) throw new ObsError("bad_option", `--adapter is required (${ADAPTER_NAMES.join(", ")})`, { exitCode: 2 });
  const store = new StateStore(c.stateDir);
  const adapter = createAdapter(name, { env: c.env, redactor: c.redactor, logger: c.logger, clock: c.io.clock ?? realClock, defaultSinkDir: path.join(store.dir, "sink"), ...(c.io.adapterDeps ?? {}) });
  const cfg = adapter.validateConfig(c.env);
  return { store, adapter, cfg };
}

function failConfig(adapter, cfg, c) {
  if (c.json) c.emit({ ok: false, adapter: adapter.name, status: adapter.status(), errors: cfg.errors });
  else {
    c.err(`${adapter.name}: not configured`);
    for (const e of cfg.errors) c.err(`  - ${e}`);
  }
  return 2;
}

function resolveSource(values, c) {
  if (values.url && values["source-file"]) throw new ObsError("bad_option", "give --url or --source-file, not both", { exitCode: 2 });
  const allow = allowListFromEnv(c.env);
  if (values.url) assertAllowedUrl(values.url, { allow });
  return {
    sceneUrl: values.url ?? null,
    sourceFile: values["source-file"] ? hashedMedia(values["source-file"], "source file") : null,
    slateFile: values["slate-file"] ? hashedMedia(values["slate-file"], "slate file") : null,
    allow,
  };
}

/** Resolved path + sha256 of an operator-supplied MP4: what the approval is bound to. */
function hashedMedia(p, what) {
  const abs = path.resolve(p);
  const problem = mp4Problem(abs);
  if (problem) throw new ObsError("media_invalid", `${what}: ${problem}`, { exitCode: 2, hint: "Only MP4/MOV files are accepted." });
  return { path: abs, sha256: sha256File(abs) };
}

/** Contents of /proc/mounts (injectable for tests); empty when unreadable. */
function readProcMounts(c) {
  if (typeof c.io.procMounts === "string") return c.io.procMounts;
  try { return fs.readFileSync("/proc/mounts", "utf8"); } catch { return ""; }
}

/** Look for (and reap) encoders orphaned by a dead supervisor, and say what was found. */
function reportOrphans(store, c) {
  const rep = store.reapOrphans();
  if (!c.json) for (const o of rep) if (o.action !== "gone") c.err(`orphan: ffmpeg pid ${o.pid} (run ${o.runId}) ${o.action}: ${o.reason}`);
  return rep;
}

function visibilityOf(values) {
  const v = values.visibility ?? "unlisted";
  if (!VISIBILITIES.includes(v)) throw new ObsError("bad_visibility", `--visibility must be one of ${VISIBILITIES.join(", ")}`, { exitCode: 2 });
  return v;
}

const COMMON = { adapter: { type: "string" }, url: { type: "string" }, "source-file": { type: "string" }, "slate-file": { type: "string" }, visibility: { type: "string" }, fps: { type: "string" }, size: { type: "string" }, bitrate: { type: "string" } };

// ------------------------------------------------------------------------------------------------------ prepare
async function cmdPrepare(args, c) {
  const { values } = parse(args, { ...COMMON, "ttl-sec": { type: "string" } });
  c.stateDir = values["state-dir"] ?? defaultStateDir(c.env);
  const { store, adapter, cfg } = setupAdapter(values.adapter, c);
  if (!cfg.ok) return failConfig(adapter, cfg, c);
  const src = resolveSource(values, c);
  if (!src.sceneUrl && !src.sourceFile) throw new ObsError("no_source", "prepare needs --url (a presenter-mode scene) or --source-file", { exitCode: 2 });
  const visibility = visibilityOf(values);
  const encoding = encodingFromOptions(values);
  const pre = await adapter.preflight({ diskDir: store.dir });
  if (!pre.ok) {
    if (c.json) c.emit({ ok: false, adapter: adapter.name, status: adapter.status(), preflight: pre });
    else { c.err(`${adapter.name}: preflight failed`); for (const k of pre.checks.filter((x) => !x.ok)) c.err(`  - ${k.name}: ${k.detail}`); }
    return 2;
  }
  const ap = await createApproval({
    store, clock: c.io.clock ?? realClock, ttlMs: num(values["ttl-sec"], "ttl-sec", DEFAULT_TTL_MS / 1000) * 1000,
    plan: {
      adapter: adapter.name, visibility, sourceUrl: src.sceneUrl ?? "(file)", encoding, target: adapter.planTarget?.() ?? null, targetDisplay: adapter.planDisplay?.() ?? adapter.name,
      sourceFile: src.sourceFile, slateFile: src.slateFile, notes: [...cfg.warnings, ...pre.notes],
    },
  });
  const needsPublic = visibility === "public" || adapter.treatAsPublic;
  const publicNote = needsPublic ? (visibility === "public" ? "PUBLIC visibility: publish will also require --approve-public" : "platform-side visibility is beyond this tool: publish will require --approve-public") : null;
  if (c.json) {
    c.emit({ ok: true, plan: ap.plan, id: ap.id, expiresAt: ap.expiresAt, codeFile: ap.codeFile, requiresApproval: adapter.requiresApproval, preflight: pre, publicNote });
  } else {
    c.out(`plan ${ap.id} for ${adapter.name}`);
    c.out(`  target      ${ap.plan.targetDisplay}`);
    c.out(`  scene       ${src.sceneUrl ?? "(source file)"}`);
    c.out(`  visibility  ${visibility}${publicNote ? `  <- ${publicNote}` : ""}`);
    c.out(`  encoding    ${encoding.width}x${encoding.height} @ ${encoding.fps} fps, ${encoding.videoBitrateKbps} kbps H.264 + silent AAC`);
    c.out(`  preflight   ${pre.verified ? "local checks passed (verified locally)" : "local checks passed; platform NOT contacted - ingest unverified (verified:false)"}`);
    for (const n of ap.plan.notes) c.out(`  note        ${n}`);
    c.out(`approval code written to ${ap.codeFile} (not printed). It expires ${ap.expiresAt}.`);
    c.out(`next: obs publish --adapter ${adapter.name} ${src.sceneUrl ? `--url ${src.sceneUrl}` : "--source-file ..."} --visibility ${visibility} --approve <code>${needsPublic ? " --approve-public" : ""}${adapter.keyOnArgv ? " --accept-argv-exposure" : ""}`);
  }
  return 0;
}

// ------------------------------------------------------------------------------------------------------ publish
async function cmdPublish(args, c) {
  const { values } = parse(args, {
    ...COMMON, approve: { type: "string" }, "approve-public": { type: "boolean" }, "max-runtime-sec": { type: "string" },
    "stall-timeout-sec": { type: "string" }, "max-attempts": { type: "string" }, "accept-argv-exposure": { type: "boolean" },
  });
  c.stateDir = values["state-dir"] ?? defaultStateDir(c.env);
  const { store, adapter, cfg } = setupAdapter(values.adapter, c);
  if (!cfg.ok) return failConfig(adapter, cfg, c);
  const src = resolveSource(values, c);
  if (!src.sceneUrl && !src.sourceFile) throw new ObsError("no_source", "publish needs --url (a presenter-mode scene) or --source-file", { exitCode: 2 });
  const visibility = visibilityOf(values);
  const encoding = encodingFromOptions(values);

  // The stream key rides on ffmpeg's command line. That is an ffmpeg limit, not something this tool solves, so publishing
  // needs an explicit acknowledgement, checked BEFORE the approval code is spent. (hidepid hides the process table from
  // OTHER users only; the same user can always read it.)
  let argvNote = null;
  if (adapter.keyOnArgv) {
    const hidden = procHidesOtherUsers(readProcMounts(c));
    if (!values["accept-argv-exposure"] && !hidden) {
      throw new ObsError("argv_exposure_not_accepted", `${adapter.name}: the stream key is passed to ffmpeg on its command line and /proc is not mounted with hidepid>=1, so other users on this host can read it while the stream runs`, {
        exitCode: 3,
        hint: "Run the broadcaster as a dedicated user or in a container, then pass --accept-argv-exposure to acknowledge the risk (or mount /proc with hidepid=2).",
      });
    }
    argvNote = hidden ? "the stream key is on ffmpeg's command line; /proc hides it from OTHER users (hidepid), not from this user" : "argv exposure of the stream key accepted by the operator (--accept-argv-exposure)";
  }

  // Gate first: nothing is started, probed or written until the approval is consumed.
  if (adapter.requiresApproval || visibility === "public") {
    await consumeApproval({
      store, code: values.approve, approvePublic: !!values["approve-public"], treatAsPublic: adapter.treatAsPublic, clock: c.io.clock ?? realClock,
      request: { adapter: adapter.name, visibility, sourceUrl: src.sceneUrl ?? "(file)", target: adapter.planTarget?.() ?? null, encoding, sourceFile: src.sourceFile, slateFile: src.slateFile },
    });
  }
  if (argvNote) c.err(`note: ${argvNote}`);
  const pre = await adapter.preflight({ diskDir: store.dir });
  if (!pre.ok) {
    c.err(`${adapter.name}: preflight failed`);
    for (const k of pre.checks.filter((x) => !x.ok)) c.err(`  - ${k.name}: ${k.detail}`);
    return 2;
  }
  (c.io.adapterDeps?.checkFfmpeg ?? (() => requireFfmpeg(c.env)))();
  const health = { ...(c.io.health ?? {}) };
  if (values["stall-timeout-sec"]) health.stallTimeoutMs = num(values["stall-timeout-sec"], "stall-timeout-sec", 10) * 1000;
  const backoff = { ...(c.io.backoff ?? {}) };
  if (values["max-attempts"]) backoff.maxAttempts = Math.round(num(values["max-attempts"], "max-attempts", 6));

  c.logger.info("publish_start", { adapter: adapter.name, visibility, target: adapter.planDisplay?.() ?? adapter.name });
  if (!adapter.canVerify) c.err(`note: live status cannot be verified for ${adapter.name} in this build; this tool will not report "live" for it.`);
  const r = await runPublish({
    store, adapter, redactor: c.redactor, logger: c.logger, sceneUrl: src.sceneUrl, sourceFile: src.sourceFile?.path ?? null, sourceSha256: src.sourceFile?.sha256 ?? null,
    allow: src.allow, encoding, visibility, env: c.env, slateFile: src.slateFile?.path ?? null, slateSha256: src.slateFile?.sha256 ?? null,
    clock: c.io.clock, health, backoff, sceneProbe: c.io.sceneProbe, signal: c.io.signal,
    maxRuntimeSec: values["max-runtime-sec"] ? num(values["max-runtime-sec"], "max-runtime-sec", 60) : undefined,
    installSignalHandlers: c.io.installSignalHandlers ?? true,
  });
  if (c.json) c.emit({ ok: true, stopReason: r.stopReason, final: r.snapshot });
  else c.out(`broadcast ended (${r.stopReason}); final state ${r.snapshot.state}`);
  return r.snapshot.stopReason === "output_failed" ? 1 : 0;
}

// ------------------------------------------------------------------------------------------------------ status
function readLive(store) {
  const st = store.readStatus();
  const pid = store.supervisorPid();
  return { st, pid, alive: pid !== null };
}

async function cmdStatus(args, c) {
  const { values } = parse(args, {});
  const store = new StateStore(values["state-dir"] ?? defaultStateDir(c.env));
  const { st, alive, pid } = readLive(store);
  const orphans = reportOrphans(store, c).filter((o) => o.action !== "gone");
  if (!st) { if (c.json) c.emit({ running: false, state: null, orphans }); else c.out("no broadcast has run in this state directory"); return 0; }
  // A status file left by a dead supervisor must not be read as a live broadcast.
  const stale = !alive && !["stopped", "not_configured", "preflight_failed"].includes(st.state);
  const view = { running: alive, pid, orphans, ...st, ...(stale ? { staleState: st.state, state: "stopped", detail: `supervisor is not running (last recorded state ${st.state})`, verified: false } : {}) };
  if (c.json) c.emit(view);
  else {
    c.out(`state     ${view.state}${view.verified ? " (verified)" : " (verified:false)"}`);
    c.out(`adapter   ${view.adapter ?? "-"}   phase ${view.phase ?? "-"}   visibility ${view.visibility ?? "-"}`);
    c.out(`detail    ${view.detail ?? "-"}`);
    if (view.message) c.out(`message   ${view.message}`);
    if (view.evidence) c.out(`evidence  ${view.evidence}`);
    if (view.encoder) c.out(`encoder   pid ${view.encoder.pid} frame ${view.encoder.frame} bitrate ${view.encoder.bitrateKbps == null ? "n/a" : Math.round(view.encoder.bitrateKbps) + " kbps"}`);
    if (view.attempts) c.out(`reconnect attempts ${view.attempts}/${view.budget}${view.nextRetryAt ? `, next ${view.nextRetryAt}` : ""}`);
    c.out(`running   ${alive ? `yes (pid ${pid})` : "no"}   heartbeat ${view.heartbeatAt ?? "-"}`);
  }
  return 0;
}

// ------------------------------------------------------------------------------------------------------ stop
async function cmdStop(args, c) {
  const { values } = parse(args, { "timeout-sec": { type: "string" } });
  const store = new StateStore(values["state-dir"] ?? defaultStateDir(c.env));
  const pid = store.supervisorPid();
  if (pid === null) {
    // No supervisor, but its encoder may have outlived it (SIGKILL, OOM): find it, kill it, and SAY so.
    const orphans = reportOrphans(store, c);
    const found = orphans.filter((o) => o.action !== "gone");
    const stuck = found.some((o) => o.action === "left");
    if (c.json) c.emit({ ok: !stuck, running: false, orphans });
    else c.out(found.length ? `no broadcast is running, but ${found.length} orphaned encoder process(es) were found: ${found.map((o) => `pid ${o.pid} ${o.action}`).join(", ")}` : "no broadcast is running");
    return stuck ? 1 : 0;
  }
  try { process.kill(pid, "SIGTERM"); } catch (e) {
    throw new ObsError("stop_denied", `could not signal pid ${pid} (${/** @type {any} */ (e).code ?? "error"})`, { hint: "The broadcaster runs as another user; stop it as that user (or root)." });
  }
  const deadline = Date.now() + num(values["timeout-sec"], "timeout-sec", 15) * 1000;
  while (pidAlive(pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  if (pidAlive(pid)) throw new ObsError("stop_timeout", `pid ${pid} did not exit after SIGTERM`, { hint: "Inspect with `obs status`; as a last resort kill -9 the pid and its ffmpeg child." });
  c.json ? c.emit({ ok: true, stopped: pid }) : c.out(`stopped broadcast (pid ${pid})`);
  return 0;
}

// ------------------------------------------------------------------------------------------------------ slate
async function cmdSlate(args, c) {
  const [sub, ...rest] = args;
  const { values } = parse(rest, { out: { type: "string" }, fps: { type: "string" }, size: { type: "string" }, duration: { type: "string" } });
  const store = new StateStore(values["state-dir"] ?? defaultStateDir(c.env));
  if (sub === "generate") {
    if (!values.out) throw new ObsError("bad_option", "slate generate needs --out FILE.mp4", { exitCode: 2 });
    const encoding = encodingFromOptions({ size: values.size, fps: values.fps });
    const r = await generateSlate({ out: values.out, durationSec: num(values.duration, "duration", 6), encoding, env: c.env });
    c.json ? c.emit({ ok: true, ...r }) : c.out(`slate written to ${r.out} (${r.width}x${r.height}, ${r.durationSec}s loop): "${r.text}"`);
    return 0;
  }
  if (sub === "on" || sub === "off") {
    await store.setControl({ forceSlate: sub === "on" });
    const alive = store.supervisorPid() !== null;
    c.json ? c.emit({ ok: true, forceSlate: sub === "on", supervisorRunning: alive }) : c.out(`fallback slate ${sub === "on" ? "requested" : "released"}${alive ? "" : " (no broadcast is running; the setting applies to the next one)"}`);
    return 0;
  }
  throw new ObsError("bad_option", "usage: obs slate generate --out FILE | obs slate on | obs slate off", { exitCode: 2 });
}

// ------------------------------------------------------------------------------------------------------ health
async function cmdHealth(args, c) {
  const { values } = parse(args, { "max-age-sec": { type: "string" } });
  const store = new StateStore(values["state-dir"] ?? defaultStateDir(c.env));
  const maxAge = num(values["max-age-sec"], "max-age-sec", 10) * 1000;
  const { st, alive, pid } = readLive(store);
  const orphans = reportOrphans(store, c).filter((o) => o.action !== "gone");
  /** @type {{ name: string, ok: boolean, detail: string }[]} */ const checks = [];
  try { checks.push({ name: "ffmpeg", ok: true, detail: requireFfmpeg(c.env) }); } catch (e) { checks.push({ name: "ffmpeg", ok: false, detail: /** @type {Error} */ (e).message }); }
  const chromium = c.env.CHROMIUM || "/opt/pw-browsers/chromium";
  checks.push({ name: "chromium", ok: fs.existsSync(chromium), detail: chromium });
  try { const d = checkDiskSpace(store.dir, 256 * 1024 * 1024); checks.push({ name: "disk", ok: d.ok, detail: `${Math.floor(d.freeBytes / 1e6)} MB free` }); } catch (e) { checks.push({ name: "disk", ok: false, detail: String(e) }); }

  let status = "down"; let reason = "no broadcast running";
  if (alive && st) {
    const hb = st.heartbeatAt ? Date.now() - Date.parse(st.heartbeatAt) : Infinity;
    const adv = st.encoder?.lastFrameAdvanceAt ? Date.now() - Date.parse(st.encoder.lastFrameAdvanceAt) : Infinity;
    if (hb > maxAge) { status = "down"; reason = `supervisor heartbeat is ${Math.round(hb / 1000)} s old`; }
    else if (["reconnecting", "fallback_slate"].includes(st.state)) { status = "degraded"; reason = st.state === "fallback_slate" ? "showing the fallback slate" : "reconnecting"; }
    else if (st.state === "stopped") { status = "down"; reason = "stopped"; }
    else if (!st.encoder) { status = "degraded"; reason = "no encoder running"; }
    else if (adv > maxAge * 3) { status = "degraded"; reason = `frame counter has not advanced for ${Math.round(adv / 1000)} s`; }
    else { status = "ok"; reason = `${st.state}${st.verified ? " (verified)" : " (unverified)"}, encoder frames advancing`; }
  } else if (st && !alive) reason = `supervisor not running (last state ${st.state})`;
  if (orphans.length) { status = "down"; reason = `${reason}; ${orphans.length} orphaned encoder process(es) found: ${orphans.map((o) => `pid ${o.pid} ${o.action}`).join(", ")}`; }
  const code = status === "ok" ? 0 : status === "degraded" ? 1 : 2;
  const doc = { status, reason, pid, state: st?.state ?? null, verified: st?.verified ?? false, orphans, checks };
  if (c.json) c.emit(doc);
  else { c.out(`${status}: ${reason}`); for (const k of checks) c.out(`  ${k.ok ? "ok  " : "FAIL"} ${k.name}: ${k.detail}`); }
  return code;
}
