import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  buildVtt, clipCues, escapeCueText, formatTimestamp, normalizeCues, parseCueJson, parseTimestamp, validateVtt,
} from "../../observatory-broadcast/src/captions.mjs";

// Cues are the plain {startSec,endSec,text}[] the journey produces. The WebVTT built from them must be valid by
// construction, and the independent validator must catch every way a hand-written or third-party file can be wrong.

const cues = [
  { startSec: 0, endSec: 2.5, text: "Synthetic hall: every number is illustrative." },
  { startSec: 2.5, endSec: 5, text: "Line one\nLine two" },
];

describe("observatory-broadcast: WebVTT building", () => {
  it("formats and parses timestamps symmetrically, rounding to milliseconds", () => {
    expect(formatTimestamp(0)).toBe("00:00:00.000");
    expect(formatTimestamp(3661.0049)).toBe("01:01:01.005");
    expect(formatTimestamp(59.9996)).toBe("00:01:00.000");
    for (const t of [0, 0.001, 12.345, 599.999, 3600.5]) expect(parseTimestamp(formatTimestamp(t))).toBeCloseTo(t, 3);
    expect(parseTimestamp("1:02.000")).toBeNull();
    expect(parseTimestamp("00:61:00.000")).toBeNull();
  });

  it("emits a header, numbered cues, and LF line endings", () => {
    const vtt = buildVtt(cues);
    expect(vtt.startsWith("WEBVTT\n\n1\n00:00:00.000 --> 00:00:02.500\n")).toBe(true);
    expect(vtt).toContain("2\n00:00:02.500 --> 00:00:05.000\nLine one\nLine two\n");
    expect(vtt).not.toContain("\r");
    expect(vtt.endsWith("\n")).toBe(true);
  });

  it("escapes &, < and > so a cue can never close, open a tag or contain the timing arrow", () => {
    expect(escapeCueText("a -> b & <c> --> d")).toBe("a -&gt; b &amp; &lt;c&gt; --&gt; d");
    const vtt = buildVtt([{ startSec: 0, endSec: 1, text: "grid --> rack <b>bold</b> & more" }]);
    const payload = vtt.split("\n\n")[1].split("\n").slice(2).join("\n");
    expect(payload).not.toContain("-->");
    expect(payload).not.toMatch(/<(?!\/)/);
    expect(validateVtt(vtt).valid).toBe(true);
  });

  it("strips control characters and blank lines from the payload (a blank line would end the cue)", () => {
    const vtt = buildVtt([{ startSec: 0, endSec: 1, text: "one\u0000\u0007\n\n\n  two  \r\nthree" }]);
    expect(vtt).toContain("one\ntwo\nthree\n");
    expect(validateVtt(vtt).valid).toBe(true);
  });

  it("sorts unordered cues", () => {
    const vtt = buildVtt([cues[1], cues[0]]);
    expect(vtt.indexOf("Synthetic")).toBeLessThan(vtt.indexOf("Line one"));
  });

  it("resolves an overlap by trimming the earlier cue, and says so", () => {
    const r = normalizeCues([
      { startSec: 0, endSec: 4, text: "first" },
      { startSec: 3, endSec: 6, text: "second" },
    ]);
    expect(r.errors).toEqual([]);
    expect(r.cues[0].endSec).toBe(3);
    expect(r.warnings).toHaveLength(1);
    const v = validateVtt(buildVtt([{ startSec: 0, endSec: 4, text: "first" }, { startSec: 3, endSec: 6, text: "second" }]));
    expect(v.valid).toBe(true);
  });

  it("rejects cues that cannot be made valid, with a message naming the cue", () => {
    const bad = (c: unknown) => normalizeCues([c]).errors.join(" ");
    expect(bad({ startSec: 2, endSec: 2, text: "x" })).toMatch(/cue 1: endSec must be at least/);
    expect(bad({ startSec: 3, endSec: 1, text: "x" })).toMatch(/cue 1/);
    expect(bad({ startSec: -1, endSec: 1, text: "x" })).toMatch(/startSec/);
    expect(bad({ startSec: Number.NaN, endSec: 1, text: "x" })).toMatch(/startSec/);
    expect(bad({ startSec: 0, endSec: Number.POSITIVE_INFINITY, text: "x" })).toMatch(/endSec/);
    expect(bad({ startSec: 0, endSec: 1, text: "   " })).toMatch(/text/);
    expect(bad({ startSec: 0, endSec: 1, text: "\u0000\u0001" })).toMatch(/text/);
    expect(bad({ startSec: 0, endSec: 1 })).toMatch(/text/);
    expect(bad(null)).toMatch(/not an object/);
    expect(normalizeCues("nope" as unknown).errors[0]).toMatch(/array/);
    expect(() => buildVtt([{ startSec: 5, endSec: 1, text: "x" }])).toThrow(/cue list is invalid/);
    // an overlap so tight the first cue would vanish
    expect(normalizeCues([{ startSec: 0, endSec: 1, text: "a" }, { startSec: 0.01, endSec: 2, text: "b" }]).errors[0]).toMatch(/vanish/);
  });

  it("clips a cue list to the recording length: later cues dropped, a straddling cue cut, invalid input left for buildVtt to report", () => {
    const list = [{ startSec: 0, endSec: 2.5, text: "a" }, { startSec: 2.5, endSec: 5, text: "b" }, { startSec: 7.5, endSec: 10, text: "c" }];
    expect(clipCues(list, 2)).toEqual([{ startSec: 0, endSec: 2, text: "a" }]);
    expect(clipCues(list, 4)).toEqual([{ startSec: 0, endSec: 2.5, text: "a" }, { startSec: 2.5, endSec: 4, text: "b" }]);
    expect(clipCues(list, 100)).toEqual(list);
    expect(clipCues(list, 2.52)).toHaveLength(1); // a cue that would last under 50 ms is dropped, not emitted
    const bad = [{ startSec: 3, endSec: 1, text: "x" }];
    expect(clipCues(bad, 2)).toBe(bad);
    expect(() => buildVtt(clipCues(bad, 2))).toThrow(/invalid/);
  });

  it("an empty cue list is a valid (header-only) file", () => {
    const vtt = buildVtt([]);
    expect(vtt).toBe("WEBVTT\n\n");
    expect(validateVtt(vtt).valid).toBe(true);
  });

  it("round-trips: parsing built VTT returns the same cues (text escaped)", () => {
    const parsed = validateVtt(buildVtt(cues));
    expect(parsed.valid).toBe(true);
    expect(parsed.cues).toEqual([
      { startSec: 0, endSec: 2.5, text: "Synthetic hall: every number is illustrative." },
      { startSec: 2.5, endSec: 5, text: "Line one\nLine two" },
    ]);
  });

  it("builds valid WebVTT for any text (seeded fuzz)", () => {
    let seed = 1234567;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
    const alphabet = ["a", "Z", " ", "\n", "\r", "<", ">", "&", "-", "--", "-->", "&amp;", "<b>", "\t", "\u0000", "é", "😀", " ", ":", "."];
    for (let i = 0; i < 300; i++) {
      let t = "";
      for (let k = 0; k < 1 + Math.floor(rnd() * 12); k++) t += alphabet[Math.floor(rnd() * alphabet.length)];
      const start = Math.round(rnd() * 5000) / 1000;
      const list = [{ startSec: start, endSec: start + 0.5 + rnd(), text: `x${t}` }, { startSec: start + 2, endSec: start + 3, text: `y${t}` }];
      const vtt = buildVtt(list);
      const v = validateVtt(vtt);
      expect(v.errors).toEqual([]);
      expect(vtt.split("\n").filter((l) => l.includes("-->")).length).toBe(2); // only the two timing lines
    }
  });

  it("the committed fixture cue list builds valid WebVTT", () => {
    const file = path.join(__dirname, "../../observatory-broadcast/fixtures/cues.json");
    const list = parseCueJson(fs.readFileSync(file, "utf8"));
    const vtt = buildVtt(list);
    expect(validateVtt(vtt).valid).toBe(true);
    expect(vtt).toContain("&lt;not&gt;");
    expect(vtt).toContain("&amp;");
  });

  it("parseCueJson accepts an array or {cues:[...]} and rejects other shapes with an actionable error", () => {
    expect(parseCueJson(JSON.stringify(cues))).toHaveLength(2);
    expect(parseCueJson(JSON.stringify({ cues }))).toHaveLength(2);
    expect(() => parseCueJson("{not json")).toThrow(/not valid JSON/);
    expect(() => parseCueJson('{"a":1}')).toThrow(/JSON array/);
  });
});

describe("observatory-broadcast: WebVTT validator", () => {
  const good = "WEBVTT\n\n1\n00:00:00.000 --> 00:00:01.000\nhello\n";
  const errorsOf = (s: string) => validateVtt(s).errors.join(" | ");

  it("accepts a good file, a BOM, CRLF and cues without identifiers", () => {
    expect(validateVtt(good).valid).toBe(true);
    expect(validateVtt("﻿" + good).valid).toBe(true);
    expect(validateVtt(good.replace(/\n/g, "\r\n")).valid).toBe(true);
    expect(validateVtt("WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nhello\n").valid).toBe(true);
  });

  it("rejects a missing or malformed header", () => {
    expect(errorsOf("00:00:00.000 --> 00:00:01.000\nhello")).toMatch(/WEBVTT/);
    expect(errorsOf("WEBVTTX\n\n")).toMatch(/WEBVTT/);
    expect(errorsOf("WEBVTT\n1\n00:00:00.000 --> 00:00:01.000\nhello")).toMatch(/blank line must follow/);
  });

  it("rejects malformed timing lines and timestamps", () => {
    expect(errorsOf("WEBVTT\n\n1\n00:00:00.000 -> 00:00:01.000\nhi")).toMatch(/timing line/);
    expect(errorsOf("WEBVTT\n\n1\n0:00.0 --> 0:01.0\nhi")).toMatch(/malformed timestamp/);
    expect(errorsOf("WEBVTT\n\n1\n00:00:00.000 --> 00:00:01.000")).toMatch(/no text/);
  });

  it("rejects end <= start, out-of-order and overlapping cues", () => {
    expect(errorsOf("WEBVTT\n\n00:00:02.000 --> 00:00:01.000\nhi\n")).toMatch(/end must be after/);
    expect(errorsOf("WEBVTT\n\n00:00:02.000 --> 00:00:02.000\nhi\n")).toMatch(/end must be after/);
    expect(errorsOf("WEBVTT\n\n00:00:03.000 --> 00:00:04.000\na\n\n00:00:01.000 --> 00:00:02.000\nb\n")).toMatch(/not in start order/);
    expect(errorsOf("WEBVTT\n\n00:00:00.000 --> 00:00:03.000\na\n\n00:00:02.000 --> 00:00:04.000\nb\n")).toMatch(/overlaps the previous/);
  });

  it("rejects payload that is not escaped", () => {
    expect(errorsOf("WEBVTT\n\n00:00:00.000 --> 00:00:01.000\na --> b\n")).toMatch(/-->/);
    expect(errorsOf("WEBVTT\n\n00:00:00.000 --> 00:00:01.000\n1 < 2\n")).toMatch(/raw "<"/);
    expect(errorsOf("WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nR&D\n")).toMatch(/bare "&"/);
  });

  it("treats a blank line inside a payload as the end of the cue (the rest is then not a valid cue)", () => {
    const v = validateVtt("WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nfirst\n\nsecond\n");
    expect(v.valid).toBe(false);
  });
});
