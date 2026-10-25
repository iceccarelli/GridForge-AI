import crypto from "node:crypto";
import fs from "node:fs";
import { ObsError } from "./errors.mjs";
import { Supervisor } from "./supervisor.mjs";
import { generateSlate } from "./slate.mjs";
import { TOOL_NAME, TOOL_VERSION } from "./version.mjs";
import { realClock } from "./clock.mjs";
import { assertAllowedUrl } from "./safety.mjs";
import { mp4Problem, sha256File } from "./ffmpeg.mjs";

/**
 * Runs one broadcast: claims the supervisor slot, makes sure a slate exists, starts the Supervisor against the adapter,
 * mirrors its status into the state directory (so `obs status/health/stop/slate` can see and steer it), and returns when it stops.
 */

/**
 * Probe the scene page: can it still be fetched, and does it answer 2xx? (Only ever called with an allow-listed URL.)
 * @param {string} url
 */
export async function probeSceneUrl(url, timeoutMs = 3000) {
  try {
    const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
    await res.body?.cancel().catch(() => {});
    return res.status >= 200 && res.status < 300;
  } catch { return false; }
}

/**
 * Copy an operator-supplied media file into the state dir and check the COPY: it must look like an MP4 and, when a hash was
 * approved, match it. ffmpeg only ever reads the copy.
 * @param {string} src @param {string} dest @param {string|null} expectedSha256 @param {string} what
 */
export function pinFile(src, dest, expectedSha256, what) {
  if (!fs.existsSync(src)) throw new ObsError("source_missing", `${what} not found: ${src}`, { exitCode: 2 });
  try { fs.unlinkSync(dest); } catch { /* none */ }
  fs.copyFileSync(src, dest, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(dest, 0o600);
  const problem = mp4Problem(dest);
  if (problem) throw new ObsError("media_invalid", `${what}: ${problem}`, { exitCode: 2, hint: "Only MP4/MOV files are accepted." });
  if (expectedSha256 && sha256File(dest) !== expectedSha256) {
    throw new ObsError("file_changed", `${what} ${src} changed after it was approved (sha256 differs)`, { exitCode: 3, hint: "Run `obs prepare` again for the file you intend to publish." });
  }
  return dest;
}

/**
 * @param {{
 *   store: import("./state.mjs").StateStore, adapter: any, redactor: import("./redact.mjs").Redactor, logger: any,
 *   sceneUrl?: string|null, sourceFile?: string|null, allow?: readonly string[], encoding: import("./ffmpeg.mjs").Encoding,
 *   visibility: string, env?: Record<string, string | undefined>, clock?: any, health?: any, backoff?: any, rand?: () => number,
 *   sceneProbe?: () => Promise<boolean>|boolean, signal?: AbortSignal, maxRuntimeSec?: number, installSignalHandlers?: boolean,
 *   slateFile?: string|null, slateSha256?: string|null, sourceSha256?: string|null,
 * }} o
 */
export async function runPublish(o) {
  const clock = o.clock ?? realClock;
  if (!o.sceneUrl && !o.sourceFile) throw new ObsError("no_source", "nothing to broadcast: give --url (a presenter-mode scene) or --source-file", { exitCode: 2 });
  if (o.sceneUrl) assertAllowedUrl(o.sceneUrl, { allow: o.allow });
  if (o.sourceFile && !fs.existsSync(o.sourceFile)) throw new ObsError("source_missing", `source file not found: ${o.sourceFile}`, { exitCode: 2 });

  await o.store.claimSupervisor();
  const reaped = o.store.reapOrphans();
  if (reaped.length) o.logger.warn("orphans_found", { orphans: reaped });
  const runId = crypto.randomBytes(5).toString("hex");
  const startedAt = clock.now();
  /** @type {Supervisor|null} */ let sup = null;
  /** Serialise status writes; only the newest pending snapshot is written. */
  let writing = Promise.resolve();
  let pending = /** @type {any} */ (null);
  const baseDoc = {
    schema: "observatory-broadcast/status/1",
    tool: { name: TOOL_NAME, version: TOOL_VERSION },
    pid: process.pid,
    runId,
    startedAt: new Date(startedAt).toISOString(),
    sourceUrl: o.sceneUrl ?? null,
    sourceFile: o.sourceFile ? "(file)" : null,
    visibility: o.visibility,
    target: o.adapter.planDisplay?.() ?? o.adapter.name,
  };
  let lastChildPid = /** @type {number|null} */ (null);
  const flush = (/** @type {any} */ snap) => {
    const pid = snap?.encoder?.pid ?? null;
    if (pid !== lastChildPid) {
      lastChildPid = pid;
      try { o.store.recordChildren(pid ? [{ pid, mode: snap.encoder.mode }] : [], runId); } catch { /* best effort */ }
    }
    pending = snap;
    writing = writing.then(async () => {
      const s = pending; pending = null;
      if (!s) return;
      try { await o.store.updateStatus(o.redactor.redactDeep({ ...baseDoc, ...s })); } catch (e) { o.logger.warn("status_write_failed", { error: String(e) }); }
    });
    return writing;
  };

  let signalHandlers = [];
  try {
    // --- the slate: generated fresh for every run (never trusted from a previous one), or an approved operator file ---
    // Operator-supplied files are COPIED into the state dir and the copy is hashed against what was approved, so the file
    // ffmpeg reads is byte-for-byte the one that was approved (no swap between approval and use).
    let slateFile;
    if (o.slateFile) {
      slateFile = pinFile(o.slateFile, o.store.file("slate-supplied.mp4"), o.slateSha256 ?? null, "slate file");
    } else {
      slateFile = o.store.file(`slate-${runId}.mp4`);
      o.logger.info("slate_generate", { file: slateFile });
      await generateSlate({ out: slateFile, encoding: o.encoding, env: o.env });
    }
    const sourceFile = o.sourceFile ? pinFile(o.sourceFile, o.store.file("source-supplied.mp4"), o.sourceSha256 ?? null, "source file") : null;

    const viewport = { width: o.encoding.width, height: o.encoding.height };
    sup = new Supervisor({
      adapter: o.adapter,
      clock,
      logger: o.logger,
      health: o.health,
      backoff: o.backoff,
      rand: o.rand,
      streamFor: (mode) => ({
        mode,
        runId,
        visibility: o.visibility,
        encoding: o.encoding,
        source: mode === "slate"
          ? { kind: "file", file: slateFile }
          : sourceFile ? { kind: "file", file: sourceFile } : { kind: "scene", url: /** @type {string} */ (o.sceneUrl), allow: o.allow, viewport },
      }),
      sceneProbe: o.sceneProbe ?? (sourceFile ? () => fs.existsSync(sourceFile) : () => probeSceneUrl(/** @type {string} */ (o.sceneUrl))),
      onStatus: (s) => { void flush(s); },
      pollControl: () => o.store.readControl(),
    });

    const done = new Promise((resolve) => {
      // resolve only when the supervisor has finished stopping (encoder and browser really gone), not when it began to
      const check = setInterval(() => { if (sup?.stopPromise) { clearInterval(check); sup.stopPromise.then(() => resolve(sup?.stopReason), () => resolve(sup?.stopReason)); } }, 50);
      const finish = (/** @type {string} */ why) => () => { void sup?.stop(why); };
      if (o.installSignalHandlers) {
        for (const sig of /** @type {const} */ (["SIGINT", "SIGTERM"])) {
          const h = finish(`signal ${sig}`);
          process.on(sig, h);
          signalHandlers.push([sig, h]);
        }
      }
      o.signal?.addEventListener("abort", finish("aborted"), { once: true });
      if (o.maxRuntimeSec) setTimeout(finish("max runtime reached"), o.maxRuntimeSec * 1000).unref?.();
    });

    await sup.start();
    const reason = await done;
    await writing;
    await flush(sup.snapshot());
    return { stopReason: reason, snapshot: sup.snapshot(), runId, orphans: reaped };
  } finally {
    for (const [sig, h] of signalHandlers) process.off(sig, h);
    try { await sup?.stop("cleanup"); } catch { /* already stopped */ }
    await writing.catch(() => {});
    for (const f of [`slate-${runId}.mp4`, "slate-supplied.mp4", "source-supplied.mp4"]) { try { fs.unlinkSync(o.store.file(f)); } catch { /* not created */ } }
    await o.store.releaseSupervisor();
  }
}
