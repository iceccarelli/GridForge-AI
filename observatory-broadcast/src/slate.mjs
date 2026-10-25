import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { ObsError } from "./errors.mjs";
import { buildVideoArgs, resolveEncoding, runFfmpeg, ffmpegHas } from "./ffmpeg.mjs";

/**
 * The FALLBACK SLATE: a generated looping video, "GridForge Observatory - we will be right back". It is the only
 * thing shown when the scene is unhealthy or the operator cuts to it. It contains no data and no customer information by
 * construction: the text is fixed in this file and the only variable is the clock-free pulse that keeps the picture moving
 * (a frozen frame can itself trip a platform's "stream is not healthy" detector).
 */
export const SLATE_TITLE = "GridForge Observatory";
export const SLATE_SUBTITLE = "We will be right back";
export const SLATE_FOOTNOTE = "Synthetic demonstration stream";

const FONT_CANDIDATES = [
  "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
  "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
  "/usr/share/fonts/truetype/freefont/FreeSansBold.ttf",
  "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf",
  "/Library/Fonts/Arial Bold.ttf",
];

export function findFont(env = process.env) {
  if (env.OBS_FONT && fs.existsSync(env.OBS_FONT)) return env.OBS_FONT;
  for (const f of FONT_CANDIDATES) if (fs.existsSync(f)) return f;
  try {
    const p = execFileSync("fc-match", ["-f", "%{file}", "sans:bold"], { encoding: "utf8", timeout: 5000 }).trim();
    if (p && fs.existsSync(p)) return p;
  } catch { /* fontconfig absent */ }
  return null;
}

/** Escape a path for the ffmpeg drawtext/filter syntax. */
const esc = (/** @type {string} */ p) => p.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");

/**
 * Generate the slate. Output is a short H.264 clip (video only) meant to be looped with `-stream_loop -1`.
 * @param {{ out: string, durationSec?: number, encoding?: Partial<import("./ffmpeg.mjs").Encoding>, env?: Record<string, string | undefined>, spawn?: any }} o
 */
export async function generateSlate(o) {
  const env = o.env ?? process.env;
  const { encoding, errors } = resolveEncoding({ videoBitrateKbps: 600, ...o.encoding });
  if (errors.length) throw new ObsError("bad_encoding", `invalid slate encoding: ${errors.join("; ")}`, { exitCode: 2 });
  if (!ffmpegHas("filter", "drawtext", env)) throw new ObsError("slate_unavailable", "this ffmpeg has no drawtext filter (libfreetype)", { exitCode: 2, hint: "Install an ffmpeg with libfreetype, or supply a pre-made slate with --slate-file." });
  const font = findFont(env);
  if (!font) throw new ObsError("font_missing", "no usable font found for the slate", { exitCode: 2, hint: "Set OBS_FONT to a .ttf file." });
  const dur = o.durationSec ?? 6;
  const out = path.resolve(o.out);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "obs-slate-"));
  try {
    const wr = (/** @type {string} */ n, /** @type {string} */ t) => { const p = path.join(work, n); fs.writeFileSync(p, t); return esc(p); };
    const title = wr("title.txt", SLATE_TITLE);
    const sub = wr("sub.txt", SLATE_SUBTITLE);
    const foot = wr("foot.txt", SLATE_FOOTNOTE);
    const f = esc(font);
    const w = encoding.width, h = encoding.height;
    const fs1 = Math.round(h / 10), fs2 = Math.round(h / 17), fs3 = Math.round(h / 32);
    const dot = Math.round(h / 36);
    const filter = [
      `color=c=0x0b1220:s=${w}x${h}:r=${encoding.fps}:d=${dur}`,
      `drawbox=x=0:y=ih*0.62:w=iw*(t/${dur}):h=${Math.max(4, Math.round(h / 90))}:color=0x38bdf8@0.9:t=fill`,
      `drawtext=fontfile='${f}':textfile='${title}':fontcolor=white:fontsize=${fs1}:x=(w-text_w)/2:y=h*0.34`,
      `drawtext=fontfile='${f}':textfile='${sub}':fontcolor=0x93c5fd:fontsize=${fs2}:x=(w-text_w)/2:y=h*0.50`,
      `drawtext=fontfile='${f}':textfile='${foot}':fontcolor=0x64748b:fontsize=${fs3}:x=(w-text_w)/2:y=h*0.86`,
      `drawbox=x=(iw-${dot})/2:y=ih*0.72:w=${dot}:h=${dot}:color=0x4ade80@1:t=fill:enable='lt(mod(t,2),1)'`,
      "format=yuv420p",
    ].join(",");
    await runFfmpeg(["-f", "lavfi", "-i", filter, ...buildVideoArgs(encoding), "-an", "-movflags", "+faststart", "-y", out], { env, spawn: o.spawn });
    return { out, durationSec: dur, width: w, height: h, fps: encoding.fps, text: `${SLATE_TITLE} - ${SLATE_SUBTITLE.toLowerCase()}` };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}
