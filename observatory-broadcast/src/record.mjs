import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ObsError } from "./errors.mjs";
import { TOOL_NAME, TOOL_VERSION } from "./version.mjs";
import { assertAllowedUrl, assertDiskSpace, estimateBytes } from "./safety.mjs";
import { buildVtt, clipCues, validateVtt } from "./captions.mjs";
import {
  buildEncodeArgs, burnFilter, ffmpegHas, INPUT_FILE_MP4, INPUT_FILE_VTT, INPUT_FILE_WEBM, INPUT_PIPE, probeMedia, requireFfmpeg, resolveEncoding,
  runFfmpeg, sha256File, silentAudioInput,
} from "./ffmpeg.mjs";

/** Present in an HLS output directory this tool created; only such a directory is ever replaced. */
export const HLS_MARKER = ".observatory-broadcast-hls";
import { captureRealtime, captureStepped, openScene } from "./capture.mjs";
import { Redactor } from "./redact.mjs";

/**
 * STAGE 2: CAPTURE / ENCODE. A scene URL -> H.264/AAC MP4 with a silent audio track and captions, plus a manifest.
 *
 *   mode "stepped"  : frame i is the page at t=i/fps (?t=&freeze=1), PNG screenshots piped to ffmpeg. Deterministic:
 *                     the manifest carries a sha256 over the raw frames, so two runs of the same page can be compared.
 *   mode "realtime" : Playwright recordVideo of the page running on its own clock, transcoded by ffmpeg.
 *
 * Captions: "soft" = a mov_text track in the MP4 (plus the sidecar .vtt), "burn" = rendered into the pixels,
 * "both", or "none". Optional HLS packaging (video + silent audio only) of the finished MP4.
 *
 * @typedef {{
 *   url: string, out: string, durationSec: number, mode?: "stepped"|"realtime",
 *   cues?: unknown, captions?: "soft"|"burn"|"both"|"none", hls?: boolean,
 *   encoding?: Partial<import("./ffmpeg.mjs").Encoding>, allow?: readonly string[],
 *   env?: Record<string, string | undefined>, signal?: AbortSignal, now?: () => number, onProgress?: (p: any) => void,
 *   track?: Set<import("node:child_process").ChildProcess>
 * }} RecordOptions
 */
export async function record(/** @type {RecordOptions} */ o) {
  const env = o.env ?? process.env;
  const now = o.now ?? (() => Date.now());
  const mode = o.mode ?? "stepped";
  const captionMode = o.captions ?? (o.cues ? "soft" : "none");
  if (!["stepped", "realtime"].includes(mode)) throw new ObsError("bad_option", `mode must be stepped or realtime`, { exitCode: 2 });
  if (!["soft", "burn", "both", "none"].includes(captionMode)) throw new ObsError("bad_option", `captions must be soft, burn, both or none`, { exitCode: 2 });
  if (!(o.durationSec > 0 && o.durationSec <= 3600)) throw new ObsError("bad_option", "duration must be between 0 and 3600 seconds", { exitCode: 2 });

  // --- preflight: everything that can be refused is refused before a browser or encoder starts ---
  const sceneUrl = assertAllowedUrl(o.url, { allow: o.allow });
  const { encoding, errors } = resolveEncoding(o.encoding);
  if (errors.length) throw new ObsError("bad_encoding", `invalid encoding settings: ${errors.join("; ")}`, { exitCode: 2 });
  const ffmpegVersion = requireFfmpeg(env);
  if ((captionMode === "burn" || captionMode === "both") && !ffmpegHas("filter", "subtitles", env)) {
    throw new ObsError("burn_unavailable", "this ffmpeg has no `subtitles` filter (libass); burned-in captions are unavailable", { exitCode: 2, hint: "Use --captions soft, or install an ffmpeg built with libass." });
  }
  let vtt = null;
  if (captionMode !== "none") {
    if (!o.cues) throw new ObsError("captions_missing", `captions "${captionMode}" requested but no cues were given`, { exitCode: 2, hint: "Pass --cues cues.json or --vtt file.vtt, or use --captions none." });
    vtt = buildVtt(clipCues(o.cues, o.durationSec));
  }
  const out = path.resolve(o.out);
  if (o.hls) {
    const planned = out.replace(/\.mp4$/i, "") + "-hls";
    if (fs.existsSync(planned) && !fs.existsSync(path.join(planned, HLS_MARKER))) {
      throw new ObsError("hls_dir_exists", `${planned} already exists and was not created by this tool; refusing to delete it`, { exitCode: 2, hint: "Choose another --out, or remove that directory yourself." });
    }
  }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  assertDiskSpace(path.dirname(out), estimateBytes(o.durationSec, encoding.videoBitrateKbps, { overhead: mode === "stepped" ? 2 : 6 }));

  const runId = crypto.randomBytes(5).toString("hex");
  const work = fs.mkdtempSync(path.join(os.tmpdir(), `obs-rec-${runId}-`));
  const track = o.track ?? new Set();
  const tmpOut = `${out}.partial-${runId}.mp4`;
  const startedAt = now();
  try {
    const vttPath = path.join(work, "captions.vtt");
    if (vtt) fs.writeFileSync(vttPath, vtt);

    /** @type {string[]} */ let inputArgs;
    /** @type {any} */ let capture;
    const frames = Math.round(o.durationSec * encoding.fps);
    let framesSha256 = null;
    const size = `${encoding.width}x${encoding.height}`;

    // --- build the ffmpeg command ---
    const vf = [`scale=${size}:flags=bicubic`, "format=yuv420p"];
    if (captionMode === "burn" || captionMode === "both") vf.push(burnFilter(vttPath));
    const soft = captionMode === "soft" || captionMode === "both";
    const outArgs = [
      // The audio source is longer than the video and the OUTPUT is cut at the requested duration (-t): the video, not
      // AAC frame granularity, decides how long the file is (with -shortest the last video frame could be lost).
      ...silentAudioInput(o.durationSec + 1),
      ...(soft ? [...INPUT_FILE_VTT, "-i", vttPath] : []),
      "-map", "0:v:0", "-map", "1:a:0", ...(soft ? ["-map", "2:0"] : []),
      "-vf", vf.join(","), "-r", String(encoding.fps), ...buildEncodeArgs(encoding),
      ...(soft ? ["-c:s", "mov_text", "-metadata:s:s:0", "language=eng", "-metadata:s:s:0", "title=Captions"] : []),
      "-t", String(o.durationSec), "-movflags", "+faststart", "-metadata", `comment=${TOOL_NAME} ${TOOL_VERSION} run ${runId}`,
      "-f", "mp4", "-y", tmpOut,
    ];

    if (mode === "stepped") {
      inputArgs = [...INPUT_PIPE, "-f", "image2pipe", "-framerate", String(encoding.fps), "-i", "pipe:0"];
      const args = [...inputArgs, ...outArgs];
      const hash = crypto.createHash("sha256");
      const scene = await openScene({ url: sceneUrl.toString(), allow: o.allow, viewport: { width: encoding.width, height: encoding.height }, env, workRoot: work });
      try {
        await runFfmpeg(args, {
          env, signal: o.signal, track, onProgress: o.onProgress,
          stdin: async (w) => {
            try {
              await captureStepped({
                page: scene.page, url: sceneUrl.toString(), allow: o.allow, fps: encoding.fps, frames, signal: o.signal,
                onFrame: async (png) => {
                  hash.update(png);
                  if (!w.write(png)) await new Promise((r) => w.once("drain", r));
                },
              });
            } finally { w.end(); }
          },
        });
        capture = { blocked: scene.blocked };
      } finally { await scene.close(); }
      framesSha256 = hash.digest("hex");
    } else {
      const rt = await captureRealtime({ url: sceneUrl.toString(), allow: o.allow, viewport: { width: encoding.width, height: encoding.height }, durationSec: o.durationSec + 0.5, workDir: work, env, signal: o.signal });
      capture = { blocked: rt.blocked, leadInSec: rt.leadInSec };
      inputArgs = ["-ss", rt.leadInSec.toFixed(3), "-t", String(o.durationSec), ...INPUT_FILE_WEBM, "-i", rt.webm];
      await runFfmpeg([...inputArgs, ...outArgs], { env, signal: o.signal, track, onProgress: o.onProgress });
    }

    fs.renameSync(tmpOut, out);
    const sidecar = vtt ? out.replace(/\.mp4$/i, "") + ".vtt" : null;
    if (sidecar && vtt) fs.writeFileSync(sidecar, vtt);

    // --- optional HLS (video + silent audio; the mov_text track is not carried into MPEG-TS) ---
    let hls = null;
    if (o.hls) {
      const hlsDir = out.replace(/\.mp4$/i, "") + "-hls";
      // only a directory this tool made (it carries the marker) is ever replaced; preflight already refused anything else
      if (fs.existsSync(hlsDir)) {
        if (!fs.existsSync(path.join(hlsDir, HLS_MARKER))) throw new ObsError("hls_dir_exists", `${hlsDir} exists and was not created by this tool; refusing to delete it`, { exitCode: 2 });
        fs.rmSync(hlsDir, { recursive: true, force: true });
      }
      fs.mkdirSync(hlsDir, { recursive: true });
      fs.writeFileSync(path.join(hlsDir, HLS_MARKER), `created by ${TOOL_NAME} ${TOOL_VERSION}\n`);
      await runFfmpeg([...INPUT_FILE_MP4, "-i", out, "-map", "0:v:0", "-map", "0:a:0", "-c", "copy", "-f", "hls", "-hls_time", "2", "-hls_playlist_type", "vod", "-hls_segment_filename", path.join(hlsDir, "seg_%03d.ts"), path.join(hlsDir, "index.m3u8")], { env, signal: o.signal, track });
      const files = fs.readdirSync(hlsDir).sort();
      hls = { dir: hlsDir, playlist: "index.m3u8", segments: files.filter((f) => f.endsWith(".ts")).length, playlistSha256: sha256File(path.join(hlsDir, "index.m3u8")), captions: "not included (HLS carries video+audio only; use the sidecar .vtt)" };
    }

    // --- probe + manifest ---
    const probe = probeMedia(out, env);
    const warnings = [];
    if (probe.video && probe.video.frames !== frames && mode === "stepped") warnings.push(`expected ${frames} frames, decoded ${probe.video.frames}`);
    if (capture.blocked?.length) warnings.push(`${capture.blocked.length} page request(s) blocked by the origin guard`);
    const redactor = new Redactor();
    const manifest = redactor.redactDeep({
      schema: "observatory-broadcast/manifest/1",
      tool: { name: TOOL_NAME, version: TOOL_VERSION },
      createdAt: new Date(now()).toISOString(),
      elapsedMs: now() - startedAt,
      source: { url: sceneUrl.toString(), mode, viewport: { width: encoding.width, height: encoding.height }, framesSha256, leadInSec: capture.leadInSec ?? null, synthetic: true },
      encoding: { ...encoding, codecs: { video: "h264 (libx264)", audio: "aac (silent)" } },
      encoder: { ffmpeg: ffmpegVersion, args: ["ffmpeg", ...inputArgs.map(redactWorkPath(work)), ...outArgs.map(redactWorkPath(work))] },
      captions: vtt ? { mode: captionMode, cues: validateVtt(vtt).cues.length, vttSha256: crypto.createHash("sha256").update(vtt).digest("hex"), sidecar: sidecar ? path.basename(sidecar) : null } : { mode: "none" },
      output: { file: path.basename(out), sha256: sha256File(out), bytes: probe.bytes, durationSec: probe.durationSec, frames: probe.video?.frames ?? null, video: probe.video, audio: probe.audio, subtitleStreams: probe.subtitles },
      hls,
      warnings,
    });
    const manifestPath = out.replace(/\.mp4$/i, "") + ".manifest.json";
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    return { out, sidecar, manifestPath, manifest };
  } catch (e) {
    for (const c of track) { try { c.kill("SIGKILL"); } catch { /* gone */ } }
    try { fs.rmSync(tmpOut, { force: true }); } catch { /* none */ }
    throw e;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

/** Manifest arguments must not leak the throwaway work directory layout. */
function redactWorkPath(work) {
  return (/** @type {string} */ a) => a.split(work).join("<work>");
}
