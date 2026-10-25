import fs from "node:fs";
import { ObsError } from "./errors.mjs";

/** @param {number} pid */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); } catch (e) { return /** @type {any} */ (e).code === "EPERM"; }
  // A zombie (exited, not yet reaped by its parent or init) still answers kill(pid, 0) but is not running.
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const state = stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3);
    if (state === "Z" || state === "X") return false;
  } catch { /* no /proc: kill(0) is the best answer available */ }
  return true;
}

/**
 * Advisory lockfile (O_EXCL). A lock whose owner is dead, or older than staleMs, is broken. Used around every
 * read-modify-write of the state directory so `obs status`, the running supervisor and `obs stop` never interleave writes.
 *
 * @template T
 * @param {string} lockPath
 * @param {() => Promise<T>|T} fn
 * @param {{ timeoutMs?: number, staleMs?: number, pollMs?: number }} [opts]
 * @returns {Promise<T>}
 */
export async function withLock(lockPath, fn, opts = {}) {
  const { timeoutMs = 5000, staleMs = 15_000, pollMs = 15 } = opts;
  const deadline = Date.now() + timeoutMs;
  let fd = null;
  for (;;) {
    try {
      fd = fs.openSync(lockPath, "wx", 0o600);
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
      break;
    } catch (e) {
      if (/** @type {any} */ (e).code !== "EEXIST") throw e;
      let stale = false;
      try {
        const st = fs.statSync(lockPath);
        let owner = 0;
        try { owner = JSON.parse(fs.readFileSync(lockPath, "utf8")).pid; } catch { /* half-written lock: judged by age */ }
        stale = Date.now() - st.mtimeMs > staleMs || (owner > 0 && !pidAlive(owner));
      } catch { continue; }
      if (stale) { try { fs.unlinkSync(lockPath); } catch { /* raced with another breaker */ } continue; }
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
