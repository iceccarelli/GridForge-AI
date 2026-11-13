/**
 * The list of calibration gates in code (lib/calibration-gates.ts) is pinned to the database view that actually enforces them, so the public
 * page and the administrator's checklist cannot say something the view does not.
 *
 * Two independent anchors:
 *   1. tests/test_calibration_final_gate.py: the keys of VIEW_GATES, which that test reads back out of a database built by the whole chain.
 *   2. the SQL of the migration that holds the FINAL view: every condition's `sql` fragment must appear in it.
 * The same files also pin the residual-report schema constants to the Python that produces the report.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  GATE_COUNT,
  GATE_COUNT_WORD,
  LEDGER_GATES,
  LEDGER_LIMITS,
  PUBLICATION_CONDITIONS,
  PUBLISHED_VARIABLES,
  RECORD_SHAPE,
  RESIDUAL_CELL_FIELDS,
  RESIDUAL_REQUIREMENTS,
  RESIDUAL_TOP_FIELDS,
  RESIDUAL_VARIABLE_FIELDS,
  RESIDUALS_SCHEMA,
  VIEW_CONDITIONS,
  VIEW_CONDITION_COUNT,
  VIEW_WHERE_TERMS,
  WITHHELD_VARIABLES,
  conditionsOf,
  type ViewCondition,
} from "@/lib/calibration-gates";
import { CalibrationTransparency } from "@/components/CalibrationTransparency";

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const flat = (s: string) => s.replace(/\s+/g, " ").toLowerCase();
const text = (html: string) => html.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&rsquo;/g, "'").replace(/\s+/g, " ").trim();

/** The migrations directory; GRIDFORGE_MIGRATIONS_DIR points at a scratch copy (as the Python rig's does) to watch a mutated view fail. */
const MIGRATIONS_DIR = process.env.GRIDFORGE_MIGRATIONS_DIR ?? path.join(ROOT, "supabase", "migrations");

/** Splits `text` on a keyword ` and ` that sits outside every parenthesis and string literal. */
function topLevelAnd(text: string): string[] {
  const parts: string[] = [];
  let depth = 0, quote = false, last = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "'") quote = !quote;
    else if (!quote && ch === "(") depth++;
    else if (!quote && ch === ")") depth--;
    else if (!quote && depth === 0 && text.startsWith(" and ", i)) {
      parts.push(text.slice(last, i));
      last = i + 5;
    }
  }
  parts.push(text.slice(last));
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** The top-level AND terms of the WHERE clause of the FINAL view in the migrations directory. */
function finalViewWhereTerms(): { file: string; terms: string[] } {
  const holders = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql") && readFileSync(path.join(MIGRATIONS_DIR, f), "utf8").includes("create or replace view public.calibration_ledger_rows")).sort();
  const file = holders[holders.length - 1];
  const sql = flat(readFileSync(path.join(MIGRATIONS_DIR, file), "utf8").split("\n").map((l) => l.replace(/--.*$/, "")).join("\n"));
  const from = sql.indexOf("create or replace view public.calibration_ledger_rows");
  const body = sql.slice(from, sql.indexOf(";", from));
  // the first top-level " where " (those inside exists( ... ) are deeper)
  let depth = 0, w = -1;
  for (let i = 0; i < body.length && w < 0; i++) {
    if (body[i] === "(") depth++;
    else if (body[i] === ")") depth--;
    else if (depth === 0 && body.startsWith(" where ", i)) w = i;
  }
  expect(w).toBeGreaterThan(-1);
  return { file, terms: topLevelAnd(body.slice(w + 7)) };
}

/** The keys of the VIEW_GATES dict in the Python test, in order. */
function pythonViewGateKeys(): string[] {
  const src = read("tests/test_calibration_final_gate.py");
  const start = src.indexOf("VIEW_GATES = {");
  const end = src.indexOf("\n}\n", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return [...src.slice(start, end).matchAll(/^ {4}"([^"]+)":/gm)].map((m) => m[1]);
}

/** What differs between the Python test's keys and a list of conditions; empty when they are the same set, each once. */
function drift(conditions: readonly ViewCondition[], keys: string[]): string[] {
  const labels = conditions.map((c) => c.label);
  const out: string[] = [];
  for (const k of keys) if (!labels.includes(k)) out.push(`in the view test, not in code: ${k}`);
  for (const l of labels) if (!keys.includes(l)) out.push(`in code, not in the view test: ${l}`);
  if (new Set(labels).size !== labels.length) out.push("duplicate label in code");
  return out;
}

describe("the gate list in code is the final view's, not a copy that can drift", () => {
  it("has exactly the conditions tests/test_calibration_final_gate.py asserts of the final view", () => {
    const keys = pythonViewGateKeys();
    expect(keys.length).toBeGreaterThanOrEqual(18);
    expect(drift(VIEW_CONDITIONS, keys)).toEqual([]);
    expect(VIEW_CONDITION_COUNT).toBe(keys.length);
  });

  it("the drift check bites: a condition removed from, or added to, the code list is reported", () => {
    const keys = pythonViewGateKeys();
    expect(drift(VIEW_CONDITIONS.slice(1), keys)).toEqual([`in the view test, not in code: ${VIEW_CONDITIONS[0].label}`]);
    expect(drift([...VIEW_CONDITIONS, { label: "an invented gate", group: "production_origin", sql: "x" }], keys)).toEqual(["in code, not in the view test: an invented gate"]);
    expect(drift(VIEW_CONDITIONS, [...keys, "a gate someone added to the view"])).toEqual(["in the view test, not in code: a gate someone added to the view"]);
  });

  it("every condition's SQL fragment appears in the migration that holds the FINAL view, and that migration is the last one that defines it", () => {
    const { file } = finalViewWhereTerms();
    // A later migration that redefines the view is a new decision: it must update this list (and the Python test), not slip by.
    expect(file.slice(0, 4)).toBe("0056");
    const sql = flat(readFileSync(path.join(MIGRATIONS_DIR, file), "utf8"));
    for (const c of VIEW_CONDITIONS) expect(sql, c.label).toContain(c.sql.toLowerCase());
  });

  it("the final view has no condition beyond the listed ones: its WHERE clause has exactly as many top-level AND terms as the list accounts for", () => {
    const { terms } = finalViewWhereTerms();
    expect(terms.length, terms.join("\n")).toBe(VIEW_WHERE_TERMS);
  });

  it("the term counter bites: a condition appended to, or removed from, a copy of the clause changes the count", () => {
    const { terms } = finalViewWhereTerms();
    expect(topLevelAnd([...terms, "o.observed_value < 9000"].join(" and ")).length).toBe(terms.length + 1);
    expect(topLevelAnd(terms.slice(1).join(" and ")).length).toBe(terms.length - 1);
    // an AND inside parentheses or a string is not top level
    expect(topLevelAnd("a = 1 and (b = 2 and c = 3) and d = 'x and y'").length).toBe(3);
  });

  it("states the real number of gates: six, each with at least one view condition, plus the record's shape", () => {
    expect(GATE_COUNT).toBe(6);
    expect(GATE_COUNT_WORD).toBe("six");
    expect(LEDGER_GATES.map((g) => g.id)).toEqual(["independent_review", "frozen_forecast", "production_origin", "owner_permission", "file_decision", "never_test_site"]);
    for (const g of LEDGER_GATES) expect(conditionsOf(g.id).length, g.id).toBeGreaterThan(0);
    expect(conditionsOf("record_shape").length).toBe(4);
    // 0056's three conditions are filed apart from the six gates: they are the organisation's and the project's decisions, but the administrator's
    // checklist does not read them, so they must not be counted as gates (and a gate must not quietly absorb one).
    expect(conditionsOf("publication").map((c) => c.label)).toEqual([
      "the organisation's LATEST consent is a grant",
      "the project attested its completion milestone and no supplier record shows delivery in flight",
      "the observation was not withdrawn (no tombstone)",
    ]);
    const grouped =
      LEDGER_GATES.reduce((n, g) => n + conditionsOf(g.id).length, 0) + conditionsOf("record_shape").length + conditionsOf("publication").length;
    expect(grouped).toBe(VIEW_CONDITION_COUNT);
    expect(VIEW_CONDITION_COUNT).toBe(21);
  });

  it("the six gates carry the conditions the task names, in the view's own terms", () => {
    const labels = (id: Parameters<typeof conditionsOf>[0]) => conditionsOf(id).map((c) => c.label);
    expect(labels("independent_review")).toEqual(expect.arrayContaining(["reviewer is not the submitter", "reviewed as E5 only"]));
    expect(labels("frozen_forecast")).toEqual(expect.arrayContaining(["the forecast predates the outcome", "the forecast still matches its digest", "the prediction is the forecast's own number"]));
    expect(labels("production_origin")).toEqual(["production origin"]);
    expect(labels("owner_permission")).toEqual(["the project's LATEST permission is a grant"]);
    expect(labels("file_decision")).toContain("a verified decision row whose confirmed digest equals the stored one");
    expect(labels("never_test_site")).toEqual(["the project was never filed under a non-production site"]);
  });
});

describe("the residual-report schema in code is the engine's", () => {
  const records = read("gridforge/calibration/records.py");
  const residuals = read("gridforge/calibration/residuals.py");

  it("lists the variables the public report carries, with the units the engine records, and the ones it withholds", () => {
    const block = records.slice(records.indexOf("VARIABLES: dict"), records.indexOf("SUBSYSTEMS"));
    const all = [...block.matchAll(/^ {4}"(\w+)": \("(\w+)", "([^"]+)"/gm)].map((m) => ({ name: m[1], subsystem: m[2], unit: m[3] }));
    const withheld = [...(residuals.match(/WITHHELD_FROM_PUBLIC[^=]*=\s*frozenset\(\{([^}]*)\}\)/)?.[1] ?? "").matchAll(/"(\w+)"/g)].map((m) => m[1]);
    expect(withheld.sort()).toEqual([...WITHHELD_VARIABLES].sort());
    expect(PUBLISHED_VARIABLES).toEqual(all.filter((v) => !withheld.includes(v.name)));
  });

  it("names the schema, the thresholds and the fields of the report, the variable block and the residual cell", () => {
    expect(residuals).toContain(`PUBLIC_SCHEMA = "${RESIDUALS_SCHEMA}"`);
    expect(residuals).toContain(`MIN_APPROVED_OBSERVATIONS = ${RESIDUAL_REQUIREMENTS.min_approved_observations_per_variable}`);
    expect(residuals).toContain(`MIN_DISTINCT_SITES = ${RESIDUAL_REQUIREMENTS.min_distinct_sites_per_variable}`);
    const publicReport = residuals.slice(residuals.indexOf("def public_report"), residuals.indexOf("def disclosure_summary"));
    const ret = publicReport.slice(publicReport.lastIndexOf("return {"));
    expect([...ret.matchAll(/^ {8}"(\w+)":/gm)].map((m) => m[1])).toEqual([...RESIDUAL_TOP_FIELDS]);
    const stats = residuals.slice(residuals.indexOf("def _stats"), residuals.indexOf("def _grouped"));
    expect([...stats.matchAll(/^ {8}"(\w+)":/gm)].map((m) => m[1])).toEqual(RESIDUAL_CELL_FIELDS.map((f) => f.field));
    const variable = residuals.slice(residuals.indexOf("def _variable_block"), residuals.indexOf("def subsystem_statement"));
    const named = [...variable.matchAll(/(?:^ {8}"(\w+)":|block\["(\w+)"\] =)/gm)].map((m) => m[1] ?? m[2]);
    // by_configuration is keyed by free text a submitter typed: the engine builds it and never publishes it (_public_variable drops it).
    expect(residuals).toMatch(/_public_variable[\s\S]*?"by_configuration"[\s\S]*?"interval_coverage"\)/);
    expect(named.filter((n) => n !== "by_configuration")).toEqual([...RESIDUAL_VARIABLE_FIELDS]);
  });
});

describe("the public panel renders the typed list", () => {
  const html = renderToStaticMarkup(React.createElement(CalibrationTransparency, { live: { status: "unreadable", reason: "unreachable" } }));
  const t = text(html);

  it("shows every gate's rule and its limit, in order, and the shared limits", () => {
    let at = -1;
    for (const g of LEDGER_GATES) {
      const i = t.indexOf(text(g.title));
      expect(i, g.id).toBeGreaterThan(at);
      at = i;
      expect(t).toContain(text(g.rule));
      expect(t).toContain(text(g.limit));
    }
    for (const l of LEDGER_LIMITS) expect(t).toContain(text(l));
    expect(t).toContain(`applies ${GATE_COUNT_WORD} gates`);
    expect(t).toContain(`${VIEW_CONDITION_COUNT} conditions`);
  });

  it("states 0056's three conditions as conditional on that migration, not as gates, and says the administrator's checklist does not read them", () => {
    expect(t).toContain(text(PUBLICATION_CONDITIONS.title));
    expect(t).toContain(text(PUBLICATION_CONDITIONS.rule));
    expect(t).toContain(text(PUBLICATION_CONDITIONS.limit));
    expect(PUBLICATION_CONDITIONS.rule).toMatch(/^Once migration 0056 is applied/);
    expect(t).toMatch(/not on that screen yet/);
    // the block comes after the six gates and the record's shape, and is not one of the numbered gates
    expect(t.indexOf(text(PUBLICATION_CONDITIONS.title))).toBeGreaterThan(t.indexOf(text(RECORD_SHAPE.title)));
    expect(html.match(/<li class="rounded border/g)?.length).toBe(GATE_COUNT);
  });

  it("states the limits the owner asked to be plain", () => {
    expect(t).toMatch(/outcome date is the submitter's declaration/);
    expect(t).toMatch(/An assertion, not authentication/);
    expect(t).toMatch(/A verdict is final/);
    expect(t).toMatch(/not recalled/);
    expect(t).toMatch(/unclassified/);
    expect(t).toMatch(/not accurate/);
  });
});
