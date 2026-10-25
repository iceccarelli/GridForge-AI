import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { main } from "../../observatory-broadcast/src/cli.mjs";
import { ffmpegHas } from "../../observatory-broadcast/src/ffmpeg.mjs";
import { findFont } from "../../observatory-broadcast/src/slate.mjs";
import { pidAlive } from "../../observatory-broadcast/src/lock.mjs";
import { StateStore } from "../../observatory-broadcast/src/state.mjs";

// The operator surface: record / prepare / publish / status / stop / slate / health, with the JSON status file, graceful
// SIGINT/SIGTERM and process cleanup exercised on a real `bin/obs.mjs` process (local sink, looping source file).

function has(cmd: string) { try { execFileSync(cmd, ["-version"], { stdio: "ignore" }); return true; } catch { return false; } }
const REAL = has("ffmpeg") && has("ffprobe") && ffmpegHas("encoder", "libx264") && ffmpegHas("filter", "drawtext") && !!findFont();
const BIN = path.join(__dirname, "../../observatory-broadcast/bin/obs.mjs");

let tmp: string;
let stateDir: string;
let sinkDir: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "obs-cli-test-")); stateDir = path.join(tmp, "state"); sinkDir = path.join(tmp, "sink"); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const env = () => ({ ...process.env, OBS_STATE_DIR: stateDir, OBS_LOCAL_SINK_DIR: sinkDir });
async function obs(argv: string[]) {
  const lines: string[] = [];
  const code = await main(argv, { env: env(), stdout: (s) => lines.push(s), stderr: (s) => lines.push(s) });
  return { code, text: lines.join("") };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => T | Promise<T>, ms = 20_000, step = 150): Promise<T> {
  const end = Date.now() + ms;
  let last: T;
  do { last = await fn(); if (last) return last; await sleep(step); } while (Date.now() < end);
  return last;
}
const pgrep = (needle: string) => { try { return execFileSync("pgrep", ["-f", needle], { encoding: "utf8" }).trim().split("\n").filter(Boolean); } catch { return []; } };

describe("observatory-broadcast: operator CLI (no media)", () => {
  it("help lists every subcommand, and an unknown command or option is a usage error (exit 2)", async () => {
    const h = await obs(["help"]);
    expect(h.code).toBe(0);
    for (const c of ["record", "prepare", "publish", "status", "stop", "slate", "health"]) expect(h.text).toContain(c);
    expect(h.text).toMatch(/NEVER accepted as arguments/);
    expect((await obs(["frobnicate"])).code).toBe(2);
    expect((await obs(["status", "--bogus"])).code).toBe(2);
    expect((await obs([])).code).toBe(2);
    expect((await obs(["--version"])).text).toMatch(/observatory-broadcast 0\.1\.0/);
  });

  it("status with no history, and stop with nothing running, are calm", async () => {
    expect((await obs(["status"])).text).toMatch(/no broadcast has run/);
    expect((await obs(["status", "--json"])).text).toContain('"running": false');
    expect((await obs(["stop"])).text).toMatch(/no broadcast is running/);
  });

  it("a status file left by a dead supervisor is reported as stopped and unverified, never as 'live'", async () => {
    const store = new StateStore(stateDir);
    store.writeJson("status.json", { state: "live", verified: true, adapter: "local", detail: "verified: x", heartbeatAt: new Date(Date.now() - 3_600_000).toISOString() });
    const s = JSON.parse((await obs(["status", "--json"])).text);
    expect(s).toMatchObject({ running: false, state: "stopped", verified: false, staleState: "live" });
    const human = (await obs(["status"])).text;
    expect(human).toMatch(/state\s+stopped \(verified:false\)/);
    expect(human).not.toMatch(/^state\s+live/m);
  });

  it("health: down (exit 2) with no broadcast; degraded (exit 1) on the slate; down when the heartbeat is stale", async () => {
    const down = await obs(["health", "--json"]);
    expect(down.code).toBe(2);
    expect(JSON.parse(down.text)).toMatchObject({ status: "down" });
    const store = new StateStore(stateDir);
    // pretend this very process is the supervisor so the pid check passes
    store.writeJson("supervisor.json", { pid: process.pid, startedAt: Date.now() });
    const fresh = (over: object) => ({ adapter: "local", verified: false, heartbeatAt: new Date().toISOString(), encoder: { pid: 1, frame: 5, lastFrameAdvanceAt: new Date().toISOString() }, ...over });
    store.writeJson("status.json", fresh({ state: "fallback_slate" }));
    const slate = await obs(["health", "--json"]);
    expect(slate.code).toBe(1);
    expect(JSON.parse(slate.text)).toMatchObject({ status: "degraded", reason: "showing the fallback slate" });
    store.writeJson("status.json", fresh({ state: "reconnecting", encoder: null }));
    expect((await obs(["health", "--json"])).code).toBe(1);
    store.writeJson("status.json", fresh({ state: "starting" }));
    const ok = await obs(["health", "--json"]);
    expect(ok.code).toBe(0);
    expect(JSON.parse(ok.text).reason).toMatch(/unverified/);
    store.writeJson("status.json", fresh({ state: "starting", heartbeatAt: new Date(Date.now() - 60_000).toISOString() }));
    const stale = await obs(["health", "--json"]);
    expect(stale.code).toBe(2);
    expect(JSON.parse(stale.text).reason).toMatch(/heartbeat/);
    store.writeJson("status.json", fresh({ state: "starting", encoder: { pid: 1, frame: 5, lastFrameAdvanceAt: new Date(Date.now() - 120_000).toISOString() } }));
    expect(JSON.parse((await obs(["health", "--json"])).text).reason).toMatch(/frame counter has not advanced/);
  });

  it("slate on/off record the operator's request in the control file even when nothing is running", async () => {
    expect((await obs(["slate", "on"])).text).toMatch(/requested/);
    expect(new StateStore(stateDir).readControl().forceSlate).toBe(true);
    expect((await obs(["slate", "off"])).text).toMatch(/released/);
    expect(new StateStore(stateDir).readControl().forceSlate).toBe(false);
    expect((await obs(["slate", "sideways"])).code).toBe(2);
    expect((await obs(["slate", "generate"])).code).toBe(2);
  });

  it("record validates its arguments before touching a browser", async () => {
    expect((await obs(["record", "--out", "x.mp4"])).code).toBe(2);
    const bad = await obs(["record", "--url", "http://localhost:3000/observatory/presenter", "--out", path.join(tmp, "x.mp4"), "--size", "big"]);
    expect(bad.code).toBe(2);
    expect(bad.text).toMatch(/1280x720/);
    const refused = await obs(["record", "--url", "http://localhost:3000/account", "--out", path.join(tmp, "x.mp4")]);
    expect(refused.code).toBe(4);
    expect(refused.text).toMatch(/deny list/);
    expect((await obs(["record", "--url", "http://localhost:3000/observatory/presenter", "--out", path.join(tmp, "x.mp4"), "--cues", path.join(tmp, "nope.json"), "--vtt", "x"])).text).toMatch(/not both/);
    const badVtt = path.join(tmp, "bad.vtt");
    fs.writeFileSync(badVtt, "not vtt");
    expect((await obs(["record", "--url", "http://localhost:3000/observatory/presenter", "--out", path.join(tmp, "x.mp4"), "--vtt", badVtt])).text).toMatch(/not valid WebVTT/);
  });
});

describe.skipIf(!REAL)("observatory-broadcast: real obs process (local sink, looping source file)", () => {
  async function makeSource() {
    const f = path.join(tmp, "scene.mp4");
    const r = await obs(["slate", "generate", "--out", f, "--size", "320x180", "--fps", "10", "--duration", "2"]);
    expect(r.code).toBe(0);
    expect(r.text).toMatch(/we will be right back/);
    return f;
  }
  function launch(source: string) {
    const child = spawn(process.execPath, [BIN, "publish", "--adapter", "local", "--source-file", source, "--size", "320x180", "--fps", "10", "--bitrate", "300k"], { env: env(), stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const exited = new Promise<{ code: number | null; signal: string | null }>((r) => child.on("exit", (code, signal) => r({ code, signal })));
    return { child, exited, output: () => out };
  }
  const statusOf = async () => JSON.parse((await obs(["status", "--json"])).text);

  it("publishes to the sink, reports 'live' only with filesystem evidence, obeys `slate on`, health is ok, and `stop` ends it cleanly with nothing left running", async () => {
    const source = await makeSource();
    const run = launch(source);
    const live = await until(async () => { const s = await statusOf(); return s.state === "live" ? s : null; }, 30_000);
    expect(live, run.output()).toBeTruthy();
    expect(live).toMatchObject({ running: true, verified: true, adapter: "local", phase: "scene" });
    expect(live.evidence).toMatch(/segment\(s\).*from the current run/);
    expect(fs.readdirSync(sinkDir).some((f) => f.startsWith("seg-scene-r1-"))).toBe(true);
    const encPid = live.encoder.pid as number;
    expect(pidAlive(encPid)).toBe(true);

    const health = await obs(["health", "--json"]);
    expect(health.code, health.text).toBe(0);

    expect((await obs(["slate", "on"])).code).toBe(0);
    const slated = await until(async () => { const s = await statusOf(); return s.state === "fallback_slate" ? s : null; }, 15_000);
    expect(slated).toMatchObject({ state: "fallback_slate", verified: false, forcedSlate: true });
    expect(await until(() => fs.readdirSync(sinkDir).some((f) => f.startsWith("seg-slate-")), 15_000)).toBe(true);
    expect(pidAlive(encPid)).toBe(false); // the scene encoder was replaced, not left running
    expect((await obs(["health"])).code).toBe(1); // degraded while on the slate

    const stop = await obs(["stop"]);
    expect(stop.code, stop.text).toBe(0);
    const ended = await run.exited;
    expect(ended).toEqual({ code: 0, signal: null });
    const final = await statusOf();
    expect(final).toMatchObject({ running: false, state: "stopped", verified: false });
    expect(final.transitions.map((t: any) => t.to)).toEqual(expect.arrayContaining(["starting", "live", "fallback_slate", "stopped"]));
    expect(final.transitions.filter((t: any) => t.to === "live").length).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(stateDir, "supervisor.json"))).toBe(false);
    expect(pgrep(path.basename(tmp))).toEqual([]); // no ffmpeg left with our sink/state paths on its command line
    expect(run.output()).not.toMatch(/internal|Error:/);
  }, 120_000);

  it("SIGINT is a graceful stop too (exit 0, status stopped, no orphan)", async () => {
    const source = await makeSource();
    const run = launch(source);
    const up = await until(async () => { const s = await statusOf(); return s.running && s.encoder ? s : null; }, 30_000);
    expect(up, run.output()).toBeTruthy();
    const encPid = up.encoder.pid as number;
    run.child.kill("SIGINT");
    expect(await run.exited).toEqual({ code: 0, signal: null });
    expect(pidAlive(encPid)).toBe(false);
    expect((await statusOf()).state).toBe("stopped");
    expect(pgrep(path.basename(tmp))).toEqual([]);
  }, 90_000);

  it("a second publish while one is running is refused, and the first is unaffected", async () => {
    const source = await makeSource();
    const run = launch(source);
    expect((await until(async () => (await statusOf()).running, 30_000))).toBeTruthy();
    const second = await obs(["publish", "--adapter", "local", "--source-file", source, "--size", "320x180", "--fps", "10", "--max-runtime-sec", "2"]);
    expect(second.code).toBe(1);
    expect(second.text).toMatch(/already_running/);
    expect((await statusOf()).running).toBe(true);
    run.child.kill("SIGTERM");
    expect(await run.exited).toEqual({ code: 0, signal: null });
  }, 90_000);

  it("the real RTMP output stage fails against a closed local port, retries, falls back, gives up - and the stream key appears nowhere", async () => {
    const KEY = "REALffmpegKEY-7777-8888-9999";
    const source = await makeSource();
    const e = { ...env(), OBS_RTMP_URL: "rtmp://127.0.0.1:1/live", OBS_RTMP_KEY: KEY };
    const run = (argv: string[]) => new Promise<{ code: number | null; out: string }>((resolve) => {
      const c = spawn(process.execPath, [BIN, ...argv], { env: e, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      c.stdout.on("data", (d) => (out += d));
      c.stderr.on("data", (d) => (out += d));
      c.on("exit", (code) => resolve({ code, out }));
    });
    const prep = await run(["prepare", "--adapter", "rtmp", "--source-file", source, "--size", "320x180", "--fps", "10"]);
    expect(prep.code, prep.out).toBe(0);
    expect(prep.out).toContain("rtmp://127.0.0.1:1/[REDACTED]");
    expect(prep.out).toMatch(/NOT contacted/);
    const code = fs.readFileSync(path.join(stateDir, "approval-code.txt"), "utf8").trim();
    const pub = await run(["publish", "--adapter", "rtmp", "--source-file", source, "--size", "320x180", "--fps", "10", "--max-attempts", "1", "--approve", code]);
    expect(pub.code, pub.out).toBe(1); // nothing could be sent anywhere: output_failed
    expect(pub.out).toMatch(/live status cannot be verified for rtmp in this build/);
    expect(pub.out).toMatch(/"event":"encoder_failure"/);
    expect(pub.out).toMatch(/Connection refused|Error opening output/i); // ffmpeg's real reason is surfaced...
    const status = JSON.parse(fs.readFileSync(path.join(stateDir, "status.json"), "utf8"));
    const to = status.transitions.map((t: any) => t.to);
    expect(to).toEqual(expect.arrayContaining(["reconnecting", "fallback_slate", "stopped"]));
    expect(to).not.toContain("live");
    expect(status).toMatchObject({ state: "stopped", verified: false, stopReason: "output_failed" });
    // ...and the key is in none of: stdout/stderr, status file, plan, any file in the state dir
    expect(pub.out + prep.out).not.toContain(KEY);
    for (const f of fs.readdirSync(stateDir)) {
      const full = path.join(stateDir, f);
      if (fs.statSync(full).isFile() && !f.endsWith(".mp4")) expect(fs.readFileSync(full, "utf8"), f).not.toContain(KEY);
    }
    expect(pgrep(path.basename(tmp))).toEqual([]);
  }, 120_000);

  it("a supervisor that was SIGKILLed leaves an orphan ffmpeg that the next run reaps (and only that process)", async () => {
    const source = await makeSource();
    const run = launch(source);
    const up = await until(async () => { const s = await statusOf(); return s.running && s.encoder ? s : null; }, 30_000);
    expect(up, run.output()).toBeTruthy();
    const encPid = up.encoder.pid as number;
    run.child.kill("SIGKILL");
    await run.exited;
    await sleep(300);
    expect(pidAlive(encPid)).toBe(true); // the orphan the design must not leave around
    // an unrelated process must survive the reaper
    const bystander = spawn("sleep", ["30"]);
    const second = launch(source);
    const again = await until(async () => { const s = await statusOf(); return s.running && s.encoder && s.encoder.pid !== encPid ? s : null; }, 30_000);
    expect(again, second.output()).toBeTruthy();
    expect(pidAlive(encPid)).toBe(false); // reaped
    expect(pidAlive(bystander.pid as number)).toBe(true);
    bystander.kill();
    second.child.kill("SIGTERM");
    await second.exited;
  }, 120_000);
});
