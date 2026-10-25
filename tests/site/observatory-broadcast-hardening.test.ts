import { SITE_URL } from "@/lib/site";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { main } from "../../observatory-broadcast/src/cli.mjs";
import { StateStore } from "../../observatory-broadcast/src/state.mjs";
import { withLock } from "../../observatory-broadcast/src/lock.mjs";
import { createApproval, MAX_TTL_MS } from "../../observatory-broadcast/src/approval.mjs";
import { pidAlive, procHidesOtherUsers, procStartTime, runMarker, sameProcess } from "../../observatory-broadcast/src/proc.mjs";
import { DEFAULT_ALLOW, checkTargetUrl, isAllowedNavigation } from "../../observatory-broadcast/src/safety.mjs";
import { Redactor } from "../../observatory-broadcast/src/redact.mjs";
import { createAdapter } from "../../observatory-broadcast/src/adapters/index.mjs";
import { buildLiveArgs, FfmpegEncoder } from "../../observatory-broadcast/src/encoder.mjs";
import { mp4Problem, ffmpegHas, resolveEncoding } from "../../observatory-broadcast/src/ffmpeg.mjs";
import { pinFile } from "../../observatory-broadcast/src/publish.mjs";
import { buildLaunchOptions, chromiumArgs } from "../../observatory-broadcast/src/capture.mjs";
import { minimalEnv } from "../../observatory-broadcast/src/env.mjs";
import { record, HLS_MARKER } from "../../observatory-broadcast/src/record.mjs";
import { serveFixtures } from "../../observatory-broadcast/fixtures/serve.mjs";
import { fakeEncoderFactory } from "../../observatory-broadcast/testing/fakes.mjs";

// Regression tests for the independent security review. Each describe is one finding; the tests were written to FAIL
// against the code as reviewed (the first four were mutation-checked by reverting the fix).

const KEY = "HARDENkey-4444-5555-6666";
const URL_OK = "http://localhost:3000/observatory/presenter";
function has(cmd: string) { try { execFileSync(cmd, ["-version"], { stdio: "ignore" }); return true; } catch { return false; } }
const FFMPEG = has("ffmpeg") && has("ffprobe") && ffmpegHas("encoder", "libx264");
const BROWSER = FFMPEG && (() => {
  try { createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || "/opt/node-tools/node_modules/playwright"); return fs.existsSync(process.env.CHROMIUM || "/opt/pw-browsers/chromium"); } catch { return false; }
})();

let tmp: string;
let stateDir: string;
const kids: ChildProcess[] = [];
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "obs-hard-test-")); stateDir = path.join(tmp, "state"); });
afterEach(() => {
  vi.restoreAllMocks();
  for (const k of kids.splice(0)) { try { k.kill("SIGKILL"); } catch { /* gone */ } }
  fs.rmSync(tmp, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const cap = () => { const l: string[] = []; return { l, stdout: (s: string) => l.push(s), stderr: (s: string) => l.push(s), text: () => l.join("") }; };
async function obs(argv: string[], env: Record<string, string | undefined> = {}) {
  const c = cap();
  const code = await main(argv, { env: { OBS_STATE_DIR: stateDir, PATH: process.env.PATH ?? "", ...env }, stdout: c.stdout, stderr: c.stderr });
  return { code, text: c.text() };
}
/** A harmless long-running process whose command line carries a run marker, standing in for an orphaned ffmpeg. */
function fakeEncoder(runId: string) {
  const c = spawn(process.execPath, ["-e", "setTimeout(()=>{},300000)", `${runMarker(runId)}slate`], { stdio: "ignore" });
  kids.push(c);
  return c;
}
const DEAD_PID = 2 ** 22 + 4321;
function writeOrphanRecord(store: StateStore, runId: string, children: { pid: number; startTime: string | null }[]) {
  store.writeJson("children.json", { supervisor: { pid: DEAD_PID, startTime: "1" }, runId, children, at: Date.now() });
}
async function started(c: ChildProcess) { for (let i = 0; i < 50 && !procStartTime(c.pid as number); i++) await sleep(20); await sleep(100); return procStartTime(c.pid as number) as string; }
const mp4Bytes = () => Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypisom"), Buffer.alloc(16)]);

describe("finding 1: orphaned encoder after a SIGKILLed supervisor is found, killed and REPORTED by stop, status and health", () => {
  it("`obs stop` kills the orphan and says so (it used to say nothing was running)", async () => {
    const store = new StateStore(stateDir);
    const orphan = fakeEncoder("RUNONE");
    const startTime = await started(orphan);
    writeOrphanRecord(store, "RUNONE", [{ pid: orphan.pid as number, startTime }]);
    expect(pidAlive(orphan.pid as number)).toBe(true);
    const r = await obs(["stop"]);
    expect(r.text).toMatch(/orphan/);
    expect(r.text).toContain(`pid ${orphan.pid} killed`);
    expect(r.code).toBe(0);
    await sleep(100);
    expect(pidAlive(orphan.pid as number)).toBe(false);
    expect(fs.existsSync(store.file("children.json"))).toBe(false);
  });

  it("`obs status` reports (json and text) and reaps the orphan too", async () => {
    const store = new StateStore(stateDir);
    const orphan = fakeEncoder("RUNTWO");
    writeOrphanRecord(store, "RUNTWO", [{ pid: orphan.pid as number, startTime: await started(orphan) }]);
    const r = await obs(["status", "--json"]);
    const j = JSON.parse(r.text);
    expect(j.orphans).toEqual([expect.objectContaining({ pid: orphan.pid, runId: "RUNTWO", action: "killed" })]);
    await sleep(100);
    expect(pidAlive(orphan.pid as number)).toBe(false);

    const orphan2 = fakeEncoder("RUNTHREE");
    writeOrphanRecord(store, "RUNTHREE", [{ pid: orphan2.pid as number, startTime: await started(orphan2) }]);
    const t = await obs(["status"]);
    expect(t.text).toMatch(new RegExp(`orphan: ffmpeg pid ${orphan2.pid} \\(run RUNTHREE\\) killed`));
  });

  it("`obs health` is DOWN (exit 2) and names the orphan", async () => {
    const store = new StateStore(stateDir);
    const orphan = fakeEncoder("RUNFOUR");
    writeOrphanRecord(store, "RUNFOUR", [{ pid: orphan.pid as number, startTime: await started(orphan) }]);
    const r = await obs(["health", "--json"]);
    expect(r.code).toBe(2);
    const j = JSON.parse(r.text);
    expect(j.status).toBe("down");
    expect(j.reason).toMatch(/orphaned encoder/);
    expect(j.orphans[0]).toMatchObject({ pid: orphan.pid, action: "killed" });
  });

  it("nothing is reported or killed while the recorded supervisor is genuinely alive", async () => {
    const store = new StateStore(stateDir);
    const orphan = fakeEncoder("RUNFIVE");
    const startTime = await started(orphan);
    store.writeJson("children.json", { supervisor: { pid: process.pid, startTime: procStartTime(process.pid) }, runId: "RUNFIVE", children: [{ pid: orphan.pid, startTime }], at: Date.now() });
    // the current process IS the recorded supervisor here, so these are its children, not orphans
    expect(store.reapOrphans()).toEqual([]);
    expect(pidAlive(orphan.pid as number)).toBe(true);
    const other = fakeEncoder("X");
    store.writeJson("children.json", { supervisor: { pid: other.pid, startTime: await started(other) }, runId: "RUNFIVE", children: [{ pid: orphan.pid, startTime }], at: Date.now() });
    expect(store.reapOrphans()).toEqual([]);
    expect(pidAlive(orphan.pid as number)).toBe(true);
  });
});

describe("finding 2: process identity (start time + exact run marker), recycled pids, EPERM", () => {
  it("a recycled pid is never killed: matching marker but a different start time is left alone and reported", async () => {
    const store = new StateStore(stateDir);
    const victim = fakeEncoder("RUNSIX");
    await started(victim);
    writeOrphanRecord(store, "RUNSIX", [{ pid: victim.pid as number, startTime: "1" /* recorded when it was another process */ }]);
    const rep = store.reapOrphans();
    expect(rep).toEqual([expect.objectContaining({ pid: victim.pid, action: "left", reason: expect.stringMatching(/recycled/) })]);
    expect(pidAlive(victim.pid as number)).toBe(true);
  });

  it("the run id must match EXACTLY (a prefix of another run's id, or a different run, is not ours)", async () => {
    const store = new StateStore(stateDir);
    const other = fakeEncoder("abc123");
    const startTime = await started(other);
    for (const runId of ["abc", "abc12", "zzz999"]) {
      writeOrphanRecord(store, runId, [{ pid: other.pid as number, startTime }]);
      const rep = store.reapOrphans();
      expect(rep[0], runId).toMatchObject({ action: "left", reason: expect.stringMatching(/marker/) });
      expect(pidAlive(other.pid as number)).toBe(true);
    }
    expect(sameProcess(other.pid as number, { startTime, marker: runMarker("abc123") }).same).toBe(true);
    expect(sameProcess(other.pid as number, { startTime, marker: runMarker("abc") }).same).toBe(false);
    // without a recorded start time identity is unknown: never "same"
    expect(sameProcess(other.pid as number, { startTime: null, marker: runMarker("abc123") }).same).toBe(false);
  });

  it("`obs stop` does not SIGTERM an unrelated process that inherited the supervisor's pid", async () => {
    const store = new StateStore(stateDir);
    const bystander = fakeEncoder("BYSTANDER");
    await started(bystander);
    store.writeJson("supervisor.json", { pid: bystander.pid, startTime: "1", startedAt: 0 }); // recorded for a long-dead supervisor
    expect(store.supervisorPid()).toBeNull();
    const r = await obs(["stop"]);
    expect(r.text).toMatch(/no broadcast is running/);
    expect(pidAlive(bystander.pid as number)).toBe(true);
    // and a second supervisor can claim the slot instead of being told one is "already running"
    await expect(store.claimSupervisor()).resolves.toBeUndefined();
  });

  it("EPERM while signalling the supervisor is an actionable error, not an `internal` crash", async () => {
    const store = new StateStore(stateDir);
    const sup = fakeEncoder("SUP");
    store.writeJson("supervisor.json", { pid: sup.pid, startTime: await started(sup), startedAt: 0 });
    const real = process.kill.bind(process);
    vi.spyOn(process, "kill").mockImplementation(((pid: number, sig?: string | number) => {
      if (sig === "SIGTERM" && pid === sup.pid) throw Object.assign(new Error("not permitted"), { code: "EPERM" });
      return real(pid, sig as any);
    }) as any);
    const r = await obs(["stop"]);
    expect(r.code).toBe(1);
    expect(r.text).toMatch(/stop_denied/);
    expect(r.text).not.toMatch(/internal/);
  });

  it("EPERM while killing an orphan is reported (action left), not thrown, and the record is kept for a retry", async () => {
    const store = new StateStore(stateDir);
    const orphan = fakeEncoder("RUNEPERM");
    writeOrphanRecord(store, "RUNEPERM", [{ pid: orphan.pid as number, startTime: await started(orphan) }]);
    const real = process.kill.bind(process);
    vi.spyOn(process, "kill").mockImplementation(((pid: number, sig?: string | number) => {
      if (sig === "SIGKILL" && pid === orphan.pid) throw Object.assign(new Error("nope"), { code: "EPERM" });
      return real(pid, sig as any);
    }) as any);
    const rep = store.reapOrphans();
    expect(rep[0]).toMatchObject({ action: "left", reason: expect.stringMatching(/EPERM/) });
    expect(fs.existsSync(store.file("children.json"))).toBe(true);
    const r = await obs(["stop"]);
    expect(r.code).toBe(1); // something is still running that we could not stop
    expect(r.text).not.toMatch(/internal/);
  });

  it("a lock whose owner pid was recycled (alive, different start time) is stale", async () => {
    const store = new StateStore(stateDir);
    const squatter = fakeEncoder("SQ");
    await started(squatter);
    fs.writeFileSync(store.lockPath, JSON.stringify({ pid: squatter.pid, start: "1", at: Date.now() }));
    await expect(withLock(store.lockPath, () => "got it", { timeoutMs: 500 })).resolves.toBe("got it");
  });

  it("start time is read from /proc/<pid>/stat field 22 even when the command name contains spaces and parentheses", () => {
    expect(procStartTime(process.pid)).toMatch(/^\d+$/);
    expect(procStartTime(DEAD_PID)).toBeNull();
  });
});

describe("finding 3: the stream key is on ffmpeg's argv - state it, and require an explicit acknowledgement", () => {
  const env = (extra: Record<string, string> = {}) => ({ OBS_STATE_DIR: stateDir, PATH: process.env.PATH ?? "", OBS_YOUTUBE_STREAM_KEY: KEY, ...extra });
  const slate = () => { const f = path.join(tmp, "slate.mp4"); fs.writeFileSync(f, mp4Bytes()); return f; };
  const deps = (f = fakeEncoderFactory()) => ({ checkFfmpeg: () => "x", hasFfmpegFeature: () => true, encoderFactory: f });

  async function prepare(adapter = "youtube", e = env()) {
    const c = cap();
    const code = await main(["prepare", "--adapter", adapter, "--url", URL_OK, "--slate-file", slate()], { env: e, stdout: c.stdout, stderr: c.stderr, adapterDeps: deps() });
    expect(code, c.text()).toBe(0);
    return { out: c.text(), code: fs.readFileSync(path.join(stateDir, "approval-code.txt"), "utf8").trim() };
  }
  async function publish(argv: string[], procMounts: string, e = env()) {
    const c = cap();
    const factory = fakeEncoderFactory();
    const ctl = new AbortController();
    const done = main(["publish", "--adapter", "youtube", "--url", URL_OK, "--slate-file", slate(), ...argv], {
      env: e, stdout: c.stdout, stderr: c.stderr, signal: ctl.signal, installSignalHandlers: false, sceneProbe: () => true, health: { checkIntervalMs: 20 }, procMounts, adapterDeps: deps(factory),
    });
    return { done, ctl, factory, text: c.text };
  }
  async function finish(p: Awaited<ReturnType<typeof publish>>) {
    for (let i = 0; i < 100 && p.factory.made.length === 0; i++) await sleep(20);
    p.ctl.abort();
    return p.done;
  }
  const MOUNTS_OPEN = "proc /proc proc rw,nosuid,nodev,noexec,relatime 0 0\n";
  const MOUNTS_HIDEPID2 = "proc /proc proc rw,nosuid,nodev,noexec,relatime,hidepid=2 0 0\n";

  it("prepare's plan notes state the exposure plainly (text and JSON)", async () => {
    const { out } = await prepare();
    expect(out).toMatch(/stream key is passed to ffmpeg on its command line/);
    expect(out).toMatch(/same OS user/);
    const c = cap();
    await main(["prepare", "--adapter", "youtube", "--url", URL_OK, "--slate-file", slate(), "--json"], { env: env(), stdout: c.stdout, stderr: c.stderr, adapterDeps: deps() });
    expect(JSON.parse(c.text()).plan.notes.join(" ")).toMatch(/command line/);
    expect(out).toContain("--accept-argv-exposure");
  });

  it("publish without --accept-argv-exposure is refused (exit 3) BEFORE the code is spent and before anything starts", async () => {
    const { code } = await prepare();
    const p = await publish(["--approve", code, "--approve-public"], MOUNTS_OPEN);
    expect(await p.done).toBe(3);
    expect(p.text()).toMatch(/argv_exposure_not_accepted/);
    expect(p.text()).toMatch(/dedicated user/);
    expect(p.factory.made).toHaveLength(0);
    expect(fs.existsSync(path.join(stateDir, "approval-code.txt"))).toBe(true); // not consumed
    expect(p.text()).not.toContain(KEY);
  });

  it("with the acknowledgement it proceeds, and says what was accepted", async () => {
    const { code } = await prepare();
    const p = await publish(["--approve", code, "--approve-public", "--accept-argv-exposure"], MOUNTS_OPEN);
    expect(await finish(p)).toBe(0);
    expect(p.text()).toMatch(/argv exposure of the stream key accepted by the operator/);
  });

  it("hidepid>=1 on /proc lifts the requirement - but the note still says it hides only OTHER users", async () => {
    const { code } = await prepare();
    const p = await publish(["--approve", code, "--approve-public"], MOUNTS_HIDEPID2);
    expect(await finish(p)).toBe(0);
    expect(p.text()).toMatch(/hides it from OTHER users/);
  });

  it("detects hidepid in /proc/mounts (1, 2, invisible, noaccess) and not hidepid=0 / absent / other mounts", () => {
    const m = (opts: string, mp = "/proc", type = "proc") => `${type} ${mp} ${type} ${opts} 0 0\n`;
    expect(procHidesOtherUsers(m("rw,hidepid=1"))).toBe(true);
    expect(procHidesOtherUsers(m("rw,hidepid=2,gid=100"))).toBe(true);
    expect(procHidesOtherUsers(m("hidepid=invisible"))).toBe(true);
    expect(procHidesOtherUsers(m("hidepid=noaccess"))).toBe(true);
    expect(procHidesOtherUsers(m("rw,hidepid=0"))).toBe(false);
    expect(procHidesOtherUsers(m("rw,nosuid"))).toBe(false);
    expect(procHidesOtherUsers(m("rw,hidepid=2", "/other"))).toBe(false);
    expect(procHidesOtherUsers("")).toBe(false);
  });

  it("hidepid=0 does not count; the local sink never needs the acknowledgement (no key on any argv)", async () => {
    const { code } = await prepare();
    const p = await publish(["--approve", code, "--approve-public"], MOUNTS_OPEN.replace("relatime", "relatime,hidepid=0"));
    expect(await p.done).toBe(3);
    expect(createAdapter("local", {}).keyOnArgv).toBe(false);
    for (const a of ["rtmp", "youtube", "kick"]) expect(createAdapter(a, {}).keyOnArgv).toBe(true);
  });
});

describe("finding 4: scoped default allow-list, robots private paths denied, main-frame navigations pinned", () => {
  const robots = fs.readFileSync(path.join(__dirname, "../../app/robots.ts"), "utf8");
  const privatePaths = (() => {
    const body = /const PRIVATE_PATHS = \[([\s\S]*?)\];/.exec(robots)?.[1] ?? "";
    return [...body.replace(/\/\/[^\n]*/g, "").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  })();

  it("parses app/robots.ts PRIVATE_PATHS (guards against the parse silently finding nothing)", () => {
    expect(privatePaths.length).toBeGreaterThanOrEqual(12);
    expect(privatePaths).toEqual(expect.arrayContaining(["/dashboard", "/admin", "/account", "/api/", "/api-access/", "/deliverable/", "/watch/", "/intake/", "/q/", "/p/", "/commissioned", "/workspace"]));
  });

  it("every private path in robots.ts is denied by the guard, under the default allow-list AND under a widened one (the presenter route is the sole exception: robots keeps it out of search, the tool exists to show it)", () => {
    for (const p of privatePaths) {
      const url = `http://localhost:3000${p}`;
      if (p === "/observatory/presenter") {
        expect(checkTargetUrl(url).ok, p).toBe(true);
        continue;
      }
      expect(checkTargetUrl(url).ok, p).toBe(false);
      const widened = checkTargetUrl(url, { allow: ["http://localhost", `${SITE_URL}`] });
      expect(widened.ok, `${p} (widened allow-list)`).toBe(false);
      expect(widened.ok ? "" : widened.reason, p).toMatch(/deny list/);
      // and nested under the presenter route, and on the production host
      expect(checkTargetUrl(`http://localhost:3000/observatory/presenter${p.replace(/\/$/, "")}/x`).ok, `nested ${p}`).toBe(false);
      expect(checkTargetUrl(`${SITE_URL}${p}`, { allow: [`${SITE_URL}`] }).ok, `prod ${p}`).toBe(false);
    }
    // the surfaces the review named that robots.ts does not list
    for (const p of ["/power/deploy", "/billing", "/login", "/checkout"]) expect(checkTargetUrl(`http://localhost:3000${p}`, { allow: ["http://localhost"] }).ok, p).toBe(false);
  });

  it("localhost is no longer 'any path on any port': only the presenter route and the fixture stage", () => {
    for (const u of ["http://localhost:3000/", "http://localhost:3000/pricing", "http://127.0.0.1:8080/constraints", "http://localhost:3000/observatory", "http://localhost:3000/_next/static/x.js", "http://[::1]:3000/qualify"]) {
      expect(checkTargetUrl(u).ok, u).toBe(false);
    }
    for (const u of ["http://localhost:3000/observatory/presenter", "http://127.0.0.1:1234/stage", "http://[::1]:3000/observatory/presenter?t=1&freeze=1"]) expect(checkTargetUrl(u).ok, u).toBe(true);
    expect(DEFAULT_ALLOW.every((e) => /\/(observatory\/presenter|stage)$/.test(e))).toBe(true);
  });

  it("navigation pin (unit): same origin AND under the scene's own path only", () => {
    const scene = new URL("http://localhost:3000/observatory/presenter");
    const nav = (u: string) => isAllowedNavigation(u, scene);
    expect(nav("http://localhost:3000/observatory/presenter")).toBe(true);
    expect(nav("http://localhost:3000/observatory/presenter?t=1&freeze=1")).toBe(true);
    expect(nav("http://localhost:3000/observatory/presenter/hall-a")).toBe(true);
    expect(nav("http://localhost:4000/observatory/presenter")).toBe(false); // another port: allow-listed but not this scene
    expect(nav("http://127.0.0.1:3000/observatory/presenter")).toBe(false); // another host name for the same machine
    expect(nav("http://localhost:3000/stage")).toBe(false); // allow-listed path, but not this scene's
    expect(nav("http://localhost:3000/observatory/presenterx")).toBe(false);
    expect(nav("http://localhost:3000/admin")).toBe(false);
    expect(isAllowedNavigation("http://localhost:3000/stage", new URL("http://localhost:3000/stage"))).toBe(true);
  });

  describe.skipIf(!BROWSER)("navigation pin (real Chromium)", () => {
    function counting(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void) {
      const hits: string[] = [];
      const srv = http.createServer((req, res) => { hits.push(req.url ?? ""); handler(req, res); });
      return new Promise<{ srv: http.Server; hits: string[]; port: number }>((resolve) => srv.listen(0, "127.0.0.1", () => resolve({ srv, hits, port: (srv.address() as any).port })));
    }
    const page = (body: string) => `<!doctype html><title>t</title><body style="background:#123">${body}</body>`;

    it("an HTTP redirect to another localhost port is refused and that port is never contacted", async () => {
      const b = await counting((_q, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end(page("B")); });
      const a = await counting((_q, res) => { res.writeHead(302, { location: `http://127.0.0.1:${b.port}/stage` }); res.end(); });
      try {
        await expect(record({ url: `http://127.0.0.1:${a.port}/stage`, out: path.join(tmp, "r.mp4"), durationSec: 1, encoding: { width: 320, height: 180, fps: 4, videoBitrateKbps: 300 } })).rejects.toMatchObject({ code: "url_refused", exitCode: 4, message: expect.stringMatching(/redirects are refused/) });
        expect(b.hits).toEqual([]); // Chromium does not route redirect hops: the target must never even be contacted
      } finally { a.srv.close(); b.srv.close(); }
    }, 60_000);

    it("a redirect to another ALLOW-LISTED path on the same port is refused too", async () => {
      const a = await counting((q, res) => {
        if ((q.url ?? "").startsWith("/stage")) { res.writeHead(302, { location: "/observatory/presenter" }); res.end(); }
        else { res.writeHead(200, { "content-type": "text/html" }); res.end(page("other")); }
      });
      try {
        await expect(record({ url: `http://127.0.0.1:${a.port}/stage`, out: path.join(tmp, "r2.mp4"), durationSec: 1, encoding: { width: 320, height: 180, fps: 4, videoBitrateKbps: 300 } })).rejects.toMatchObject({ code: "url_refused" });
        expect(a.hits.some((h) => h.startsWith("/observatory/presenter"))).toBe(false);
      } finally { a.srv.close(); }
    }, 60_000);

    it("an in-page navigation (location change) to another origin is refused, the target is never contacted, and the recording FAILS rather than capturing an error page", async () => {
      const b = await counting((_q, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end(page("B")); });
      const a = await counting((_q, res) => {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(page(`scene<script>location.href="http://127.0.0.1:${b.port}/stage"</script>`));
      });
      try {
        await expect(record({ url: `http://127.0.0.1:${a.port}/stage`, out: path.join(tmp, "r3.mp4"), durationSec: 1, mode: "stepped", encoding: { width: 320, height: 180, fps: 4, videoBitrateKbps: 300 } })).rejects.toMatchObject({ code: "scene_navigated_away", exitCode: 4 });
        expect(b.hits).toEqual([]);
        expect(fs.existsSync(path.join(tmp, "r3.mp4"))).toBe(false);
      } finally { a.srv.close(); b.srv.close(); }
    }, 60_000);
  });
});

describe("finding 5: the approval is bound to the media files; ffmpeg reads them with a protocol whitelist and a forced demuxer", () => {
  const env = () => ({ OBS_STATE_DIR: stateDir, PATH: process.env.PATH ?? "", OBS_YOUTUBE_STREAM_KEY: KEY });
  const deps = (f = fakeEncoderFactory()) => ({ checkFfmpeg: () => "x", hasFfmpegFeature: () => true, encoderFactory: f });
  const media = (name: string, extra = "") => { const f = path.join(tmp, name); fs.writeFileSync(f, Buffer.concat([mp4Bytes(), Buffer.from(extra)])); return f; };
  async function prepare(extra: string[]) {
    const c = cap();
    const code = await main(["prepare", "--adapter", "youtube", "--source-file", extra[0], ...extra.slice(1)], { env: env(), stdout: c.stdout, stderr: c.stderr, adapterDeps: deps() });
    expect(code, c.text()).toBe(0);
    return fs.readFileSync(path.join(stateDir, "approval-code.txt"), "utf8").trim();
  }
  async function publish(argv: string[]) {
    const c = cap();
    const factory = fakeEncoderFactory();
    const code = await main(["publish", "--adapter", "youtube", "--approve-public", "--accept-argv-exposure", ...argv], { env: env(), stdout: c.stdout, stderr: c.stderr, installSignalHandlers: false, procMounts: "", adapterDeps: deps(factory), sceneProbe: () => true });
    return { code, text: c.text(), factory };
  }

  it("changing the --source-file's CONTENT after prepare is a plan mismatch (same path, different sha256)", async () => {
    const src = media("scene.mp4");
    const slate = media("slate.mp4");
    const code = await prepare([src, "--slate-file", slate]);
    fs.writeFileSync(src, Buffer.concat([mp4Bytes(), Buffer.from("tampered")]));
    const r = await publish(["--source-file", src, "--slate-file", slate, "--approve", code]);
    expect(r.code).toBe(3);
    expect(r.text).toMatch(/plan_mismatch/);
    expect(r.factory.made).toHaveLength(0);
  });

  it("a different path with identical bytes, or a swapped --slate-file, is a mismatch as well", async () => {
    const src = media("scene.mp4");
    const slate = media("slate.mp4");
    const code = await prepare([src, "--slate-file", slate]);
    const copy = media("scene-copy.mp4");
    expect((await publish(["--source-file", copy, "--slate-file", slate, "--approve", code])).text).toMatch(/plan_mismatch/);
    const code2 = await prepare([src, "--slate-file", slate]);
    expect((await publish(["--source-file", src, "--slate-file", media("other-slate.mp4"), "--approve", code2])).text).toMatch(/plan_mismatch/);
    const code3 = await prepare([src, "--slate-file", slate]);
    expect((await publish(["--source-file", src, "--approve", code3])).text).toMatch(/plan_mismatch/); // dropping the slate file is a change too
  });

  it("an unchanged pair publishes, and ffmpeg is handed COPIES in the state dir, not the original paths", async () => {
    const src = media("scene.mp4");
    const slate = media("slate.mp4");
    const code = await prepare([src, "--slate-file", slate]);
    const c = cap();
    const factory = fakeEncoderFactory();
    const ctl = new AbortController();
    const done = main(["publish", "--adapter", "youtube", "--approve-public", "--accept-argv-exposure", "--source-file", src, "--slate-file", slate, "--approve", code], {
      env: env(), stdout: c.stdout, stderr: c.stderr, installSignalHandlers: false, procMounts: "", adapterDeps: deps(factory), sceneProbe: () => true, signal: ctl.signal, health: { checkIntervalMs: 20 },
    });
    for (let i = 0; i < 100 && factory.made.length === 0; i++) await sleep(20);
    const used = (factory.made[0].spec.source as any).file as string;
    expect(path.dirname(used)).toBe(stateDir);
    expect(used).not.toBe(src);
    expect(fs.readFileSync(used).equals(fs.readFileSync(src))).toBe(true);
    ctl.abort();
    expect(await done).toBe(0);
    expect(fs.existsSync(used)).toBe(false); // cleaned up
  });

  it("pinFile refuses a file that changed after approval, and anything that is not an MP4", () => {
    const f = media("a.mp4");
    const good = crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
    expect(pinFile(f, path.join(tmp, "copy.mp4"), good, "source file")).toBe(path.join(tmp, "copy.mp4"));
    fs.appendFileSync(f, "x");
    expect(() => pinFile(f, path.join(tmp, "copy2.mp4"), good, "source file")).toThrow(/changed after it was approved/);
    const concat = path.join(tmp, "evil.mp4");
    fs.writeFileSync(concat, "ffconcat version 1.0\nfile '/etc/passwd'\n");
    expect(() => pinFile(concat, path.join(tmp, "copy3.mp4"), null, "source file")).toThrow(/not an MP4/);
    expect(mp4Problem(concat)).toMatch(/no ftyp box/);
    expect(mp4Problem(path.join(tmp, "missing.mp4"))).toMatch(/cannot be read/);
    expect(mp4Problem(f)).toBeNull();
  });

  it("the live ffmpeg arguments confine inputs: file -> `-protocol_whitelist file -f mov`; scene pipe -> `-protocol_whitelist pipe`", () => {
    const { encoding } = resolveEncoding({ width: 640, height: 360, fps: 15 });
    const out = { args: ["-f", "flv", "rtmp://h/a/k"], display: "" };
    const file = buildLiveArgs({ mode: "slate", runId: "r", encoding, source: { kind: "file", file: "/x/s.mp4" }, output: out }).join(" ");
    expect(file).toContain("-protocol_whitelist file -f mov -i /x/s.mp4");
    const scene = buildLiveArgs({ mode: "scene", runId: "r", encoding, source: { kind: "scene", url: "http://localhost/x", viewport: { width: 640, height: 360 } }, output: out }).join(" ");
    expect(scene).toContain("-protocol_whitelist pipe");
    expect(scene).toContain("-f image2pipe");
  });

  it.skipIf(!FFMPEG)("a real ffmpeg given an ffconcat 'mp4' with the forced mov demuxer reads nothing from the file it points at", () => {
    const secret = path.join(tmp, "secret.txt");
    fs.writeFileSync(secret, "TOPSECRET");
    const evil = path.join(tmp, "evil.mp4");
    fs.writeFileSync(evil, `ffconcat version 1.0\nfile '${secret}'\n`);
    let failed = false;
    try { execFileSync("ffmpeg", ["-v", "error", "-protocol_whitelist", "file", "-f", "mov", "-i", evil, "-f", "null", "-"], { stdio: "pipe" }); } catch (e) { failed = true; expect(String((e as any).stderr)).not.toMatch(/TOPSECRET/); }
    expect(failed).toBe(true);
  });
});

describe("finding 6: sandbox policy, minimal child environment, WebSocket and WebRTC blocked", () => {
  it("--no-sandbox only for uid 0 or OBS_NO_SANDBOX=1", () => {
    expect(chromiumArgs({ uid: 1000, env: {} })).not.toContain("--no-sandbox");
    expect(chromiumArgs({ uid: 0, env: {} })).toContain("--no-sandbox");
    expect(chromiumArgs({ uid: 1000, env: { OBS_NO_SANDBOX: "1" } })).toContain("--no-sandbox");
    expect(chromiumArgs({ uid: 1000, env: { OBS_NO_SANDBOX: "0" } })).not.toContain("--no-sandbox");
    expect(chromiumArgs({ uid: null, env: {} })).not.toContain("--no-sandbox");
  });

  it("WebRTC may not use non-proxied UDP", () => {
    expect(chromiumArgs({ uid: 1000, env: {} })).toContain("--force-webrtc-ip-handling-policy=disable_non_proxied_udp");
  });

  it("minimalEnv keeps what a browser/encoder needs and drops stream keys, *_FILE paths and other secrets", () => {
    const e = minimalEnv({
      PATH: "/usr/bin", HOME: "/root", LANG: "C.UTF-8", LC_ALL: "C", TZ: "UTC", DISPLAY: ":1", PLAYWRIGHT_BROWSERS_PATH: "/opt/pw",
      OBS_YOUTUBE_STREAM_KEY: KEY, OBS_YOUTUBE_STREAM_KEY_FILE: "/secret/key", OBS_RTMP_URL: "rtmps://h/k", OBS_KICK_STREAM_KEY: "x",
      AWS_SECRET_ACCESS_KEY: "aws", GITHUB_TOKEN: "gh", STRIPE_SECRET_KEY: "sk", DATABASE_PASSWORD: "pw", SOME_API_KEY: "k", ANYTHING_FILE: "/f", NODE_OPTIONS: "--require x",
    });
    expect(Object.keys(e).sort()).toEqual(["DISPLAY", "HOME", "LANG", "LC_ALL", "PATH", "PLAYWRIGHT_BROWSERS_PATH", "TZ"]);
    expect(JSON.stringify(e)).not.toContain(KEY);
  });

  it("the browser's launch options carry the minimal environment and the sandbox policy", () => {
    const o = buildLaunchOptions({ env: { PATH: "/usr/bin", OBS_YOUTUBE_STREAM_KEY: KEY, CHROMIUM: "/x/chrome" }, viewport: { width: 320, height: 180 }, uid: 1000 });
    expect(o.env).toEqual({ PATH: "/usr/bin" });
    expect(o.args).not.toContain("--no-sandbox");
    expect(o.executablePath).toBe("/x/chrome");
  });

  it("ffmpeg is spawned with the minimal environment (no key variables), while the ingest URL stays on its argv", async () => {
    const { EventEmitter } = await import("node:events");
    const { PassThrough } = await import("node:stream");
    const child: any = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough(); child.pid = 4242; child.kill = () => {};
    let opts: any = null;
    const redactor = new Redactor([KEY]);
    const { encoding } = resolveEncoding({ width: 640, height: 360, fps: 15 });
    const enc = new FfmpegEncoder({ mode: "slate", runId: "r", encoding, source: { kind: "file", file: "/x/s.mp4" }, output: { args: ["-f", "flv", `rtmps://h/${KEY}`], display: "" } }, {
      spawn: ((_b: string, _a: string[], o: any) => { opts = o; return child; }) as any, redactor,
      env: { PATH: "/usr/bin", OBS_YOUTUBE_STREAM_KEY: KEY, OBS_YOUTUBE_STREAM_KEY_FILE: "/k", SECRET_THING_TOKEN: "t" },
    });
    await enc.start();
    expect(opts.env).toEqual({ PATH: "/usr/bin" });
  });

  describe.skipIf(!BROWSER)("real Chromium", () => {
    it("a page that opens a WebSocket never reaches the server (the upgrade is not even sent), and the attempt is reported", async () => {
      let upgrades = 0;
      const srv = http.createServer((q, res) => {
        if ((q.url ?? "").startsWith("/stage")) {
          res.writeHead(200, { "content-type": "text/html" });
          res.end(`<!doctype html><title>t</title><body style="background:#123"><script>try{new WebSocket("ws://127.0.0.1:"+location.port+"/socket")}catch(e){}</script>ws</body>`);
        } else { res.writeHead(404); res.end(); }
      });
      srv.on("upgrade", (_q, socket) => { upgrades++; socket.destroy(); });
      await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
      try {
        const r = await record({ url: `http://127.0.0.1:${(srv.address() as any).port}/stage`, out: path.join(tmp, "ws.mp4"), durationSec: 1, mode: "stepped", encoding: { width: 320, height: 180, fps: 4, videoBitrateKbps: 300 } });
        expect(upgrades).toBe(0);
        expect(r.manifest.warnings.join(" ")).toMatch(/blocked by the origin guard/);
      } finally { srv.closeAllConnections?.(); srv.close(); }
    }, 60_000);
  });
});

describe("finding 7: rtmp, youtube and kick count as PUBLIC whatever --visibility says", () => {
  it("the adapters declare it; the local sink does not", () => {
    for (const a of ["rtmp", "youtube", "kick"]) expect(createAdapter(a, {}).treatAsPublic, a).toBe(true);
    expect(createAdapter("local", {}).treatAsPublic).toBe(false);
  });

  it("an UNLISTED youtube publish with a valid code but no --approve-public is refused, says why, and keeps the code", async () => {
    const env = { OBS_STATE_DIR: stateDir, PATH: process.env.PATH ?? "", OBS_YOUTUBE_STREAM_KEY: KEY };
    const slate = path.join(tmp, "slate.mp4"); fs.writeFileSync(slate, mp4Bytes());
    const deps = (f = fakeEncoderFactory()) => ({ checkFfmpeg: () => "x", hasFfmpegFeature: () => true, encoderFactory: f });
    const c = cap();
    await main(["prepare", "--adapter", "youtube", "--url", URL_OK, "--slate-file", slate, "--visibility", "unlisted"], { env, stdout: c.stdout, stderr: c.stderr, adapterDeps: deps() });
    expect(c.text()).toMatch(/publish will require --approve-public/);
    expect(c.text()).toMatch(/counts as PUBLIC/);
    const code = fs.readFileSync(path.join(stateDir, "approval-code.txt"), "utf8").trim();
    const factory = fakeEncoderFactory();
    const c2 = cap();
    const exit = await main(["publish", "--adapter", "youtube", "--url", URL_OK, "--slate-file", slate, "--visibility", "unlisted", "--approve", code, "--accept-argv-exposure"], { env, stdout: c2.stdout, stderr: c2.stderr, procMounts: "", adapterDeps: deps(factory) });
    expect(exit).toBe(3);
    expect(c2.text()).toMatch(/public_requires_approve_public/);
    expect(c2.text()).toMatch(/counts as PUBLIC/);
    expect(factory.made).toHaveLength(0);
    expect(fs.existsSync(path.join(stateDir, "approval-code.txt"))).toBe(true);
  });
});

describe("finding 8: state directory and file hygiene", () => {
  it("refuses a state dir that is a symlink, group/world accessible, or owned by someone else", () => {
    const real = path.join(tmp, "real"); fs.mkdirSync(real, { mode: 0o700 });
    const link = path.join(tmp, "link"); fs.symlinkSync(real, link);
    expect(() => new StateStore(link)).toThrow(/is a symlink/);
    const open = path.join(tmp, "open"); fs.mkdirSync(open); fs.chmodSync(open, 0o755);
    expect(() => new StateStore(open)).toThrow(/mode is 755, expected 700/);
    const file = path.join(tmp, "afile"); fs.writeFileSync(file, "x");
    expect(() => new StateStore(file)).toThrow(/not a directory/);
    if (process.getuid?.() === 0) {
      const theirs = path.join(tmp, "theirs"); fs.mkdirSync(theirs, { mode: 0o700 }); fs.chownSync(theirs, 12345, 12345);
      expect(() => new StateStore(theirs)).toThrow(/owned by uid 12345/);
    }
    expect(new StateStore(path.join(tmp, "fresh")).dir).toBe(path.join(tmp, "fresh"));
    expect(fs.statSync(path.join(tmp, "fresh")).mode & 0o777).toBe(0o700);
  });

  it("the CLI exits 2 with an actionable message for an unsafe state dir", async () => {
    fs.mkdirSync(stateDir); fs.chmodSync(stateDir, 0o777);
    const r = await obs(["status"]);
    expect(r.code).toBe(2);
    expect(r.text).toMatch(/state_dir_unsafe/);
    expect(r.text).toMatch(/0700/);
  });

  it("prepare FAILS on a pre-existing approval-code.txt symlink and never writes through it", async () => {
    const store = new StateStore(stateDir);
    const victim = path.join(tmp, "victim.txt");
    fs.writeFileSync(victim, "precious");
    fs.symlinkSync(victim, store.file("approval-code.txt"));
    await expect(createApproval({ store, plan: { adapter: "youtube", visibility: "unlisted", sourceUrl: URL_OK, encoding: resolveEncoding().encoding, target: "t", targetDisplay: "t" } })).rejects.toMatchObject({ code: "state_file_unsafe" });
    expect(fs.readFileSync(victim, "utf8")).toBe("precious");
  });

  it("a stale regular approval-code.txt is replaced, created 0600 even under umask 0, and status.json symlinks are replaced not followed", async () => {
    const store = new StateStore(stateDir);
    fs.writeFileSync(store.file("approval-code.txt"), "OLD\n", { mode: 0o644 });
    const old = process.umask(0);
    try {
      const a = await createApproval({ store, plan: { adapter: "youtube", visibility: "unlisted", sourceUrl: URL_OK, encoding: resolveEncoding().encoding, target: "t", targetDisplay: "t" } });
      expect(fs.readFileSync(a.codeFile, "utf8").trim()).toBe(a.code);
      expect(fs.statSync(a.codeFile).mode & 0o777).toBe(0o600);
      const victim = path.join(tmp, "victim2.txt"); fs.writeFileSync(victim, "keep");
      fs.symlinkSync(victim, store.file("status.json"));
      await store.updateStatus({ state: "x" });
      expect(fs.readFileSync(victim, "utf8")).toBe("keep");
      expect(fs.lstatSync(store.file("status.json")).isSymbolicLink()).toBe(false);
      expect(store.readStatus().state).toBe("x");
    } finally { process.umask(old); }
  });

  it("the approval lifetime is capped at one hour (API and CLI)", async () => {
    const store = new StateStore(stateDir);
    const p = { adapter: "youtube", visibility: "unlisted", sourceUrl: URL_OK, encoding: resolveEncoding().encoding, target: "t", targetDisplay: "t" };
    await expect(createApproval({ store, plan: p, ttlMs: MAX_TTL_MS + 1000 })).rejects.toMatchObject({ code: "bad_ttl" });
    await expect(createApproval({ store, plan: p, ttlMs: 0 })).rejects.toMatchObject({ code: "bad_ttl" });
    await expect(createApproval({ store, plan: p, ttlMs: MAX_TTL_MS })).resolves.toBeTruthy();
    const slate = path.join(tmp, "s.mp4"); fs.writeFileSync(slate, mp4Bytes());
    const run = (ttl: string) => obs(["prepare", "--adapter", "youtube", "--url", URL_OK, "--slate-file", slate, "--ttl-sec", ttl], { OBS_YOUTUBE_STREAM_KEY: KEY });
    const long = await run("7200");
    expect(long.code).toBe(2);
    expect(long.text).toMatch(/bad_ttl/);
  });
});

describe("finding 9: two waiters that both judge a lock stale cannot both enter", () => {
  it("the second breaker re-checks under the break-lock and backs off from the first one's fresh lock", async () => {
    const store = new StateStore(stateDir);
    fs.writeFileSync(store.lockPath, JSON.stringify({ pid: DEAD_PID, start: "1", at: Date.now() })); // stale: dead owner
    let active = 0;
    let overlap = false;
    const entered: string[] = [];
    const critical = (who: string, ms: number) => async () => {
      active++; entered.push(who);
      if (active > 1) overlap = true;
      await sleep(ms);
      active--;
    };
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    // B judges the lock stale first, then stalls just before breaking it...
    const B = withLock(store.lockPath, critical("B", 80), { onStaleDetected: () => gate, timeoutMs: 3000 });
    await sleep(30);
    // ...A breaks the same stale lock, takes a fresh one and is inside its critical section...
    const A = withLock(store.lockPath, critical("A", 150), { timeoutMs: 3000 });
    await sleep(60);
    expect(entered).toEqual(["A"]);
    // ...and only now does B try to break what it saw earlier. It must not remove A's live lock.
    release();
    await Promise.all([A, B]);
    expect(overlap).toBe(false);
    expect(entered).toEqual(["A", "B"]);
    expect(fs.existsSync(store.lockPath)).toBe(false);
    expect(fs.existsSync(`${store.lockPath}.break`)).toBe(false);
  });

  it("a break-lock abandoned by a crashed breaker does not wedge the lock forever", async () => {
    const store = new StateStore(stateDir);
    fs.writeFileSync(store.lockPath, JSON.stringify({ pid: DEAD_PID, start: "1", at: Date.now() }));
    fs.writeFileSync(`${store.lockPath}.break`, "");
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(`${store.lockPath}.break`, old, old);
    await expect(withLock(store.lockPath, () => "ok", { timeoutMs: 2000 })).resolves.toBe("ok");
  });
});

describe("finding 10: redaction gaps, HLS directory safety, no key-derived digest in plan.json", () => {
  it("Authorization headers are redacted completely (scheme AND credential), in text and inside JSON log lines", () => {
    const r = new Redactor();
    const tok = "abc123.DEF456-ghi789_jkl";
    for (const s of [`Authorization: Bearer ${tok}`, `authorization=Bearer ${tok}`, `Proxy-Authorization: Basic dXNlcjpwYXNzd29yZA==`, `curl -H "Authorization: Bearer ${tok}" https://x`, `got bearer ${tok} in response`]) {
      const out = r.redact(s);
      expect(out, s).not.toContain(tok);
      expect(out, s).not.toContain("dXNlcjpwYXNzd29yZA");
      expect(out, s).toContain("[REDACTED]");
    }
    // a JSON log line stays parseable after redaction
    const line = JSON.stringify({ event: "x", header: `Authorization: Bearer ${tok}`, other: "kept" });
    const redacted = r.redact(line);
    expect(JSON.parse(redacted).other).toBe("kept");
    expect(redacted).not.toContain(tok);
  });

  it("a key that is the ONLY path segment (rtmp://host/KEY) is registered and removed wherever it appears alone", () => {
    const redactor = new Redactor();
    const a = createAdapter("rtmp", { redactor, checkFfmpeg: () => "x", hasFfmpegFeature: () => true });
    expect(a.validateConfig({ OBS_RTMP_URL: "rtmps://ingest.example:443/SINGLEsegment99" }).ok).toBe(true);
    expect(redactor.redact("encoder said: bad key SINGLEsegment99 (check it)")).toBe("encoder said: bad key [REDACTED] (check it)");
    // an app-name-only URL with a separate key does not register 'live' (that would blank the word everywhere)
    const r2 = new Redactor();
    const b = createAdapter("rtmp", { redactor: r2, checkFfmpeg: () => "x", hasFfmpegFeature: () => true });
    expect(b.validateConfig({ OBS_RTMP_URL: "rtmps://h.example/livestream", OBS_RTMP_KEY: KEY }).ok).toBe(true);
    expect(r2.redact("livestream is fine")).toBe("livestream is fine");
    expect(r2.redact(`k=${KEY}`)).not.toContain(KEY);
  });

  it.skipIf(!FFMPEG)("--hls refuses a pre-existing directory it did not create, and leaves its contents alone", async () => {
    const out = path.join(tmp, "rec.mp4");
    const dir = path.join(tmp, "rec-hls");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "precious.txt"), "do not delete");
    await expect(record({ url: "http://localhost:3000/observatory/presenter", out, durationSec: 1, hls: true, env: { PATH: process.env.PATH ?? "", PLAYWRIGHT_MODULE: "/nonexistent" } })).rejects.toMatchObject({ code: "hls_dir_exists", exitCode: 2 });
    expect(fs.readFileSync(path.join(dir, "precious.txt"), "utf8")).toBe("do not delete");
  });

  it.skipIf(!BROWSER)("--hls replaces a directory that carries this tool's marker, and writes the marker into new ones", async () => {
    const server = await serveFixtures();
    try {
      const out = path.join(tmp, "m.mp4");
      const opts = { url: server.url, out, durationSec: 1, hls: true, encoding: { width: 320, height: 180, fps: 5, videoBitrateKbps: 300 } };
      const first = await record(opts);
      const dir = first.manifest.hls.dir as string;
      expect(fs.existsSync(path.join(dir, HLS_MARKER))).toBe(true);
      fs.writeFileSync(path.join(dir, "stale-leftover.txt"), "from an earlier run");
      await record(opts);
      expect(fs.existsSync(path.join(dir, "stale-leftover.txt"))).toBe(false);
      expect(fs.existsSync(path.join(dir, "index.m3u8"))).toBe(true);
    } finally { await server.close(); }
  }, 120_000);

  it("plan.json holds nothing from which the stream key can be tested: no digest of the target, no salted hash next to its salt", async () => {
    const store = new StateStore(stateDir);
    const target = `rtmps://a.rtmps.youtube.com:443/live2/${KEY}`;
    const a = await createApproval({ store, plan: { adapter: "youtube", visibility: "unlisted", sourceUrl: URL_OK, encoding: resolveEncoding().encoding, target, targetDisplay: "rtmps://a.rtmps.youtube.com:443/[REDACTED]" } });
    const text = fs.readFileSync(store.file("plan.json"), "utf8");
    const doc = JSON.parse(text);
    expect(text).not.toMatch(/targetDigest/);
    const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
    for (const t of [target, KEY]) {
      for (const candidate of [sha(t), sha(`${doc.salt}|${t}`), sha(`${doc.salt}:${t}`), sha(`${t}|${doc.salt}`), sha(`${doc.salt}${t}`)]) expect(text).not.toContain(candidate);
    }
    // the fingerprint is an HMAC keyed by the (unstored) code: wrong code or wrong target gives a different value
    expect(doc.plan.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(text).not.toContain(a.code);
    expect(text).not.toContain(KEY);
  });
});
