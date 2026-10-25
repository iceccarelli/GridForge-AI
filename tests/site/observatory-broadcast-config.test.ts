import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { Redactor, createLogger } from "../../observatory-broadcast/src/redact.mjs";
import { createAdapter, ADAPTER_NAMES, PLATFORM_STATES, assertAdapterInterface } from "../../observatory-broadcast/src/adapters/index.mjs";
import { YOUTUBE_DEFAULT_INGEST } from "../../observatory-broadcast/src/adapters/youtube.mjs";
import { parseIngestUrl } from "../../observatory-broadcast/src/adapters/rtmp.mjs";
import { FfmpegEncoder, buildLiveArgs } from "../../observatory-broadcast/src/encoder.mjs";
import { main } from "../../observatory-broadcast/src/cli.mjs";
import { resolveEncoding } from "../../observatory-broadcast/src/ffmpeg.mjs";
import { fakeEncoderFactory } from "../../observatory-broadcast/testing/fakes.mjs";

// Stream keys and ingest URLs come from the environment or 0600 secret files, never argv or the repo, and must not
// appear in ANY log, error, status file or manifest. These tests plant a distinctive key and grep everything that was written.

const KEY = "KEYsecretXYZ-1234-abcd-9876";
const KICK_URL = "rtmps://ingest.kick.example:443/app";
let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "obs-cfg-test-")); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

function capture() {
  const lines: string[] = [];
  return { lines, stdout: (s: string) => lines.push(s), stderr: (s: string) => lines.push(s), text: () => lines.join("") };
}
const adapterLog: string[] = [];
const fakeDeps = (extra: Record<string, unknown> = {}) => {
  const redactor = (extra.redactor as Redactor | undefined) ?? new Redactor();
  const logger = createLogger({ redactor, write: (l) => adapterLog.push(l), level: "debug" });
  return { checkFfmpeg: () => "ffmpeg (fake)", hasFfmpegFeature: () => true, encoderFactory: fakeEncoderFactory(), redactor, logger, ...extra };
};
afterEach(() => { expect(adapterLog.join("\n")).not.toContain(KEY); adapterLog.length = 0; });

describe("observatory-broadcast: redaction", () => {
  it("removes registered secrets in raw, URL-encoded and base64 form", () => {
    const r = new Redactor([KEY]);
    expect(r.redact(`key is ${KEY}`)).toBe("key is [REDACTED]");
    expect(r.redact(`q=${encodeURIComponent("a b" + KEY)}`)).not.toContain(KEY);
    expect(r.redact(Buffer.from(KEY).toString("base64"))).toBe("[REDACTED]");
  });

  it("masks the path of any rtmp(s) URL even when the key was never registered", () => {
    const r = new Redactor();
    const out = r.redact("ffmpeg failed to connect rtmps://a.rtmps.youtube.com:443/live2/abcd-efgh-ijkl: refused");
    expect(out).toBe("ffmpeg failed to connect rtmps://a.rtmps.youtube.com:443/[REDACTED] refused");
    expect(r.redact("rtmp://user:pw@host/app/key")).toBe("rtmp://[REDACTED]@host/[REDACTED]");
    expect(r.redact("stream_key=abc123 token: zzz password='p w'")).not.toMatch(/abc123|zzz|p w/);
  });

  it("redactDeep covers nested values, keys and Errors; the logger redacts every line", () => {
    const r = new Redactor([KEY]);
    const d = r.redactDeep({ a: [`x ${KEY}`], [KEY]: { e: new Error(`boom ${KEY}`) }, n: 3 });
    expect(JSON.stringify(d)).not.toContain(KEY);
    expect(d.n).toBe(3);
    const lines: string[] = [];
    const log = createLogger({ redactor: r, write: (l) => lines.push(l), level: "debug" });
    log.info("evt", { url: `rtmps://h/app/${KEY}`, msg: KEY });
    log.error(`weird ${KEY}`, undefined);
    expect(lines.join("\n")).not.toContain(KEY);
    expect(JSON.parse(lines[0]).url).toBe("rtmps://h/[REDACTED]");
  });

  it("ignores secrets too short to register (they would shred ordinary text)", () => {
    const r = new Redactor(["ab"]);
    expect(r.redact("about")).toBe("about");
    expect(r.size).toBe(0);
  });

  it("the live ffmpeg argv holds the real URL, but describe(), logs and exit events never do", async () => {
    const redactor = new Redactor([KEY]);
    const url = `rtmps://a.example:443/live2/${KEY}`;
    redactor.add(url);
    const child: any = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => { setImmediate(() => child.emit("close", 1, null)); };
    child.pid = 4242;
    let spawnedArgs: string[] = [];
    const { encoding } = resolveEncoding({ width: 640, height: 360, fps: 15 });
    const enc = new FfmpegEncoder({
      mode: "slate", runId: "r1", encoding, source: { kind: "file", file: "/x/slate.mp4" },
      output: { args: ["-f", "flv", url], display: "-f flv rtmps://a.example:443/[REDACTED]" },
    }, { spawn: ((_bin: string, args: string[]) => { spawnedArgs = args; return child; }) as any, redactor });
    const seen: string[] = [];
    enc.on("log", (l: any) => seen.push(l.line));
    enc.on("exit", (e: any) => seen.push(JSON.stringify(e)));
    await enc.start();
    expect(spawnedArgs).toContain(url); // ffmpeg needs it; the process table is the one place it must live
    child.stderr.write(`Failed to connect to ${url}: Connection refused\n[flv @ 0x1] Error writing trailer of ${url}\n`);
    await new Promise((r) => setImmediate(r));
    child.emit("close", 1, null);
    await new Promise((r) => setImmediate(r));
    expect(enc.describe()).not.toContain(KEY);
    expect(enc.describe()).toContain("[REDACTED]");
    expect(seen.length).toBeGreaterThan(1);
    expect(seen.join("\n")).not.toContain(KEY);
    expect(seen.join("\n")).toContain("[REDACTED]");
    expect(buildLiveArgs(enc.spec).join(" ")).toContain(KEY); // the pure builder is for the encoder only; describe() is the loggable form
  });
});

describe("observatory-broadcast: adapter config validation", () => {
  it("YouTube needs a stream key; the error names the variable and never echoes a value", () => {
    const a = createAdapter("youtube", fakeDeps());
    const r = a.validateConfig({});
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/OBS_YOUTUBE_STREAM_KEY is not set/);
    expect(a.status().state).toBe("not_configured");
  });

  it("accepts a key from the environment, defaults the ingest to YouTube's documented RTMPS address, and reports it redacted", () => {
    const a = createAdapter("youtube", fakeDeps());
    const r = a.validateConfig({ OBS_YOUTUBE_STREAM_KEY: KEY });
    expect(r.ok).toBe(true);
    expect(r.summary.ingest).toBe("rtmps://a.rtmps.youtube.com:443/[REDACTED]");
    expect(JSON.stringify(r)).not.toContain(KEY);
    expect(YOUTUBE_DEFAULT_INGEST).toMatch(/^rtmps:\/\//);
    expect(a.status().state).toBe("configured_unverified");
    expect(a.status().verified).toBe(false);
  });

  it("rejects malformed keys without echoing them", () => {
    for (const bad of ["short", "has space in it 1234567", "\t"]) {
      const a = createAdapter("youtube", fakeDeps());
      const r = a.validateConfig({ OBS_YOUTUBE_STREAM_KEY: bad });
      expect(r.ok).toBe(false);
      expect(JSON.stringify(r)).not.toContain("has space in it");
    }
  });

  it("rejects an ingest URL with the wrong scheme, no host, whitespace or embedded credentials", () => {
    for (const bad of ["https://example.com/app", "rtmp://", "rtmps://host/a b", "rtmps://user:pw@host/app", "not a url"]) {
      const a = createAdapter("rtmp", fakeDeps());
      const r = a.validateConfig({ OBS_RTMP_URL: bad });
      expect(r.ok, bad).toBe(false);
      expect(r.errors.join(" ")).toMatch(/OBS_RTMP_URL/);
      expect(r.errors.join(" ")).not.toContain("user:pw");
    }
    expect(parseIngestUrl("rtmps://h:1935/app").ok).toBe(true);
  });

  it("generic RTMP: URL may carry the key; the key is then redacted wherever it would appear", () => {
    const redactor = new Redactor();
    const a = createAdapter("rtmp", fakeDeps({ redactor }));
    const r = a.validateConfig({ OBS_RTMP_URL: `rtmps://ingest.example:443/live/${KEY}` });
    expect(r.ok).toBe(true);
    expect(redactor.redact(`oops ${KEY}`)).toBe("oops [REDACTED]");
    expect(r.summary.ingest).toBe("rtmps://ingest.example:443/[REDACTED]");
  });

  it("warns (does not fail) on plain rtmp:// to a remote host", () => {
    const a = createAdapter("rtmp", fakeDeps());
    const r = a.validateConfig({ OBS_RTMP_URL: "rtmp://remote.example/app", OBS_RTMP_KEY: KEY });
    expect(r.ok).toBe(true);
    expect(r.warnings.join(" ")).toMatch(/unencrypted/);
    const local = createAdapter("rtmp", fakeDeps()).validateConfig({ OBS_RTMP_URL: "rtmp://127.0.0.1/app", OBS_RTMP_KEY: KEY });
    expect(local.warnings.join(" ")).not.toMatch(/unencrypted/);
  });

  it("Kick needs both an ingest URL (per channel; none is embedded) and a key", () => {
    const a = createAdapter("kick", fakeDeps());
    const r = a.validateConfig({});
    expect(r.errors.join(" ")).toMatch(/OBS_KICK_INGEST_URL is not set/);
    expect(r.errors.join(" ")).toMatch(/OBS_KICK_STREAM_KEY is not set/);
    expect(createAdapter("kick", fakeDeps()).validateConfig({ OBS_KICK_INGEST_URL: KICK_URL, OBS_KICK_STREAM_KEY: KEY }).ok).toBe(true);
  });

  it("reads secrets from *_FILE (0600 only), and refuses loose permissions, relative paths, empty files and double definition", () => {
    const f = path.join(tmp, "key");
    fs.writeFileSync(f, `${KEY}\n`, { mode: 0o600 });
    const ok = createAdapter("youtube", fakeDeps()).validateConfig({ OBS_YOUTUBE_STREAM_KEY_FILE: f });
    expect(ok.ok).toBe(true);
    expect(ok.summary).toMatchObject({ secretSource: { key: "file" } });

    fs.chmodSync(f, 0o644);
    const loose = createAdapter("youtube", fakeDeps()).validateConfig({ OBS_YOUTUBE_STREAM_KEY_FILE: f });
    expect(loose.errors.join(" ")).toMatch(/chmod 600/);
    fs.chmodSync(f, 0o600);

    expect(createAdapter("youtube", fakeDeps()).validateConfig({ OBS_YOUTUBE_STREAM_KEY_FILE: "relative/key" }).errors.join(" ")).toMatch(/absolute/);
    const empty = path.join(tmp, "empty");
    fs.writeFileSync(empty, "\n", { mode: 0o600 });
    expect(createAdapter("youtube", fakeDeps()).validateConfig({ OBS_YOUTUBE_STREAM_KEY_FILE: empty }).errors.join(" ")).toMatch(/empty/);
    expect(createAdapter("youtube", fakeDeps()).validateConfig({ OBS_YOUTUBE_STREAM_KEY: KEY, OBS_YOUTUBE_STREAM_KEY_FILE: f }).errors.join(" ")).toMatch(/only one/);
    expect(createAdapter("youtube", fakeDeps()).validateConfig({ OBS_YOUTUBE_STREAM_KEY_FILE: path.join(tmp, "missing") }).errors.join(" ")).toMatch(/could not be read/);
  });

  it("local sink needs an absolute directory", () => {
    expect(createAdapter("local", fakeDeps()).validateConfig({}).errors.join(" ")).toMatch(/OBS_LOCAL_SINK_DIR/);
    expect(createAdapter("local", fakeDeps()).validateConfig({ OBS_LOCAL_SINK_DIR: "rel" }).errors.join(" ")).toMatch(/absolute/);
    expect(createAdapter("local", fakeDeps()).validateConfig({ OBS_LOCAL_SINK_DIR: tmp }).ok).toBe(true);
  });
});

describe("observatory-broadcast: adapter interface and honest status", () => {
  it("every adapter implements { name, validateConfig, preflight, start, status, stop }", () => {
    for (const n of ADAPTER_NAMES) {
      const a = createAdapter(n, fakeDeps());
      assertAdapterInterface(a);
      expect(a.name).toBe(n);
    }
    expect(() => createAdapter("twitch", fakeDeps())).toThrow(/unknown adapter/);
    expect(() => assertAdapterInterface({ name: "x", validateConfig() {} })).toThrow(/lacks preflight/);
  });

  it("status().state is always one of the declared vocabulary, and starts not_configured with verified:false", () => {
    expect(PLATFORM_STATES).toEqual(["not_configured", "configured_unverified", "preflight_failed", "ready", "starting", "live", "reconnecting", "stopped", "fallback_slate"]);
    for (const n of ADAPTER_NAMES) {
      const s = createAdapter(n, fakeDeps()).status();
      expect(s.state).toBe("not_configured");
      expect(s.verified).toBe(false);
      expect(PLATFORM_STATES).toContain(s.state);
    }
  });

  it("YouTube/Kick/RTMP preflight is local-only and reports 'unverified' (never 'ready')", async () => {
    const cases: [string, Record<string, string>][] = [
      ["youtube", { OBS_YOUTUBE_STREAM_KEY: KEY }],
      ["kick", { OBS_KICK_INGEST_URL: KICK_URL, OBS_KICK_STREAM_KEY: KEY }],
      ["rtmp", { OBS_RTMP_URL: "rtmps://h.example/app", OBS_RTMP_KEY: KEY }],
    ];
    for (const [name, env] of cases) {
      const a = createAdapter(name, fakeDeps());
      expect(a.validateConfig(env).ok).toBe(true);
      const pre = await a.preflight();
      expect(pre.ok).toBe(true);
      expect(pre.verified).toBe(false);
      expect(pre.state).toBe("configured_unverified");
      expect(pre.notes.join(" ")).toMatch(/unverified/);
      expect(a.status()).toMatchObject({ state: "configured_unverified", verified: false, liveVerifiable: false });
      expect(a.status().message).toBe(`live status cannot be verified for ${name} in this build; an encoder that is running is not proof that viewers can see it`);
      expect(JSON.stringify(pre)).not.toContain(KEY);
    }
    // platform-specific honesty
    const yt = createAdapter("youtube", fakeDeps());
    yt.validateConfig({ OBS_YOUTUBE_STREAM_KEY: KEY });
    expect((await yt.preflight()).notes.join(" ")).toMatch(/YouTube Studio/);
  });

  it("preflight fails (preflight_failed) when ffmpeg or a required protocol is missing, and names it", async () => {
    const a = createAdapter("youtube", fakeDeps({ hasFfmpegFeature: (kind: string, n: string) => !(kind === "protocol" && n === "rtmps") }));
    a.validateConfig({ OBS_YOUTUBE_STREAM_KEY: KEY });
    const pre = await a.preflight();
    expect(pre.ok).toBe(false);
    expect(pre.checks.find((c: any) => !c.ok)?.name).toBe("ffmpeg protocol rtmps");
    expect(a.status().state).toBe("preflight_failed");
    await expect(a.start({ mode: "scene", source: {}, encoding: resolveEncoding().encoding, runId: "x" })).rejects.toThrow(/cannot start/);

    const b = createAdapter("kick", fakeDeps({ checkFfmpeg: () => { throw new Error("ffmpeg/ffprobe could not be run"); } }));
    b.validateConfig({ OBS_KICK_INGEST_URL: KICK_URL, OBS_KICK_STREAM_KEY: KEY });
    expect((await b.preflight()).checks.find((c: any) => c.name === "ffmpeg")?.ok).toBe(false);
  });

  it("preflight of an unconfigured adapter stays not_configured", async () => {
    const a = createAdapter("youtube", fakeDeps());
    const pre = await a.preflight();
    expect(pre).toMatchObject({ ok: false, state: "not_configured", verified: false });
  });

  it("no adapter without a verifier can say 'live'; verify() says why", async () => {
    for (const [name, env] of [["youtube", { OBS_YOUTUBE_STREAM_KEY: KEY }], ["rtmp", { OBS_RTMP_URL: "rtmps://h.example/a", OBS_RTMP_KEY: KEY }]] as const) {
      const a = createAdapter(name, fakeDeps());
      a.validateConfig(env);
      await a.preflight();
      await a.start({ mode: "scene", source: { kind: "file", file: "x" }, encoding: resolveEncoding().encoding, runId: "r" });
      const v = await a.verify();
      expect(v).toMatchObject({ ok: false, supported: false, message: `live status cannot be verified for ${name} in this build` });
      expect(a.status().state).toBe("starting");
      expect(a.status().verified).toBe(false);
    }
  });

  it("'live' is unreachable through markState; only a verifier result with evidence produces it", async () => {
    const a = createAdapter("youtube", fakeDeps({ verifier: async () => ({ ok: true, evidence: "fake platform confirmed ingest" }) }));
    a.validateConfig({ OBS_YOUTUBE_STREAM_KEY: KEY });
    await a.preflight();
    expect(() => a.markState("live" as any, "trust me")).toThrow(/verification/);
    expect(() => a.markState("bogus" as any, "x")).toThrow();
    await a.start({ mode: "scene", source: { kind: "file", file: "x" }, encoding: resolveEncoding().encoding, runId: "r" });
    expect(a.status().state).toBe("starting");
    const v = await a.verify();
    expect(v.ok).toBe(true);
    expect(a.status()).toMatchObject({ state: "live", verified: true, evidence: "fake platform confirmed ingest", liveVerifiable: true });
    a.markState("reconnecting", "x");
    expect(a.status()).toMatchObject({ state: "reconnecting", verified: false, evidence: null });
  });

  it("a verifier that returns ok without evidence, throws, or says no does not produce 'live'", async () => {
    for (const verifier of [async () => ({ ok: true }), async () => { throw new Error(`boom ${KEY}`); }, async () => ({ ok: false, evidence: "nope" }), async () => ({ ok: "yes", evidence: "x" })]) {
      const a = createAdapter("kick", fakeDeps({ verifier }));
      a.validateConfig({ OBS_KICK_INGEST_URL: KICK_URL, OBS_KICK_STREAM_KEY: KEY });
      await a.preflight();
      await a.start({ mode: "scene", source: { kind: "file", file: "x" }, encoding: resolveEncoding().encoding, runId: "r" });
      await a.verify();
      expect(a.status().state).not.toBe("live");
      expect(a.status().verified).toBe(false);
      expect(JSON.stringify(a.status())).not.toContain(KEY);
    }
  });

  it("the local sink preflight is a real local check, so it is 'ready' and verified", async () => {
    const a = createAdapter("local", fakeDeps());
    a.validateConfig({ OBS_LOCAL_SINK_DIR: path.join(tmp, "sink") });
    const pre = await a.preflight();
    expect(pre).toMatchObject({ ok: true, verified: true, state: "ready" });
    expect(a.requiresApproval).toBe(false);
    expect(fs.existsSync(path.join(tmp, "sink"))).toBe(true);
  });
});

// The CLI owns its redactor and logger (so its own output is redacted by value); only the encoder/ffmpeg seams are faked.
const cliDeps = () => ({ checkFfmpeg: () => "ffmpeg (fake)", hasFfmpegFeature: () => true, encoderFactory: fakeEncoderFactory() });

describe("observatory-broadcast: CLI never takes secrets on argv and never prints them", () => {
  const env = (extra: Record<string, string> = {}) => ({ OBS_STATE_DIR: path.join(tmp, "state"), PATH: process.env.PATH ?? "", ...extra });

  it("refuses --stream-key, --rtmp-url and any rtmp(s):// argument before doing anything", async () => {
    for (const argv of [
      ["publish", "--adapter", "youtube", "--stream-key", "abc"],
      ["publish", "--adapter", "youtube", "--key=abc"],
      ["publish", "--adapter", "rtmp", "--rtmp-url", "x"],
      ["publish", "--adapter", "rtmp", "--url", `rtmps://h/app/${KEY}`],
      ["prepare", `rtmp://h/${KEY}`],
    ]) {
      const cap = capture();
      const code = await main(argv, { env: env(), stdout: cap.stdout, stderr: cap.stderr });
      expect(code, argv.join(" ")).toBe(2);
      expect(cap.text()).toMatch(/never accepted as arguments/);
      expect(cap.text()).not.toContain(KEY);
    }
    expect(fs.existsSync(path.join(tmp, "state", "plan.json"))).toBe(false);
  });

  it("an unconfigured publish exits 2 with actionable errors that contain no values", async () => {
    const cap = capture();
    const code = await main(["prepare", "--adapter", "youtube", "--url", "http://localhost:3000/observatory/presenter"], { env: env(), stdout: cap.stdout, stderr: cap.stderr, adapterDeps: cliDeps() });
    expect(code).toBe(2);
    expect(cap.text()).toMatch(/OBS_YOUTUBE_STREAM_KEY is not set/);
  });

  it("prepare with a real-looking key prints the plan with the target redacted, and the key appears nowhere on disk or in output", async () => {
    const cap = capture();
    const e = env({ OBS_YOUTUBE_STREAM_KEY: KEY });
    const code = await main(["prepare", "--adapter", "youtube", "--url", "http://localhost:3000/observatory/presenter"], { env: e, stdout: cap.stdout, stderr: cap.stderr, adapterDeps: cliDeps() });
    expect(code).toBe(0);
    expect(cap.text()).toContain("rtmps://a.rtmps.youtube.com:443/[REDACTED]");
    expect(cap.text()).toMatch(/verified:false/);
    expect(cap.text()).not.toContain(KEY);
    const stateDir = path.join(tmp, "state");
    for (const f of fs.readdirSync(stateDir)) expect(fs.readFileSync(path.join(stateDir, f), "utf8"), f).not.toContain(KEY);
    // the approval code is in its file, not on screen
    const codeText = fs.readFileSync(path.join(stateDir, "approval-code.txt"), "utf8").trim();
    expect(codeText).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(cap.text()).not.toContain(codeText);
    expect(fs.statSync(path.join(stateDir, "approval-code.txt")).mode & 0o077).toBe(0);
  });
});
