import fs from "node:fs";
import { ObsError } from "./errors.mjs";
import { pidAlive, procStartTime } from "./proc.mjs";

export { pidAlive };

/**
 * Advisory lockfile (O_EXCL). A lock whose owner is dead (or whose pid was recycled by another process), or that is older
 * than staleMs, is stale and may be broken. Used around every read-modify-write of the state directory so `obs status`,
 * the running supervisor and `obs stop` never interleave writes.
 *
 * BREAKING A STALE LOCK IS ITSELF GUARDED. Two waiters that both judge the same lock stale must not both break it: the
 * second would unlink the FIRST waiter's brand-new lock and both would enter. So breaking needs the break-lock
 * (`<lock>.break`, also O_EXCL), and the stale verdict is RE-TAKEN while holding it: a waiter whose "stale" lock was
 * already replaced finds a fresh, live lock, and backs off.
 *
 * @param {string} lockPath
 * @param {{ staleMs: number }} o
 * @returns {boolean}
 */
function lockIsStale(lockPath, { staleMs }) {
  let st;
  try { st = fs.statSync(lockPath); } catch { return false; } // gone: not stale, just free
  let owner = null;
  try { owner = JSON.parse(fs.readFileSync(lockPath, "utf8")); } catch { /* half-written lock: judged by age */ }
  if (Date.now() - st.mtimeMs > staleMs) return true;
  if (owner && owner.pid > 0) {
    if (!pidAlive(owner.pid)) return true;
    // the pid is alive, but is it the process that took the lock? (recycled pid)
    if (owner.start && procStartTime(owner.pid) !== null && procStartTime(owner.pid) !== owner.start) return true;
  }
  return false;
}

/**
 * @template T
 * @param {string} lockPath
 * @param {() => Promise<T>|T} fn
 * @param {{ timeoutMs?: number, staleMs?: number, pollMs?: number, onStaleDetected?: () => Promise<void>|void }} [opts]
 *   onStaleDetected is a test seam called between "judged stale" and "tried to break it".
 * @returns {Promise<T>}
 */
export async function withLock(lockPath, fn, opts = {}) {
  const { timeoutMs = 5000, staleMs = 15_000, pollMs = 15 } = opts;
  const deadline = Date.now() + timeoutMs;
  let fd = null;
  for (;;) {
    try {
      fd = fs.openSync(lockPath, "wx", 0o600);
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, start: procStartTime(process.pid), at: Date.now() }));
      break;
    } catch (e) {
      if (/** @type {any} */ (e).code !== "EEXIST") throw e;
      if (lockIsStale(lockPath, { staleMs })) {
        await opts.onStaleDetected?.();
        await breakStale(lockPath, staleMs);
        continue;
      }
      if (Date.now() > deadline) throw new ObsError("lock_timeout", `could not acquire ${lockPath} within ${timeoutMs} ms`, { hint: "Another obs command holds the state lock; retry, or remove a stale lock file if no obs process is running." });
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }
  try {
    return await fn();
  } finally {
    try { fs.closeSync(fd); } catch { /* already closed */ }
    try { fs.unlinkSync(lockPath); } catch { /* already broken */ }
  }
}

/** Break a stale lock under the break-lock, re-checking staleness while holding it. */
async function breakStale(lockPath, staleMs) {
  const breakPath = `${lockPath}.break`;
  let bfd;
  try {
    bfd = fs.openSync(breakPath, "wx", 0o600);
  } catch (e) {
    if (/** @type {any} */ (e).code !== "EEXIST") throw e;
    // someone else is breaking right now; a break-lock abandoned by a crashed breaker is itself removed once old
    try { if (Date.now() - fs.statSync(breakPath).mtimeMs > 5000) fs.unlinkSync(breakPath); } catch { /* raced */ }
    await new Promise((r) => setTimeout(r, 10));
    return;
  }
  try {
    if (lockIsStale(lockPath, { staleMs })) {
      try { fs.unlinkSync(lockPath); } catch { /* released meanwhile */ }
    }
  } finally {
    try { fs.closeSync(bfd); } catch { /* closed */ }
    try { fs.unlinkSync(breakPath); } catch { /* gone */ }
  }
}
