import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { main } from "../../observatory-broadcast/src/cli.mjs";
import { StateStore } from "../../observatory-broadcast/src/state.mjs";
import { FakeClock } from "../../observatory-broadcast/src/clock.mjs";
import { DEFAULT_TTL_MS, MAX_ATTEMPTS, consumeApproval, createApproval, generateCode, normalizeCode } from "../../observatory-broadcast/src/approval.mjs";
import { withLock } from "../../observatory-broadcast/src/lock.mjs";
import { fakeEncoderFactory } from "../../observatory-broadcast/testing/fakes.mjs";
import { resolveEncoding } from "../../observatory-broadcast/src/ffmpeg.mjs";
import { procStartTime } from "../../observatory-broadcast/src/proc.mjs";

// Publishing is a two-step control: `prepare` writes a plan and a short-lived single-use code to a local file;
// `publish --approve <code>` is required, and PUBLIC additionally needs --approve-public. Nothing starts before the gate opens.

const KEY = "APPROVALkey-1111-2222-3333";
const URL_OK = "http://localhost:3000/observatory/presenter";
let tmp: string;
let stateDir: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "obs-appr-test-")); stateDir = path.join(tmp, "state"); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const encoding = resolveEncoding().encoding;
const plan = (over: Record<string, unknown> = {}) => ({ adapter: "youtube", visibility: "unlisted", sourceUrl: URL_OK, encoding, target: `rtmps://h/${KEY}`, targetDisplay: "rtmps://h/[REDACTED]", ...over });
const request = (over: Record<string, unknown> = {}) => ({ adapter: "youtube", visibility: "unlisted", sourceUrl: URL_OK, encoding, target: `rtmps://h/${KEY}`, ...over });
const refusal = async (p: Promise<unknown>) => p.then(() => null, (e: any) => e);

describe("observatory-broadcast: approval gate (unit)", () => {
  it("codes are 8 characters from an unambiguous alphabet, shown as XXXX-XXXX, and compared case/dash-insensitively", () => {
    for (let i = 0; i < 50; i++) expect(generateCode()).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    expect(normalizeCode(" ab-cd ef ")).toBe("ABCDEF");
  });

  it("prepare stores only a salted hash of the code in the plan, and the code file is 0600", async () => {
    const store = new StateStore(stateDir);
    const a = await createApproval({ store, plan: plan() });
    const doc = fs.readFileSync(store.file("plan.json"), "utf8");
    expect(doc).not.toContain(a.code);
    expect(doc).not.toContain(KEY);
    expect(doc).toContain("rtmps://h/[REDACTED]");
    expect(fs.readFileSync(a.codeFile, "utf8").trim()).toBe(a.code);
    expect(fs.statSync(a.codeFile).mode & 0o777).toBe(0o600);
    expect(JSON.parse(doc).expiresAtMs - Date.parse(JSON.parse(doc).createdAt)).toBe(DEFAULT_TTL_MS);
  });

  it("rejects an unknown visibility at prepare", async () => {
    const store = new StateStore(stateDir);
    const e = await refusal(createApproval({ store, plan: plan({ visibility: "world" }) }));
    expect(e.code).toBe("bad_visibility");
  });

  it("no code -> approval_required (exit 3), even when a plan exists", async () => {
    const store = new StateStore(stateDir);
    await createApproval({ store, plan: plan() });
    for (const code of [undefined, null, "", "  - "]) {
      const e = await refusal(consumeApproval({ store, code: code as any, request: request() }));
      expect(e.code).toBe("approval_required");
      expect(e.exitCode).toBe(3);
    }
  });

  it("no plan at all -> no_plan", async () => {
    const e = await refusal(consumeApproval({ store: new StateStore(stateDir), code: "ABCD-EFGH", request: request() }));
    expect(e.code).toBe("no_plan");
  });

  it("a correct code works exactly once; the code file is removed; reuse -> approval_used", async () => {
    const store = new StateStore(stateDir);
    const a = await createApproval({ store, plan: plan() });
    const ok = await consumeApproval({ store, code: a.code.toLowerCase().replace("-", ""), request: request() });
    expect(ok.id).toBe(a.id);
    expect(fs.existsSync(a.codeFile)).toBe(false);
    const e = await refusal(consumeApproval({ store, code: a.code, request: request() }));
    expect(e.code).toBe("approval_used");
  });

  it("a wrong code is refused, counted, and the plan locks after the attempt budget (even for the right code)", async () => {
    const store = new StateStore(stateDir);
    const a = await createApproval({ store, plan: plan() });
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      const e = await refusal(consumeApproval({ store, code: "WRONG-CODE", request: request() }));
      expect(e.code).toBe("wrong_code");
      expect(e.message).toContain(`${MAX_ATTEMPTS - i - 1} attempts left`);
    }
    const locked = await refusal(consumeApproval({ store, code: a.code, request: request() }));
    expect(locked.code).toBe("approval_locked");
  });

  it("an expired code is refused (fake clock), and a fresh prepare replaces it", async () => {
    const clock = new FakeClock();
    const store = new StateStore(stateDir);
    const a = await createApproval({ store, plan: plan(), clock, ttlMs: 60_000 });
    await clock.advance(59_000);
    // still valid one second before expiry: verify without consuming by checking a wrong code is reported as wrong, not expired
    expect((await refusal(consumeApproval({ store, code: "AAAA-BBBB", request: request(), clock }))).code).toBe("wrong_code");
    await clock.advance(2_000);
    const e = await refusal(consumeApproval({ store, code: a.code, request: request(), clock }));
    expect(e.code).toBe("approval_expired");
    expect(e.exitCode).toBe(3);
    const b = await createApproval({ store, plan: plan(), clock });
    expect((await consumeApproval({ store, code: b.code, request: request(), clock })).id).toBe(b.id);
  });

  it("public visibility without --approve-public is refused BEFORE the code is checked or consumed", async () => {
    const store = new StateStore(stateDir);
    const a = await createApproval({ store, plan: plan({ visibility: "public" }) });
    const e = await refusal(consumeApproval({ store, code: a.code, approvePublic: false, request: request({ visibility: "public" }) }));
    expect(e.code).toBe("public_requires_approve_public");
    expect(e.exitCode).toBe(3);
    expect(fs.existsSync(a.codeFile)).toBe(true); // not consumed
    // --approve-public alone is not enough either
    const e2 = await refusal(consumeApproval({ store, code: undefined, approvePublic: true, request: request({ visibility: "public" }) }));
    expect(e2.code).toBe("approval_required");
    // both together work
    const ok = await consumeApproval({ store, code: a.code, approvePublic: true, request: request({ visibility: "public" }) });
    expect(ok.plan.visibility).toBe("public");
  });

  it("the code is bound to the plan: changing visibility, scene URL, adapter, encoding or ingest target is a mismatch and does not consume it", async () => {
    const store = new StateStore(stateDir);
    const a = await createApproval({ store, plan: plan() });
    const variants: Record<string, unknown>[] = [
      { visibility: "private" },
      { sourceUrl: "http://localhost:3000/observatory/presenter?other=1" },
      { adapter: "kick" },
      { encoding: { ...encoding, fps: 30 } },
      { target: "rtmps://h/ANOTHER-KEY-9999" },
    ];
    for (const v of variants) {
      const e = await refusal(consumeApproval({ store, code: a.code, request: request(v) }));
      expect(e.code, JSON.stringify(v)).toBe("plan_mismatch");
    }
    expect((await consumeApproval({ store, code: a.code, request: request() })).id).toBe(a.id);
  });
});

describe("observatory-broadcast: lockfile", () => {
  it("serialises concurrent read-modify-write so no update is lost", async () => {
    const store = new StateStore(stateDir);
    await Promise.all(Array.from({ length: 25 }, (_, i) => store.updateStatus({ [`k${i}`]: i, counter: i })));
    const st = store.readStatus();
    for (let i = 0; i < 25; i++) expect(st[`k${i}`]).toBe(i);
    expect(fs.existsSync(store.lockPath)).toBe(false);
  });

  it("breaks a lock whose owner is dead, and times out on a live holder", async () => {
    const store = new StateStore(stateDir);
    fs.writeFileSync(store.lockPath, JSON.stringify({ pid: 2 ** 22 + 12345, at: Date.now() })); // no such pid
    await expect(store.updateStatus({ a: 1 })).resolves.toMatchObject({ a: 1 });
    fs.writeFileSync(store.lockPath, JSON.stringify({ pid: process.pid, at: Date.now() }));
    await expect(withLock(store.lockPath, () => 1, { timeoutMs: 120, pollMs: 10 })).rejects.toMatchObject({ code: "lock_timeout" });
    fs.unlinkSync(store.lockPath);
  });

  it("claimSupervisor refuses a second live supervisor but accepts after the first is gone", async () => {
    const store = new StateStore(stateDir);
    fs.writeFileSync(store.file("supervisor.json"), JSON.stringify({ pid: 1, startTime: procStartTime(1), startedAt: 0 })); // pid 1 is alive and not us
    await expect(store.claimSupervisor()).rejects.toMatchObject({ code: "already_running" });
    fs.writeFileSync(store.file("supervisor.json"), JSON.stringify({ pid: 2 ** 22 + 999, startedAt: 0 }));
    await expect(store.claimSupervisor()).resolves.toBeUndefined();
    expect(store.supervisorPid()).toBe(process.pid);
    await store.releaseSupervisor();
    expect(store.supervisorPid()).toBeNull();
  });
});

describe("observatory-broadcast: publish through the CLI is gated", () => {
  // a minimal ISO-BMFF header ('ftyp'): all the fake encoders need, and all the MP4 sanity check looks at
  const slate = () => { const f = path.join(tmp, "slate.mp4"); fs.writeFileSync(f, Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypisom"), Buffer.alloc(16)])); return f; };
  const baseEnv = (extra: Record<string, string> = {}) => ({ OBS_STATE_DIR: stateDir, PATH: process.env.PATH ?? "", OBS_YOUTUBE_STREAM_KEY: KEY, ...extra });
  const cap = () => { const l: string[] = []; return { l, stdout: (s: string) => l.push(s), stderr: (s: string) => l.push(s), text: () => l.join("") }; };

  async function prepare(extra: string[] = [], env = baseEnv()) {
    const c = cap();
    const code = await main(["prepare", "--adapter", "youtube", "--url", URL_OK, "--slate-file", slate(), ...extra], { env, stdout: c.stdout, stderr: c.stderr, adapterDeps: { checkFfmpeg: () => "x", hasFfmpegFeature: () => true } });
    expect(code).toBe(0);
    return fs.readFileSync(path.join(stateDir, "approval-code.txt"), "utf8").trim();
  }
  // YouTube/Kick/RTMP count as PUBLIC and put the key on ffmpeg's argv, so a normal publish carries both acknowledgements;
  // `bare` leaves them off (tests of the gates themselves).
  async function publish(argv: string[], env = baseEnv(), opts: { run?: boolean; bare?: boolean; procMounts?: string } = {}) {
    const c = cap();
    const factory = fakeEncoderFactory();
    const ctl = new AbortController();
    const done = main(["publish", "--adapter", "youtube", "--url", URL_OK, "--slate-file", slate(), ...(opts.bare ? [] : ["--approve-public", "--accept-argv-exposure"]), ...argv], {
      env, stdout: c.stdout, stderr: c.stderr, signal: ctl.signal, installSignalHandlers: false, sceneProbe: () => true, health: { checkIntervalMs: 20 }, procMounts: opts.procMounts ?? "",
      adapterDeps: { checkFfmpeg: () => "x", hasFfmpegFeature: () => true, encoderFactory: factory },
    });
    if (opts.run) {
      for (let i = 0; i < 100 && factory.made.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
      ctl.abort();
    }
    return { code: await done, text: c.text(), factory };
  }

  it("publish without a code exits 3 and starts nothing", async () => {
    await prepare();
    const r = await publish([]);
    expect(r.code).toBe(3);
    expect(r.text).toMatch(/approval_required/);
    expect(r.factory.made).toHaveLength(0);
  });

  it("publish with a wrong code exits 3 and starts nothing", async () => {
    await prepare();
    const r = await publish(["--approve", "AAAA-AAAA"]);
    expect(r.code).toBe(3);
    expect(r.text).toMatch(/wrong_code/);
    expect(r.factory.made).toHaveLength(0);
  });

  it("publish with the right code starts the encoder, never prints the key, and the status is never 'live' for YouTube", async () => {
    const code = await prepare();
    const r = await publish(["--approve", code], baseEnv(), { run: true });
    expect(r.code).toBe(0);
    expect(r.factory.made.length).toBeGreaterThan(0);
    expect(r.factory.made[0].mode).toBe("scene");
    expect(r.text).toMatch(/live status cannot be verified for youtube in this build/);
    expect(r.text).not.toContain(KEY);
    const status = JSON.parse(fs.readFileSync(path.join(stateDir, "status.json"), "utf8"));
    expect(status.state).toBe("stopped");
    expect(status.verified).toBe(false);
    expect(JSON.stringify(status)).not.toContain(KEY);
    for (const t of status.transitions) expect(t.to).not.toBe("live");
  });

  it("the code cannot be replayed for a second publish", async () => {
    const code = await prepare();
    expect((await publish(["--approve", code], baseEnv(), { run: true })).code).toBe(0);
    const again = await publish(["--approve", code]);
    expect(again.code).toBe(3);
    expect(again.text).toMatch(/approval_used/);
  });

  it("an expired code is refused through the CLI (fake clock)", async () => {
    const clock = new FakeClock();
    const c = cap();
    await main(["prepare", "--adapter", "youtube", "--url", URL_OK, "--slate-file", slate(), "--ttl-sec", "30"], { env: baseEnv(), stdout: c.stdout, stderr: c.stderr, clock, adapterDeps: { checkFfmpeg: () => "x", hasFfmpegFeature: () => true } });
    const code = fs.readFileSync(path.join(stateDir, "approval-code.txt"), "utf8").trim();
    await clock.advance(31_000);
    const c2 = cap();
    const exit = await main(["publish", "--adapter", "youtube", "--url", URL_OK, "--approve", code, "--slate-file", slate(), "--approve-public", "--accept-argv-exposure"], {
      env: baseEnv(), stdout: c2.stdout, stderr: c2.stderr, clock, adapterDeps: { checkFfmpeg: () => "x", hasFfmpegFeature: () => true, encoderFactory: fakeEncoderFactory() },
    });
    expect(exit).toBe(3);
    expect(c2.text()).toMatch(/approval_expired/);
  });

  it("public needs --approve-public AND the code; privacy defaults to unlisted", async () => {
    // default plan is unlisted
    const c = cap();
    await main(["prepare", "--adapter", "youtube", "--url", URL_OK, "--json"], { env: baseEnv(), stdout: c.stdout, stderr: c.stderr, adapterDeps: { checkFfmpeg: () => "x", hasFfmpegFeature: () => true } });
    expect(JSON.parse(c.text()).plan.visibility).toBe("unlisted");

    const code = await prepare(["--visibility", "public"]);
    const noFlag = await publish(["--approve", code, "--visibility", "public", "--accept-argv-exposure"], baseEnv(), { bare: true });
    expect(noFlag.code).toBe(3);
    expect(noFlag.text).toMatch(/public_requires_approve_public/);
    expect(noFlag.factory.made).toHaveLength(0);
    const flagOnly = await publish(["--approve-public", "--visibility", "public"]);
    expect(flagOnly.code).toBe(3);
    expect(flagOnly.text).toMatch(/approval_required/);
    const both = await publish(["--approve", code, "--visibility", "public"], baseEnv(), { run: true });
    expect(both.code).toBe(0);
    expect(both.factory.made.length).toBeGreaterThan(0);
  });

  it("changing anything after prepare (visibility, key) is a plan mismatch", async () => {
    const code = await prepare();
    const r = await publish(["--approve", code, "--visibility", "private"]);
    expect(r.code).toBe(3);
    expect(r.text).toMatch(/plan_mismatch/);
    const code2 = await prepare();
    const r2 = await publish(["--approve", code2], baseEnv({ OBS_YOUTUBE_STREAM_KEY: "a-different-key-0000-1111" }));
    expect(r2.code).toBe(3);
    expect(r2.text).toMatch(/plan_mismatch/);
  });

  it("refuses a bad visibility value and a non-allow-listed scene URL before anything else", async () => {
    const r = await publish(["--visibility", "everyone", "--approve", "AAAA-BBBB"]);
    expect(r.code).toBe(2);
    expect(r.text).toMatch(/bad_visibility/);
    const c = cap();
    const exit = await main(["publish", "--adapter", "youtube", "--url", "https://example.com/observatory/presenter", "--approve", "AAAA-BBBB"], { env: baseEnv(), stdout: c.stdout, stderr: c.stderr });
    expect(exit).toBe(4);
    expect(c.text()).toMatch(/url_refused/);
  });

  it("the local sink needs no code (nothing leaves the machine) unless public is requested", async () => {
    const c = cap();
    const factory = fakeEncoderFactory();
    const ctl = new AbortController();
    const env = { OBS_STATE_DIR: stateDir, OBS_LOCAL_SINK_DIR: path.join(tmp, "sink"), PATH: process.env.PATH ?? "" };
    const run = main(["publish", "--adapter", "local", "--url", URL_OK, "--slate-file", slate()], {
      env, stdout: c.stdout, stderr: c.stderr, signal: ctl.signal, installSignalHandlers: false, sceneProbe: () => true, health: { checkIntervalMs: 20 },
      adapterDeps: { checkFfmpeg: () => "x", hasFfmpegFeature: () => true, encoderFactory: factory },
    });
    for (let i = 0; i < 100 && factory.made.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    ctl.abort();
    expect(await run).toBe(0);
    expect(factory.made.length).toBeGreaterThan(0);

    const c2 = cap();
    const pub = await main(["publish", "--adapter", "local", "--url", URL_OK, "--visibility", "public", "--slate-file", slate()], { env, stdout: c2.stdout, stderr: c2.stderr, adapterDeps: { checkFfmpeg: () => "x", hasFfmpegFeature: () => true, encoderFactory: factory } });
    expect(pub).toBe(3);
  });
});
