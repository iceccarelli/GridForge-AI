import fs from "node:fs";
import path from "node:path";
import { BaseAdapter } from "./base.mjs";

/**
 * LOCAL SINK adapter: writes MPEG-TS segments (2 s) to a directory on this machine. Nothing leaves the machine, so it needs
 * no approval code, and it is the adapter every automated test publishes to. Because the sink is local, its verifier
 * is real: it looks at the segment files and says `live` only when a segment was written recently.
 *
 * Segment names carry the mode and run so a test (or an operator) can see exactly when the scene gave way to the slate:
 *   seg-scene-r1-00000.ts ... seg-slate-r3-00000.ts
 */
export class LocalSinkAdapter extends BaseAdapter {
  /** @param {import("./base.mjs").AdapterDeps} [deps] */
  constructor(deps = {}) {
    super("local", { verifier: undefined, ...deps });
    this.requiresApproval = false;
    /** @type {string|null} */ this.dir = null;
    if (!this.deps.verifier) this.deps = { ...this.deps, verifier: () => this.verifySink() };
  }

  get locallyVerifiable() { return true; }
  requiredMuxer() { return "segment"; }

  validateConfig(/** @type {Record<string, string | undefined>} */ env) {
    /** @type {string[]} */ const errors = [];
    const dir = env.OBS_LOCAL_SINK_DIR || this.deps.defaultSinkDir;
    if (!dir) errors.push("OBS_LOCAL_SINK_DIR is not set (a directory to write segments into)");
    else if (!path.isAbsolute(dir)) errors.push("OBS_LOCAL_SINK_DIR must be an absolute path");
    if (errors.length) {
      this.configured = false;
      this._set("not_configured", "configuration invalid");
      return { ok: false, errors, warnings: [], summary: { adapter: this.name, configured: false } };
    }
    this.dir = /** @type {string} */ (dir);
    this.configured = true;
    this._set("configured_unverified", "configured; run preflight");
    return { ok: true, errors, warnings: [], summary: { adapter: this.name, dir: this.dir } };
  }

  planTarget() { return this.dir; }
  planDisplay() { return `local directory ${this.dir}`; }

  async localChecks() {
    try {
      fs.mkdirSync(/** @type {string} */ (this.dir), { recursive: true });
      const probe = path.join(/** @type {string} */ (this.dir), `.write-test-${process.pid}`);
      fs.writeFileSync(probe, "x");
      fs.unlinkSync(probe);
      return [{ name: "sink dir writable", ok: true, detail: String(this.dir) }];
    } catch (e) {
      return [{ name: "sink dir writable", ok: false, detail: `${this.dir}: ${/** @type {any} */ (e).code ?? "error"}` }];
    }
  }

  outputSpec(/** @type {import("./base.mjs").StreamSpec} */ stream) {
    const dir = /** @type {string} */ (this.dir);
    const pattern = path.join(dir, `seg-${stream.mode}-r${this.runCounter}-%05d.ts`);
    return {
      args: ["-f", "segment", "-segment_time", "2", "-segment_format", "mpegts", "-reset_timestamps", "1", pattern],
      display: `-f segment ${pattern}`,
    };
  }

  /** Real verification of a local sink: at least one segment, and the newest was written within maxAgeMs. */
  async verifySink(maxAgeMs = 8000) {
    // Only the CURRENT encoder run counts: segments left by an earlier run (or by the slate) prove nothing about now.
    const prefix = this.lastStream ? `seg-${this.lastStream.mode}-r${this.runCounter}-` : null;
    const segs = this.listSegments(prefix);
    if (segs.length === 0) return { ok: false, evidence: "no segments written yet by the current encoder run" };
    const nonEmpty = segs.filter((s) => s.size > 0);
    if (nonEmpty.length === 0) return { ok: false, evidence: "segment files exist but none has data yet" };
    const newest = nonEmpty.reduce((a, b) => (b.mtimeMs > a.mtimeMs ? b : a));
    const age = Math.round(Date.now() - newest.mtimeMs);
    const bytes = segs.reduce((s, x) => s + x.size, 0);
    if (age > maxAgeMs) return { ok: false, evidence: `newest segment ${newest.name} is ${age} ms old` };
    return { ok: true, evidence: `${segs.length} segment(s), ${bytes} bytes from the current run; newest ${newest.name} written ${age} ms ago` };
  }

  /** @param {string|null} [prefix] only files starting with this prefix */
  listSegments(prefix = null) {
    if (!this.dir) return [];
    try {
      return fs.readdirSync(this.dir).filter((f) => /^seg-.*\.ts$/.test(f) && (!prefix || f.startsWith(prefix))).map((name) => {
        const st = fs.statSync(path.join(/** @type {string} */ (this.dir), name));
        return { name, size: st.size, mtimeMs: st.mtimeMs };
      });
    } catch { return []; }
  }
}
