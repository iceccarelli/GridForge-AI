/**
 * What child processes (Chromium, ffmpeg) get to see of this tool's environment: a short allow-list, not a copy.
 * The stream key / ingest URL variables (OBS_*_KEY, OBS_*_URL, *_FILE), cloud credentials and everything else stay in this
 * process only. ffmpeg's output URL is still on its argv (see README); this keeps the rest of the secrets out of /proc/<pid>/environ.
 */
const EXACT = new Set(["PATH", "HOME", "USER", "LOGNAME", "LANG", "LANGUAGE", "TZ", "TMPDIR", "DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "XDG_RUNTIME_DIR", "FONTCONFIG_PATH", "FONTCONFIG_FILE"]);
const PREFIX = ["LC_", "PLAYWRIGHT_"];

/** @param {Record<string, string | undefined>} env @returns {Record<string, string>} */
export function minimalEnv(env = process.env) {
  /** @type {Record<string, string>} */ const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (/^(OBS_|.*_KEY$|.*_TOKEN$|.*_SECRET$|.*_PASSWORD$)/.test(k) || k.endsWith("_FILE")) continue;
    if (EXACT.has(k) || PREFIX.some((p) => k.startsWith(p))) out[k] = v;
  }
  return out;
}
