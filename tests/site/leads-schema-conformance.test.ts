/**
 * The in-memory PostgREST stand-in accepts any row, so it can never catch a record the REAL table would refuse. This test reads the table
 * definition from BOTH files that can have built production (supabase/schema.sql, with NOT NULL and CHECK constraints, and
 * supabase/migrations/0001_leads.sql, plain) and validates the record each lead-writing route actually sends against each: a NOT NULL column
 * with no default must be present and non-null, a CHECK ... IN (...) must be satisfied, the types must fit, and no unknown column may be sent.
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { siteUrl } from "@/lib/site";
import { resetMemoryLimiter } from "@/lib/rate-limit";

interface Col { name: string; type: string; notNull: boolean; hasDefault: boolean; allowed: string[] | null; maxLen: number | null }
const ROOT = path.resolve(__dirname, "../..");

/** Column definitions of `create table ... public.leads (...)`, one per top-level comma. */
export function parseLeadsTable(sql: string): Col[] {
  const noComments = sql.replace(/--[^\n]*/g, "");
  const start = noComments.search(/create table (?:if not exists )?public\.leads\s*\(/i);
  if (start < 0) throw new Error("no leads table");
  let depth = 0, i = noComments.indexOf("(", start), from = i + 1;
  const parts: string[] = [];
  for (; i < noComments.length; i++) {
    const ch = noComments[i];
    if (ch === "(") depth++;
    else if (ch === ")") { depth--; if (depth === 0) { parts.push(noComments.slice(from, i)); break; } }
    else if (ch === "," && depth === 1) { parts.push(noComments.slice(from, i)); from = i + 1; }
  }
  return parts.map((p) => p.trim()).filter(Boolean).map((def) => {
    const m = /^(\w+)\s+(\w+(?:\[\])?(?:\(\d+\))?)/.exec(def)!;
    const inList = /check\s*\(\s*\w+\s+in\s*\(([^)]*)\)\s*\)/i.exec(def.replace(/\s+/g, " "));
    const varchar = /\((\d+)\)/.exec(m[2]);
    return {
      name: m[1], type: m[2].replace(/\(\d+\)/, "").toLowerCase(), notNull: /not null/i.test(def) || /primary key/i.test(def),
      hasDefault: /\bdefault\b/i.test(def) || /primary key/i.test(def) && /default/i.test(def),
      allowed: inList ? [...inList[1].matchAll(/'([^']*)'/g)].map((x) => x[1]) : null, maxLen: varchar ? Number(varchar[1]) : null,
    };
  });
}

/** Every way `record` would be refused by a table with these columns. Empty = accepted. */
export function violations(cols: Col[], record: Record<string, unknown>): string[] {
  const out: string[] = [];
  const by = new Map(cols.map((c) => [c.name, c]));
  for (const k of Object.keys(record)) if (!by.has(k)) out.push(`unknown column ${k}`);
  for (const c of cols) {
    const v = record[c.name];
    const present = v !== undefined;
    if (!present) { if (c.notNull && !c.hasDefault) out.push(`${c.name}: NOT NULL with no default, missing`); continue; }
    if (v === null) { if (c.notNull) out.push(`${c.name}: NOT NULL but null`); continue; }
    if (c.type === "text" || c.type.startsWith("varchar")) {
      if (typeof v !== "string") out.push(`${c.name}: expected text`);
      else if (c.maxLen !== null && v.length > c.maxLen) out.push(`${c.name}: longer than ${c.maxLen}`);
      else if (c.allowed && !c.allowed.includes(v)) out.push(`${c.name}: ${JSON.stringify(v)} violates check in (${c.allowed.join(",")})`);
    } else if (c.type === "numeric" || c.type === "int" || c.type === "integer") {
      if (typeof v !== "number" || !Number.isFinite(v)) out.push(`${c.name}: expected a number`);
      else if (c.type !== "numeric" && !Number.isInteger(v)) out.push(`${c.name}: expected an integer`);
    } else if (c.type === "text[]") {
      if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) out.push(`${c.name}: expected text[]`);
    } else if (c.type === "jsonb") {
      /* any JSON */
    }
  }
  return out;
}

const SOURCES = { "supabase/schema.sql": "supabase/schema.sql", "supabase/migrations/0001_leads.sql": "supabase/migrations/0001_leads.sql" };
const tables = Object.fromEntries(Object.entries(SOURCES).map(([k, f]) => [k, parseLeadsTable(fs.readFileSync(path.join(ROOT, f), "utf8"))]));

describe("the checker itself", () => {
  const strict = tables["supabase/schema.sql"], plain = tables["supabase/migrations/0001_leads.sql"];
  const good = { name: "n", company: "c", email: "e", location: "l", capacity_mw: null, urgency: "exploratory", grid_status: "unknown", services: [], message: "m", context: "x", source: "x", score: 1, tier: "warm", reasons: [], status: "new" };
  it("reads the constraints out of both files", () => {
    expect(strict.find((c) => c.name === "urgency")).toMatchObject({ notNull: true, allowed: ["immediate", "90days", "exploratory"] });
    expect(strict.find((c) => c.name === "location")).toMatchObject({ notNull: true });
    expect(strict.find((c) => c.name === "tier")?.allowed).toEqual(["hot", "warm", "exploratory"]);
    expect(plain.find((c) => c.name === "urgency")).toMatchObject({ notNull: false, allowed: null });
    expect(plain.find((c) => c.name === "name")).toMatchObject({ notNull: true });
  });
  it("catches the exact mismatch the stub hid: urgency 'not stated' passes the plain table and fails schema.sql", () => {
    expect(violations(plain, { ...good, urgency: "not stated" })).toEqual([]);
    expect(violations(strict, { ...good, urgency: "not stated" }).join()).toMatch(/urgency.*violates check/);
  });
  it("catches a missing NOT NULL column, a null in one, a bad type and an unknown column", () => {
    const { location: _l, ...noLocation } = good;
    expect(violations(strict, noLocation).join()).toMatch(/location.*missing/);
    expect(violations(strict, { ...good, name: null }).join()).toMatch(/name.*null/);
    expect(violations(strict, { ...good, score: "1" }).join()).toMatch(/score/);
    expect(violations(strict, { ...good, extra: 1 }).join()).toMatch(/unknown column extra/);
    expect(violations(strict, { ...good, tier: "cold" }).join()).toMatch(/tier/);
  });
});

describe("the record /api/contact sends is accepted by the real table definitions", () => {
  let sent: Record<string, unknown>[];
  let restore: () => void;
  beforeEach(async () => {
    Object.assign(process.env, { SUPABASE_URL: "https://stub.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "sb_secret_test" });
    delete process.env.RESEND_API_KEY; delete process.env.LEAD_TO_EMAIL;
    resetMemoryLimiter();
    for (const m of ["error", "warn", "log", "info", "debug"] as const) vi.spyOn(console, m).mockImplementation(() => {});
    const { newPaygDb } = await import("./payg-harness");
    const db = newPaygDb();
    const undo = db.install();
    const inner = globalThis.fetch;
    sent = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/rest/v1/leads") && init?.method === "POST") sent.push(JSON.parse(String(init.body)));
      return inner(input as RequestInfo, init);
    }) as typeof fetch;
    restore = () => { globalThis.fetch = inner; undo(); };
  });
  afterEach(() => { restore(); vi.restoreAllMocks(); });

  let n = 0;
  const post = (over: Record<string, unknown> = {}) => new Request(siteUrl("/api/contact"), {
    method: "POST", headers: { "content-type": "application/json", "x-real-ip": `10.5.${Math.floor(++n / 250)}.${(n % 250) + 1}` },
    body: JSON.stringify({ name: "Ada Test", email: "ada@test.example", company: "Test Co", message: "A 48 MW hall and the tap-offs are the problem", mw: "48", urgency: "90days", ...over }),
  });

  for (const [file, cols] of Object.entries(tables)) {
    for (const variant of [{}, { mw: "", urgency: "immediate" }, { mw: 12.5, urgency: "exploratory" }]) {
      it(`${file}: every column is valid for ${JSON.stringify(variant) || "the default form"}`, async () => {
        const { POST } = await import("@/app/api/contact/route");
        expect((await POST(post(variant))).status).toBe(200);
        expect(sent).toHaveLength(1);
        expect(violations(cols, sent[0])).toEqual([]);
        for (const c of cols.filter((x) => x.notNull && !x.hasDefault)) expect(sent[0][c.name], c.name).not.toBeUndefined();
      });
    }
  }
});
