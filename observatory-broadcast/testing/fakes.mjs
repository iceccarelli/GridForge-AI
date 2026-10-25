import { EventEmitter } from "node:events";

/**
 * Test doubles for the supervisor and adapters: a fake encoder the test can drive (progress, crash, stall) and a factory
 * that records every encoder the adapter asked for. Nothing here spawns a process or touches the network.
 */
let nextPid = 40_000;

export class FakeEncoder extends EventEmitter {
  /** @param {any} spec @param {{ failStart?: boolean, startError?: string }} [behaviour] */
  constructor(spec, behaviour = {}) {
    super();
    this.spec = spec;
    this.mode = spec.mode;
    this.pid = nextPid++;
    this.behaviour = behaviour;
    this.started = false;
    this.stopped = false;
    this.frame = 0;
  }
  async start() {
    if (this.behaviour.failStart) throw new Error(this.behaviour.startError ?? "encoder failed to start");
    this.started = true;
  }
  /** One ffmpeg progress block. `frames` new frames (0 = heartbeat without a new frame). */
  progress({ frames = 15, bitrateKbps = 1500 } = {}) {
    if (this.stopped) return;
    this.frame += frames;
    this.emit("progress", { frame: this.frame, totalSize: null, bitrateKbps, outTimeMs: this.frame * 40, speed: 1, ended: false });
  }
  log(line) { this.emit("log", { line }); }
  crash(code = 1, error) { if (this.stopped) return; this.emit("exit", { code, signal: null, expected: false, tail: [], error }); }
  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.emit("exit", { code: 0, signal: null, expected: true, tail: [] });
  }
}

/** Factory recording every encoder. `failNextStarts` makes the next N starts throw. */
export function fakeEncoderFactory() {
  /** @type {FakeEncoder[]} */ const made = [];
  const factory = Object.assign((/** @type {any} */ spec) => {
    const failStart = factory.failNextStarts > 0;
    if (failStart) factory.failNextStarts -= 1;
    const e = new FakeEncoder(spec, { failStart });
    made.push(e);
    return e;
  }, {
    made,
    failNextStarts: 0,
    byMode(/** @type {string} */ m) { return made.filter((e) => e.mode === m); },
  });
  Object.defineProperty(factory, "current", { get: () => made.filter((e) => e.started && !e.stopped).at(-1) ?? null });
  return /** @type {typeof factory & { current: FakeEncoder|null }} */ (factory);
}
