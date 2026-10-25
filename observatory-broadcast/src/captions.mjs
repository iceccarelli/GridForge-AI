import { ObsError } from "./errors.mjs";

/**
 * Captions. Input is the plain cue list the journey produces: {startSec, endSec, text}[]. Output is WebVTT that
 * is valid by construction (escaped, ordered, non-overlapping), and validateVtt() is an independent checker that parses
 * the text back, so a hand-written or third-party .vtt can be checked by the same rules.
 *
 * @typedef {{ startSec: number, endSec: number, text: string }} Cue
 */

const MIN_CUE_SEC = 0.05;

/** @param {number} sec */
export function formatTimestamp(sec) {
  const ms = Math.round(sec * 1000);
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const r = ms % 1000;
  const p = (/** @type {number} */ n, w = 2) => String(n).padStart(w, "0");
  return `${p(h)}:${p(m)}:${p(s)}.${p(r, 3)}`;
}

/** @param {string} ts @returns {number|null} seconds */
export function parseTimestamp(ts) {
  const m = /^(?:(\d{2,}):)?([0-5]\d):([0-5]\d)\.(\d{3})$/.exec(ts);
  if (!m) return null;
  return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000;
}

/** Escape cue text for a WebVTT payload: `&`, `<`, `>` become entities, so "-->" can never appear. */
export function escapeCueText(text) {
  return String(text)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f￾￿]/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .split("\n").map((l) => l.trim()).filter((l) => l.length > 0).join("\n");
}

/**
 * Validate and normalise a cue list: finite times, end after start, text present, sorted; overlaps are resolved by
 * trimming the earlier cue to end where the next starts (reported in `warnings`); a cue that would vanish is an error.
 * @param {unknown} cues
 * @returns {{ cues: Cue[], errors: string[], warnings: string[] }}
 */
export function normalizeCues(cues) {
  /** @type {string[]} */ const errors = [];
  /** @type {string[]} */ const warnings = [];
  if (!Array.isArray(cues)) return { cues: [], errors: ["cue list must be an array"], warnings };
  /** @type {Cue[]} */ const list = [];
  cues.forEach((c, i) => {
    if (!c || typeof c !== "object") { errors.push(`cue ${i + 1}: not an object`); return; }
    const { startSec, endSec, text } = /** @type {any} */ (c);
    if (typeof startSec !== "number" || !Number.isFinite(startSec) || startSec < 0) { errors.push(`cue ${i + 1}: startSec must be a finite number >= 0`); return; }
    if (typeof endSec !== "number" || !Number.isFinite(endSec)) { errors.push(`cue ${i + 1}: endSec must be a finite number`); return; }
    if (endSec - startSec < MIN_CUE_SEC) { errors.push(`cue ${i + 1}: endSec must be at least ${MIN_CUE_SEC}s after startSec`); return; }
    if (typeof text !== "string" || escapeCueText(text).length === 0) { errors.push(`cue ${i + 1}: text must be a non-empty string`); return; }
    list.push({ startSec, endSec, text });
  });
  list.sort((a, b) => a.startSec - b.startSec || a.endSec - b.endSec);
  for (let i = 0; i < list.length - 1; i++) {
    if (list[i].endSec > list[i + 1].startSec) {
      const trimmed = list[i + 1].startSec;
      if (trimmed - list[i].startSec < MIN_CUE_SEC) {
        errors.push(`cues at ${formatTimestamp(list[i].startSec)} and ${formatTimestamp(list[i + 1].startSec)} overlap so closely that the first would vanish`);
      } else {
        warnings.push(`cue at ${formatTimestamp(list[i].startSec)} overlapped the next cue; its end was trimmed to ${formatTimestamp(trimmed)}`);
        list[i] = { ...list[i], endSec: trimmed };
      }
    }
  }
  return { cues: list, errors, warnings };
}

/**
 * Fit a cue list to a recording of `durationSec`: cues starting at or after the end are dropped, a cue running past it is cut.
 * (An embedded caption track longer than the video would make the container longer than the picture.)
 * An invalid list is returned untouched so buildVtt reports the real problem.
 * @param {unknown} cues
 * @param {number} durationSec
 * @returns {unknown}
 */
export function clipCues(cues, durationSec) {
  const n = normalizeCues(cues);
  if (n.errors.length) return cues;
  return n.cues
    .filter((c) => c.startSec < durationSec - MIN_CUE_SEC)
    .map((c) => (c.endSec > durationSec ? { ...c, endSec: durationSec } : c));
}

/**
 * Build WebVTT from a cue list.
 * @param {unknown} cues
 * @returns {string}
 * @throws {ObsError} code captions_invalid
 */
export function buildVtt(cues) {
  const { cues: ok, errors } = normalizeCues(cues);
  if (errors.length) throw new ObsError("captions_invalid", `cue list is invalid: ${errors.join("; ")}`, { exitCode: 2, hint: "Fix the cue list ({startSec,endSec,text}[]) and retry." });
  const blocks = ok.map((c, i) => `${i + 1}\n${formatTimestamp(c.startSec)} --> ${formatTimestamp(c.endSec)}\n${escapeCueText(c.text)}`);
  const vtt = `WEBVTT\n\n${blocks.join("\n\n")}${blocks.length ? "\n" : ""}`;
  const v = validateVtt(vtt);
  if (!v.valid) throw new ObsError("captions_invalid", `generated WebVTT failed validation: ${v.errors.join("; ")}`);
  return vtt;
}

const TIMING = /^(\S+) --> (\S+)(?: .*)?$/;

/**
 * Validate WebVTT text: header, blank line after it, well-formed timing lines, start < end, cues in order without
 * overlap, no "-->" or blank lines inside a payload, no raw "<" or bare "&" (only entities this tool emits).
 * @param {string} text
 * @returns {{ valid: boolean, errors: string[], cues: Cue[] }}
 */
export function validateVtt(text) {
  /** @type {string[]} */ const errors = [];
  /** @type {Cue[]} */ const cues = [];
  if (typeof text !== "string") return { valid: false, errors: ["not a string"], cues };
  const src = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n"); // WebVTT allows CRLF and CR line endings
  const lines = src.split("\n");
  if (!/^WEBVTT(?:[ \t].*)?$/.test(lines[0] ?? "")) errors.push('first line must be "WEBVTT"');
  if (lines.length > 1 && lines[1] !== "") errors.push("a blank line must follow the WEBVTT header");
  let i = 1;
  while (i < lines.length && lines[i] !== "") i++; // header metadata (none written by this tool)
  while (i < lines.length) {
    while (i < lines.length && lines[i] === "") i++;
    if (i >= lines.length) break;
    const blockStart = i + 1;
    let timingLine = lines[i];
    if (!timingLine.includes("-->")) { i++; timingLine = lines[i] ?? ""; } // cue identifier
    const m = TIMING.exec(timingLine);
    if (!m) { errors.push(`line ${blockStart}: expected a cue timing line "start --> end"`); while (i < lines.length && lines[i] !== "") i++; continue; }
    const start = parseTimestamp(m[1]);
    const end = parseTimestamp(m[2]);
    if (start === null || end === null) errors.push(`line ${i + 1}: malformed timestamp`);
    i++;
    /** @type {string[]} */ const payload = [];
    while (i < lines.length && lines[i] !== "") { payload.push(lines[i]); i++; }
    if (payload.length === 0) errors.push(`line ${i}: cue has no text`);
    for (const p of payload) {
      if (p.includes("-->")) errors.push(`line ${i}: cue text contains "-->"`);
      if (/<(?!\/?(?:b|i|u|c|v|lang|ruby|rt)\b)/.test(p)) errors.push(`line ${i}: raw "<" in cue text (must be escaped)`);
      if (/&(?!(?:amp|lt|gt|nbsp|lrm|rlm);)/.test(p)) errors.push(`line ${i}: bare "&" in cue text (must be escaped)`);
    }
    if (start !== null && end !== null) {
      if (end <= start) errors.push(`line ${i}: cue end must be after its start`);
      const prev = cues[cues.length - 1];
      if (prev && start < prev.startSec) errors.push(`line ${i}: cues are not in start order`);
      if (prev && start < prev.endSec) errors.push(`line ${i}: cue overlaps the previous one`);
      cues.push({ startSec: start, endSec: end, text: payload.join("\n") });
    }
  }
  return { valid: errors.length === 0, errors, cues };
}

/**
 * Cue list from JSON text (the interchange format with the journey code).
 * @param {string} jsonText
 * @returns {Cue[]}
 */
export function parseCueJson(jsonText) {
  let data;
  try { data = JSON.parse(jsonText); } catch (e) { throw new ObsError("captions_invalid", `cue file is not valid JSON: ${/** @type {Error} */ (e).message}`, { exitCode: 2 }); }
  const list = Array.isArray(data) ? data : data && Array.isArray(data.cues) ? data.cues : null;
  if (!list) throw new ObsError("captions_invalid", "cue file must be a JSON array of {startSec,endSec,text} (or {cues:[...]})", { exitCode: 2 });
  return list;
}
