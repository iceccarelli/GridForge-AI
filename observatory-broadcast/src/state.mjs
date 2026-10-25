import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { withLock, pidAlive } from "./lock.mjs";
import { ObsError } from "./errors.mjs";

/**
 * The state directory: status.json (what `obs status/health` read), control.json (operator -> running supervisor),
 * plan.json + approval-code.txt (the two-step publish gate), supervisor.pid, slate.mp4, and a lock.
 * Everything is written atomically (tmp + rename) under the lock; the directory is 0700 and secrets are never stored in it
 * (ingest URLs and stream keys are read from the environment / secret files at run time only).
 */
export function defaultStateDir(env = process.env) {
  if (env.OBS_STATE_DIR) return path.resolve(env.OBS_STATE_DIR);
  const base = env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
  return path.join(base, "observatory-broadcast");
}

export class StateStore {
  /** @param {string} dir */
  constructor(dir) {
    this.dir = path.resolve(dir);
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }
  /** @param {string} name */
  file(name) { return path.join(this.dir, name); }
  get lockPath() { return this.file("state.lock"); }

  /**
   * @param {string} name
   * @returns {any|null}
   */
  readJson(name) {
    try { return JSON.parse(fs.readFileSync(this.file(name), "utf8")); } catch (e) {
      if (/** @type {any} */ (e).code === "ENOENT") return null;
      return null;
    }
  }

  /** Atomic write; the caller holds the lock where read-modify-write matters. */
  writeJson(name, value, mode = 0o600) {
    const target = this.file(name);
    const tmp = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode });
    fs.renameSync(tmp, target);
  }

  /** @template T @param {() => Promise<T>|T} fn */
  locked(fn) { return withLock(this.lockPath, fn); }

  /** Merge `patch` into status.json under the lock. */
  async updateStatus(patch) {
    return this.locked(() => {
      const cur = this.readJson("status.json") ?? {};
      const next = { ...cur, ...patch };
      this.writeJson("status.json", next, 0o644);
      return next;
    });
  }

  readStatus() { return this.readJson("status.json"); }

  async setControl(patch) {
    return this.locked(() => {
      const cur = this.readJson("control.json") ?? {};
      const next = { ...cur, ...patch, updatedAt: Date.now() };
      this.writeJson("control.json", next);
      return next;
    });
  }
  readControl() { return this.readJson("control.json") ?? {}; }

  /** Claim the single supervisor slot; refuses when a live process already holds it. */
  async claimSupervisor() {
    return this.locked(() => {
      const cur = this.readJson("supervisor.json");
      if (cur && pidAlive(cur.pid) && cur.pid !== process.pid) {
        throw new ObsError("already_running", `a broadcast is already running (pid ${cur.pid})`, { hint: "Run `obs stop` first, or `obs status` to inspect it." });
      }
      this.writeJson("supervisor.json", { pid: process.pid, startedAt: Date.now() });
    });
  }
  async releaseSupervisor() {
    return this.locked(() => {
      const cur = this.readJson("supervisor.json");
      if (cur && cur.pid === process.pid) { try { fs.unlinkSync(this.file("supervisor.json")); } catch { /* gone */ } }
    });
  }
  /** Remember the encoder pids this supervisor owns, so a later run can reap them if the supervisor was SIGKILLed. */
  recordChildren(/** @type {number[]} */ pids) {
    this.writeJson("children.json", { supervisor: process.pid, pids, at: Date.now() });
  }

  /**
   * Kill encoder processes left behind by a supervisor that died without cleaning up. A pid is only killed when the
   * recorded supervisor is gone AND the process command line still carries this tool's run marker (so a recycled pid is never hit).
   * @returns {number[]} pids killed
   */
  reapOrphans() {
    const rec = this.readJson("children.json");
    if (!rec || !Array.isArray(rec.pids) || rec.supervisor === process.pid || pidAlive(rec.supervisor)) return [];
    /** @type {number[]} */ const killed = [];
    for (const pid of rec.pids) {
      try {
        const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
        if (!cmd.includes("observatory-broadcast run")) continue;
        process.kill(pid, "SIGKILL");
        killed.push(pid);
      } catch { /* already gone, or no /proc on this platform */ }
    }
    try { fs.unlinkSync(this.file("children.json")); } catch { /* none */ }
    return killed;
  }

  /** pid of the running supervisor, or null (a stale pid file is ignored). */
  supervisorPid() {
    const cur = this.readJson("supervisor.json");
    return cur && pidAlive(cur.pid) ? /** @type {number} */ (cur.pid) : null;
  }
}
