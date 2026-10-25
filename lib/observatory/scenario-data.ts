// The Observatory's scenario data: loads public/observatory/scenarios.json and validates it against the contract in
// lib/observatory/types.ts (ScenarioFile) before anything renders it.
//
// The file is generated at build time by scripts/build-observatory.py from the repository's own engine and diffed in CI. This
// module is the other half of that bargain: a renderer must never draw a number that the contract's honesty rules forbid, so the
// file is refused outright, with the path of the first problem, when any of them is broken:
//
//   - the schema label is not the one this code understands, or `synthetic` is not literally true;
//   - a quantity has a value but no evidence class, or no value and no reason, or its range is inverted;
//   - a scenario claims field validation or deployment (E6/E7): the calibration ledger is empty, nothing here is measured;
//   - an outcome is "dated" without weeks (or has weeks without being dated, or is "dated" on an assumed E0 lead time);
//   - an outcome that deploys no rack carries a capex figure, or its capex pricing / completeness contradicts its figure;
//   - a constraint whose `passes` flag disagrees with its racksAllowed (passes === (racksAllowed === null));
//   - any figure was edited by hand: contentSha256 is a SHA-256 over every leaf of the file and must match;
//   - a date is not ISO 8601, an id is repeated, the headline outcome or a binding key names nothing that exists;
//   - any string looks like an email address or a web address (the data is synthetic; it must not point at a real site).
//
// Server-only in practice: `loadScenarioFile` reads the file with node:fs (like lib/tool-rates.ts). `parseScenarioFile` is pure.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { EvidenceClass, ScenarioFile } from "@/lib/observatory/types";

const EVIDENCE = ["E0", "E1", "E2", "E3", "E4", "E5", "E6", "E7"] as const;
const RANK: Record<EvidenceClass, number> = { E0: 0, E1: 1, E2: 2, E3: 3, E4: 4, E5: 5, E6: 6, E7: 7 };

/** E6 (field-validated) and E7 (deployed) are earned through the calibration ledger, which is empty. */
const evidence = z.enum(EVIDENCE).refine((e) => RANK[e] <= 5, {
  message: "evidence E6/E7 cannot appear: the calibration ledger is empty, so nothing here is field-validated or measured",
});

const num = z.number().finite();
const text = z.string().min(1);

// --- strings that point at a real person or site -------------------------------------------------------------------------------
const LOOKS_LIKE_ADDRESS: { re: RegExp; what: string }[] = [
  { re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/, what: "an email address" },
  { re: /\b[a-z][a-z0-9+.-]*:\/\//i, what: "a URL" },
  { re: /\bwww\./i, what: "a web address" },
  { re: /\b[a-z0-9-]{2,}\.(com|net|org|io|ai|co|eu|de|ie|uk|no|fr|nl|se|es|it|app|dev|cloud|info|biz)\b/i, what: "a domain name" },
];

function stringsIn(value: unknown, at: string, out: { at: string; s: string }[]): void {
  if (typeof value === "string") out.push({ at, s: value });
  else if (Array.isArray(value)) value.forEach((v, i) => stringsIn(v, `${at}[${i}]`, out));
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) stringsIn(v, at ? `${at}.${k}` : k, out);
  }
}

// --- dates -----------------------------------------------------------------------------------------------------------------
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_DATETIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(:(\d{2})(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

export function isIsoDate(s: string): boolean {
  const m = ISO_DATE.exec(s) ?? ISO_DATETIME.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return false;
  if (m.length > 4 && m[4] !== undefined) {
    if (Number(m[4]) > 23 || Number(m[5]) > 59 || (m[7] !== undefined && Number(m[7]) > 59)) return false;
  }
  return true;
}

const isoDate = z.string().refine(isIsoDate, { message: "must be an ISO 8601 date (YYYY-MM-DD) or date-time" });

// --- the shapes -----------------------------------------------------------------------------------------------------------
const quantity = z
  .object({
    value: num.nullable(),
    low: num.nullable(),
    high: num.nullable(),
    unit: text,
    evidence,
    missingReason: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((q, ctx) => {
    if (q.value === null && !q.missingReason) {
      ctx.addIssue({ code: "custom", path: ["missingReason"], message: "a quantity with no value must say why (missingReason)" });
    }
    if (q.value === null && (q.low !== null || q.high !== null)) {
      ctx.addIssue({ code: "custom", path: ["low"], message: "a quantity with no value cannot have a range" });
    }
    if (q.low !== null && q.high !== null && q.low > q.high) {
      ctx.addIssue({ code: "custom", path: ["low"], message: "range is inverted (low > high)" });
    }
    if (q.value !== null && ((q.low !== null && q.low > q.value) || (q.high !== null && q.high < q.value))) {
      ctx.addIssue({ code: "custom", path: ["value"], message: "value lies outside its own range" });
    }
  });

const PATH_KINDS = ["utility", "transformer", "switchgear", "ups", "busway", "rack_feed", "rack", "cooling"] as const;

const pathNode = z
  .object({
    id: text,
    kind: z.enum(PATH_KINDS),
    label: text,
    capacity: quantity,
    loadAsFound: quantity.nullable(),
    loadAfterPlan: quantity.nullable(),
    binds: z.boolean(),
    constraintKey: text.nullable(),
  })
  .strict()
  .superRefine((n, ctx) => {
    if (n.constraintKey === null) {
      // A stage the engine does not model: no key, no capacity, and it cannot be the thing that binds.
      if (n.capacity.value !== null) {
        ctx.addIssue({ code: "custom", path: ["capacity", "value"], message: "a stage the engine does not model (no constraintKey) cannot state a capacity" });
      }
      if (n.binds) ctx.addIssue({ code: "custom", path: ["binds"], message: "a stage with no constraintKey cannot bind" });
    }
  });

const constraintResult = z
  .object({
    key: text,
    name: text,
    domain: text,
    racksAllowed: z.number().int().nonnegative().nullable(),
    passes: z.boolean(),
    binds: z.boolean(),
    basis: text,
    evidence,
  })
  .strict()
  .superRefine((c, ctx) => {
    // null racksAllowed = the engine reports no finite limit = the constraint does not limit the hall (passes).
    if (c.passes !== (c.racksAllowed === null)) {
      ctx.addIssue({ code: "custom", path: ["passes"], message: "passes must be true exactly when racksAllowed is null (the constraint does not limit the hall)" });
    }
    if (c.passes && c.binds) ctx.addIssue({ code: "custom", path: ["binds"], message: "a constraint that passes (does not limit the hall) cannot bind" });
  });

const rackRow = z
  .object({
    id: text,
    label: text,
    racks: z.number().int().nonnegative(),
    kwPerRackAsFound: num.nonnegative().nullable(),
    kwPerRackAfterPlan: num.nonnegative().nullable(),
  })
  .strict();

const outcome = z
  .object({
    id: text,
    name: text,
    racksAsFound: z.number().int().nonnegative(),
    racksAfterPlan: z.number().int().nonnegative(),
    bindingAfterPlan: text.nullable(),
    itLoadKwAfterPlan: quantity,
    weeksToCapacity: quantity,
    dated: z.boolean(),
    capexEur: quantity,
    capexComplete: z.boolean(),
    capexPricing: z.enum(["placeholder", "partly_supplied", "supplied", "none"]),
    unpricedComponents: z.array(text),
    evidence,
  })
  .strict()
  .superRefine((o, ctx) => {
    if (o.capexEur.value === null && o.capexPricing !== "none") {
      ctx.addIssue({ code: "custom", path: ["capexPricing"], message: 'an outcome with no capex figure must have capexPricing "none"' });
    }
    if (o.capexEur.value !== null && o.capexPricing === "none") {
      ctx.addIssue({ code: "custom", path: ["capexPricing"], message: 'an outcome with a capex figure cannot have capexPricing "none"' });
    }
    if (o.capexEur.value === null && o.capexComplete) {
      ctx.addIssue({ code: "custom", path: ["capexComplete"], message: "an outcome with no capex figure cannot have a complete capex" });
    }
    if (o.unpricedComponents.length > 0 && o.capexComplete) {
      ctx.addIssue({ code: "custom", path: ["capexComplete"], message: "a capex that omits unpriced components is not complete (it is a lower bound)" });
    }
    const weeks = o.weeksToCapacity;
    if (o.dated && weeks.value === null) {
      ctx.addIssue({ code: "custom", path: ["weeksToCapacity", "value"], message: "a dated outcome must have weeksToCapacity" });
    }
    if (!o.dated && weeks.value !== null) {
      ctx.addIssue({ code: "custom", path: ["dated"], message: "weeksToCapacity is given but the outcome is not dated: a figure without every lead time is not a date" });
    }
    if (o.dated && weeks.evidence === "E0") {
      ctx.addIssue({ code: "custom", path: ["dated"], message: "an outcome resting on assumed (E0) lead times is not dated" });
    }
    if (o.racksAfterPlan === 0) {
      if (o.capexEur.value !== null) {
        ctx.addIssue({ code: "custom", path: ["capexEur", "value"], message: "an outcome that deploys no rack has no capex (null, not 0)" });
      }
      if (o.dated) ctx.addIssue({ code: "custom", path: ["dated"], message: "an outcome that deploys no rack cannot be dated" });
    }
    // The outcome carries the weakest class of what it rests on.
    for (const [name, q] of [["itLoadKwAfterPlan", o.itLoadKwAfterPlan], ["capexEur", o.capexEur], ["weeksToCapacity", weeks]] as const) {
      if (q.value !== null && RANK[o.evidence] > RANK[q.evidence]) {
        ctx.addIssue({ code: "custom", path: ["evidence"], message: `outcome evidence ${o.evidence} is stronger than its weakest input (${name}: ${q.evidence})` });
      }
    }
  });

function duplicates(ids: string[]): string[] {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const id of ids) (seen.has(id) ? dup : seen).add(id);
  return [...dup];
}

const scenario = z
  .object({
    id: text,
    title: text.refine((t) => /synthetic/i.test(t), { message: "the title must say it is synthetic" }),
    summary: text,
    synthetic: z.literal(true),
    hall: z
      .object({
        name: text.refine((t) => /synthetic/i.test(t), { message: "the hall name must say it is synthetic" }),
        platform: text,
        contractedMW: num.nonnegative(),
        currentItLoadMW: num.nonnegative(),
        positionsAvailable: z.number().int().nonnegative(),
        region: text,
      })
      .strict(),
    powerPath: z.array(pathNode).min(1),
    constraints: z.array(constraintResult).min(1),
    rackRows: z.array(rackRow),
    outcomes: z.array(outcome).min(1),
    headlineOutcome: text,
    limitations: z.array(text),
  })
  .strict()
  .superRefine((s, ctx) => {
    const keys = s.constraints.map((c) => c.key);
    const issue = (p: (string | number)[], message: string) => ctx.addIssue({ code: "custom", path: p, message });

    for (const [what, ids] of [
      ["constraint key", keys],
      ["path node id", s.powerPath.map((n) => n.id)],
      ["rack row id", s.rackRows.map((r) => r.id)],
      ["outcome id", s.outcomes.map((o) => o.id)],
    ] as const) {
      for (const d of duplicates([...ids])) issue([], `duplicate ${what}: ${d}`);
    }

    if (!s.outcomes.some((o) => o.id === s.headlineOutcome)) {
      issue(["headlineOutcome"], `headlineOutcome "${s.headlineOutcome}" names no outcome of this scenario`);
    }
    if (s.constraints.filter((c) => c.binds).length > 1) issue(["constraints"], "more than one constraint binds as found");

    const byKey = new Map(s.constraints.map((c) => [c.key, c]));
    s.powerPath.forEach((n, i) => {
      if (n.constraintKey !== null && !byKey.has(n.constraintKey)) {
        issue(["powerPath", i, "constraintKey"], `constraintKey "${n.constraintKey}" is not one of this scenario's constraints`);
      }
      if (n.binds && n.constraintKey !== null && byKey.get(n.constraintKey)?.binds !== true) {
        issue(["powerPath", i, "binds"], `node binds but constraint "${n.constraintKey}" does not`);
      }
    });
    if (s.powerPath.filter((n) => n.binds).length > 1) issue(["powerPath"], "more than one stage binds");

    s.outcomes.forEach((o, i) => {
      if (o.bindingAfterPlan !== null && !byKey.has(o.bindingAfterPlan)) {
        issue(["outcomes", i, "bindingAfterPlan"], `bindingAfterPlan "${o.bindingAfterPlan}" is not one of this scenario's constraints`);
      }
    });

    // Every scenario says the ledger is empty and nothing is measured.
    if (!s.limitations.some((l) => /calibration ledger is empty/i.test(l))) {
      issue(["limitations"], "limitations must state that the calibration ledger is empty and nothing is measured");
    }
  });

const scenarioFile = z
  .object({
    schema: z.literal("gridforge/observatory-scenarios/1"),
    engine: z
      .object({
        version: text,
        codeSha256: z.string().regex(/^[0-9a-f]{64}$/, "must be a 64-character lowercase hex SHA-256"),
        routes: z.array(z.string().regex(/^\/v1\/[a-z0-9/_-]+$/, "must be an engine route")).min(1),
      })
      .strict(),
    generatedAt: isoDate,
    synthetic: z.literal(true),
    calibration: z.object({ state: z.literal("empty"), statement: text }).strict(),
    contentSha256: z.string().regex(/^[0-9a-f]{64}$/, "must be a 64-character lowercase hex SHA-256"),
    scenarios: z.array(scenario).min(1),
  })
  .strict()
  .superRefine((f, ctx) => {
    for (const d of duplicates(f.scenarios.map((s) => s.id))) {
      ctx.addIssue({ code: "custom", path: ["scenarios"], message: `duplicate scenario id: ${d}` });
    }
  });

// --- content fingerprint -----------------------------------------------------------------------------------------------------
// Must match scripts/build-observatory.py `content_fingerprint` exactly (a shared test vector in both test suites pins it).
// Every leaf of the file except the top-level contentSha256 is written as one line "/path\t<kind><value>":
//   z = null, b = boolean, n = number (canonical decimal text: integers without a point, others shortest round-trip; exponent
//   notation and magnitudes above 2^53 are refused), s = string (JSON-escaped, no ASCII escaping). Object keys are visited in
//   sorted order, arrays by index. The lines are joined with "\n" and hashed as UTF-8.
function canonicalNumber(x: number, at: string): string {
  if (!Number.isFinite(x) || Math.abs(x) > 2 ** 53) throw new Error(`${at}: number out of range for the content fingerprint`);
  const t = Number.isInteger(x) ? String(Math.trunc(x) + 0) : String(x);
  if (/e/i.test(t)) throw new Error(`${at}: number in exponent notation cannot be fingerprinted`);
  return t === "-0" ? "0" : t;
}

function fingerprintLines(value: unknown, at: string, out: string[]): void {
  if (value === null) out.push(`${at}\tz`);
  else if (typeof value === "boolean") out.push(`${at}\tb${value ? "true" : "false"}`);
  else if (typeof value === "number") out.push(`${at}\tn${canonicalNumber(value, at)}`);
  else if (typeof value === "string") out.push(`${at}\ts${JSON.stringify(value)}`);
  else if (Array.isArray(value)) value.forEach((v, i) => fingerprintLines(v, `${at}/${i}`, out));
  else if (typeof value === "object" && value !== undefined) {
    const o = value as Record<string, unknown>;
    for (const k of Object.keys(o).sort()) fingerprintLines(o[k], `${at}/${k}`, out);
  } else throw new Error(`${at}: ${typeof value} cannot be fingerprinted`);
}

/** SHA-256 (hex) of every leaf of a scenario file other than its own contentSha256. */
export function contentFingerprint(file: unknown): string {
  if (!file || typeof file !== "object" || Array.isArray(file)) throw new Error("contentFingerprint: not an object");
  const { contentSha256: _own, ...rest } = file as Record<string, unknown>;
  void _own;
  const lines: string[] = [];
  fingerprintLines(rest, "", lines);
  return createHash("sha256").update(lines.join("\n"), "utf8").digest("hex");
}

// Compile-time proof that what the schema accepts is exactly assignable to the contract (a drift in either fails `tsc`).
const _schemaMatchesContract = (x: z.infer<typeof scenarioFile>): ScenarioFile => x;
void _schemaMatchesContract;

function describe(issue: z.ZodIssue): string {
  const where = issue.path.length ? issue.path.map(String).join(".") : "(file)";
  return `${where}: ${issue.message}`;
}

/** Validate untrusted JSON against the contract; throws on any drift (the page must not render a malformed file). */
export function parseScenarioFile(raw: unknown): ScenarioFile {
  const parsed = scenarioFile.safeParse(raw);
  if (!parsed.success) {
    const shown = parsed.error.issues.slice(0, 8).map(describe);
    const more = parsed.error.issues.length - shown.length;
    throw new Error(`scenarios.json is not a valid Observatory scenario file: ${shown.join("; ")}${more > 0 ? `; and ${more} more` : ""}`);
  }
  // Strings anywhere in the file must not point at a real address.
  const strings: { at: string; s: string }[] = [];
  stringsIn(raw, "", strings);
  for (const { at, s } of strings) {
    for (const { re, what } of LOOKS_LIKE_ADDRESS) {
      if (re.test(s)) throw new Error(`scenarios.json is not a valid Observatory scenario file: ${at}: looks like ${what}; the data is synthetic and must not name a real address`);
    }
  }
  // No schema-valid hand edit of a figure: the file must still be the one the generator sealed.
  const sealed = contentFingerprint(raw);
  if (sealed !== parsed.data.contentSha256) {
    throw new Error(
      "scenarios.json is not a valid Observatory scenario file: contentSha256 does not match the content; the file was edited by hand " +
        "(regenerate it with scripts/build-observatory.sh)",
    );
  }
  return parsed.data;
}

export const SCENARIO_FILE_PATH = ["public", "observatory", "scenarios.json"] as const;

let memo: ScenarioFile | null = null;

/** Server-only: read the committed file and validate it. Memoised for the life of the process. */
export function loadScenarioFile(): ScenarioFile {
  if (memo) return memo;
  const raw = fs.readFileSync(path.join(process.cwd(), ...SCENARIO_FILE_PATH), "utf8");
  memo = parseScenarioFile(JSON.parse(raw));
  return memo;
}

/** Test helper: forget the memoised file. */
export function resetScenarioFileCache(): void {
  memo = null;
}
