// CSV for the site registry's export and import: RFC 4180 quoting both ways, and a spreadsheet-safe writer.
// Plain functions, no I/O, no server imports.
//
// FORMULA INJECTION. A spreadsheet treats a cell that starts with = + - @ (and, in some programs, a tab or a carriage return) as a formula, and a
// recorded value, a file name or a hall label is text somebody typed. The writer therefore puts an apostrophe in front of any TEXT cell that starts with one
// of those characters, so the spreadsheet shows it as text. A cell that holds a real finite number is written as the number (a negative number is not
// a formula, and prefixing it would corrupt the figure). The apostrophe is part of the file, not of the figure: the JSON export carries the value untouched.

const FORMULA_START = /^[=+\-@\t\r]/;

/** One cell as it is written: text that could start a formula gets an apostrophe; quoting is added when the cell has a comma, a quote or a line break. */
export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  let s = typeof v === "string" ? v : String(v);
  if (FORMULA_START.test(s)) s = "'" + s;
  return /[",\r\n]|^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const csvLine = (cells: unknown[]): string => cells.map(csvCell).join(",");

/** Rows to a CSV document: CRLF line ends, a leading byte-order mark so a spreadsheet reads the UTF-8, and a trailing line end. */
export const toCsv = (rows: unknown[][]): string => "﻿" + rows.map(csvLine).join("\r\n") + "\r\n";

/** `comments`: how many comment lines were skipped (a line that starts with #), so the caller can say so rather than let them vanish. */
export type CsvParse = { ok: true; rows: string[][]; tooMany: boolean; comments: number } | { ok: false; error: string };

/**
 * Parse CSV text. A leading byte-order mark is dropped; a line whose first character is # (outside quotes) is a comment and skipped; empty lines
 * are skipped. The cells are returned exactly as written (no trimming, no apostrophe removal). At most `maxRecords` records are read: past that
 * `tooMany` is true and nothing more is parsed, so a hostile file cannot make the parser run on.
 */
export function parseCsv(input: string, maxRecords = 1000): CsvParse {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;        // inside a quoted cell
  let quotedInRow = false;   // some cell of this record was quoted (so a record of one empty quoted cell is still a record)
  let atStart = true;        // at the first character of a record
  let line = 1;
  let comments = 0;
  let i = 0;
  const n = text.length;

  const endCell = () => { row.push(cell); cell = ""; };
  const endRecord = (): boolean => {
    endCell();
    const blank = row.length === 1 && row[0] === "" && !quotedInRow;
    const comment = row.length === 1 && row[0]!.startsWith("#");          // a comment written as a quoted cell (it had a comma in it)
    if (comment) comments++;
    if (!blank && !comment) rows.push(row);
    row = []; atStart = true; quotedInRow = false;
    return rows.length > maxRecords;
  };

  while (i < n) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i += 2; continue; }
        quoted = false; i++;
        const next = text[i];
        if (next !== undefined && next !== "," && next !== "\n" && next !== "\r") return { ok: false, error: `Line ${line}: a quoted cell must end at its closing quote (found “${next}” after it).` };
        continue;
      }
      if (ch === "\n") line++;
      cell += ch; i++; continue;
    }
    if (atStart && ch === "#") {                      // a comment line: to the end of the line
      while (i < n && text[i] !== "\n" && text[i] !== "\r") i++;
      comments++;
      continue;
    }
    atStart = false;
    if (ch === '"') {
      if (cell !== "") return { ok: false, error: `Line ${line}: a quote may only start a cell.` };
      quoted = true; quotedInRow = true; i++; continue;
    }
    if (ch === ",") { endCell(); i++; continue; }
    if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      i++; line++;
      if (endRecord()) return { ok: true, rows: rows.slice(0, maxRecords), tooMany: true, comments };
      continue;
    }
    cell += ch; i++;
  }
  if (quoted) return { ok: false, error: `Line ${line}: a quoted cell is never closed.` };
  if (!atStart) endRecord();
  return { ok: true, rows: rows.slice(0, maxRecords), tooMany: rows.length > maxRecords, comments };
}
