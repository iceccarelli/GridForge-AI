import fs from "node:fs";

/**
 * Process identity. A pid alone proves nothing: pids are recycled, so "alive" and "kill" must be decided on identity.
 * Identity here = the process START TIME from /proc/<pid>/stat (clock ticks since boot, recorded when we claimed the
 * process) AND the command-line marker the tool puts on every ffmpeg it starts ("observatory-broadcast run <runId> ").
 * Without /proc (not Linux) identity cannot be established and nothing is ever killed on the strength of a pid.
 */

/** @param {number} pid @returns {{ state: string, startTime: string }|null} */
export function readStat(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" "); // fields from 3 (state) onward
    const state = rest[0];
    const startTime = rest[19]; // field 22
    if (!state || !startTime) return null;
    return { state, startTime };
  } catch { return null; }
}

/** Start time of a pid as a string, or null when unreadable. */
export function procStartTime(pid) { return readStat(pid)?.startTime ?? null; }

/** @param {number} pid @returns {string|null} NUL-separated cmdline joined with single spaces */
export function procCmdline(pid) {
  try { return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" "); } catch { return null; }
}

/**
 * Is a process with this pid running (not a zombie)? EPERM means it exists but belongs to someone else: alive.
 * @param {number} pid
 */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); } catch (e) { return /** @type {any} */ (e).code === "EPERM"; }
  const st = readStat(pid);
  if (st && (st.state === "Z" || st.state === "X")) return false;
  return true;
}

/**
 * Is `pid` still THE process we recorded? Requires it to be running with the same start time; when a marker is given the
 * command line must also contain it. A recycled pid fails the start-time check.
 * @param {number} pid
 * @param {{ startTime?: string|null, marker?: string|null }} id
 * @returns {{ same: boolean, reason: string }}
 */
export function sameProcess(pid, id) {
  if (!pidAlive(pid)) return { same: false, reason: "not running" };
  if (!id.startTime) return { same: false, reason: "no recorded start time (identity unknown)" };
  const now = procStartTime(pid);
  if (now === null) return { same: false, reason: "cannot read /proc: identity cannot be established" };
  if (now !== id.startTime) return { same: false, reason: "pid was recycled (start time differs)" };
  if (id.marker) {
    const cmd = procCmdline(pid);
    if (cmd === null || !cmd.includes(id.marker)) return { same: false, reason: "command line does not carry this run's marker" };
  }
  return { same: true, reason: "identity confirmed" };
}

/** The exact marker the encoder puts on its ffmpeg command line for a run (trailing space matters: exact run id). */
export const runMarker = (/** @type {string} */ runId) => `observatory-broadcast run ${runId} `;

/**
 * Does the /proc mount hide other users' processes (hidepid=1/2/invisible/noaccess)? Takes the text of /proc/mounts.
 * Note: this never protects against the SAME user, which can always read its own processes' argv.
 * @param {string} mountsText
 */
export function procHidesOtherUsers(mountsText) {
  for (const line of String(mountsText).split("\n")) {
    const f = line.split(" ");
    if (f[1] !== "/proc" || f[2] !== "proc") continue;
    const m = /(?:^|,)hidepid=([^,]+)/.exec(f[3] ?? "");
    if (!m) continue;
    return ["1", "2", "invisible", "noaccess", "4", "ptraceable"].includes(m[1]);
  }
  return false;
}
