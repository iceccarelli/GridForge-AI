import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { withLock } from "./lock.mjs";
import { ObsError } from "./errors.mjs";
import { pidAlive, procStartTime, runMarker, sameProcess } from "./proc.mjs";

/**
 * The state directory: status.json (what `obs status/health` read), control.json (operator -> running supervisor),
 * plan.json + approval-code.txt (the two-step publish gate), supervisor.json, children.json, slate files, and a lock.
 *
 * Hygiene: the directory must be a real directory (not a symlink) owned by the current user with mode 0700, or the tool
 * refuses to use it. Files are written through O_EXCL temp files + rename (a pre-existing symlink is never followed), the
 * approval code through O_EXCL|O_NOFOLLOW, all 0600. Secrets (ingest URLs, stream keys) are never stored here.
 */
export function defaultStateDir(env = process.env) {
  if (env.OBS_STATE_DIR) return path.resolve(env.OBS_STATE_DIR);
  const base = env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
  return path.join(base, "observatory-broadcast");
}

/** @param {string} dir */
function ensureSafeDir(dir) {
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  let st = null;
  try { st = fs.lstatSync(dir); } catch (e) { if (/** @type {any} */ (e).code !== "ENOENT") throw e; }
  if (!st) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    st = fs.lstatSync(dir);
  }
  /** @param {string} why */
  const refuse = (why) => new ObsError("state_dir_unsafe", `state directory ${dir} is unsafe: ${why}`, { exitCode: 2, hint: "Use a directory you own with mode 0700 (OBS_STATE_DIR / --state-dir), not a symlink." });
  if (st.isSymbolicLink()) throw refuse("it is a symlink");
  if (!st.isDirectory()) throw refuse("it is not a directory");
  if (uid !== null && st.uid !== uid) throw refuse(`it is owned by uid ${st.uid}, not ${uid}`);
  if ((st.mode & 0o777) !== 0o700) throw refuse(`its mode is ${(st.mode & 0o777).toString(8)}, expected 700`);
}

export class StateStore {
  /** @param {string} dir */
  constructor(dir) {
    this.dir = path.resolve(dir);
    ensureSafeDir(this.dir);
  }
  /** @param {string} name */
  file(name) { return path.join(this.dir, name); }
  get lockPath() { return this.file("state.lock"); }

  /**
   * @param {string} name
   * @returns {any|null}
   */
  readJson(name) {
    try { return JSON.parse(fs.readFileSync(this.file(name), "utf8")); } catch { return null; }
  }

  /** Atomic write via an O_EXCL temp file (never follows a planted symlink) and rename. */
  writeJson(name, value, mode = 0o600) {
    const target = this.file(name);
    const tmp = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), mode);
    try {
      fs.writeSync(fd, JSON.stringify(value, null, 2) + "\n");
      fs.fchmodSync(fd, mode);
    } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, target);
  }

  /**
   * Write a secret-bearing file (the approval code): replace a regular file, FAIL on a symlink, create with
   * O_EXCL|O_NOFOLLOW and mode 0600.
   */
  writeSecretFile(name, text) {
    const target = this.file(name);
    let st = null;
    try { st = fs.lstatSync(target); } catch { /* absent */ }
    if (st) {
      if (!st.isFile()) throw new ObsError("state_file_unsafe", `${target} exists and is not a regular file (symlink?); refusing to write a secret through it`, { exitCode: 2, hint: "Remove it and re-run." });
      fs.unlinkSync(target);
    }
    const fd = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
    try { fs.writeSync(fd, text); fs.fchmodSync(fd, 0o600); } finally { fs.closeSync(fd); }
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

  /** Claim the single supervisor slot; refuses when the recorded supervisor is genuinely still running. */
  async claimSupervisor() {
    return this.locked(() => {
      const cur = this.readJson("supervisor.json");
      if (cur && cur.pid !== process.pid && sameProcess(cur.pid, { startTime: cur.startTime ?? null }).same) {
        throw new ObsError("already_running", `a broadcast is already running (pid ${cur.pid})`, { hint: "Run `obs stop` first, or `obs status` to inspect it." });
      }
      this.writeJson("supervisor.json", { pid: process.pid, startTime: procStartTime(process.pid), startedAt: Date.now() });
    });
  }
  async releaseSupervisor() {
    return this.locked(() => {
      const cur = this.readJson("supervisor.json");
      if (cur && cur.pid === process.pid) { try { fs.unlinkSync(this.file("supervisor.json")); } catch { /* gone */ } }
    });
  }

  /**
   * pid of the running supervisor, or null. A pid file left by a dead supervisor is ignored, and so is one whose pid has
   * been recycled by an unrelated process (start time differs).
   */
  supervisorPid() {
    const cur = this.readJson("supervisor.json");
    if (!cur) return null;
    if (cur.pid === process.pid) return cur.pid;
    return sameProcess(cur.pid, { startTime: cur.startTime ?? null }).same ? /** @type {number} */ (cur.pid) : null;
  }

  /**
   * Remember the encoder processes this supervisor owns (pid + start time + run id), so a later command can find and reap
   * them if the supervisor was SIGKILLed.
   * @param {{ pid: number, mode?: string }[]} kids
   * @param {string} runId
   */
  recordChildren(kids, runId) {
    this.writeJson("children.json", {
      supervisor: { pid: process.pid, startTime: procStartTime(process.pid) },
      runId,
      children: kids.map((k) => ({ pid: k.pid, mode: k.mode ?? null, startTime: procStartTime(k.pid) })),
      at: Date.now(),
    });
  }

  /**
   * Find (and kill) encoder processes left behind by a supervisor that died without cleaning up. Reported, never silent.
   * A pid is killed ONLY when (a) the recorded supervisor is gone, (b) the process still has the start time recorded for
   * it, and (c) its command line carries the exact marker of the recorded run id. A recycled pid fails (b); a foreign
   * process fails (c). EPERM and other kill errors are reported, not thrown.
   * @returns {{ pid: number, runId: string|null, action: "killed"|"left"|"gone", reason: string }[]}
   */
  reapOrphans() {
    const rec = this.readJson("children.json");
    if (!rec || !Array.isArray(rec.children)) return [];
    const sup = rec.supervisor;
    if (sup && sup.pid === process.pid) return [];
    if (sup && sameProcess(sup.pid, { startTime: sup.startTime ?? null }).same) return []; // its owner is alive: not orphans
    /** @type {{ pid: number, runId: string|null, action: "killed"|"left"|"gone", reason: string }[]} */
    const report = [];
    let allHandled = true;
    for (const c of rec.children) {
      const id = sameProcess(c.pid, { startTime: c.startTime ?? null, marker: runMarker(String(rec.runId)) });
      if (!pidAlive(c.pid)) { report.push({ pid: c.pid, runId: rec.runId, action: "gone", reason: "already exited" }); continue; }
      if (!id.same) { report.push({ pid: c.pid, runId: rec.runId, action: "left", reason: `not killed: ${id.reason}` }); continue; }
      try {
        process.kill(c.pid, "SIGKILL");
        report.push({ pid: c.pid, runId: rec.runId, action: "killed", reason: "orphaned encoder of a supervisor that is no longer running" });
      } catch (e) {
        allHandled = false;
        report.push({ pid: c.pid, runId: rec.runId, action: "left", reason: `could not be killed: ${/** @type {any} */ (e).code ?? "error"}` });
      }
    }
    if (allHandled) { try { fs.unlinkSync(this.file("children.json")); } catch { /* none */ } }
    return report;
  }
}
