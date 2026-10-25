import { BaseAdapter, readSecret } from "./base.mjs";

/**
 * RTMP(S) output stage. The ingest URL and stream key are read ONLY from the environment (or *_FILE secret files) at
 * run time: never from argv, never from the repo, never logged. Every string this adapter produces for humans uses
 * `display` (scheme://host:port/[REDACTED]); the real URL exists only inside the ffmpeg argument vector.
 *
 * NOTE on argv: ffmpeg takes its output URL as an argument, so the ingest URL is visible to the same OS user in the
 * process table while ffmpeg runs. Run the broadcaster under a dedicated user or container. (This is an ffmpeg limit.)
 */

/** @param {string} raw @returns {{ ok: true, scheme: "rtmp"|"rtmps", host: string, port: string, path: string } | { ok: false, error: string }} */
export function parseIngestUrl(raw) {
  if (/\s/.test(raw)) return { ok: false, error: "contains whitespace" };
  let u;
  try { u = new URL(raw); } catch { return { ok: false, error: "is not a valid URL" }; }
  if (u.protocol !== "rtmp:" && u.protocol !== "rtmps:") return { ok: false, error: "must start with rtmp:// or rtmps://" };
  if (!u.hostname) return { ok: false, error: "has no host" };
  if (u.username || u.password) return { ok: false, error: "must not embed user:password" };
  return { ok: true, scheme: /** @type {"rtmp"|"rtmps"} */ (u.protocol.slice(0, -1)), host: u.hostname, port: u.port, path: u.pathname };
}

export const ARGV_EXPOSURE_NOTE = "the stream key is passed to ffmpeg on its command line (an ffmpeg limit): any process of the same OS user, and of other users unless /proc is mounted with hidepid>=1, can read it from the process table while the stream runs; run the broadcaster as a dedicated user or container";
export const VISIBILITY_NOTE = "this tool cannot set or verify the platform-side visibility of the stream, so publishing counts as PUBLIC and needs --approve-public whatever --visibility says";

/** `rtmps://host:443/[REDACTED]` */
export function displayIngest(scheme, host, port, hasPath = true) {
  return `${scheme}://${host}${port ? ":" + port : ""}${hasPath ? "/[REDACTED]" : ""}`;
}

const MIN_KEY = 8;

export class RtmpAdapter extends BaseAdapter {
  /**
   * @param {import("./base.mjs").AdapterDeps} deps
   * @param {{ name?: string, urlVar?: string, keyVar?: string, keyRequired?: boolean, defaultUrl?: string|null, label?: string, notes?: string[] }} [cfg]
   */
  constructor(deps = {}, cfg = {}) {
    super(cfg.name ?? "rtmp", deps);
    this.cfg = { urlVar: "OBS_RTMP_URL", keyVar: "OBS_RTMP_KEY", keyRequired: false, defaultUrl: null, label: "RTMP(S)", notes: [], ...cfg };
    /** @type {{ url: string, display: string, host: string, scheme: string } | null} */ this.target = null;
    /** ffmpeg takes the ingest URL (which carries the stream key) as a command-line argument: publish needs an explicit acknowledgement. */
    this.keyOnArgv = true;
    /** This tool cannot set or verify the platform-side visibility, so the stream counts as PUBLIC for approval purposes. */
    this.treatAsPublic = true;
  }

  requiredMuxer() { return "flv"; }
  requiredProtocols() { return this.target?.scheme === "rtmps" ? ["rtmps"] : ["rtmp"]; }
  platformNotes() { return [ARGV_EXPOSURE_NOTE, VISIBILITY_NOTE, ...this.cfg.notes]; }

  validateConfig(/** @type {Record<string, string | undefined>} */ env) {
    /** @type {string[]} */ const errors = [];
    /** @type {string[]} */ const warnings = [];
    const { urlVar, keyVar, keyRequired, defaultUrl } = this.cfg;
    this.configured = false;
    this.target = null;

    const u = readSecret(env, urlVar);
    const k = readSecret(env, keyVar);
    if (u.error) errors.push(u.error);
    if (k.error) errors.push(k.error);
    // Whatever was read is registered before anything can be formatted, so no later message can leak it.
    if (u.value) this.redactor.add(u.value);
    if (k.value) this.redactor.add(k.value);

    let base = u.value ?? null;
    let usedDefault = false;
    if (!u.present && defaultUrl) { base = defaultUrl; usedDefault = true; }
    if (!u.present && !defaultUrl) errors.push(`${urlVar} is not set (set ${urlVar}, or ${urlVar}_FILE pointing at a 0600 file, to the ingest URL; the CLI never accepts it as an argument)`);
    if (!k.present && keyRequired) errors.push(`${keyVar} is not set (set ${keyVar}, or ${keyVar}_FILE pointing at a 0600 file)`);
    if (k.value !== undefined && (k.value.length < MIN_KEY || /\s/.test(k.value))) errors.push(`${keyVar} looks malformed (shorter than ${MIN_KEY} characters or contains whitespace)`);

    let parsed = null;
    if (base) {
      const p = parseIngestUrl(base);
      if (!p.ok) errors.push(`${usedDefault ? "the default ingest URL" : urlVar} ${p.error}`);
      else {
        parsed = p;
        if (p.scheme === "rtmp" && !["localhost", "127.0.0.1", "[::1]"].includes(p.host)) warnings.push("plain rtmp:// sends the stream key unencrypted; prefer rtmps:// where the platform offers it");
        if (!k.value && (p.path === "/" || p.path === "")) warnings.push(`the ingest URL has no path and no ${keyVar} is set; most platforms need a stream key`);
      }
    }
    // The URL itself may carry the key in its path (generic RTMP): treat the path as secret too.
    // With no separate key variable the LAST path segment of the URL is the key, even when it is the only segment
    // (rtmp://host/KEY): register it as its own redaction value, so it is removed wherever it appears on its own.
    if (parsed && !usedDefault && !k.value) {
      const segs = parsed.path.split("/").filter(Boolean);
      const last = segs[segs.length - 1];
      if (last && last.length >= 8) this.redactor.add(last); // shorter segments look like app names ("live"); the URL pattern still masks them in URLs
    }

    if (errors.length || !parsed || !base) {
      this._set("not_configured", errors.length ? "configuration invalid" : "not configured");
      return { ok: false, errors, warnings, summary: { adapter: this.name, configured: false } };
    }
    const full = k.value ? `${base.replace(/\/+$/, "")}/${k.value}` : base;
    const display = displayIngest(parsed.scheme, parsed.host, parsed.port, !!(k.value || parsed.path.length > 1));
    this.target = { url: full, display, host: parsed.host, scheme: parsed.scheme };
    this.redactor.add(full);
    this.configured = true;
    this._set("configured_unverified", "configured; not verified (the platform has not been contacted)");
    return {
      ok: true, errors, warnings,
      summary: { adapter: this.name, ingest: display, secretSource: { url: u.source ?? (usedDefault ? "default" : null), key: k.source ?? null } },
    };
  }

  /** The secret-bearing target string, used only to fingerprint the approval plan (as a salted hash). */
  planTarget() { return this.target?.url ?? null; }
  planDisplay() { return this.target?.display ?? "(unconfigured)"; }

  outputSpec(/** @type {import("./base.mjs").StreamSpec} */ _stream) {
    if (!this.target) throw new Error("not configured");
    return { args: ["-f", "flv", "-flvflags", "no_duration_filesize", this.target.url], display: `-f flv ${this.target.display}` };
  }
}
