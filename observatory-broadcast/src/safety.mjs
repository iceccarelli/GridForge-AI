import fs from "node:fs";
import { ObsError } from "./errors.mjs";

/**
 * URL allow-list. The tool drives a real browser at a URL and publishes what it sees, so which URLs it may open is a
 * safety property, not a convenience. Default: localhost (any port, http/https) and the presenter route of the
 * public site. Anything else, and anything on the deny list below, is refused before a browser is launched.
 *
 * Allow-list entries are strings: `http://localhost`, `https://host`, or `https://host/path/prefix`.
 * An entry without a path allows any path on that origin; with a path it allows that path and its children.
 * The deny list (admin/account/api/checkout/... and token-looking segments) applies on top of EVERY entry, so an
 * operator who widens the allow-list still cannot point the tool at an authenticated or paying surface.
 */
export const DEFAULT_ALLOW = Object.freeze([
  "http://localhost",
  "http://127.0.0.1",
  "http://[::1]",
  "https://timetopower.ai/observatory/presenter",
]);

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export const DENIED_SEGMENTS = Object.freeze([
  "admin", "account", "api", "checkout", "billing", "login", "logout", "signin", "signup", "auth", "oauth",
  "workspace", "portal", "stripe", "webhook", "webhooks", "cron", "internal",
]);

const TOKEN_QUERY_KEY = /(token|secret|password|passwd|apikey|api_key|key|signature|sig|auth|session|code|jwt|bearer)/i;

/** @param {string} seg */
function looksLikeToken(seg) {
  if (/^(sk|pk|rk|whsec|ghp|gho)_[A-Za-z0-9_-]{6,}$/i.test(seg) || /^xox[bap]-[A-Za-z0-9-]{6,}$/.test(seg) || /^eyJ[A-Za-z0-9_-]{10,}/.test(seg)) return true;
  if (/^[0-9a-f]{32,}$/i.test(seg)) return true;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return true;
  // long opaque run with mixed letters and digits (route names are words with hyphens, not 20+ char opaque runs)
  if (seg.length >= 20 && /^[A-Za-z0-9_-]+$/.test(seg) && /[0-9]/.test(seg) && /[A-Za-z]/.test(seg) && !/^[a-z]+(-[a-z0-9]+)+$/.test(seg)) return true;
  if (seg.length >= 32 && /^[A-Za-z0-9_-]+$/.test(seg) && !seg.includes("-")) return true;
  return false;
}

/**
 * @param {string} raw
 * @param {{ allow?: readonly string[] }} [opts]
 * @returns {{ ok: true, url: URL } | { ok: false, reason: string }}
 */
export function checkTargetUrl(raw, opts = {}) {
  const allow = opts.allow && opts.allow.length ? opts.allow : DEFAULT_ALLOW;
  let url;
  try { url = new URL(String(raw)); } catch { return { ok: false, reason: "not a valid absolute URL" }; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, reason: `protocol ${url.protocol} is not allowed (http/https only)` };
  if (url.username || url.password) return { ok: false, reason: "URLs with embedded credentials are refused" };
  if (/%2f|%5c|\\/i.test(url.pathname)) return { ok: false, reason: "encoded or backslash path separators are refused" };

  /** @type {string[]} */
  const segments = [];
  for (const s of url.pathname.split("/")) {
    if (!s) continue;
    let d = s;
    for (let i = 0; i < 2; i++) { try { d = decodeURIComponent(d); } catch { return { ok: false, reason: "malformed percent-encoding in path" }; } }
    if (d === ".." || d === "." || d.includes("/") || d.includes("\\")) return { ok: false, reason: "path traversal is refused" };
    segments.push(d);
  }
  for (const d of segments) {
    if (DENIED_SEGMENTS.includes(d.toLowerCase())) return { ok: false, reason: `path segment "${d}" is on the deny list (admin/account/api/checkout and similar surfaces are never opened)` };
    if (looksLikeToken(d)) return { ok: false, reason: "a path segment looks like a token or secret; such URLs are never opened" };
  }
  for (const k of url.searchParams.keys()) {
    if (TOKEN_QUERY_KEY.test(k)) return { ok: false, reason: `query parameter "${k}" looks like a credential; refused` };
  }

  const host = url.hostname.startsWith("[") ? url.hostname : url.hostname;
  for (const entry of allow) {
    let e;
    try { e = new URL(entry); } catch { continue; }
    if (e.protocol !== url.protocol) {
      // localhost may be served over either protocol
      if (!(LOCAL_HOSTS.has(e.hostname) && LOCAL_HOSTS.has(host))) continue;
    }
    if (e.hostname !== host) continue;
    if (LOCAL_HOSTS.has(e.hostname)) { if (e.port && e.port !== url.port) continue; }
    else if ((e.port || "") !== (url.port || "")) continue;
    const prefix = e.pathname.replace(/\/+$/, "");
    if (prefix && !(url.pathname === prefix || url.pathname.startsWith(prefix + "/"))) continue;
    return { ok: true, url };
  }
  return { ok: false, reason: `origin/path is not on the allow-list (${allow.join(", ")})` };
}

/** @throws {ObsError} code url_refused, exit 4 */
export function assertAllowedUrl(raw, opts = {}) {
  const r = checkTargetUrl(raw, opts);
  if (!r.ok) {
    throw new ObsError("url_refused", `target URL refused: ${r.reason}`, {
      exitCode: 4,
      hint: "Only presenter-mode URLs are broadcast: localhost, or https://timetopower.ai/observatory/presenter. Extend the allow-list with OBS_ALLOW_URLS only for hosts you control; the deny list cannot be extended away.",
    });
  }
  return r.url;
}

/** Allow-list from the environment: OBS_ALLOW_URLS (comma separated) replaces the default. */
export function allowListFromEnv(env) {
  const v = env.OBS_ALLOW_URLS;
  if (!v || !v.trim()) return [...DEFAULT_ALLOW];
  return v.split(",").map((s) => s.trim()).filter(Boolean);
}

/**
 * Whether a sub-request made by the page may proceed. Same origin as the scene, or an inline scheme. Deny-listed paths
 * (e.g. /api) are blocked even on the same origin: the scene is a presenter surface, not an application client.
 * @param {string} reqUrl
 * @param {URL} sceneUrl
 */
export function isAllowedSubrequest(reqUrl, sceneUrl) {
  if (/^(data|blob|about):/i.test(reqUrl)) return true;
  let u;
  try { u = new URL(reqUrl); } catch { return false; }
  if (u.origin !== sceneUrl.origin) return false;
  return checkTargetUrl(reqUrl, { allow: [sceneUrl.origin] }).ok;
}

/**
 * Free-space preflight.
 * @param {string} dir directory (created if missing)
 * @param {number} neededBytes
 * @param {{ statfs?: (p: string) => { bavail: number|bigint, bsize: number|bigint } }} [deps]
 */
export function checkDiskSpace(dir, neededBytes, deps = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const st = (deps.statfs ?? fs.statfsSync)(dir);
  const free = Number(st.bavail) * Number(st.bsize);
  return { ok: free >= neededBytes, freeBytes: free, neededBytes };
}

/** Rough upper bound of what a recording of this length may need, with a floor for temp frames/segments. */
export function estimateBytes(durationSec, videoBitrateKbps, { overhead = 2, floor = 64 * 1024 * 1024 } = {}) {
  return Math.max(floor, Math.ceil(((durationSec * (videoBitrateKbps + 128)) / 8) * 1000 * overhead));
}

export function assertDiskSpace(dir, neededBytes, deps = {}) {
  const r = checkDiskSpace(dir, neededBytes, deps);
  if (!r.ok) {
    throw new ObsError("disk_space", `not enough free disk space in ${dir}: ${Math.floor(r.freeBytes / 1e6)} MB free, about ${Math.ceil(neededBytes / 1e6)} MB needed`, {
      exitCode: 2,
      hint: "Free space or point --out / the state dir at a larger volume.",
    });
  }
  return r;
}
