import { describe, expect, it } from "vitest";
import { csvCell, csvLine, parseCsv, toCsv } from "@/lib/site-registry-csv";
import {
  DECLARATION, EXPORT_FORMAT, buildExport, exportFileName, exportJson, inputsCsv, readWholeTimeline, timelineCsv,
} from "@/lib/site-registry-export";
import type { RegistryEvent, RegistryInput } from "@/lib/site-registry-model";

// Export for a compliance binder: the CSV writer (formula injection, quoting), the shape of the file, what it never carries, and the timeline paging.

const input = (over: Partial<RegistryInput> = {}): RegistryInput => ({
  id: "i1", fieldPath: "grid.firm_capacity_mva", value: 40, unit: "MVA", evidenceClass: "E1", origin: "assumed", asOf: "2026-01-15", recordedBy: "eng@acme.example",
  recordedAt: "2026-02-01T10:00:00.123456+00:00", supersedesId: null, superseded: false, source: null, ...over,
});
const event = (over: Partial<RegistryEvent> = {}): RegistryEvent => ({
  occurredAt: "2026-02-01T10:00:00Z", kind: "input_recorded", subject: "grid.firm_capacity_mva", summary: "grid.firm_capacity_mva = 40 MVA (as of 2026-01-15)", origin: "assumed",
  evidenceClass: "E1", basis: "declared by eng@acme.example; no file cited", actor: "eng@acme.example", projectId: null, superseded: false, sourceTable: "hall_inputs", sourceId: "i1", ...over,
});
const hall = { id: "h1", label: "Hall A1", siteName: "North campus", dataOrigin: "synthetic", country: "DE" };

describe("csvCell: spreadsheet-safe, correctly quoted", () => {
  it.each(["=1+1", "+1", "-1", "@SUM(A1)", "\tcmd", "\rcmd", '=HYPERLINK("http://evil.example","x")', "=cmd|' /C calc'!A0", "-2+3"])("text %j that could start a formula gets an apostrophe", (v) => {
    const out = csvCell(v);
    const bare = out.startsWith('"') ? out.slice(1, -1).replace(/""/g, '"') : out;
    expect(bare.startsWith("'")).toBe(true);
    expect(bare).toBe("'" + v);
  });
  it("does not prefix text that merely contains those characters, or starts with a letter, a digit or a hash", () => {
    for (const v of ["a=b", "x+y", "1-2", "name@host", "# comment", "40", "0.5", ""]) expect(csvCell(v)).toBe(v);
  });
  it("a real finite number is written as the number (a negative number is not a formula and must not be corrupted); the same TEXT is prefixed", () => {
    expect(csvCell(-5)).toBe("-5");
    expect(csvCell(0.25)).toBe("0.25");
    expect(csvCell(1e21)).toBe("1e+21");
    expect(csvCell("-5")).toBe("'-5");
    expect(csvCell(Number.NaN)).toBe("NaN");
  });
  it("quotes a cell with a comma, a quote, a line break or edge spaces, and doubles inner quotes", () => {
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("two\nlines")).toBe('"two\nlines"');
    expect(csvCell("cr\rhere")).toBe('"cr\rhere"');
    expect(csvCell(" padded ")).toBe('" padded "');
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
    expect(csvCell(true)).toBe("true");
  });
  it("a formula that also needs quoting is prefixed first and then quoted", () => {
    expect(csvCell('=A1,"x"')).toBe('"\'=A1,""x"""');
  });
  it("round trip: what the writer writes the parser reads back, byte for byte (modulo the apostrophe)", () => {
    const rows = [["a,b", 'q"q', "multi\nline", "=SUM(1)", "plain", "", "  x  ", "tab\there"], ["-7", 12, true, null, "é ü 日本", "@x", "+y", "\rz"]];
    const text = toCsv(rows);
    const p = parseCsv(text);
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    const expected = rows.map((r) => r.map((c) => (c === null ? "" : typeof c === "number" || typeof c === "boolean" ? String(c) : /^[=+\-@\t\r]/.test(c) ? "'" + c : c)));
    expect(p.rows).toEqual(expected);
  });
  it("toCsv: a byte-order mark, CRLF line ends, one line per row, even when a cell has an embedded newline", () => {
    const t = toCsv([["a", "b"], ["c", "d"]]);
    expect(t.charCodeAt(0)).toBe(0xfeff);
    expect(t.slice(1)).toBe("a,b\r\nc,d\r\n");
    expect(csvLine([1, "x"])).toBe("1,x");
  });
});

describe("parseCsv", () => {
  it("handles quotes, doubled quotes, CRLF, LF and CR, a BOM, comment lines and blank lines", () => {
    const p = parseCsv('﻿# a comment, with a comma\r\nh1,h2\r\n\r\n"a,""b""",c\n# another\nx,y\rz,w');
    expect(p).toEqual({ ok: true, tooMany: false, rows: [["h1", "h2"], ['a,"b"', "c"], ["x", "y"], ["z", "w"]] });
  });
  it("a comment written as one quoted cell (it had a comma) is still a comment", () => {
    expect(parseCsv('"# note, with comma"\nh\nv')).toEqual({ ok: true, tooMany: false, rows: [["h"], ["v"]] });
  });
  it("an unterminated quote, a quote in the middle of a cell and text after a closing quote are refused with a line number", () => {
    expect(parseCsv('a,"b\nc')).toMatchObject({ ok: false, error: expect.stringMatching(/never closed/) });
    expect(parseCsv('ab"c,d')).toMatchObject({ ok: false, error: expect.stringMatching(/Line 1.*quote may only start/) });
    expect(parseCsv('"ab"c,d')).toMatchObject({ ok: false, error: expect.stringMatching(/Line 1.*closing quote/) });
  });
  it("stops at the record cap and says so, so a hostile file cannot make it run on", () => {
    const big = Array.from({ length: 5000 }, (_, i) => `r${i}`).join("\n");
    const p = parseCsv(big, 10);
    expect(p).toMatchObject({ ok: true, tooMany: true });
    if (p.ok) expect(p.rows).toHaveLength(10);
  });
  it("an empty quoted cell on its own line is a record, an empty line is not", () => {
    expect(parseCsv('a\n""\nb')).toEqual({ ok: true, tooMany: false, rows: [["a"], [""], ["b"]] });
  });
});

describe("the export file", () => {
  const measured = input({
    id: "i2", fieldPath: "grid.contracted_mw", value: 30, unit: "MW", origin: "measured", evidenceClass: "E5", supersedesId: "i0",
    source: { kind: "project_evidence", id: "e1", filename: "meter-readings.pdf", reviewStatus: "verified" },
  });
  const doc = buildExport({
    hall, inputs: [input(), measured], eventsNewestFirst: [event({ occurredAt: "2026-03-01T00:00:00Z", summary: "newer" }), event({ occurredAt: "2026-02-01T00:00:00Z", summary: "older" })],
    timelineComplete: true, exportedAt: "2026-11-07T09:00:00.000Z",
  });

  it("states in the file itself that origin and class are the recorder's declaration, and names the format", () => {
    expect(doc.format).toBe(EXPORT_FORMAT);
    expect(DECLARATION).toMatch(/declaration of the person who recorded/);
    const json = JSON.parse(exportJson(doc));
    expect(json.declaration).toBe(DECLARATION);
    expect(json.privacy).toMatch(/email addresses/);
    for (const csv of [inputsCsv(doc), timelineCsv(doc)]) {
      expect(csv).toContain("declaration of the person who recorded each figure");
      expect(csv.replace(/^\ufeff/, "").replace(/^"/, "").startsWith("# GridForge hall record")).toBe(true);
    }
  });

  it("carries, per figure: path, value, unit, declared origin and class, file name and live review status, who and when, and what it replaces", () => {
    const row = JSON.parse(exportJson(doc)).currentInputs.find((i: any) => i.fieldPath === "grid.contracted_mw");
    expect(row).toEqual({
      fieldPath: "grid.contracted_mw", value: 30, unit: "MW", declaredOrigin: "measured", declaredClass: "E5", asOf: "2026-01-15", sourceFileName: "meter-readings.pdf",
      sourceKind: "project_evidence", sourceId: "e1", sourceReviewStatusNow: "verified", recordedBy: "eng@acme.example", recordedAt: "2026-02-01T10:00:00.123456+00:00", supersedesId: "i0", id: "i2",
    });
    const csv = parseCsv(inputsCsv(doc));
    expect(csv.ok).toBe(true);
    if (!csv.ok) return;
    const [head, ...rows] = csv.rows;
    expect(head).toEqual(["field_path", "value", "unit", "declared_origin", "declared_class", "as_of", "source_file_name", "source_kind", "source_id", "source_review_status_now", "recorded_by", "recorded_at", "supersedes_id", "id"]);
    expect(rows.find((r) => r[0] === "grid.contracted_mw")).toEqual(["grid.contracted_mw", "30", "MW", "measured", "E5", "2026-01-15", "meter-readings.pdf", "project_evidence", "e1", "verified", "eng@acme.example", "2026-02-01T10:00:00.123456+00:00", "i0", "i2"]);
  });

  it("figures are sorted by field, and the timeline is oldest first (the server sends newest first)", () => {
    expect(doc.currentInputs.map((i) => i.fieldPath)).toEqual(["grid.contracted_mw", "grid.firm_capacity_mva"]);
    expect(doc.timeline.map((e) => e.summary)).toEqual(["older", "newer"]);
  });

  it("is built field by field: a field the API did not mean to send (a storage location, a token, a digest) cannot ride along", () => {
    const leaky = { ...measured, storage_ref: "project-evidence/LEAK-1", project_token: "LEAK-2", sha256: "LEAK-3", source: { ...measured.source!, storage_ref: "LEAK-4", sha256: "LEAK-5" } } as unknown as RegistryInput;
    const leakyEvent = { ...event(), payload: { case_token: "LEAK-6" }, project_token: "LEAK-7" } as unknown as RegistryEvent;
    const d = buildExport({ hall, inputs: [leaky], eventsNewestFirst: [leakyEvent], timelineComplete: true, exportedAt: "2026-11-07T09:00:00.000Z" });
    for (const text of [exportJson(d), inputsCsv(d), timelineCsv(d)]) expect(text).not.toMatch(/LEAK|storage_ref|project-evidence\/|sha256|token/i);
  });

  it("hostile values reach the CSV as text: a formula in a file name, a summary or a hall label is neutralised, JSON keeps it untouched", () => {
    const evil = input({ id: "i9", fieldPath: "hall.x", value: "=cmd|' /C calc'!A0", unit: null, source: { kind: "project_evidence", id: "e", filename: '=HYPERLINK("http://evil.example")', reviewStatus: "unverified" } });
    const d = buildExport({ hall: { ...hall, label: "@evil" }, inputs: [evil], eventsNewestFirst: [event({ summary: "+1+1", basis: "-2", actor: "\t@x" })], timelineComplete: true, exportedAt: "2026-11-07T09:00:00.000Z" });
    const figures = parseCsv(inputsCsv(d));
    const time = parseCsv(timelineCsv(d));
    expect(figures.ok && time.ok).toBe(true);
    if (!figures.ok || !time.ok) return;
    const cells = [...figures.rows.slice(5).flat(), ...time.rows.slice(5).flat()].filter((c) => c !== "");     // after the five comment-and-header lines the data rows start
    for (const c of cells) expect(/^[=+\-@\t\r]/.test(c), c).toBe(false);
    expect(figures.rows.find((r) => r[0] === "hall.x")![1]).toBe("'=cmd|' /C calc'!A0");
    expect(JSON.parse(exportJson(d)).currentInputs[0].value).toBe("=cmd|' /C calc'!A0");
  });

  it("an incomplete timeline says so in the file, in JSON and in CSV", () => {
    const d = buildExport({ hall, inputs: [], eventsNewestFirst: [event()], timelineComplete: false, timelineNote: "Page 2 could not be read", exportedAt: "2026-11-07T09:00:00.000Z" });
    expect(JSON.parse(exportJson(d))).toMatchObject({ timelineComplete: false, timelineNote: "Page 2 could not be read" });
    expect(timelineCsv(d)).toContain("INCOMPLETE: Page 2 could not be read");
    expect(JSON.parse(exportJson(doc))).toMatchObject({ timelineComplete: true, timelineNote: null });
  });

  it("a figure recorded as missing is exported as missing: no value, class E0", () => {
    const m = input({ id: "m1", origin: "missing", value: null, unit: null, evidenceClass: "E0" });
    const d = buildExport({ hall, inputs: [m], eventsNewestFirst: [], timelineComplete: true, exportedAt: "2026-11-07T09:00:00.000Z" });
    expect(d.currentInputs[0]).toMatchObject({ value: null, declaredOrigin: "missing", declaredClass: "E0" });
  });

  it("file names are letters, digits and hyphens only, never a path", () => {
    expect(exportFileName("Hall A1", "record", "json", "2026-11-07T09:00:00Z")).toBe("gridforge-hall-a1-record-2026-11-07.json");
    for (const label of ["../../etc/passwd", "a/b\\c", "日本語", "   ", '"><script>', "x".repeat(300)]) {
      const n = exportFileName(label, "figures", "csv", "2026-11-07T09:00:00Z");
      expect(n).toMatch(/^gridforge-[a-z0-9-]{1,40}-figures-2026-11-07\.csv$/);
    }
  });
});

describe("readWholeTimeline follows the cursor the server gave, verbatim, and says when it could not read everything", () => {
  const page = (events: RegistryEvent[], next: string | null) => ({ status: 200, body: { ok: true, events, truncated: next !== null, nextCursor: next } });
  it("reads every page once, newest first, passing the cursor back URL-encoded and untouched", async () => {
    const seen: string[] = [];
    const api = async (path: string) => {
      seen.push(path);
      if (!path.includes("cursor=")) return page([event({ summary: "e3" })], '{"k":"a b&c"}');
      if (path.includes(encodeURIComponent('{"k":"a b&c"}'))) return page([event({ summary: "e2" })], "c2");
      return page([event({ summary: "e1" })], null);
    };
    const r = await readWholeTimeline(api, "h1", 20, 1);
    expect(r).toMatchObject({ complete: true, note: null, error: null });
    expect(r.events.map((e) => e.summary)).toEqual(["e3", "e2", "e1"]);
    expect(seen).toHaveLength(3);
    expect(seen[0]).toBe("/api/halls/h1/timeline?limit=1");
    expect(seen[2]).toContain("&cursor=c2");
  });
  it("stops at the page cap and reports an incomplete read", async () => {
    let n = 0;
    const r = await readWholeTimeline(async () => page([event({ summary: `e${n++}` })], "more"), "h1", 3);
    expect(r.complete).toBe(false);
    expect(r.events).toHaveLength(3);
    expect(r.note).toMatch(/Only the newest 3 events were read/);
  });
  it("a page that fails midway returns what was read and says which page failed", async () => {
    let n = 0;
    const r = await readWholeTimeline(async () => (n++ === 0 ? page([event()], "c") : { status: 429, body: { ok: false, error: "Too many requests." } }), "h1");
    expect(r).toMatchObject({ complete: false, error: "Too many requests." });
    expect(r.events).toHaveLength(1);
    expect(r.note).toMatch(/Page 2 .* could not be read \(Too many requests\.\)/);
  });
  it("a request that throws is an incomplete read, not an exception", async () => {
    const r = await readWholeTimeline(async () => { throw new Error("offline"); }, "h1");
    expect(r).toMatchObject({ complete: false, events: [], error: "Could not reach the server." });
  });
});
