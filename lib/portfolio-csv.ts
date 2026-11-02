// The Portfolio Screen's hall list, as a buyer fills it in: one row per hall, one column per figure. Pure and shared by the form (to
// show what was understood before anything is sent) and by the tests; the SERVER still validates everything with portfolioIntakeSchema.

export interface PortfolioColumn {
  key: string;
  label: string;
  unit: string;
  required: boolean;
  kind: "text" | "number" | "platform";
  from: string;
}

/** Columns in template order. Required = what the free qualifier needs; the three optional ones become named assumptions per hall. */
export const PORTFOLIO_COLUMNS: PortfolioColumn[] = [
  { key: "siteName", label: "Site name", unit: "", required: true, kind: "text", from: "you" },
  { key: "hallId", label: "Hall id", unit: "", required: true, kind: "text", from: "you" },
  { key: "metro", label: "Metro", unit: "", required: false, kind: "text", from: "you" },
  { key: "country", label: "Country", unit: "", required: false, kind: "text", from: "you" },
  { key: "contractedMW", label: "Contracted grid capacity", unit: "MW", required: true, kind: "number", from: "the supply contract" },
  { key: "currentPeakMW", label: "Current site peak demand", unit: "MW", required: true, kind: "number", from: "metering or operations" },
  { key: "currentItLoadMW", label: "Current IT load", unit: "MW", required: true, kind: "number", from: "metering or operations" },
  { key: "buswayAmpacityA", label: "Busway ampacity", unit: "A", required: true, kind: "number", from: "the LV distribution schedule" },
  { key: "tapoffMaxA", label: "Largest tap-off rating", unit: "A", required: true, kind: "number", from: "the LV distribution schedule" },
  { key: "positionsAvailable", label: "Rack positions available", unit: "", required: true, kind: "number", from: "the hall layout" },
  { key: "plantSupplyC", label: "Chilled-water design supply temperature", unit: "°C", required: true, kind: "number", from: "the mechanical schedule" },
  { key: "firmCapacityMVA", label: "Firm connection capacity", unit: "MVA", required: false, kind: "number", from: "the DSO connection agreement" },
  { key: "floorLoadingKPa", label: "Floor loading", unit: "kPa", required: false, kind: "number", from: "the structural record" },
  { key: "plantCapacityKW", label: "Chilled-water plant capacity", unit: "kW", required: false, kind: "number", from: "the mechanical schedule" },
  { key: "platform", label: "Platform to deploy", unit: "", required: false, kind: "platform", from: "your plan (gb300_nvl72, gb200_nvl72 or generic_dlc_50; blank = gb300_nvl72)" },
];

const BY_KEY = new Map(PORTFOLIO_COLUMNS.map((c) => [c.key, c]));
const MAX_CELLS = 15 * 40; // a bound on what is parsed, far above any real hall list

export const portfolioTemplate = (): string => PORTFOLIO_COLUMNS.map((c) => c.key).join(",") + "\n";

/** RFC 4180-style rows: quoted cells may hold commas, quotes ("") and newlines. Tabs separate cells when the paste came from a spreadsheet. */
export function splitRows(text: string): string[][] {
  const delim = text.includes("\t") && !text.split("\n")[0].includes(",") ? "\t" : ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"' && cell === "") quoted = true;
    else if (ch === delim) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

export interface ParsedPortfolio {
  halls: Record<string, string | number>[];
  /** Problems found before anything is sent: an unknown column, a missing one, a cell that is not a number. */
  errors: string[];
}

export function parsePortfolioCsv(text: string): ParsedPortfolio {
  const errors: string[] = [];
  const rows = splitRows(text.replace(/^﻿/, ""));
  if (rows.length === 0) return { halls: [], errors: ["Paste the hall list, or load a CSV file."] };
  const header = rows[0].map((h) => h.trim());
  if (header.length * rows.length > MAX_CELLS) return { halls: [], errors: ["That is more than a portfolio of this size can hold."] };
  const unknown = header.filter((h) => h && !BY_KEY.has(h));
  if (unknown.length) errors.push(`Unknown column${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}. Use the template's column names.`);
  const missing = PORTFOLIO_COLUMNS.filter((c) => c.required && !header.includes(c.key)).map((c) => c.key);
  if (missing.length) errors.push(`Missing required column${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}.`);
  const dup = header.filter((h, i) => h && header.indexOf(h) !== i);
  if (dup.length) errors.push(`Repeated column: ${[...new Set(dup)].join(", ")}.`);
  const halls: Record<string, string | number>[] = [];
  rows.slice(1).forEach((r, ri) => {
    const hall: Record<string, string | number> = {};
    header.forEach((key, ci) => {
      const col = BY_KEY.get(key);
      const raw = (r[ci] ?? "").trim();
      if (!col || raw === "") return;
      if (col.kind === "number") {
        const n = Number(raw.replace(/,/g, ""));
        if (!Number.isFinite(n)) errors.push(`Hall ${ri + 1}, ${key}: "${raw}" is not a number.`);
        else hall[key] = n;
      } else hall[key] = raw;
    });
    halls.push(hall);
  });
  return { halls, errors };
}
