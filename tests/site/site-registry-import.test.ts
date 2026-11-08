import { describe, expect, it } from "vitest";
import {
  HALL_FIELD_LIMIT, UNKNOWN_MESSAGE, numberLiteralProblem, outcomeUnknown, provenanceFlags, IMPORT_COLUMNS, IMPORT_MAX_BYTES, IMPORT_MAX_ROWS, MAX_AUTO_WAIT_SECONDS, allowedPaths, buildPreview, importTemplateCsv, importTemplateJson, parseImport, runImport, sniffFormat,
  writeOrder, type ImportContext, type PostResult, type RawRow, type RowPlan, type WriteBody,
} from "@/lib/site-registry-import";
import { EXPECTED_HALL_FIELDS } from "@/lib/site-registry-fields";
import type { RegistryInput } from "@/lib/site-registry-model";

// The import: parsing, the preview that judges every row before anything is written, and the run (sequential, 429 backoff, stop on first failure, exact report).

const FILE_A = "11111111-1111-4111-8111-111111111111";
const FILE_B = "22222222-2222-4222-8222-222222222222";
// ids with LETTERS in them: an all-digit id reads the same in either case and would prove nothing about case handling
const HEX_A = "abcdef01-aaaa-4bbb-8ccc-ddddeeeeffff";
const HEX_B = "fedcba98-bbbb-4aaa-9ddd-eeeeffff0000";
const TODAY = "2026-11-07";

const cur = (over: Partial<RegistryInput> = {}): RegistryInput => ({
  id: "c1", fieldPath: "grid.firm_capacity_mva", value: 40, unit: "MVA", evidenceClass: "E1", origin: "assumed", asOf: "2026-01-15", recordedBy: "eng@acme.example",
  recordedAt: "2026-02-01T10:00:00Z", supersedesId: null, superseded: false, source: null, ...over,
});
const ctx = (current: RegistryInput[] = []): ImportContext => ({ current, today: TODAY });
const row = (cells: Record<string, unknown>, n = 1, fromCsv = false): RawRow => ({ n, cells, fromCsv });
const base = { field_path: "grid.contracted_mw", value: 30, unit: "MW", origin: "assumed", class: "E1", as_of: "2026-10-01" };
const one = (cells: Record<string, unknown>, current: RegistryInput[] = [], fromCsv = false) => buildPreview([row({ ...base, ...cells }, 1, fromCsv)], ctx(current)).rows[0]!;

const CSV_HEAD = "field_path,value,unit,origin,class,as_of,source_kind,source_id";

describe("parsing", () => {
  it("reads a CSV: header, rows numbered from 1, comments and BOM skipped, cells exactly as written", () => {
    const p = parseImport(`﻿# note\r\n${CSV_HEAD}\r\ngrid.contracted_mw,30,MW,assumed,E1,2026-10-01,,\r\n"hall.x","a,b",,assumed,E0,2026-10-01,,\r\n`, "csv");
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.rows.map((r) => r.n)).toEqual([1, 2]);
    expect(p.rows[0]!.cells).toMatchObject({ field_path: "grid.contracted_mw", value: "30", unit: "MW" });
    expect(p.rows[1]!.cells.value).toBe("a,b");
    expect(p.rows[0]!.fromCsv).toBe(true);
  });
  it("a header column is case-insensitive; an unknown column, a repeated one, or a missing required one refuses the whole file by name", () => {
    expect(parseImport("FIELD_PATH,Origin,CLASS,As_Of\nx,assumed,E0,2026-01-01", "csv")).toMatchObject({ ok: true });
    expect(parseImport(`${CSV_HEAD},notes\nx`, "csv")).toMatchObject({ ok: false, error: expect.stringMatching(/Unknown column.*“notes”/) });
    expect(parseImport(`${CSV_HEAD},unit\nx`, "csv")).toMatchObject({ ok: false, error: expect.stringMatching(/“unit” appears twice/) });
    expect(parseImport("field_path,value\nx,1", "csv")).toMatchObject({ ok: false, error: expect.stringMatching(/lacks the columns: origin, class, as_of/) });
  });
  it("a row with the wrong number of cells is kept and marked, so the preview can reject it by number", () => {
    const p = parseImport(`${CSV_HEAD}\nonly,three,cells`, "csv");
    expect(p.ok && p.rows[0]!.error).toMatch(/3 cells; the header has 8/);
  });
  it("no data rows, no header, and an unclosed quote are refused", () => {
    expect(parseImport(CSV_HEAD, "csv")).toMatchObject({ ok: false, error: expect.stringMatching(/no data rows/) });
    expect(parseImport("", "csv")).toMatchObject({ ok: false, error: expect.stringMatching(/no header/) });
    expect(parseImport(`${CSV_HEAD}\n"oops`, "csv")).toMatchObject({ ok: false, error: expect.stringMatching(/never closed/) });
  });
  it(`more than ${IMPORT_MAX_ROWS} rows is refused, ${IMPORT_MAX_ROWS} is fine`, () => {
    const mk = (n: number) => `${CSV_HEAD}\n` + Array.from({ length: n }, (_, i) => `a.f${i},1,,assumed,E0,2026-01-01,,`).join("\n");
    expect(parseImport(mk(IMPORT_MAX_ROWS), "csv")).toMatchObject({ ok: true });
    expect(parseImport(mk(IMPORT_MAX_ROWS + 1), "csv")).toMatchObject({ ok: false, error: expect.stringMatching(/more than 200 rows/) });
    expect(parseImport(mk(5000), "csv")).toMatchObject({ ok: false, error: expect.stringMatching(/more than 200 rows/) });
    const j = (n: number) => JSON.stringify(Array.from({ length: n }, () => ({ ...base })));
    expect(parseImport(j(IMPORT_MAX_ROWS), "json")).toMatchObject({ ok: true });
    expect(parseImport(j(IMPORT_MAX_ROWS + 1), "json")).toMatchObject({ ok: false, error: expect.stringMatching(/more than 200 rows/) });
  });
  it(`a file over ${IMPORT_MAX_BYTES / 1024} KB is refused before it is parsed`, () => {
    const huge = `${CSV_HEAD}\nx,${"9".repeat(IMPORT_MAX_BYTES)},,assumed,E0,2026-01-01,,`;
    expect(parseImport(huge, "csv")).toMatchObject({ ok: false, error: expect.stringMatching(/larger than 256 KB/) });
    expect(parseImport("[" + " ".repeat(IMPORT_MAX_BYTES) + "]", "json")).toMatchObject({ ok: false, error: expect.stringMatching(/larger than 256 KB/) });
  });
  it("reads JSON: a list, or {rows}, with native types; anything else is refused", () => {
    const p = parseImport(JSON.stringify({ comment: "hi", rows: [{ ...base, value: 30 }] }), "json");
    expect(p).toMatchObject({ ok: true, format: "json" });
    expect(p.ok && p.rows[0]!.cells.value).toBe(30);
    expect(parseImport("not json", "json")).toMatchObject({ ok: false, error: "The file is not valid JSON." });
    expect(parseImport('{"rows": 3}', "json")).toMatchObject({ ok: false });
    expect(parseImport('{"rows": [], "other": 1}', "json")).toMatchObject({ ok: false, error: expect.stringMatching(/Unknown top-level key.*other/) });
    expect(parseImport("42", "json")).toMatchObject({ ok: false });
    expect(parseImport("[]", "json")).toMatchObject({ ok: false, error: expect.stringMatching(/no rows/) });
  });
  it("a JSON row that is not an object, or has an unknown key, is marked for the preview; __proto__ is just an unknown key, never an assignment", () => {
    const p = parseImport('[1, {"field_path": "x", "oops": 1}, {"__proto__": {"origin": "measured"}, "field_path": "grid.contracted_mw"}]', "json");
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.rows[0]!.error).toMatch(/not an object/);
    expect(p.rows[1]!.error).toMatch(/Unknown key.*“oops”/);
    expect(p.rows[2]!.error).toMatch(/Unknown key.*“__proto__”/);
    expect(({} as Record<string, unknown>).origin).toBeUndefined();
  });
  it("no eval, no Function: the parser and the run use JSON.parse only", async () => {
    const fs = await import("node:fs");
    for (const f of ["lib/site-registry-import.ts", "lib/site-registry-csv.ts", "components/SiteRegistryImport.tsx", "components/SiteRegistryExport.tsx", "components/SiteRegistryDiff.tsx"]) {
      const src = fs.readFileSync(f, "utf8");
      expect(src, f).not.toMatch(/\beval\s*\(|new Function\s*\(|dangerouslySetInnerHTML|innerHTML|document\.write/);
    }
  });
  it("sniffFormat uses the extension, then the first character", () => {
    expect(sniffFormat("a.JSON", "x")).toBe("json");
    expect(sniffFormat("a.csv", "[1]")).toBe("csv");
    expect(sniffFormat("a.txt", " [1]")).toBe("json");
    expect(sniffFormat("a.txt", "a,b")).toBe("csv");
  });
});

describe("the preview: what will happen to every row", () => {
  it("a new figure on a known field is NEW and carries the explicit origin, class, unit and as-of for the existing route", () => {
    const r = one({});
    expect(r.status).toBe("new");
    expect(r.body).toEqual({ fieldPath: "grid.contracted_mw", value: 30, unit: "MW", evidenceClass: "E1", origin: "assumed", asOf: "2026-10-01", projectEvidenceId: null, intakeEvidenceFileId: null, supersedes: null });
  });
  it("a field that already has a current figure is a SUPERSEDE that names the current figure's id, and says what it replaces", () => {
    const r = one({ field_path: "GRID.firm_capacity_MVA", value: 42, unit: "MVA" }, [cur()]);
    expect(r.status).toBe("supersede");
    expect(r.body?.supersedes).toBe("c1");
    expect(r.body?.fieldPath).toBe("grid.firm_capacity_mva");        // lower-cased: two spellings are one field
    expect(r.replaces?.id).toBe("c1");
  });
  it("a row identical to the current figure is UNCHANGED and is not written", () => {
    const r = one({ field_path: "grid.firm_capacity_mva", value: 40, unit: "MVA", class: "E1", as_of: "2026-01-15" }, [cur()]);
    expect(r.status).toBe("unchanged");
    expect(r.body).toBeNull();
  });
  it("an UNKNOWN path is rejected with its row number and the reason, not dropped and not created", () => {
    const p = buildPreview([row({ ...base }, 1), row({ ...base, field_path: "grid.firm_capcity_mva" }, 2), row({ ...base, field_path: "Not A Path" }, 3)], ctx());
    expect(p.rows.map((r) => r.status)).toEqual(["new", "rejected", "rejected"]);
    expect(p.rows[1]!.n).toBe(2);
    expect(p.rows[1]!.reasons[0]).toMatch(/“grid\.firm_capcity_mva” is not a field this registry knows/);
    expect(p.rows[2]!.reasons[0]).toMatch(/not a dotted path/);
    expect(p.counts).toMatchObject({ total: 3, new: 1, rejected: 2, writes: 1 });
  });
  it("the allow-list is the intake's expected fields plus any field already recorded for this hall, nothing else", () => {
    const m = allowedPaths([cur({ fieldPath: "busway.rating_a", unit: "A" })]);
    expect([...m.keys()].sort()).toEqual([...EXPECTED_HALL_FIELDS.map((f) => f.path), "busway.rating_a"].sort());
    expect(one({ field_path: "busway.rating_a", value: 800, unit: "A" }, [cur({ id: "c9", fieldPath: "busway.rating_a", value: 600, unit: "A" })]).status).toBe("supersede");
    expect(one({ field_path: "busway.rating_a", value: 800, unit: "A" }).status).toBe("rejected");
  });
  it("origin and class must be present and valid; as-of must be a real, plausible, non-future date", () => {
    expect(one({ origin: "" }).reasons.join()).toMatch(/origin is required/);
    expect(one({ origin: "guess" }).reasons.join()).toMatch(/not one of/);
    expect(one({ class: "" }).reasons.join()).toMatch(/class is required/);
    expect(one({ class: "E9" }).reasons.join()).toMatch(/not one of E0 to E7/);
    expect(one({ as_of: "" }).reasons.join()).toMatch(/as_of is required/);
    expect(one({ as_of: "2026-02-30" }).reasons.join()).toMatch(/not a date/);
    expect(one({ as_of: "07/11/2026" }).reasons.join()).toMatch(/not a date/);
    expect(one({ as_of: "1989-12-31" }).reasons.join()).toMatch(/too old/);
    expect(one({ as_of: "2026-11-09" }).reasons.join()).toMatch(/future/);
    expect(one({ as_of: "2026-11-08" }).status).toBe("new");            // the database allows tomorrow (time zones)
    expect(one({ as_of: "1990-01-01" }).status).toBe("new");
  });

  describe("the class caps the database enforces are rejected BEFORE submit, never lowered", () => {
    it("assumed and modelled cannot claim above E3, even with a file", () => {
      for (const origin of ["assumed", "modelled"]) {
        expect(one({ origin, class: "E3" }).status).toBe("new");
        const r = one({ origin, class: "E4", source_kind: "project", source_id: FILE_A });
        expect(r.status, origin).toBe("rejected");
        expect(r.reasons.join()).toMatch(/cannot claim a class above E3; E4 is refused/);
        expect(r.body).toBeNull();
      }
    });
    it("a vendor figure with no file cannot claim above E3; with a project file it can (the file's status is then the database's call)", () => {
      expect(one({ origin: "vendor", class: "E4" }).reasons.join()).toMatch(/vendor figure with no file/);
      const r = one({ origin: "vendor", class: "E4", source_kind: "project", source_id: FILE_A });
      expect(r.status).toBe("new");
      expect(r.needsDatabaseCheck).toBe(true);
    });
    it("measured, observed and quotation need a source file; with one they are accepted at E3 or below", () => {
      for (const origin of ["measured", "observed", "quotation"]) {
        const r = one({ origin, class: "E3" });
        expect(r.status, origin).toBe("rejected");
        expect(r.reasons.join()).toMatch(new RegExp(`${origin} figure needs a source file`));
        expect(one({ origin, class: "E3", source_kind: "intake", source_id: FILE_A }).status, origin).toBe("new");
      }
    });
    it("a purchased engagement's file supports E3 at most", () => {
      const r = one({ origin: "measured", class: "E5", source_kind: "intake", source_id: FILE_A });
      expect(r.status).toBe("rejected");
      expect(r.reasons.join()).toMatch(/not reviewable.*E3 at most; E5 is refused/);
    });
    it("a project file above E3 is judged by the review status the page KNOWS (from the hall's current figures), and is flagged when it cannot know", () => {
      const verified = cur({ id: "c2", fieldPath: "grid.current_site_peak_mw", unit: "MW", value: 10, origin: "measured", evidenceClass: "E5", source: { kind: "project_evidence", id: FILE_A, filename: "meter.pdf", reviewStatus: "verified" } });
      const pending = cur({ id: "c3", fieldPath: "hall.floor_loading_kpa", unit: "kPa", value: 12, origin: "measured", evidenceClass: "E3", source: { kind: "project_evidence", id: FILE_B, filename: "survey.pdf", reviewStatus: "unverified" } });
      const rejected = cur({ id: "c4", fieldPath: "hall.rack_positions", unit: null, value: 100, origin: "measured", evidenceClass: "E0", source: { kind: "project_evidence", id: "33333333-3333-4333-8333-333333333333", filename: "bad.pdf", reviewStatus: "rejected" } });
      const known = [verified, pending, rejected];
      const claim = { origin: "measured", class: "E5", source_kind: "project" };
      const ok = one({ ...claim, source_id: FILE_A }, known);
      expect(ok.status).toBe("new");
      expect(ok.needsDatabaseCheck).toBe(false);
      const notYet = one({ ...claim, source_id: FILE_B }, known);
      expect(notYet.status).toBe("rejected");
      expect(notYet.reasons.join()).toMatch(/needs a source file that has been reviewed and verified.*unverified/);
      const rej = one({ ...claim, class: "E1", source_id: "33333333-3333-4333-8333-333333333333" }, known);
      expect(rej.status).toBe("rejected");
      expect(rej.reasons.join()).toMatch(/reviewed and rejected/);
      const unseen = one({ ...claim, source_id: "44444444-4444-4444-8444-444444444444" }, known);
      expect(unseen.status).toBe("new");
      expect(unseen.needsDatabaseCheck).toBe(true);
      expect(unseen.warnings.join()).toMatch(/review status this page cannot see/);
      expect(one({ ...claim, class: "E3", source_id: "44444444-4444-4444-8444-444444444444" }, known).needsDatabaseCheck).toBe(false);   // E3 and below needs no review
    });
    it("a source id that is not a UUID, a kind that is not project or intake, and a half-given source are rejected", () => {
      expect(one({ origin: "measured", source_kind: "project", source_id: "meter.pdf" }).reasons.join()).toMatch(/not a file id/);
      expect(one({ origin: "measured", source_kind: "evidence", source_id: FILE_A }).reasons.join()).toMatch(/not project or intake/);
      expect(one({ origin: "measured", source_kind: "project" }).reasons.join()).toMatch(/both source_kind/);
      expect(one({ origin: "assumed", source_id: FILE_A }).reasons.join()).toMatch(/both source_kind/);
    });
    it("every refusal lists ALL of its reasons, not just the first", () => {
      const r = one({ origin: "assumed", class: "E6", unit: "kW", as_of: "2026-12-25" });
      expect(r.reasons.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe("missing", () => {
    const miss = { origin: "missing", value: null, unit: null, class: "E0" };
    it("a missing figure has no value, no unit, no source and class E0", () => {
      expect(one(miss).status).toBe("new");
      expect(one({ ...miss, value: 5 }).reasons.join()).toMatch(/has no value/);
      expect(one({ ...miss, class: "E2" }).reasons.join()).toMatch(/class E0/);
      expect(one({ ...miss, unit: "MW" }).reasons.join()).toMatch(/no unit/);
      expect(one({ ...miss, source_kind: "project", source_id: FILE_A }).reasons.join()).toMatch(/cites no source/);
    });
    it("any other origin needs a value", () => {
      expect(one({ value: null }).reasons.join()).toMatch(/Give a value/);
      expect(one({ value: "" }, [], true).reasons.join()).toMatch(/Give a value/);
    });
  });

  describe("values and units", () => {
    it("CSV values: a number is a number, true/false a boolean, anything else text; JSON values keep their type", () => {
      expect(one({ value: "30" }, [], true).body?.value).toBe(30);
      expect(one({ value: "-1.5e2", unit: "MW" }, [], true).body?.value).toBe(-150);
      expect(one({ field_path: "hall.mode", value: "true", unit: "" }, [cur({ id: "c5", fieldPath: "hall.mode", value: false, unit: null })], true).body?.value).toBe(true);
      expect(one({ value: "30" }, [], false).status).toBe("rejected");                                   // ...which a numeric field refuses
    });
    it("out-of-range, non-finite and hostile numbers are rejected", () => {
      for (const v of [1e16, -1e16, "1e999", "99999999999999999999"]) expect(one({ value: v }, [], typeof v === "string").status, String(v)).toBe("rejected");
      expect(one({ value: Number.POSITIVE_INFINITY }).status).toBe("rejected");
      expect(one({ value: Number.NaN }).status).toBe("rejected");
      expect(one({ value: "NaN" }, [], true).status).toBe("rejected");
      expect(one({ value: "Infinity" }, [], true).status).toBe("rejected");
      expect(one({ value: { a: 1 } }).reasons.join()).toMatch(/number, a short text or true\/false/);
      expect(one({ value: [1] }).status).toBe("rejected");
      expect(one({ value: 1e15 }).status).toBe("new");
    });
    it("a text value over 200 characters, or on a numeric field, is rejected; the reason names what it was read as", () => {
      expect(one({ value: "x".repeat(201) }, [], true).reasons.join()).toMatch(/at most 200/);
      expect(one({ value: "1,200" }, [], true).reasons.join()).toMatch(/grid\.contracted_mw is a number in MW; “1,200” is read as text/);
    });
    it("a unit is required where the field has one, must be the field's unit, and is never converted", () => {
      expect(one({ unit: "" }).reasons.join()).toMatch(/Give the unit: grid\.contracted_mw is recorded in MW/);
      expect(one({ unit: "kW" }).reasons.join()).toMatch(/not the unit.*MW.*does not convert/);
      expect(one({ unit: "mw" }).status).toBe("rejected");                  // case matters: mW and MW differ
      expect(one({ field_path: "hall.rack_positions", unit: "MW", value: 100 }).reasons.join()).toMatch(/recorded without a unit/);
      expect(one({ field_path: "hall.rack_positions", unit: "", value: 100 }).status).toBe("new");
    });
    it("a unit with a bad character or over 24 characters is rejected; a unit on text is rejected", () => {
      expect(one({ unit: "MW<script>" }).status).toBe("rejected");
      expect(one({ unit: "x".repeat(25) }).reasons.join()).toMatch(/24 characters/);
      expect(one({ field_path: "hall.note", value: "busway", unit: "m" }, [cur({ id: "c6", fieldPath: "hall.note", value: "old", unit: null })], true).reasons.join()).toMatch(/unit belongs only to a number/);
    });
    it("a negative capacity is allowed through but warned about", () => {
      const r = one({ value: -3 });
      expect(r.status).toBe("new");
      expect(r.warnings.join()).toMatch(/negative/);
    });
    it("a figure dated before the current one warns", () => {
      expect(one({ field_path: "grid.firm_capacity_mva", unit: "MVA", value: 41, as_of: "2025-01-01" }, [cur()]).warnings.join()).toMatch(/earlier than the current one/);
    });
  });

  it("a field twice in one file: the second is rejected naming the first row", () => {
    const p = buildPreview([row({ ...base }, 1), row({ ...base, value: 31 }, 2), row({ ...base, field_path: "GRID.CONTRACTED_MW" }, 3)], ctx());
    expect(p.rows.map((r) => r.status)).toEqual(["new", "rejected", "rejected"]);
    expect(p.rows[1]!.reasons[0]).toMatch(/already in row 1/);
    expect(p.rows[2]!.reasons[0]).toMatch(/already in row 1/);
  });
  it("a row the parser marked (wrong cell count, unknown key) is rejected with that message", () => {
    const r = buildPreview([{ n: 4, cells: { ...base }, fromCsv: true, error: "This row has 3 cells; the header has 8." }], ctx()).rows[0]!;
    expect(r.status).toBe("rejected");
    expect(r.n).toBe(4);
    expect(r.reasons[0]).toMatch(/3 cells/);
  });
  it(`a hall holds at most ${HALL_FIELD_LIMIT} fields: new fields beyond the limit are rejected, corrections still pass`, () => {
    const full = Array.from({ length: HALL_FIELD_LIMIT - 1 }, (_, i) => cur({ id: `f${i}`, fieldPath: `bulk.f${i}`, unit: null, value: i }));
    const p = buildPreview([row({ ...base }, 1), row({ ...base, field_path: "grid.current_site_peak_mw", unit: "MW" }, 2), row({ ...base, field_path: "bulk.f3", unit: "", value: 99 }, 3)], ctx(full));
    expect(p.rows.map((r) => r.status)).toEqual(["new", "rejected", "supersede"]);
    expect(p.rows[1]!.reasons[0]).toMatch(/at most 500 different fields/);
  });
  it("hostile cell content is data: it is shown shortened, control characters flattened, and never interpreted", () => {
    const r = one({ field_path: '<img src=x onerror=alert(1)>\n"; DROP TABLE hall_inputs;--', value: "x" }, [], true);
    expect(r.status).toBe("rejected");
    expect(r.fieldPath.length).toBeLessThanOrEqual(60);
    expect(r.shown.value).toBe("x");
    const long = one({ origin: "o".repeat(500) });
    expect(long.shown.origin.length).toBeLessThanOrEqual(16);
  });
  it("counts add up, and writes are exactly the new and superseding rows", () => {
    const p = buildPreview([row({ ...base }, 1), row({ ...base, field_path: "grid.firm_capacity_mva", unit: "MVA", value: 41 }, 2), row({ ...base, field_path: "grid.firm_capacity_mva" }, 3), row({ ...base, origin: "" }, 4)], ctx([cur()]));
    expect(p.counts).toEqual({ total: 4, new: 1, supersede: 1, unchanged: 0, rejected: 2, writes: 2, needDatabaseCheck: 0, flagged: 0 });
  });
  it("rows that rely on a file the page cannot check are written first", () => {
    const p = buildPreview([
      row({ ...base }, 1),
      row({ ...base, field_path: "grid.current_site_peak_mw", unit: "MW", origin: "measured", class: "E5", source_kind: "project", source_id: FILE_A }, 2),
      row({ ...base, field_path: "hall.floor_loading_kpa", unit: "kPa" }, 3),
    ], ctx());
    expect(writeOrder(p).map((r) => r.n)).toEqual([2, 1, 3]);
  });
});

describe("the template", () => {
  it("is generated from the allow-list: every expected field with its unit, no values, no origin, no real data", () => {
    const csv = importTemplateCsv();
    const p = parseImport(csv, "csv");
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.rows.map((r) => r.cells.field_path)).toEqual(EXPECTED_HALL_FIELDS.map((f) => f.path));
    expect(p.rows.every((r) => !r.cells.value && !r.cells.origin && !r.cells.class)).toBe(true);
    expect(csv).toContain("holds no real data");
    expect(csv.split("\n")[0]).toContain("# ");
    for (const c of IMPORT_COLUMNS) expect(csv).toContain(c);
    const j = parseImport(importTemplateJson(), "json");
    expect(j).toMatchObject({ ok: true });
    expect(j.ok && j.rows).toHaveLength(EXPECTED_HALL_FIELDS.length);
  });
  it("importing the unfilled template writes nothing: every row is rejected for the missing origin, class and date", () => {
    for (const [text, fmt] of [[importTemplateCsv(), "csv"], [importTemplateJson(), "json"]] as const) {
      const p = parseImport(text, fmt);
      expect(p.ok).toBe(true);
      if (!p.ok) continue;
      const prev = buildPreview(p.rows, ctx());
      expect(prev.counts.writes).toBe(0);
      expect(prev.counts.rejected).toBe(EXPECTED_HALL_FIELDS.length);
    }
  });
});

// ------------------------------------------------------------------------------------------------- the run

const plan = (n: number, fieldPath = `grid.f${n}`): RowPlan => ({
  n, status: "new", fieldPath, shown: { value: "", origin: "", evidenceClass: "", source: "", asOf: "" }, reasons: [], warnings: [], flags: [], replaces: null, needsDatabaseCheck: false,
  body: { fieldPath, value: n, unit: null, evidenceClass: "E1", origin: "assumed", asOf: "2026-10-01", projectEvidenceId: null, intakeEvidenceFileId: null, supersedes: null },
});
const created = (b: WriteBody): PostResult => ({ status: 201, body: { ok: true, id: `id-${b.fieldPath}`, input: { id: `id-${b.fieldPath}`, fieldPath: b.fieldPath } } });

describe("the run", () => {
  it("writes ONE row at a time, in order: a request is never started while the previous one is in flight", async () => {
    let inFlight = 0, peak = 0;
    const order: string[] = [];
    const r = await runImport([plan(1), plan(2), plan(3), plan(4)], {
      post: async (b) => { inFlight++; peak = Math.max(peak, inFlight); order.push(b.fieldPath); await new Promise((res) => setTimeout(res, 5)); inFlight--; return created(b); },
      sleep: async () => {},
    });
    expect(peak).toBe(1);
    expect(order).toEqual(["grid.f1", "grid.f2", "grid.f3", "grid.f4"]);
    expect(r).toMatchObject({ outcome: "complete", failed: null, notAttempted: [] });
    expect(r.written.map((w) => w.n)).toEqual([1, 2, 3, 4]);
  });
  it("sends exactly the previewed body to the existing route (explicit origin and class, supersedes when replacing)", async () => {
    const bodies: WriteBody[] = [];
    const p = plan(1);
    p.body!.supersedes = "old-id";
    await runImport([p], { post: async (b) => { bodies.push(b); return created(b); }, sleep: async () => {} });
    expect(bodies).toEqual([{ fieldPath: "grid.f1", value: 1, unit: null, evidenceClass: "E1", origin: "assumed", asOf: "2026-10-01", projectEvidenceId: null, intakeEvidenceFileId: null, supersedes: "old-id" }]);
  });
  it("a pause between writes is honoured when asked for", async () => {
    const sleeps: number[] = [];
    await runImport([plan(1), plan(2), plan(3)], { post: async (b) => created(b), sleep: async (ms) => { sleeps.push(ms); }, gapMs: 150 });
    expect(sleeps).toEqual([150, 150]);
  });

  describe("429: the allowance", () => {
    it("a short Retry-After is waited out and the SAME row is retried; nothing is skipped or duplicated", async () => {
      const sleeps: number[] = [];
      const calls: string[] = [];
      let throttled = 0;
      const progress: (number | null)[] = [];
      const r = await runImport([plan(1), plan(2), plan(3)], {
        post: async (b) => {
          calls.push(b.fieldPath);
          if (b.fieldPath === "grid.f2" && throttled < 2) { throttled++; return { status: 429, body: { ok: false, error: "Too many requests.", retry_after_seconds: 7 }, retryAfter: 7 }; }
          return created(b);
        },
        sleep: async (ms) => { sleeps.push(ms); },
        onProgress: (p) => progress.push(p.waitingSeconds),
      });
      expect(calls).toEqual(["grid.f1", "grid.f2", "grid.f2", "grid.f2", "grid.f3"]);
      expect(sleeps).toEqual([7500, 7500]);
      expect(progress.filter((x) => x === 7)).toHaveLength(2);
      expect(r.outcome).toBe("complete");
      expect(r.written.map((w) => w.n)).toEqual([1, 2, 3]);
    });
    it("uses the body's retry_after_seconds when no header was read, and 60 s when neither", async () => {
      const sleeps: number[] = [];
      let n = 0;
      await runImport([plan(1)], { post: async (b) => (n++ < 2 ? { status: 429, body: n === 1 ? { retry_after_seconds: 3 } : {} } : created(b)), sleep: async (ms) => { sleeps.push(ms); } });
      expect(sleeps).toEqual([3500, 60500]);
    });
    it(`a wait over ${MAX_AUTO_WAIT_SECONDS} s is not waited out: the run stops, reports the row as not written, and lists the rest as not tried`, async () => {
      const sleeps: number[] = [];
      const r = await runImport([plan(1), plan(2), plan(3), plan(4)], {
        post: async (b) => (b.fieldPath === "grid.f3" ? { status: 429, body: { ok: false }, retryAfter: 3000 } : created(b)),
        sleep: async (ms) => { sleeps.push(ms); },
      });
      expect(sleeps).toEqual([]);
      expect(r.outcome).toBe("stopped");
      expect(r.written.map((w) => w.n)).toEqual([1, 2]);
      expect(r.failed).toMatchObject({ n: 3, status: 429, outcomeUnknown: false });
      expect(r.failed!.message).toMatch(/allowance for writes is used up \(120 an hour.*about 50 minutes.*this row was not written/);
      expect(r.notAttempted).toEqual([{ n: 4, fieldPath: "grid.f4" }]);
    });
    it("gives up after three waits on one row rather than looping", async () => {
      let calls = 0;
      const r = await runImport([plan(1), plan(2)], { post: async () => { calls++; return { status: 429, body: {}, retryAfter: 2 }; }, sleep: async () => {} });
      expect(calls).toBe(4);                                   // the first try and three retries
      expect(r.outcome).toBe("stopped");
      expect(r.failed).toMatchObject({ n: 1, status: 429 });
      expect(r.notAttempted).toEqual([{ n: 2, fieldPath: "grid.f2" }]);
    });
  });

  describe("stop on the first failure and say exactly what happened", () => {
    it("a server refusal at row 3 of 5: rows 1-2 written, row 3 failed with the server's reason, rows 4-5 never tried", async () => {
      const calls: number[] = [];
      const r = await runImport([plan(1), plan(2), plan(3), plan(4), plan(5)], {
        post: async (b) => {
          calls.push(b.value as number);
          return b.value === 3 ? { status: 400, body: { ok: false, error: "A class above E3 needs a project file that has been reviewed and verified.", reason: "invalid_input" } } : created(b);
        },
        sleep: async () => {},
      });
      expect(calls).toEqual([1, 2, 3]);
      expect(r.outcome).toBe("stopped");
      expect(r.written.map((w) => [w.n, w.id])).toEqual([[1, "id-grid.f1"], [2, "id-grid.f2"]]);
      expect(r.failed).toEqual({ n: 3, fieldPath: "grid.f3", status: 400, outcomeUnknown: false, message: "A class above E3 needs a project file that has been reviewed and verified." });
      expect(r.notAttempted).toEqual([{ n: 4, fieldPath: "grid.f4" }, { n: 5, fieldPath: "grid.f5" }]);
      const total = r.written.length + (r.failed ? 1 : 0) + r.notAttempted.length;
      expect(total).toBe(5);
    });
    it("the first issue the server names is added to the message", async () => {
      const r = await runImport([plan(1)], { post: async () => ({ status: 400, body: { error: "Some fields are not valid.", issues: [{ field: "value", message: "That number is out of range." }] } }), sleep: async () => {} });
      expect(r.failed!.message).toBe("Some fields are not valid. value: That number is out of range.");
    });
    it("a stale supersede (someone recorded the field after the preview) says so", async () => {
      for (const reason of ["superseded", "field_already_recorded"]) {
        const r = await runImport([plan(1)], { post: async () => ({ status: 409, body: { ok: false, error: "Someone corrected this figure first. Reload and try again.", reason } }), sleep: async () => {} });
        expect(r.failed!.message).toMatch(/after the preview was made.*preview again/);
      }
    });
    it("a refused sign-in or role is reported, not retried", async () => {
      let calls = 0;
      const r401 = await runImport([plan(1), plan(2)], { post: async () => { calls++; return { status: 401, body: { ok: false, error: "x" } }; }, sleep: async () => {} });
      expect(calls).toBe(1);
      expect(r401.failed!.message).toMatch(/Sign in again/);
      const r403 = await runImport([plan(1)], { post: async () => ({ status: 403, body: { ok: false, error: "Your role in that organisation does not allow this." } }), sleep: async () => {} });
      expect(r403.failed).toMatchObject({ status: 403, message: "Your role in that organisation does not allow this." });
      expect(r403.written).toEqual([]);
    });
    it("a request that never completed is reported as outcome UNKNOWN, with nothing after it tried", async () => {
      const r = await runImport([plan(1), plan(2), plan(3)], { post: async (b) => { if (b.value === 2) throw new Error("socket hang up"); return created(b); }, sleep: async () => {} });
      expect(r.outcome).toBe("stopped");
      expect(r.written.map((w) => w.n)).toEqual([1]);
      expect(r.failed).toMatchObject({ n: 2, status: null, outcomeUnknown: true });
      expect(r.failed!.message).toMatch(/result of this row is unknown.*check the hall's figures before importing again/);
      expect(r.notAttempted).toEqual([{ n: 3, fieldPath: "grid.f3" }]);
    });
    it("a 2xx that is not the route's {ok:true} answer is not counted as written", async () => {
      const r = await runImport([plan(1)], { post: async () => ({ status: 200, body: { ok: false } }), sleep: async () => {} });
      expect(r.written).toEqual([]);
      expect(r.failed).toMatchObject({ n: 1, status: 200, outcomeUnknown: true });
    });
    it("cancelling stops before the next row and lists the rest as not tried (no failure)", async () => {
      let cancel = false;
      const r = await runImport([plan(1), plan(2), plan(3)], { post: async (b) => { if (b.value === 1) cancel = true; return created(b); }, sleep: async () => {}, isCancelled: () => cancel });
      expect(r.outcome).toBe("cancelled");
      expect(r.written.map((w) => w.n)).toEqual([1]);
      expect(r.failed).toBeNull();
      expect(r.notAttempted.map((x) => x.n)).toEqual([2, 3]);
    });
    it("cancelling during a 429 wait does not retry the row", async () => {
      let cancel = false;
      let calls = 0;
      const r = await runImport([plan(1)], { post: async () => { calls++; return { status: 429, body: {}, retryAfter: 5 }; }, sleep: async () => { cancel = true; }, isCancelled: () => cancel });
      expect(calls).toBe(1);
      expect(r.outcome).toBe("cancelled");
      expect(r.notAttempted).toEqual([{ n: 1, fieldPath: "grid.f1" }]);
    });
  });

  it("nothing is written by previewing: buildPreview and writeOrder take no post function at all", () => {
    expect(buildPreview.length).toBe(2);
    expect(writeOrder.length).toBe(1);
  });
});


// ------------------------------------------------------------------------------------------------- rework: results that are not known, provenance, hostile values

const hold = (over: Partial<RegistryInput> & { fieldPath: string }): RegistryInput => cur({ id: `h-${over.fieldPath}`, ...over });

describe("a result that is not known is never reported as 'not written'", () => {
  it.each([[500], [502], [503], [504], [408], [599]])("a %i is an unknown outcome", (status) => {
    expect(outcomeUnknown({ status, body: { ok: false, error: "The site registry is unavailable just now. Nothing was changed." } })).toBe(true);
  });
  it("a success that is not the route's own 201 {ok:true} is unknown too (an unreadable body reaches the page as {})", () => {
    for (const r of [{ status: 201, body: {} }, { status: 201, body: { ok: false } }, { status: 201, body: null }, { status: 200, body: { ok: true } }, { status: 204, body: {} }]) expect(outcomeUnknown(r), JSON.stringify(r)).toBe(true);
    expect(outcomeUnknown({ status: 201, body: { ok: true, id: "x" } })).toBe(false);
  });
  it.each([[400], [401], [403], [404], [409], [413], [422], [429]])("a %i is a refusal, not an unknown", (status) => {
    expect(outcomeUnknown({ status, body: { ok: false } })).toBe(false);
  });
  it("a 503 after the commit: the run stops, says the result is UNKNOWN, never 'Nothing was changed', and the rest are not tried", async () => {
    const r = await runImport([plan(1), plan(2), plan(3)], {
      post: async (b) => (b.value === 2 ? { status: 503, body: { ok: false, error: "The site registry is unavailable just now. Nothing was changed." } } : created(b)),
      sleep: async () => {},
    });
    expect(r.outcome).toBe("stopped");
    expect(r.written.map((w) => w.n)).toEqual([1]);
    expect(r.failed).toMatchObject({ n: 2, status: 503, outcomeUnknown: true });
    expect(r.failed!.message).toContain(UNKNOWN_MESSAGE);
    expect(r.failed!.message).not.toMatch(/Nothing was changed|NOT written|not written/i);
    expect(r.notAttempted).toEqual([{ n: 3, fieldPath: "grid.f3" }]);
  });
  it("a 201 whose body could not be read is NOT counted as written (this is what `status === 201` alone would get wrong)", async () => {
    const r = await runImport([plan(1), plan(2)], { post: async () => ({ status: 201, body: {} }), sleep: async () => {} });
    expect(r.written).toEqual([]);
    expect(r.failed).toMatchObject({ n: 1, status: 201, outcomeUnknown: true });
    expect(r.notAttempted).toEqual([{ n: 2, fieldPath: "grid.f2" }]);
  });
  it("a thrown request and an unknown status read the same", async () => {
    const thrown = await runImport([plan(1)], { post: async () => { throw new Error("reset"); }, sleep: async () => {} });
    expect(thrown.failed).toMatchObject({ status: null, outcomeUnknown: true, message: UNKNOWN_MESSAGE });
  });

  describe("after any stop the hall is read again and the report says which rows actually landed", () => {
    const landedRow = (n: number, over: Record<string, unknown> = {}): RegistryInput => cur({ id: `new-${n}`, fieldPath: `grid.f${n}`, value: n, unit: null, origin: "assumed", evidenceClass: "E1", asOf: "2026-10-01", ...over });
    it("an answer lost after the commit: the failed row is reported as IN the hall, the others as not", async () => {
      const r = await runImport([plan(1), plan(2), plan(3)], {
        post: async (b) => (b.value === 2 ? { status: 502, body: {} } : created(b)),
        sleep: async () => {},
        verify: async () => [landedRow(1), landedRow(2)],
      });
      expect(r.afterStop).toMatchObject({ read: true, landed: [2], absent: [3] });
    });
    it("a refusal (409, 400, 429): verify runs too, and a row that did not land is absent", async () => {
      for (const status of [409, 400, 429]) {
        let verified = 0;
        const r = await runImport([plan(1), plan(2)], {
          post: async (b) => (b.value === 2 ? { status, body: { ok: false, reason: "superseded" }, retryAfter: 4000 } : created(b)),
          sleep: async () => {},
          verify: async () => { verified++; return [landedRow(1)]; },
        });
        expect(verified, String(status)).toBe(1);
        expect(r.afterStop).toMatchObject({ read: true, landed: [], absent: [2] });
        expect(r.afterStop!.current!.map((i) => i.fieldPath)).toEqual(["grid.f1"]);       // handed back so the page's table is not stale
      }
    });
    it("a figure with the same path but different content, or the superseded old one, is not 'landed'", async () => {
      const p = plan(2);
      p.body!.supersedes = "old";
      const r = await runImport([p], {
        post: async () => ({ status: 503, body: {} }), sleep: async () => {},
        verify: async () => [landedRow(2, { id: "old", value: 2 })],
      });
      expect(r.afterStop).toMatchObject({ landed: [], absent: [2] });
      const r2 = await runImport([plan(2)], { post: async () => ({ status: 503, body: {} }), sleep: async () => {}, verify: async () => [landedRow(2, { value: 99 })] });
      expect(r2.afterStop).toMatchObject({ landed: [], absent: [2] });
    });
    it("a hall that cannot be read again says so; no verify at all means no claim; success and cancel never verify", async () => {
      const bad = await runImport([plan(1)], { post: async () => ({ status: 503, body: {} }), sleep: async () => {}, verify: async () => null });
      expect(bad.afterStop).toEqual({ read: false, landed: [], absent: [], current: null });
      const thrown = await runImport([plan(1)], { post: async () => ({ status: 503, body: {} }), sleep: async () => {}, verify: async () => { throw new Error("x"); } });
      expect(thrown.afterStop?.read).toBe(false);
      expect((await runImport([plan(1)], { post: async () => ({ status: 503, body: {} }), sleep: async () => {} })).afterStop).toBeNull();
      let calls = 0;
      const ok = await runImport([plan(1)], { post: async (b) => created(b), sleep: async () => {}, verify: async () => { calls++; return []; } });
      expect(ok.afterStop).toBeNull();
      expect(calls).toBe(0);
    });
  });
});

describe("the preview: the file's ids, characters and numbers", () => {
  const known = (id: string, reviewStatus: string, kind = "project_evidence") => hold({ fieldPath: "grid.current_site_peak_mw", unit: "MW", value: 10, origin: "measured", evidenceClass: "E3", source: { kind, id, filename: "f.pdf", reviewStatus } });
  it("a source id is the same id in any letter case: a known rejected or unverified file is caught whatever case the file writes it in", () => {
    const upper = HEX_A.toUpperCase();
    expect(upper).not.toBe(HEX_A);
    const claim = { origin: "measured", class: "E5", source_kind: "project", source_id: upper };
    const rejected = one({ ...claim, class: "E1" }, [known(HEX_A, "rejected")]);
    expect(rejected.status).toBe("rejected");
    expect(rejected.reasons.join()).toMatch(/reviewed and rejected/);
    const unverified = one(claim, [known(HEX_A, "unverified")]);
    expect(unverified.status).toBe("rejected");
    expect(unverified.reasons.join()).toMatch(/reviewed and verified/);
    const verified = one(claim, [known(HEX_A, "verified")]);
    expect(verified.status).toBe("new");
    expect(verified.needsDatabaseCheck).toBe(false);
    expect(verified.body?.projectEvidenceId).toBe(HEX_A);                        // the body carries the lower-case form
    expect(one({ ...claim, source_id: HEX_A }, [known(HEX_A.toUpperCase(), "rejected")]).status).toBe("rejected");        // and a known id written in upper case matches a lower-case claim
  });
  it("the unchanged comparison is case-blind for the file id too", () => {
    const current = cur({ origin: "vendor", evidenceClass: "E2", source: { kind: "intake_evidence", id: HEX_A, filename: "q.pdf", reviewStatus: null } });
    const row = { origin: "vendor", class: "E2", unit: "MVA", value: 40, as_of: "2026-01-15", field_path: "grid.firm_capacity_mva", source_kind: "intake" };
    expect(one({ ...row, source_id: HEX_A.toUpperCase() }, [current]).status).toBe("unchanged");
    expect(one({ ...row, source_id: HEX_A }, [{ ...current, source: { ...current.source!, id: HEX_A.toUpperCase() } }]).status).toBe("unchanged");
    expect(one({ ...row, source_id: HEX_B }, [current]).status).toBe("supersede");
  });
  it("a file id the page knows as the other kind of file is rejected, in both directions", () => {
    const asIntake = known(FILE_A, "unverified", "intake_evidence");
    const r1 = one({ origin: "measured", class: "E3", source_kind: "project", source_id: FILE_A }, [asIntake]);
    expect(r1.status).toBe("rejected");
    expect(r1.reasons.join()).toMatch(/other kind of file; check source_kind/);
    const asProject = known(FILE_A, "verified");
    const r2 = one({ origin: "measured", class: "E3", source_kind: "intake", source_id: FILE_A }, [asProject]);
    expect(r2.status).toBe("rejected");
    expect(r2.reasons.join()).toMatch(/other kind of file/);
    expect(one({ origin: "measured", class: "E3", source_kind: "project", source_id: FILE_A }, [asProject]).status).toBe("new");
  });
  it("class and origin are accepted in any letter case and sent upper and lower case as the database wants them", () => {
    const r = one({ origin: "MEASURED", class: "e3", source_kind: "INTAKE", source_id: FILE_A });
    expect(r.status).toBe("new");
    expect(r.body).toMatchObject({ origin: "measured", evidenceClass: "E3", intakeEvidenceFileId: FILE_A });
    expect(one({ class: "e5", origin: "assumed" }).reasons.join()).toMatch(/cannot claim a class above E3; E5 is refused/);     // the cap sees the class however it is cased
    expect(one({ class: " e1 " }).body?.evidenceClass).toBe("E1");
  });

  describe("text with control, zero-width or direction-changing characters is refused with its reason", () => {
    const text = (v: string, fromCsv = true) => one({ field_path: "hall.note", value: v, unit: "" }, [hold({ fieldPath: "hall.note", unit: null, value: "old" })], fromCsv);
    it.each([["NUL", "a\u0000b"], ["escape", "a\u001bb"], ["DEL", "a\u007fb"], ["C1", "a\u0085b"], ["zero-width space", "a\u200bb"], ["zero-width joiner", "a\u200db"], ["LRM", "a\u200eb"],
      ["right-to-left override", "a\u202eb"], ["isolate", "a\u2066b"], ["pop isolate", "a\u2069b"], ["word joiner", "a\u2060b"], ["BOM", "a\ufeffb"], ["line separator", "a\u2028b"], ["newline inside", "a\nb"]])("%s", (_n, v) => {
      for (const csvFlag of [true, false]) {
        const r = text(v, csvFlag);
        expect(r.status, `${_n} csv=${csvFlag}`).toBe("rejected");
        expect(r.reasons.join()).toMatch(/control, zero-width or direction-changing character/);
      }
    });
    it("ordinary text, accents and CJK are fine", () => {
      for (const v of ["busway", "Zürich", "日本語", "a b"]) expect(text(v).status, v).toBe("supersede");
    });
  });

  describe("numbers that cannot be stored faithfully are refused, not rounded", () => {
    it("numberLiteralProblem", () => {
      expect(numberLiteralProblem("1e-400", 0)).toMatch(/too small/);
      expect(numberLiteralProblem("0.000e-400", 0)).toBeNull();                  // a literal zero is zero
      expect(numberLiteralProblem("0", 0)).toBeNull();
      expect(numberLiteralProblem("1e-320", 1e-320)).toMatch(/too small/);       // subnormal
      expect(numberLiteralProblem("0.1234567890123456789", 0.12345678901234568)).toMatch(/more than 15 significant digits/);
      expect(numberLiteralProblem("1234567890.12345", 1234567890.12345)).toBeNull();      // exactly 15
      expect(numberLiteralProblem("1234567890.123456", 1234567890.123456)).toMatch(/15 significant/);
      expect(numberLiteralProblem("100000", 100000)).toBeNull();
      expect(numberLiteralProblem("-0.30000000000000004", -0.30000000000000004)).toMatch(/15 significant/);
      expect(numberLiteralProblem("1.5e3", 1500)).toBeNull();
    });
    it("in a CSV the row is rejected with that reason", () => {
      for (const [v, re] of [["1e-400", /too small/], ["0.1234567890123456789", /15 significant/], ["1e-320", /too small/]] as const) {
        const r = one({ value: v }, [], true);
        expect(r.status, v).toBe("rejected");
        expect(r.reasons.join()).toMatch(re);
      }
      for (const v of ["0.1", "30", "1234567890.12345", "0", "-0.5", "1.5e3"]) expect(one({ value: v }, [], true).status, v).toBe("new");
    });
    it("in a JSON file the number as WRITTEN is checked (where the engine exposes it), so 1e-400 is not silently 0", () => {
      const text = `[{"field_path":"grid.contracted_mw","value":1e-400,"unit":"MW","origin":"assumed","class":"E1","as_of":"2026-10-01"},
        {"field_path":"grid.firm_capacity_mva","value":0.1234567890123456789,"unit":"MVA","origin":"assumed","class":"E1","as_of":"2026-10-01"},
        {"field_path":"hall.rack_positions","value":120,"origin":"assumed","class":"E1","as_of":"2026-10-01"}]`;
      const p = parseImport(text, "json");
      expect(p.ok).toBe(true);
      if (!p.ok) return;
      const prev = buildPreview(p.rows, ctx());
      expect(prev.rows.map((r) => r.status)).toEqual(["rejected", "rejected", "new"]);
      expect(prev.rows[0]!.reasons.join()).toMatch(/too small/);
      expect(prev.rows[1]!.reasons.join()).toMatch(/15 significant/);
    });
  });
});

describe("comment lines are counted, not silently lost", () => {
  it("parseImport reports how many lines of a CSV were skipped, and the preview carries the count", () => {
    const p = parseImport(`# a\n# b\n${CSV_HEAD}\n# c\ngrid.contracted_mw,30,MW,assumed,E1,2026-10-01,,\n`, "csv");
    expect(p).toMatchObject({ ok: true, commentLines: 3 });
    if (!p.ok) return;
    expect(buildPreview(p.rows, ctx(), p.commentLines).commentLines).toBe(3);
    expect(buildPreview(p.rows, ctx()).commentLines).toBe(0);
    expect(parseImport(importTemplateCsv(), "csv")).toMatchObject({ commentLines: 6 });
    expect(parseImport("[]", "json")).toMatchObject({ ok: false });
    const j = parseImport(`[${JSON.stringify(base)}]`, "json");
    expect(j).toMatchObject({ ok: true, commentLines: 0 });
  });
});

describe("a replacement that changes a field's provenance is flagged, apart from an ordinary correction", () => {
  const row = (cells: Record<string, unknown>, current = [cur()]) => one({ field_path: "grid.firm_capacity_mva", unit: "MVA", value: 40, ...cells }, current);
  it("a raised declared class is flagged", () => {
    const r = row({ class: "E3" });
    expect(r.status).toBe("supersede");
    expect(r.flags).toEqual(["Raises the declared class E1 → E3."]);
  });
  it("a lowered or equal class is not", () => {
    expect(row({ class: "E0", as_of: "2026-10-01" }).flags).toEqual([]);
    expect(row({ value: 41 }).flags).toEqual([]);                                               // an ordinary correction of a number
  });
  it("a changed declared origin is flagged, with both origins named", () => {
    const r = row({ origin: "vendor" });
    expect(r.flags).toEqual(["Changes the declared origin: declared assumed → declared vendor."]);
    const both = row({ origin: "modelled", class: "E3", value: 41 });
    expect(both.flags).toEqual(["Raises the declared class E1 → E3.", "Changes the declared origin: declared assumed → declared modelled."]);
  });
  it("withdrawing a figure (replacing it with missing) is flagged, with what it was", () => {
    const r = row({ origin: "missing", value: null, unit: null, class: "E0" });
    expect(r.status).toBe("supersede");
    expect(r.flags).toContain("Withdraws the figure: 40 MVA will read as missing.");
  });
  it("a first figure, a rejected row and an unchanged row carry no flags; recording over a missing figure is not a withdrawal", () => {
    expect(one({}).flags).toEqual([]);
    expect(row({ class: "E9" }).flags).toEqual([]);
    expect(row({ value: 40, unit: "MVA", class: "E1", as_of: "2026-01-15" }).flags).toEqual([]);
    const gap = hold({ fieldPath: "grid.firm_capacity_mva", origin: "missing", value: null, unit: null, evidenceClass: "E0" });
    expect(row({ class: "E2" }, [gap]).flags).toEqual(["Raises the declared class E0 → E2.", "Changes the declared origin: missing → declared assumed."]);
    expect(row({ class: "E0" }, [gap]).flags.join()).not.toMatch(/Withdraws/);
  });
  it("the preview counts the flagged rows", () => {
    const p = buildPreview([
      row0(1, { class: "E3" }), row0(2, { value: 41, field_path: "grid.contracted_mw", unit: "MW" }), row0(3, { origin: "vendor", field_path: "grid.current_site_peak_mw", unit: "MW" }),
    ], ctx([cur(), cur({ id: "k2", fieldPath: "grid.contracted_mw", unit: "MW" }), cur({ id: "k3", fieldPath: "grid.current_site_peak_mw", unit: "MW" })]));
    expect(p.counts).toMatchObject({ supersede: 3, flagged: 2 });
    function row0(n: number, cells: Record<string, unknown>): RawRow { return { n, fromCsv: false, cells: { field_path: "grid.firm_capacity_mva", value: 40, unit: "MVA", origin: "assumed", class: "E1", as_of: "2026-10-01", ...cells } }; }
  });
  it("provenanceFlags works on the body that would be sent", () => {
    const body: WriteBody = { fieldPath: "grid.firm_capacity_mva", value: 44, unit: "MVA", evidenceClass: "E5", origin: "measured", asOf: "2026-10-01", projectEvidenceId: FILE_A, intakeEvidenceFileId: null, supersedes: "c1" };
    expect(provenanceFlags(cur(), body)).toEqual(["Raises the declared class E1 → E5.", "Changes the declared origin: declared assumed → declared measured."]);
  });
});

describe("a row is UNCHANGED only if value, unit, origin, class, source and date all match; any one difference is a replacement", () => {
  const row = { field_path: "grid.firm_capacity_mva", value: 40, unit: "MVA", origin: "assumed", class: "E1", as_of: "2026-01-15" };
  it("the baseline is unchanged", () => { expect(one(row, [cur()], false).status).toBe("unchanged"); });
  it.each([
    ["value", { value: 41 }],
    ["class (the same number at a changed class)", { class: "E2" }],
    ["origin", { origin: "vendor" }],
    ["as-of date", { as_of: "2026-01-16" }],
  ])("a different %s is a supersede", (_n, change) => {
    const r = one({ ...row, ...change }, [cur()], false);
    expect(r.status).toBe("supersede");
    expect(r.body?.supersedes).toBe("c1");
  });
  it("a different unit on the recorded figure is a supersede (the recorded unit was another)", () => {
    expect(one(row, [cur({ unit: "kVA" })], false).status).toBe("supersede");
    expect(one(row, [cur({ unit: null })], false).status).toBe("supersede");
  });
  it("a different source is a supersede; the same source (in any letter case) is unchanged; adding or dropping a file is a supersede", () => {
    const withFile = (id: string | null) => cur({ origin: "vendor", evidenceClass: "E2", source: id ? { kind: "intake_evidence", id, filename: "q.pdf", reviewStatus: null } : null });
    const v = { ...row, origin: "vendor", class: "E2" };
    expect(one({ ...v, source_kind: "intake", source_id: FILE_A }, [withFile(FILE_A)], false).status).toBe("unchanged");
    expect(one({ ...v, source_kind: "intake", source_id: FILE_B }, [withFile(FILE_A)], false).status).toBe("supersede");
    expect(one({ ...v, source_kind: "intake", source_id: FILE_A }, [withFile(null)], false).status).toBe("supersede");
    expect(one(v, [withFile(FILE_A)], false).status).toBe("supersede");
  });
});

describe("error text stays short", () => {
  it("a header of many unknown columns names the first five and counts the rest", () => {
    const cols = Array.from({ length: 12 }, (_, i) => `x${i}`);
    const p = parseImport(`${cols.join(",")}\n1`, "csv");
    expect(p).toMatchObject({ ok: false });
    if (p.ok) return;
    expect(p.error).toContain("“x0”, “x1”, “x2”, “x3”, “x4”");
    expect(p.error).toContain("and 7 more");
    expect(p.error).not.toContain("x5");
    expect(p.error.length).toBeLessThan(300);
    const j = parseImport(JSON.stringify({ rows: [], ...Object.fromEntries(cols.map((c) => [c, 1])) }), "json");
    expect(j.ok === false && j.error).toContain("and 7 more");
    const longName = parseImport(`${"y".repeat(5000)}\n1`, "csv");
    expect(longName.ok === false && longName.error.length).toBeLessThan(300);
    const rowKeys = parseImport(JSON.stringify([{ ...base, ...Object.fromEntries(cols.map((c) => [c, 1])) }]), "json");
    expect(rowKeys.ok && rowKeys.rows[0]!.error).toContain("and 7 more");
  });
});
