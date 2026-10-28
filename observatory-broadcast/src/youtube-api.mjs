import { ObsError } from "./errors.mjs";
import { readSecret } from "./adapters/base.mjs";
import { realClock } from "./clock.mjs";

/**
 * The YouTube verifier: the one road to state "live" for the youtube adapter.
 *
 * What it does, and no more: READ-ONLY calls to the YouTube Data API (scope youtube.readonly) that ask whether the channel has ONE
 * active broadcast, whether that broadcast is `live` (not `testing`, not `liveStarting`), whether the stream bound to it is `active`
 * with health `good` or `ok`, and what its privacy is. It never creates, transitions or edits a broadcast, never sets privacy and
 * never reads viewer counts. "Live" therefore means "YouTube itself says the broadcast is live and healthy", with the evidence.
 *
 * Fails closed: no credentials, an API error, an unreadable answer, more than one active broadcast (it cannot tell which one this
 * encoder feeds), a privacy different from the one the operator declared, or a bad stream all leave the state out of "live" and say why.
 *
 * Secrets: the OAuth client secret and refresh token come from NAME or NAME_FILE (a 0600 file) and are registered with the redactor;
 * they never appear in an error, a log line or the evidence. Requests go to two Google hosts over https only, without redirects,
 * with a timeout and a size cap.
 *
 * Quota: the default project quota is 10,000 units a day and each list call costs 1. The supervisor asks every few seconds, so the
 * result is cached (30 s; 120 s after an error): about 5,800 units a day for a stream that runs around the clock.
 */
export const YT_SCOPE = "https://www.googleapis.com/auth/youtube.readonly";
export const YT_ENV = Object.freeze({
  clientId: "OBS_YOUTUBE_OAUTH_CLIENT_ID",
  clientSecret: "OBS_YOUTUBE_OAUTH_CLIENT_SECRET",
  refreshToken: "OBS_YOUTUBE_OAUTH_REFRESH_TOKEN",
});
const ALLOWED_HOSTS = new Set(["oauth2.googleapis.com", "www.googleapis.com"]);
const MAX_BODY = 1_000_000;
const TIMEOUT_MS = 10_000;
const HEALTHY = new Set(["good", "ok"]);
const PRIVACY = new Set(["public", "unlisted", "private"]);
/** Short identifiers only: whatever Google sends back that is not one of these is reported as "unknown". */
const SAFE_REASON = /^[A-Za-z0-9_.:-]{1,60}$/;

/**
 * @param {Record<string, string | undefined>} env
 * @returns {{ configured: boolean, partial: boolean, errors: string[], clientId?: string, clientSecret?: string, refreshToken?: string }}
 */
export function readYouTubeApiConfig(env) {
  /** @type {string[]} */ const errors = [];
  const id = (env[YT_ENV.clientId] ?? "").trim();
  const secret = readSecret(env, YT_ENV.clientSecret);
  const token = readSecret(env, YT_ENV.refreshToken);
  if (secret.error) errors.push(secret.error);
  if (token.error) errors.push(token.error);
  const present = [!!id, secret.present, token.present].filter(Boolean).length;
  if (present === 0) return { configured: false, partial: false, errors };
  if (!id) errors.push(`${YT_ENV.clientId} is not set`);
  if (!secret.present) errors.push(`${YT_ENV.clientSecret} (or ${YT_ENV.clientSecret}_FILE) is not set`);
  if (!token.present) errors.push(`${YT_ENV.refreshToken} (or ${YT_ENV.refreshToken}_FILE) is not set; run \`obs youtube-auth\` once to create it`);
  const complete = !!id && !!secret.value && !!token.value && errors.length === 0;
  return { configured: complete, partial: !complete, errors, clientId: id || undefined, clientSecret: secret.value, refreshToken: token.value };
}

/**
 * One HTTPS exchange with a Google host. Never follows a redirect; caps time and size; returns parsed JSON (or null).
 * @param {typeof fetch} fetchImpl
 * @param {string} url
 * @param {{ method?: string, headers?: Record<string, string>, body?: string }} [init]
 */
async function exchange(fetchImpl, url, init = {}) {
  const u = new URL(url);
  if (u.protocol !== "https:" || !ALLOWED_HOSTS.has(u.hostname)) throw new ObsError("youtube_host_refused", `refusing to call ${u.hostname}`, { exitCode: 1 });
  let res;
  try {
    res = await fetchImpl(url, { ...init, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    throw new ObsError("youtube_api_unreachable", `could not reach ${u.hostname} (${/** @type {any} */ (e)?.name ?? "error"})`, { exitCode: 1 });
  }
  const text = await res.text();
  if (text.length > MAX_BODY) throw new ObsError("youtube_api_oversize", `${u.hostname} sent more than ${MAX_BODY} bytes`, { exitCode: 1 });
  /** @type {any} */ let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: res.status, json };
}

/** A short, public reason out of a Google error body (never the body itself). @param {any} json @param {number} status */
function reasonOf(json, status) {
  const r = json?.error?.errors?.[0]?.reason ?? (typeof json?.error === "string" ? json.error : json?.error?.status);
  return typeof r === "string" && SAFE_REASON.test(r) ? r : `http ${status}`;
}

/** Access tokens from a refresh token; cached until a minute before they expire. */
export class AccessTokens {
  /** @param {{ cfg: { clientId?: string, clientSecret?: string, refreshToken?: string }, fetch: typeof fetch, clock?: { now: () => number }, redactor?: { add: (s: string) => any } }} o */
  constructor(o) {
    this.cfg = o.cfg;
    this.fetch = o.fetch;
    this.clock = o.clock ?? realClock;
    this.redactor = o.redactor;
    /** @type {string|null} */ this.token = null;
    this.expiresAt = 0;
  }

  async get() {
    if (this.token && this.clock.now() < this.expiresAt - 60_000) return this.token;
    const body = new URLSearchParams({
      client_id: /** @type {string} */ (this.cfg.clientId), client_secret: /** @type {string} */ (this.cfg.clientSecret),
      refresh_token: /** @type {string} */ (this.cfg.refreshToken), grant_type: "refresh_token",
    }).toString();
    const { status, json } = await exchange(this.fetch, "https://oauth2.googleapis.com/token", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body,
    });
    if (status !== 200 || typeof json?.access_token !== "string") {
      throw new ObsError("youtube_auth_failed", `Google refused the OAuth refresh (${reasonOf(json, status)})`, {
        exitCode: 1, hint: "invalid_grant means the refresh token was revoked or expired: run `obs youtube-auth` again.",
      });
    }
    this.redactor?.add(json.access_token);
    this.token = json.access_token;
    this.expiresAt = this.clock.now() + (Number(json.expires_in) > 0 ? Number(json.expires_in) * 1000 : 3_000_000);
    return this.token;
  }
}

/** @param {AccessTokens} tokens @param {typeof fetch} fetchImpl @param {string} path @param {Record<string, string>} params */
async function ytGet(tokens, fetchImpl, path, params) {
  const url = `https://www.googleapis.com/youtube/v3/${path}?${new URLSearchParams(params).toString()}`;
  const { status, json } = await exchange(fetchImpl, url, { headers: { authorization: `Bearer ${await tokens.get()}`, accept: "application/json" } });
  if (status !== 200) {
    throw new ObsError("youtube_api_error", `YouTube API refused ${path} (${reasonOf(json, status)})`, {
      exitCode: 1, hint: "liveStreamingNotEnabled: enable live streaming on the channel. insufficientPermissions: run `obs youtube-auth` again (it needs the youtube.readonly scope).",
    });
  }
  return json ?? {};
}

/**
 * The decision, as a pure function of what the API returned. `ok:true` always carries evidence.
 * @param {{ broadcasts: any[], streams: any[], declaredVisibility?: string, nowIso: string }} a
 * @returns {{ ok: boolean, evidence: string }}
 */
export function evaluateLive({ broadcasts, streams, declaredVisibility, nowIso }) {
  const active = broadcasts.filter((b) => b && typeof b === "object");
  if (active.length === 0) {
    return { ok: false, evidence: "no active YouTube broadcast on this channel (the encoder may be connected, but nothing has been taken live in YouTube Studio)" };
  }
  if (active.length > 1) {
    return { ok: false, evidence: `${active.length} active broadcasts on this channel: cannot tell which one this encoder feeds, so nothing is confirmed` };
  }
  const b = active[0];
  const life = b.status?.lifeCycleStatus;
  if (life !== "live") {
    const why = life === "testing" ? "in preview (testing): viewers cannot see it yet" : life === "liveStarting" ? "still starting" : `in state "${String(life)}"`;
    return { ok: false, evidence: `the YouTube broadcast is ${why}` };
  }
  const privacy = b.status?.privacyStatus;
  if (declaredVisibility && PRIVACY.has(declaredVisibility) && privacy !== declaredVisibility) {
    return { ok: false, evidence: `the broadcast is live with privacy "${String(privacy)}" but the plan declared "${declaredVisibility}": change it in YouTube Studio (this tool cannot)` };
  }
  const sid = b.contentDetails?.boundStreamId;
  const s = streams.find((x) => x?.id === sid);
  if (!sid || !s) return { ok: false, evidence: "the live broadcast has no readable stream bound to it" };
  if (s.status?.streamStatus !== "active") return { ok: false, evidence: `the stream bound to the broadcast is "${String(s.status?.streamStatus)}", not active: YouTube is not receiving video` };
  const health = s.status?.healthStatus?.status;
  if (!HEALTHY.has(health)) {
    const issues = (s.status?.healthStatus?.configurationIssues ?? []).map((i) => i?.type).filter((t) => typeof t === "string" && SAFE_REASON.test(t)).slice(0, 3);
    return { ok: false, evidence: `stream health is "${String(health)}"${issues.length ? ` (${issues.join(", ")})` : ""}` };
  }
  return { ok: true, evidence: `YouTube broadcast ${String(b.id)} is live (privacy ${String(privacy)}), stream active, health ${health}; checked ${nowIso}` };
}

/**
 * @param {{ env?: Record<string, string | undefined>, fetch?: typeof fetch, clock?: { now: () => number }, redactor?: { add: (s: string) => any },
 *           cacheMs?: number, errorBackoffMs?: number, cfg?: ReturnType<typeof readYouTubeApiConfig> }} [o]
 * @returns {(ctx: { adapter: string, stream: { visibility?: string } | null }) => Promise<{ ok: boolean, evidence: string }>}
 */
export function createYouTubeVerifier(o = {}) {
  const clock = o.clock ?? realClock;
  const fetchImpl = o.fetch ?? fetch;
  const cfg = o.cfg ?? readYouTubeApiConfig(o.env ?? process.env);
  if (!cfg.configured) throw new ObsError("youtube_oauth_incomplete", `YouTube verification is not configured: ${cfg.errors.join("; ") || "no credentials"}`, { exitCode: 2 });
  if (cfg.clientSecret) o.redactor?.add(cfg.clientSecret);
  if (cfg.refreshToken) o.redactor?.add(cfg.refreshToken);
  const tokens = new AccessTokens({ cfg, fetch: fetchImpl, clock, redactor: o.redactor });
  const cacheMs = o.cacheMs ?? 30_000;
  const errorBackoffMs = o.errorBackoffMs ?? 120_000;
  /** @type {{ at: number, error: boolean, visibility?: string, result: { ok: boolean, evidence: string } } | null} */ let last = null;

  return async (ctx) => {
    const visibility = ctx?.stream?.visibility;
    const now = clock.now();
    if (last && last.visibility === visibility && now - last.at < (last.error ? errorBackoffMs : cacheMs)) return last.result;
    /** @type {{ ok: boolean, evidence: string }} */ let result;
    let error = false;
    try {
      const list = await ytGet(tokens, fetchImpl, "liveBroadcasts", { part: "id,status,contentDetails", broadcastStatus: "active", maxResults: "5" });
      const broadcasts = Array.isArray(list.items) ? list.items : [];
      const ids = [...new Set(broadcasts.map((b) => b?.contentDetails?.boundStreamId).filter((x) => typeof x === "string" && x.length > 0))];
      let streams = [];
      if (broadcasts.length === 1 && ids.length === 1) {
        const sl = await ytGet(tokens, fetchImpl, "liveStreams", { part: "id,status", id: ids.join(",") });
        streams = Array.isArray(sl.items) ? sl.items : [];
      }
      result = evaluateLive({ broadcasts, streams, declaredVisibility: visibility, nowIso: new Date(clock.now()).toISOString() });
    } catch (e) {
      error = true;
      result = { ok: false, evidence: `verifier error: ${/** @type {Error} */ (e).message}` };
    }
    last = { at: now, error, visibility, result };
    return result;
  };
}

/**
 * One-time OAuth "device flow" for headless machines (a Codespace): prints a URL and a short code, waits for approval in a browser,
 * and returns the refresh token. Read-only scope. The caller stores the token; it is never printed.
 * @param {{ env?: Record<string, string | undefined>, fetch?: typeof fetch, clock?: { now: () => number }, sleep?: (ms: number) => Promise<void>,
 *           say: (s: string) => void, redactor?: { add: (s: string) => any } }} o
 * @returns {Promise<string>} the refresh token
 */
export async function deviceAuthorize(o) {
  const env = o.env ?? process.env;
  const fetchImpl = o.fetch ?? fetch;
  const clock = o.clock ?? realClock;
  const sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const id = (env[YT_ENV.clientId] ?? "").trim();
  const secret = readSecret(env, YT_ENV.clientSecret);
  if (!id || !secret.value || secret.error) {
    throw new ObsError("youtube_oauth_incomplete", `set ${YT_ENV.clientId} and ${YT_ENV.clientSecret} (or ${YT_ENV.clientSecret}_FILE) first: a Google Cloud OAuth client of type "TVs and Limited Input devices"${secret.error ? ` (${secret.error})` : ""}`, { exitCode: 2 });
  }
  o.redactor?.add(secret.value);
  const form = (/** @type {Record<string, string>} */ p) => new URLSearchParams(p).toString();
  const hdr = { "content-type": "application/x-www-form-urlencoded" };
  const dc = await exchange(fetchImpl, "https://oauth2.googleapis.com/device/code", { method: "POST", headers: hdr, body: form({ client_id: id, scope: YT_SCOPE }) });
  if (dc.status !== 200 || typeof dc.json?.device_code !== "string" || typeof dc.json?.user_code !== "string") {
    throw new ObsError("youtube_auth_failed", `Google refused the device-code request (${reasonOf(dc.json, dc.status)})`, { exitCode: 1, hint: "Check the OAuth client id and that the YouTube Data API v3 is enabled for the project." });
  }
  const deviceCode = dc.json.device_code;
  o.redactor?.add(deviceCode);
  const url = typeof dc.json.verification_url === "string" && /^https:\/\/(www\.)?google\.com\//.test(dc.json.verification_url) ? dc.json.verification_url : "https://www.google.com/device";
  o.say(`Open ${url} on any device, sign in with the YouTube channel's Google account, and enter the code: ${dc.json.user_code}`);
  o.say("This grants READ-ONLY access to your YouTube account data (youtube.readonly). Waiting for approval...");
  let interval = Math.max(1, Number(dc.json.interval) || 5) * 1000;
  const deadline = clock.now() + Math.min(1800, Number(dc.json.expires_in) || 600) * 1000;
  while (clock.now() < deadline) {
    await sleep(interval);
    const t = await exchange(fetchImpl, "https://oauth2.googleapis.com/token", {
      method: "POST", headers: hdr,
      body: form({ client_id: id, client_secret: secret.value, device_code: deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code" }),
    });
    if (t.status === 200 && typeof t.json?.refresh_token === "string") { o.redactor?.add(t.json.refresh_token); return t.json.refresh_token; }
    const err = typeof t.json?.error === "string" ? t.json.error : "";
    if (err === "authorization_pending") continue;
    if (err === "slow_down") { interval += 5000; continue; }
    if (err === "access_denied") throw new ObsError("youtube_auth_denied", "the request was declined in the browser", { exitCode: 1 });
    if (err === "expired_token") break;
    throw new ObsError("youtube_auth_failed", `Google refused the token request (${reasonOf(t.json, t.status)})`, { exitCode: 1 });
  }
  throw new ObsError("youtube_auth_expired", "the code expired before it was approved: run `obs youtube-auth` again", { exitCode: 1 });
}
