import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { serveFixtures } from "../../observatory-broadcast/fixtures/serve.mjs";
import { record } from "../../observatory-broadcast/src/record.mjs";
import { generateSlate, SLATE_FOOTNOTE, SLATE_SUBTITLE, SLATE_TITLE, findFont } from "../../observatory-broadcast/src/slate.mjs";
import { ProgressParser, buildEncodeArgs, escapeFilterPath, ffmpegHas, parseBitrateKbps, parseSize, probeMedia, resolveEncoding } from "../../observatory-broadcast/src/ffmpeg.mjs";
import { buildLiveArgs } from "../../observatory-broadcast/src/encoder.mjs";
import { createAdapter } from "../../observatory-broadcast/src/adapters/index.mjs";
import { Redactor, createLogger } from "../../observatory-broadcast/src/redact.mjs";
import { TOOL_VERSION } from "../../observatory-broadcast/src/version.mjs";
import { pidAlive } from "../../observatory-broadcast/src/lock.mjs";

// Real ffmpeg (and, where present, real Chromium) on localhost fixtures: no network, small frames, a few seconds in total.
// Tests that need a tool the machine lacks are skipped and say so, never silently passed.

function has(cmd: string) { try { execFileSync(cmd, ["-version"], { stdio: "ignore" }); return true; } catch { return false; } }
const FFMPEG = has("ffmpeg") && has("ffprobe") && ffmpegHas("encoder", "libx264") && ffmpegHas("encoder", "aac");
const DRAWTEXT = FFMPEG && ffmpegHas("filter", "drawtext") && !!findFont();
const BROWSER = FFMPEG && (() => {
  try { createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || "/opt/node-tools/node_modules/playwright"); return fs.existsSync(process.env.CHROMIUM || "/opt/pw-browsers/chromium"); } catch { return false; }
})();

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "obs-media-test-")); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const cuesFile = path.join(__dirname, "../../observatory-broadcast/fixtures/cues.json");
const cues = JSON.parse(fs.readFileSync(cuesFile, "utf8"));

const psLines = (needle: string) => { try { return execFileSync("pgrep", ["-f", needle], { encoding: "utf8" }).trim().split("\n").filter(Boolean); } catch { return []; } };

describe("observatory-broadcast: ffmpeg helpers (pure)", () => {
  it("validates encoding settings with specific messages", () => {
    expect(resolveEncoding().errors).toEqual([]);
    expect(resolveEncoding({ width: 1281 }).errors.join()).toMatch(/width must be even/);
    expect(resolveEncoding({ fps: 0 }).errors.join()).toMatch(/fps/);
    expect(resolveEncoding({ videoBitrateKbps: 50 }).errors.join()).toMatch(/videoBitrateKbps/);
    expect(resolveEncoding({ preset: "placebo" }).errors.join()).toMatch(/preset/);
    expect(parseSize("1920x1080")).toEqual({ width: 1920, height: 1080 });
    expect(() => parseSize("big")).toThrow(/1280x720/);
    expect(parseBitrateKbps("2500k")).toBe(2500);
    expect(parseBitrateKbps("2.5m")).toBe(2500);
    expect(() => parseBitrateKbps("fast")).toThrow(/2500k/);
  });

  it("builds H.264/AAC arguments from the configuration (fps, resolution, bitrate are all configurable)", () => {
    const { encoding } = resolveEncoding({ width: 1920, height: 1080, fps: 30, videoBitrateKbps: 4500, audioBitrateKbps: 96 });
    const a = buildEncodeArgs(encoding).join(" ");
    expect(a).toContain("-c:v libx264");
    expect(a).toContain("-b:v 4500k -maxrate 4500k -bufsize 9000k");
    expect(a).toContain("-g 60 -keyint_min 60 -sc_threshold 0"); // 2 s GOP: platforms want a keyframe at least every 2-4 s
    expect(a).toContain("-c:a aac -b:a 96k");
    expect(a).toContain("-pix_fmt yuv420p");
  });

  it("live arguments carry silent audio paced in real time, a constant frame rate and the run marker", () => {
    const { encoding } = resolveEncoding({ width: 640, height: 360, fps: 15 });
    const args = buildLiveArgs({ mode: "scene", runId: "abc", encoding, source: { kind: "scene", url: "http://localhost/x", viewport: { width: 640, height: 360 } }, output: { args: ["-f", "flv", "rtmp://h/a/k"], display: "" } });
    const line = args.join(" ");
    expect(line).toContain("-re -f lavfi -i anullsrc=channel_layout=stereo:sample_rate=44100");
    expect(line).toContain("fps=15");
    expect(line).toContain("-shortest");
    expect(line).toContain("observatory-broadcast run abc scene");
    expect(line).toContain("-analyzeduration 1"); // otherwise ffmpeg waits ~5 s of wall clock before writing anything
    expect(args.at(-1)).toBe("rtmp://h/a/k");
  });

  it("parses ffmpeg -progress output incrementally, with instantaneous bitrate from size deltas", () => {
    let t = 0;
    const p = new ProgressParser(() => t);
    expect(p.feed("frame=10\ntotal_size=1000\nout_time_us=400000\nspeed=1.0x\nprogress=conti")).toEqual([]);
    t = 1000;
    const first = p.feed("nue\n");
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ frame: 10, totalSize: 1000, outTimeMs: 400, speed: 1, ended: false, bitrateKbps: null });
    t = 2000;
    const [second] = p.feed("frame=25\ntotal_size=26000\nout_time_us=1000000\nspeed=1.0x\nprogress=continue\n");
    expect(second.bitrateKbps).toBeCloseTo(200, 5); // 25000 bytes in 1 s = 200 kbit/s
    const [end] = p.feed("frame=30\ntotal_size=N/A\nbitrate=512.0kbits/s\nout_time_us=N/A\nprogress=end\n");
    expect(end).toMatchObject({ frame: 30, totalSize: null, bitrateKbps: 512, outTimeMs: null, ended: true });
  });

  it("escapes filter paths", () => {
    expect(escapeFilterPath("/tmp/a:b,c'd[e]\\f")).toBe("/tmp/a\\:b\\,c\\'d\\[e\\]\\\\f");
  });
});

describe.skipIf(!DRAWTEXT)("observatory-broadcast: fallback slate (real ffmpeg)", () => {
  it("generates a looping H.264 slate that says 'GridForge Observatory - we will be right back' and carries no data", async () => {
    const out = path.join(tmp, "slate.mp4");
    const r = await generateSlate({ out, durationSec: 2, encoding: { width: 320, height: 180, fps: 10, videoBitrateKbps: 300 } });
    expect(r.text).toBe("GridForge Observatory - we will be right back");
    const probe = probeMedia(out);
    expect(probe.video).toMatchObject({ codec: "h264", width: 320, height: 180, frames: 20 });
    expect(probe.video?.fps).toBeCloseTo(10, 1);
    expect(probe.durationSec).toBeCloseTo(2, 1);
    expect(probe.audio).toBeNull(); // the audio (silent) is added by the encoder, once, for every output
    // the slate's words are fixed constants: no scenario, price, capacity, customer or live value can reach it
    expect([SLATE_TITLE, SLATE_SUBTITLE, SLATE_FOOTNOTE].join(" ")).toBe("GridForge Observatory We will be right back Synthetic demonstration stream");
    expect(r.out).toBe(out);
    // the picture really moves (a frozen slate can look like a dead stream): two frames differ
    const f = (t: number) => crypto.createHash("sha256").update(execFileSync("ffmpeg", ["-v", "error", "-ss", String(t), "-i", out, "-frames:v", "1", "-f", "image2pipe", "-c:v", "png", "-"], { maxBuffer: 1 << 24 })).digest("hex");
    expect(f(0.1)).not.toBe(f(1.6));
  }, 30_000);

  it("refuses a bad encoding with a precise error", async () => {
    await expect(generateSlate({ out: path.join(tmp, "x.mp4"), encoding: { width: 321 } })).rejects.toMatchObject({ code: "bad_encoding" });
  });
});

describe.skipIf(!DRAWTEXT)("observatory-broadcast: local sink + real encoder + process cleanup", () => {
  it("writes segments to disk through the same encoder the RTMP stage uses, verifies them for real, and leaves no process behind", async () => {
    const slate = path.join(tmp, "slate.mp4");
    await generateSlate({ out: slate, durationSec: 2, encoding: { width: 320, height: 180, fps: 10, videoBitrateKbps: 300 } });
    const sink = path.join(tmp, "sink");
    const redactor = new Redactor();
    const adapter = createAdapter("local", { redactor, logger: createLogger({ redactor, write: () => {} }), env: process.env });
    expect(adapter.validateConfig({ OBS_LOCAL_SINK_DIR: sink }).ok).toBe(true);
    expect((await adapter.preflight({ diskDir: tmp })).state).toBe("ready");
    expect((await adapter.verify()).ok).toBe(false); // nothing written yet: the verifier is honest about that too

    const { encoding } = resolveEncoding({ width: 320, height: 180, fps: 10, videoBitrateKbps: 300 });
    const runId = `media${crypto.randomBytes(4).toString("hex")}`;
    const enc = await adapter.start({ mode: "slate", source: { kind: "file", file: slate }, encoding, runId });
    const pid = enc.pid as number;
    expect(psLines(runId).length).toBeGreaterThan(0); // the marker really is on the ffmpeg command line (that is how orphans are found)
    let verified: any = null;
    for (let i = 0; i < 80 && !verified?.ok; i++) { await new Promise((r) => setTimeout(r, 150)); verified = await adapter.verify(); }
    expect(verified.ok).toBe(true);
    expect(adapter.status()).toMatchObject({ state: "live", verified: true });
    expect(adapter.status().evidence).toMatch(/segment\(s\).*from the current run/);

    await adapter.stop();
    expect(adapter.status().state).toBe("stopped");
    expect(pidAlive(pid)).toBe(false);
    expect(psLines(runId)).toEqual([]);

    const segs = fs.readdirSync(sink).filter((f) => f.endsWith(".ts"));
    expect(segs.length).toBeGreaterThan(0);
    expect(segs.every((f) => f.startsWith("seg-slate-r1-"))).toBe(true);
    const seg = probeMedia(path.join(sink, segs[0]));
    expect(seg.video).toMatchObject({ codec: "h264", width: 320, height: 180 });
    expect(seg.audio?.codec).toBe("aac"); // silent track present on every output
  }, 60_000);
});

describe.skipIf(!BROWSER)("observatory-broadcast: record (real Chromium + ffmpeg) and manifest", () => {
  it("records the stand-in stage into H.264/AAC MP4 with soft captions, a sidecar .vtt, HLS and a complete manifest", async () => {
    const server = await serveFixtures();
    try {
      const out = path.join(tmp, "rec.mp4");
      const r = await record({ url: server.url, out, durationSec: 2, mode: "stepped", cues, captions: "soft", hls: true, encoding: { width: 320, height: 180, fps: 10, videoBitrateKbps: 400 } });
      const probe = probeMedia(out);
      expect(probe.video).toMatchObject({ codec: "h264", width: 320, height: 180, frames: 20, pixFmt: "yuv420p" });
      expect(probe.video?.fps).toBeCloseTo(10, 2);
      expect(probe.durationSec).toBeCloseTo(2, 1);
      expect(probe.audio).toMatchObject({ codec: "aac", channels: 2 });
      expect(probe.subtitles).toEqual([{ codec: "mov_text", language: "eng" }]);

      const m = r.manifest;
      expect(m.schema).toBe("observatory-broadcast/manifest/1");
      expect(m.tool).toEqual({ name: "observatory-broadcast", version: TOOL_VERSION });
      expect(m.source).toMatchObject({ url: server.url, mode: "stepped", synthetic: true, viewport: { width: 320, height: 180 } });
      expect(m.source.framesSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(m.output.sha256).toBe(crypto.createHash("sha256").update(fs.readFileSync(out)).digest("hex"));
      expect(m.output).toMatchObject({ file: "rec.mp4", frames: 20, bytes: fs.statSync(out).size });
      expect(m.output.durationSec).toBeCloseTo(2, 1);
      expect(m.output.video).toMatchObject({ codec: "h264", width: 320, height: 180 });
      expect(m.output.audio.codec).toBe("aac");
      expect(m.output.subtitleStreams).toHaveLength(1);
      expect(m.encoding).toMatchObject({ width: 320, height: 180, fps: 10, videoBitrateKbps: 400 });
      expect(m.encoder.ffmpeg).toMatch(/^ffmpeg version/);
      expect(m.encoder.args.join(" ")).toMatch(/-c:v libx264.*-b:v 400k.*-c:a aac.*-c:s mov_text/);
      expect(m.encoder.args.join(" ")).not.toContain(tmp.replace(/obs-media-test-.*/, "obs-rec-")); // no temp-dir layout leaks
      expect(m.captions).toMatchObject({ mode: "soft", cues: 1, sidecar: "rec.vtt" }); // 4 cues over 10 s, clipped to this 2 s recording
      expect(m.captions.vttSha256).toBe(crypto.createHash("sha256").update(fs.readFileSync(path.join(tmp, "rec.vtt"))).digest("hex"));
      expect(m.hls).toMatchObject({ playlist: "index.m3u8" });
      expect(m.hls.segments).toBeGreaterThanOrEqual(1);
      expect(m.warnings).toEqual([]);
      expect(JSON.parse(fs.readFileSync(r.manifestPath, "utf8"))).toEqual(m);
      expect(fs.readFileSync(path.join(tmp, "rec.vtt"), "utf8")).toBe("WEBVTT\n\n1\n00:00:00.000 --> 00:00:02.000\nThis is a synthetic hall: every number is illustrative.\n");
      expect(fs.readFileSync(path.join(tmp, "rec-hls", "index.m3u8"), "utf8")).toContain("#EXT-X-ENDLIST");

      // deterministic stepped capture: the same page yields the same frames (hash of the raw screenshots)
      const again = await record({ url: server.url, out: path.join(tmp, "rec2.mp4"), durationSec: 2, mode: "stepped", encoding: { width: 320, height: 180, fps: 10, videoBitrateKbps: 400 } });
      expect(again.manifest.source.framesSha256).toBe(m.source.framesSha256);
      expect(again.manifest.captions).toEqual({ mode: "none" });
      expect(probeMedia(path.join(tmp, "rec2.mp4")).subtitles).toEqual([]);
      expect(probeMedia(path.join(tmp, "rec2.mp4")).audio?.codec).toBe("aac"); // silent audio even without captions
    } finally { await server.close(); }
  }, 120_000);

  it("burned-in captions change the pixels and add no subtitle stream", async () => {
    const server = await serveFixtures();
    try {
      const base = { url: server.url, durationSec: 1, mode: "stepped" as const, encoding: { width: 320, height: 180, fps: 5, videoBitrateKbps: 400 } };
      const plain = await record({ ...base, out: path.join(tmp, "plain.mp4") });
      const burned = await record({ ...base, out: path.join(tmp, "burn.mp4"), cues, captions: "burn" });
      expect(burned.manifest.source.framesSha256).toBe(plain.manifest.source.framesSha256); // same scene frames in
      expect(burned.manifest.output.sha256).not.toBe(plain.manifest.output.sha256); // different pixels out
      expect(burned.manifest.output.subtitleStreams).toEqual([]);
      expect(burned.manifest.captions).toMatchObject({ mode: "burn", sidecar: "burn.vtt" });
    } finally { await server.close(); }
  }, 120_000);

  it("refuses captions with no cues, and leaves no partial file or process behind", async () => {
    const server = await serveFixtures();
    try {
      const out = path.join(tmp, "nope.mp4");
      await expect(record({ url: server.url, out, durationSec: 1, captions: "soft" })).rejects.toMatchObject({ code: "captions_missing" });
      await expect(record({ url: server.url, out, durationSec: 1, cues: [{ startSec: 3, endSec: 1, text: "x" }], captions: "soft" })).rejects.toMatchObject({ code: "captions_invalid" });
      expect(fs.readdirSync(tmp)).toEqual([]);
    } finally { await server.close(); }
  }, 60_000);

  it("an aborted recording kills ffmpeg and Chromium, removes its work files and the partial output", async () => {
    const server = await serveFixtures();
    try {
      const before = psLines("obs-chromium-").length;
      const ac = new AbortController();
      const p = record({ url: server.url, out: path.join(tmp, "abort.mp4"), durationSec: 30, mode: "stepped", encoding: { width: 320, height: 180, fps: 10, videoBitrateKbps: 300 }, signal: ac.signal });
      await new Promise((r) => setTimeout(r, 2500));
      ac.abort();
      await expect(p).rejects.toBeTruthy();
      await new Promise((r) => setTimeout(r, 500));
      expect(psLines("obs-chromium-").length).toBe(before);
      expect(psLines("obs-rec-")).toEqual([]);
      expect(fs.readdirSync(tmp).filter((f) => f.includes("abort"))).toEqual([]);
      expect(fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith("obs-rec-") && fs.existsSync(path.join(os.tmpdir(), f, "captions.vtt")))).toEqual([]);
    } finally { await server.close(); }
  }, 60_000);

  it("the page's own requests are confined to its origin: a scene that calls /api or another host is blocked and reported", async () => {
    const http = await import("node:http");
    const hits: string[] = [];
    const srv = http.createServer((req, res) => {
      hits.push(req.url ?? "");
      if ((req.url ?? "").startsWith("/stage")) {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(`<!doctype html><title>t</title><body style="background:#123"><script>fetch("/api/secret").catch(()=>{});fetch("http://127.0.0.2:9/x").catch(()=>{});</script>hello</body>`);
      } else { res.writeHead(200); res.end("leaked"); }
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const port = (srv.address() as any).port;
    try {
      const r = await record({ url: `http://127.0.0.1:${port}/stage`, out: path.join(tmp, "g.mp4"), durationSec: 1, mode: "stepped", encoding: { width: 320, height: 180, fps: 4, videoBitrateKbps: 300 } });
      expect(hits).not.toContain("/api/secret"); // the browser never even asked
      expect(r.manifest.warnings.join(" ")).toMatch(/blocked by the origin guard/);
    } finally { await new Promise((r) => srv.close(r)); }
  }, 60_000);

  it("realtime mode records the page on its own clock (recordVideo), trims the lead-in, and still ends up as H.264/AAC", async () => {
    const server = await serveFixtures();
    try {
      const r = await record({ url: server.url, out: path.join(tmp, "rt.mp4"), durationSec: 2, mode: "realtime", cues, captions: "soft", encoding: { width: 320, height: 180, fps: 10, videoBitrateKbps: 300 } });
      const p = probeMedia(r.out);
      expect(p.video?.codec).toBe("h264");
      expect(p.video?.frames).toBeGreaterThanOrEqual(19);
      expect(p.video?.frames).toBeLessThanOrEqual(21);
      expect(p.audio?.codec).toBe("aac");
      expect(p.subtitles).toHaveLength(1);
      expect(r.manifest.source).toMatchObject({ mode: "realtime", framesSha256: null });
      expect(typeof r.manifest.source.leadInSec).toBe("number");
    } finally { await server.close(); }
  }, 120_000);
});
