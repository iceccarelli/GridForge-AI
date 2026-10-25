import { describe, expect, it } from "vitest";
import { FakeClock } from "../../observatory-broadcast/src/clock.mjs";
import { Supervisor, DEFAULT_HEALTH } from "../../observatory-broadcast/src/supervisor.mjs";
import { backoffDelay, backoffSchedule, resolveBackoff, DEFAULT_BACKOFF } from "../../observatory-broadcast/src/backoff.mjs";
import { createAdapter } from "../../observatory-broadcast/src/adapters/index.mjs";
import { Redactor, createLogger } from "../../observatory-broadcast/src/redact.mjs";
import { resolveEncoding } from "../../observatory-broadcast/src/ffmpeg.mjs";
import { fakeEncoderFactory } from "../../observatory-broadcast/testing/fakes.mjs";

// The supervisor runs on an injected clock with fake encoders, so reconnect backoff, stall detection, slate fallback and
// recovery are asserted exactly (to the millisecond) without sleeping and without a single real process.

const KEY = "SUPERVISORkey-aaaa-bbbb-cccc";
const encoding = resolveEncoding({ width: 640, height: 360, fps: 15 }).encoding;
const HEALTH = { checkIntervalMs: 1000, stallTimeoutMs: 10_000, minBitrateKbps: 100, lowBitrateWindowMs: 5000, stableMs: 20_000, verifyIntervalMs: 2000, sceneProbeIntervalMs: 2000, sceneFailThreshold: 2, recoveryProbeIntervalMs: 3000, recoveryHealthyProbes: 2, recoveryRetries: 1 };
const BACKOFF = { baseMs: 1000, factor: 2, maxMs: 30_000, jitter: 0.25, maxAttempts: 3 };

type Opts = {
  verifier?: (ctx: any) => any; backoff?: Partial<typeof BACKOFF>; health?: Partial<typeof HEALTH>; adapter?: "youtube" | "local";
  sceneProbe?: () => boolean | Promise<boolean>; rand?: () => number; control?: { forceSlate?: boolean };
};

async function rig(o: Opts = {}) {
  const clock = new FakeClock();
  const factory = fakeEncoderFactory();
  const redactor = new Redactor([KEY]);
  const logLines: string[] = [];
  const logger = createLogger({ redactor, write: (l) => logLines.push(l), now: () => clock.now(), level: "debug" });
  const adapter = createAdapter("youtube", { clock, redactor, logger, encoderFactory: factory, verifier: o.verifier, checkFfmpeg: () => "fake", hasFfmpegFeature: () => true });
  adapter.validateConfig({ OBS_YOUTUBE_STREAM_KEY: KEY });
  await adapter.preflight();
  const probe = { ok: true };
  const control = o.control ?? {};
  const statuses: any[] = [];
  const sup = new Supervisor({
    adapter, clock, logger,
    health: { ...HEALTH, ...o.health },
    backoff: { ...BACKOFF, ...o.backoff },
    rand: o.rand ?? (() => 0.5),
    sceneProbe: o.sceneProbe ?? (() => probe.ok),
    pollControl: () => control,
    onStatus: (s) => statuses.push(s),
    streamFor: (mode) => ({ mode, runId: "r1", encoding, source: mode === "slate" ? { kind: "file", file: "/slate.mp4" } : { kind: "scene", url: "http://localhost/observatory/presenter", viewport: { width: 640, height: 360 } } }),
  });
  /** Let `seconds` of fake time pass; each second the current encoder (if any) reports `progress`. */
  async function run(seconds: number, progress: false | { frames?: number; bitrateKbps?: number } = {}) {
    for (let i = 0; i < seconds; i++) {
      if (progress !== false) factory.current?.progress(progress);
      await clock.advance(1000);
    }
  }
  const states = () => sup.snapshot().transitions.map((t: any) => t.to);
  return { clock, factory, adapter, sup, probe, control, run, states, logLines, statuses, redactor };
}

describe("observatory-broadcast: backoff", () => {
  it("is bounded exponential: base * factor^(n-1), capped at maxMs", () => {
    expect(backoffSchedule({ baseMs: 2000, factor: 2, maxMs: 60_000, jitter: 0.25, maxAttempts: 7 })).toEqual([2000, 4000, 8000, 16000, 32000, 60000, 60000]);
    expect(backoffSchedule({ ...BACKOFF, maxAttempts: 4 })).toEqual([1000, 2000, 4000, 8000]);
    expect(backoffSchedule({ baseMs: 500, factor: 3, maxMs: 10_000, jitter: 0, maxAttempts: 5 })).toEqual([500, 1500, 4500, 10000, 10000]);
  });

  it("jitter spreads the delay by +/- jitter around the base and never exceeds the cap", () => {
    const cfg = { baseMs: 1000, factor: 2, maxMs: 5000, jitter: 0.25, maxAttempts: 5 };
    expect(backoffDelay(1, cfg, () => 0)).toBe(750);
    expect(backoffDelay(1, cfg, () => 0.5)).toBe(1000);
    expect(backoffDelay(1, cfg, () => 1)).toBe(1250);
    expect(backoffDelay(3, cfg, () => 1)).toBe(5000); // 4000 * 1.25 = 5000 (cap)
    expect(backoffDelay(10, cfg, () => 1)).toBe(5000); // capped, even with jitter
    expect(backoffDelay(10, cfg, () => 0)).toBe(3750);
    for (let a = 1; a <= 12; a++) for (const r of [0, 0.3, 0.99]) expect(backoffDelay(a, cfg, () => r)).toBeLessThanOrEqual(5000);
  });

  it("validates its configuration", () => {
    expect(resolveBackoff({}).maxAttempts).toBe(DEFAULT_BACKOFF.maxAttempts);
    expect(() => resolveBackoff({ baseMs: 0 })).toThrow(/baseMs/);
    expect(() => resolveBackoff({ jitter: 2 })).toThrow(/jitter/);
    expect(() => resolveBackoff({ maxAttempts: -1 })).toThrow(/maxAttempts/);
  });
});

describe("observatory-broadcast: supervisor state machine", () => {
  it("starts the scene encoder and reports 'starting' - not 'live' - while nothing has verified it", async () => {
    const r = await rig();
    await r.sup.start();
    expect(r.factory.made).toHaveLength(1);
    expect(r.factory.made[0].mode).toBe("scene");
    expect(r.sup.snapshot()).toMatchObject({ state: "starting", verified: false, phase: "scene" });
    await r.run(30);
    expect(r.sup.snapshot()).toMatchObject({ state: "starting", verified: false });
    expect(r.states()).not.toContain("live");
    await r.sup.stop();
  });

  it("reconnects on an encoder crash with the exact backoff schedule (rand fixed), then falls back to the slate when the budget is spent", async () => {
    const r = await rig();
    await r.sup.start();
    const startedAt = r.clock.now();
    const launchTimes: number[] = [];
    // crash each encoder immediately after it starts; record when each relaunch happens
    let seen = 0;
    for (let i = 0; i < 20_000 && r.sup.snapshot().phase === "scene"; i += 100) {
      if (r.factory.made.length > seen) { seen = r.factory.made.length; launchTimes.push(r.clock.now()); r.factory.made[seen - 1].crash(1); }
      await r.clock.advance(100);
    }
    // attempts 1..3 retry after 1000, 2000, 4000 ms; the 4th failure exhausts the budget (maxAttempts 3) and switches to the slate
    expect(r.factory.byMode("scene")).toHaveLength(4);
    expect(launchTimes.map((t) => t - startedAt)).toEqual([0, 1000, 3000, 7000]);
    expect(r.sup.snapshot()).toMatchObject({ state: "fallback_slate", phase: "slate" });
    expect(r.factory.byMode("slate")).toHaveLength(1);
    expect(r.states()).toEqual(["starting", "reconnecting", "starting", "reconnecting", "starting", "reconnecting", "starting", "fallback_slate"]);
    await r.sup.stop();
  });

  it("reports 'reconnecting' with the attempt, delay and next retry time while it waits", async () => {
    const r = await rig();
    await r.sup.start();
    r.factory.current!.crash(137, "killed");
    await r.clock.advance(10);
    const s = r.sup.snapshot();
    expect(s.state).toBe("reconnecting");
    expect(s.attempts).toBe(1);
    expect(s.detail).toMatch(/encoder_exit: attempt 1\/3 in 1000 ms/);
    expect(Date.parse(s.nextRetryAt!) - r.clock.now()).toBe(990);
    expect(s.encoder).toBeNull();
    await r.sup.stop();
  });

  it("detects a stalled encoder: heartbeats that report no new frame trip the timeout exactly when it elapses", async () => {
    const r = await rig();
    await r.sup.start();
    await r.run(3, { frames: 15 });
    const lastAdvance = r.clock.now();
    // now ffmpeg keeps sending progress blocks but the frame counter is frozen
    let tripped = 0;
    for (let s = 1; s <= 20 && !tripped; s++) {
      r.factory.current?.progress({ frames: 0 });
      await r.clock.advance(1000);
      if (r.sup.snapshot().state === "reconnecting") tripped = r.clock.now() - lastAdvance;
    }
    // the last advance happened one second before `lastAdvance`'s tick; the stall fires at the first tick strictly past the timeout
    expect(tripped).toBeGreaterThanOrEqual(HEALTH.stallTimeoutMs);
    expect(tripped).toBeLessThanOrEqual(HEALTH.stallTimeoutMs + 2000);
    expect(r.sup.snapshot().detail).toMatch(/^stall: attempt 1\/3/);
    expect(r.factory.made[0].stopped).toBe(true); // the stalled encoder (and with it the scene) is torn down
    await r.sup.stop();
  });

  it("detects total silence (no progress at all) as a stall too, and a healthy encoder never trips it", async () => {
    const quiet = await rig();
    await quiet.sup.start();
    await quiet.run(12, false);
    expect(quiet.sup.snapshot().transitions.find((t: any) => t.to === "reconnecting")?.detail).toMatch(/^stall: attempt 1\/3/);
    await quiet.sup.stop();
    const healthy = await rig();
    await healthy.sup.start();
    await healthy.run(120, { frames: 15 });
    expect(healthy.states()).toEqual(["starting"]);
    await healthy.sup.stop();
  });

  it("enforces the bitrate floor only when it is sustained, and a dip that recovers is forgiven", async () => {
    const dip = await rig();
    await dip.sup.start();
    await dip.run(3, { bitrateKbps: 50 }); // 3 s < 5 s window
    await dip.run(5, { bitrateKbps: 1500 });
    await dip.run(3, { bitrateKbps: 50 });
    expect(dip.states()).toEqual(["starting"]);
    await dip.sup.stop();

    const sustained = await rig();
    await sustained.sup.start();
    await sustained.run(7, { bitrateKbps: 50 });
    expect(sustained.sup.snapshot().transitions.find((t: any) => t.to === "reconnecting")?.detail).toMatch(/^low_bitrate: attempt 1\/3/);
    await sustained.sup.stop();

    // unknown bitrate (null) is not "low"
    const unknown = await rig();
    await unknown.sup.start();
    await unknown.run(30, { bitrateKbps: undefined as any });
    expect(unknown.states()).toEqual(["starting"]);
    await unknown.sup.stop();
  });

  it("a failed start counts as a failure too and is retried on the same schedule", async () => {
    const r = await rig();
    r.factory.failNextStarts = 2;
    await r.sup.start();
    expect(r.sup.snapshot().state).toBe("reconnecting");
    await r.clock.advance(1000);
    expect(r.sup.snapshot().state).toBe("reconnecting"); // second start also fails
    await r.clock.advance(2000);
    expect(r.sup.snapshot().state).toBe("starting");
    expect(r.factory.made).toHaveLength(3);
    await r.sup.stop();
  });

  it("an unhealthy scene switches to the slate at once, even though the encoder itself looks fine", async () => {
    const r = await rig();
    await r.sup.start();
    await r.run(5, { frames: 15 });
    r.probe.ok = false;
    await r.run(6, { frames: 15 });
    expect(r.sup.snapshot()).toMatchObject({ state: "fallback_slate", phase: "slate" });
    expect(r.sup.snapshot().detail).toMatch(/scene unhealthy/);
    expect(r.factory.made[0].stopped).toBe(true);
    expect(r.factory.current?.mode).toBe("slate");
    expect(r.factory.made.filter((e) => e.mode === "scene")).toHaveLength(1); // no pointless reconnect cycle first
    await r.sup.stop();
  });

  it("recovers from the slate back to the scene after consecutive healthy probes, and not before", async () => {
    const r = await rig();
    await r.sup.start();
    r.probe.ok = false;
    await r.run(6, { frames: 15 });
    expect(r.sup.snapshot().state).toBe("fallback_slate");
    const sceneStarts = () => r.factory.byMode("scene").length;
    // probes stay bad: stay on the slate
    await r.run(10, { frames: 15 });
    expect(r.sup.snapshot().state).toBe("fallback_slate");
    expect(sceneStarts()).toBe(1);
    // scene returns; need recoveryHealthyProbes (2) consecutive good probes spaced recoveryProbeIntervalMs (3 s) apart
    r.probe.ok = true;
    await r.run(4, { frames: 15 });
    expect(r.sup.snapshot().state).toBe("fallback_slate"); // only one good probe so far
    await r.run(4, { frames: 15 });
    expect(r.sup.snapshot().phase).toBe("scene");
    expect(sceneStarts()).toBe(2);
    expect(r.factory.byMode("slate")[0].stopped).toBe(true);
    expect(r.states().slice(-2)).toEqual(["fallback_slate", "starting"]);
    await r.sup.stop();
  });

  it("a flapping probe never reaches the required consecutive count, so the stream does not bounce", async () => {
    const r = await rig();
    await r.sup.start();
    r.probe.ok = false;
    await r.run(6, { frames: 15 });
    expect(r.sup.snapshot().state).toBe("fallback_slate");
    for (let i = 0; i < 12; i++) { r.probe.ok = i % 2 === 0; await r.run(3, { frames: 15 }); }
    expect(r.factory.byMode("scene")).toHaveLength(1);
    expect(r.sup.snapshot().phase).toBe("slate");
    await r.sup.stop();
  });

  it("after a recovery the scene gets only one retry before falling back again; a stable scene earns the full budget back", async () => {
    const r = await rig();
    await r.sup.start();
    r.probe.ok = false;
    await r.run(6, { frames: 15 });
    r.probe.ok = true;
    await r.run(8, { frames: 15 });
    expect(r.sup.snapshot().phase).toBe("scene");
    expect(r.sup.snapshot().budget).toBe(1);
    // the recovered scene's encoder crashes twice in a row: one retry, then the slate again
    r.factory.current!.crash(1);
    await r.clock.advance(1100);
    expect(r.sup.snapshot().state).toBe("starting");
    r.factory.current!.crash(1);
    await r.clock.advance(100);
    expect(r.sup.snapshot()).toMatchObject({ state: "fallback_slate", phase: "slate" });

    // second recovery, this time the scene stays healthy for stableMs: budget restored
    await r.run(8, { frames: 15 });
    expect(r.sup.snapshot().phase).toBe("scene");
    await r.run(25, { frames: 15 });
    expect(r.sup.snapshot()).toMatchObject({ budget: BACKOFF.maxAttempts, attempts: 0 });
    await r.sup.stop();
  });

  it("stops (output_failed) when even the slate cannot be kept running", async () => {
    const r = await rig();
    await r.sup.start();
    r.probe.ok = false;
    await r.run(6, { frames: 15 });
    expect(r.sup.snapshot().phase).toBe("slate");
    for (let i = 0; i < 40 && !r.sup.stopped; i++) {
      r.factory.current?.crash(1);
      await r.clock.advance(1000);
    }
    expect(r.sup.stopped).toBe(true);
    expect(r.sup.snapshot()).toMatchObject({ state: "stopped", stopReason: "output_failed" });
    expect(r.clock.pending).toBe(0);
  });

  it("operator slate control: cut to the slate, hold it even when the scene is healthy, release to recover", async () => {
    const r = await rig();
    await r.sup.start();
    await r.run(4, { frames: 15 });
    r.control.forceSlate = true;
    await r.run(2, { frames: 15 });
    expect(r.sup.snapshot()).toMatchObject({ state: "fallback_slate", forcedSlate: true });
    expect(r.sup.snapshot().detail).toMatch(/operator/);
    await r.run(30, { frames: 15 });
    expect(r.sup.snapshot().phase).toBe("slate"); // held although the probe says the scene is fine
    r.control.forceSlate = false;
    await r.run(10, { frames: 15 });
    expect(r.sup.snapshot()).toMatchObject({ phase: "scene", forcedSlate: false });
    await r.sup.stop();
  });

  it("stop() stops the encoder, ends in 'stopped', and leaves no timers behind", async () => {
    const r = await rig();
    await r.sup.start();
    await r.run(3, { frames: 15 });
    const enc = r.factory.current!;
    await r.sup.stop("test");
    expect(enc.stopped).toBe(true);
    expect(r.sup.snapshot()).toMatchObject({ state: "stopped", encoder: null });
    expect(r.clock.pending).toBe(0);
    await r.sup.stop("again"); // idempotent
    expect(r.clock.pending).toBe(0);
    // stopping during a reconnect wait also cancels the retry
    const r2 = await rig();
    await r2.sup.start();
    r2.factory.current!.crash(1);
    await r2.clock.advance(10);
    expect(r2.clock.pending).toBeGreaterThan(0);
    await r2.sup.stop();
    expect(r2.clock.pending).toBe(0);
    await r2.clock.advance(10_000);
    expect(r2.factory.made).toHaveLength(1);
  });

  it("an exit that the supervisor itself requested is never mistaken for a failure", async () => {
    const r = await rig();
    await r.sup.start();
    r.probe.ok = false;
    await r.run(6, { frames: 15 });
    // the scene encoder was stopped on purpose during the switch: only one 'reconnecting' cycle would indicate a bug
    expect(r.states()).not.toContain("reconnecting");
    await r.sup.stop();
  });

  it("transitions are logged with from/to, and no log line, status or transition contains the stream key", async () => {
    const r = await rig();
    await r.sup.start();
    r.factory.current!.log(`Failed to connect rtmps://a.rtmps.youtube.com:443/live2/${KEY}`);
    r.factory.current!.crash(1, `write error to rtmps://a/b/${KEY}`);
    await r.run(8, { frames: 15 });
    const logged = r.logLines.map((l) => JSON.parse(l));
    expect(logged.filter((l) => l.event === "transition").map((l) => `${l.from}->${l.to}`)).toContain("starting->reconnecting");
    expect(logged.some((l) => l.event === "encoder_log")).toBe(true);
    const everything = r.logLines.join("\n") + JSON.stringify(r.statuses) + JSON.stringify(r.sup.snapshot());
    expect(everything).not.toContain(KEY);
    await r.sup.stop();
  });

  it("publishes a snapshot on every tick (the heartbeat `obs health` relies on)", async () => {
    const r = await rig();
    await r.sup.start();
    const before = r.statuses.length;
    await r.run(5, { frames: 15 });
    expect(r.statuses.length - before).toBeGreaterThanOrEqual(5);
    const beats = r.statuses.slice(-5).map((s) => s.heartbeatAt);
    expect(new Set(beats).size).toBe(5);
    expect(r.statuses.at(-1).encoder).toMatchObject({ mode: "scene" });
    await r.sup.stop();
  });
});

describe("observatory-broadcast: 'live' only on verification", () => {
  it("without a verifier (YouTube in this build) the status never says live, across any amount of healthy running", async () => {
    const r = await rig();
    await r.sup.start();
    await r.run(120, { frames: 15 });
    const s = r.sup.snapshot();
    expect(s.state).not.toBe("live");
    expect(s.verified).toBe(false);
    expect(s.message).toBe("live status cannot be verified for youtube in this build; an encoder that is running is not proof that viewers can see it");
    expect(r.states()).not.toContain("live");
    expect(JSON.stringify(r.statuses)).not.toMatch(/"state":"live"/);
    await r.sup.stop();
  });

  it("with a fake verifier that confirms the ingest, the supervisor reaches 'live' (verified, with evidence)", async () => {
    let calls = 0;
    const r = await rig({ verifier: () => { calls++; return { ok: true, evidence: "fake platform says: ingest active" }; } });
    await r.sup.start();
    await r.run(5, { frames: 15 });
    expect(r.sup.snapshot()).toMatchObject({ state: "live", verified: true, evidence: "fake platform says: ingest active" });
    expect(calls).toBeGreaterThan(0);
    expect(r.states()).toEqual(["starting", "live"]);
    await r.sup.stop();
  });

  it("verification that is withdrawn takes the state back out of 'live'", async () => {
    const v = { ok: true };
    const r = await rig({ verifier: () => (v.ok ? { ok: true, evidence: "ok" } : { ok: false, evidence: "platform reports no ingest" }) });
    await r.sup.start();
    await r.run(5, { frames: 15 });
    expect(r.sup.snapshot().state).toBe("live");
    v.ok = false;
    await r.run(4, { frames: 15 });
    expect(r.sup.snapshot()).toMatchObject({ state: "starting", verified: false });
    expect(r.states()).toEqual(["starting", "live", "starting"]);
    await r.sup.stop();
  });

  it("the verifier is only consulted while the scene is the active source, and 'live' is dropped on the slate", async () => {
    const calls: string[] = [];
    const r = await rig({ verifier: (ctx) => { calls.push(ctx.stream.mode); return { ok: true, evidence: "ok" }; } });
    await r.sup.start();
    await r.run(5, { frames: 15 });
    expect(r.sup.snapshot().state).toBe("live");
    r.probe.ok = false;
    await r.run(6, { frames: 15 });
    expect(r.sup.snapshot()).toMatchObject({ state: "fallback_slate", verified: false });
    const callsAtSwitch = calls.length;
    await r.run(10, { frames: 15 });
    expect(calls.length).toBe(callsAtSwitch); // not asked while on the slate
    expect(calls.every((m) => m === "scene")).toBe(true);
    await r.sup.stop();
  });

  it("a reconnect clears verification: 'live' has to be earned again by the new encoder", async () => {
    const r = await rig({ verifier: () => ({ ok: true, evidence: "ok" }) });
    await r.sup.start();
    await r.run(5, { frames: 15 });
    expect(r.sup.snapshot().state).toBe("live");
    r.factory.current!.crash(1);
    await r.clock.advance(10);
    expect(r.sup.snapshot()).toMatchObject({ state: "reconnecting", verified: false, evidence: null });
    await r.run(6, { frames: 15 });
    expect(r.sup.snapshot().state).toBe("live");
    await r.sup.stop();
  });

  it("a throwing verifier is treated as 'not verified' and the supervisor carries on", async () => {
    const r = await rig({ verifier: () => { throw new Error(`down ${KEY}`); } });
    await r.sup.start();
    await r.run(10, { frames: 15 });
    expect(r.sup.snapshot().state).toBe("starting");
    expect(JSON.stringify(r.sup.snapshot())).not.toContain(KEY);
    await r.sup.stop();
  });
});

describe("observatory-broadcast: defaults are sane", () => {
  it("stall timeout is well above the check interval and the bitrate window is longer than a dip", () => {
    expect(DEFAULT_HEALTH.stallTimeoutMs).toBeGreaterThanOrEqual(DEFAULT_HEALTH.checkIntervalMs * 5);
    expect(DEFAULT_HEALTH.lowBitrateWindowMs).toBeGreaterThan(DEFAULT_HEALTH.checkIntervalMs * 5);
    expect(DEFAULT_HEALTH.recoveryHealthyProbes).toBeGreaterThanOrEqual(2);
    expect(DEFAULT_BACKOFF.maxAttempts).toBeGreaterThan(1);
  });
});
