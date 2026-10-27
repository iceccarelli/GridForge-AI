/**
 * The ratchet: no path that can spend a shared provider credential exists without being metered, and a NEW one cannot be
 * added by calling a different helper.
 *
 * It does not look for the text "enforceRateLimit". It finds the functions that really spend, by name, from how they spend:
 *
 *   1. SPENDERS. A function is a spender if its body calls the provider gate (engineFetch / anthropicFetch) or constructs an
 *      Anthropic client, or if it calls any function that is (followed through imports, to a fixed point). A new helper that
 *      calls the gate is therefore found the moment it is written, wherever it lives, whatever it is called.
 *   2. ROUTES. Every route handler that reaches a spender must, in its own body, either
 *        - admit the request with guardRequest(...) and make the provider calls INSIDE `.run(`, after the admission, or
 *        - run under runTrusted(...) with the operator or cron authentication visible before it.
 *      Nothing else is allowed, and a page (a server component) may not reach a spender at all.
 *   3. BYPASSES. A raw `fetch(` of the engine or of Anthropic skips the gate. Every one is either gone or on a short, reasoned
 *      allow-list that must still match exactly one real call (a stale entry fails); every Anthropic client must be built with
 *      the gate's fetch.
 *
 * The analysis is textual (this repository writes top-level functions with a closing brace in column 0), so the exact set it
 * finds is asserted below: if the analysis stopped seeing a spender, that assertion fails instead of the ratchet going quiet.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CAPABILITY_REGISTRY } from "@/lib/capability-registry";

const ROOT = process.cwd();

function walk(dir: string): string[] {
  return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = path.posix.join(dir, e.name);
    if (e.isDirectory()) return walk(rel);
    return /\.(ts|tsx)$/.test(e.name) ? [rel] : [];
  });
}
const FILES = [...walk("app"), ...walk("lib")];
const SRC = new Map(FILES.map((f) => [f, fs.readFileSync(path.join(ROOT, f), "utf8")]));
const GATE_FILE = "lib/rate-limit.ts"; // defines the gate; it is not a caller of it

interface Fn { id: string; file: string; name: string; body: string; start: number }

/**
 * Top-level functions: `function f` ... up to the next closing brace in column 0 (a signature may span lines), and
 * one-line `export const f = (...) =>` arrows. The declaration's own name is blanked so a function never "calls" itself.
 */
function functionsOf(file: string, src: string): Fn[] {
  const out: Fn[] = [];
  const re = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+(\w+)\b/gm;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const end = src.indexOf("\n}", m.index);
    const raw = src.slice(m.index, end === -1 ? src.length : end + 2);
    out.push({ id: `${file}#${m[1]}`, file, name: m[1], body: raw.replace(/^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+\w+/, "function "), start: m.index });
  }
  const arrows = /^export\s+const\s+(\w+)\s*=\s*[^\n]*=>[^\n]*$/gm;
  for (let m = arrows.exec(src); m; m = arrows.exec(src)) out.push({ id: `${file}#${m[1]}`, file, name: m[1], body: m[0].replace(/^export\s+const\s+\w+/, "const _"), start: m.index });
  return out;
}

const FNS = new Map<string, Fn>();
const BY_FILE = new Map<string, Map<string, Fn>>();
for (const [file, src] of SRC) {
  const m = new Map<string, Fn>();
  for (const f of functionsOf(file, src)) {
    FNS.set(f.id, f);
    m.set(f.name, f);
  }
  BY_FILE.set(file, m);
}

/** local name -> function id, for everything a file imports by name from another repository module. */
function importsOf(file: string, src: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+"([^"]+)"/g;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    if (!m[2].startsWith("@/") && !m[2].startsWith(".")) continue;
    const base = m[2].startsWith("@/") ? m[2].slice(2) : path.posix.normalize(path.posix.join(path.posix.dirname(file), m[2]));
    const target = [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`].find((t) => SRC.has(t));
    if (!target) continue;
    for (const part of m[1].split(",")) {
      const [orig, alias] = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/);
      if (orig) out.set(alias ?? orig, `${target}#${orig}`);
    }
  }
  return out;
}
const IMPORTS = new Map(FILES.map((f) => [f, importsOf(f, SRC.get(f)!)]));

/** Resolve a called name inside `fn` to a function id, if it is one of ours. */
function resolve(fn: Fn, name: string): string | undefined {
  const local = BY_FILE.get(fn.file)?.get(name);
  if (local) return local.id;
  const imported = IMPORTS.get(fn.file)?.get(name);
  return imported && FNS.has(imported) ? imported : undefined;
}
const callsIn = (body: string) => [...new Set([...body.matchAll(/(?<![\w.$])([A-Za-z_]\w*)\s*\(/g)].map((m) => m[1]))];

// 1. spenders ---------------------------------------------------------------------------------------------------------
const DIRECT = /\b(engineFetch|anthropicFetch|providerFetch)\b|new Anthropic\(/;
const SPENDERS = new Set<string>();
for (const f of FNS.values()) if (f.file !== GATE_FILE && DIRECT.test(f.body)) SPENDERS.add(f.id);
for (let changed = true; changed; ) {
  changed = false;
  for (const f of FNS.values()) {
    if (f.file === GATE_FILE || SPENDERS.has(f.id)) continue;
    if (callsIn(f.body).some((c) => { const t = resolve(f, c); return t !== undefined && SPENDERS.has(t); })) {
      SPENDERS.add(f.id);
      changed = true;
    }
  }
}
/** The first place in `fn` that spends: a call to a spender, or a direct use of the gate or an Anthropic client. */
function firstSpend(fn: Fn): [number, string] | null {
  let best: [number, string] | null = null;
  const consider = (idx: number, name: string) => {
    if (idx >= 0 && (!best || idx < best[0])) best = [idx, name];
  };
  for (const name of callsIn(fn.body)) {
    const t = resolve(fn, name);
    if (t && SPENDERS.has(t)) consider(fn.body.search(new RegExp(`(?<![\\w.$])${name}\\s*\\(`)), name);
  }
  const direct = DIRECT.exec(fn.body);
  if (direct) consider(direct.index, direct[1] ?? "new Anthropic");
  return best;
}

// 2. routes -----------------------------------------------------------------------------------------------------------
type Kind = "guarded" | "customer" | "trusted";
const HANDLER = /^(GET|POST|PUT|PATCH|DELETE)$/;
const ROUTES = FILES.filter((f) => f.startsWith("app/api/") && f.endsWith("/route.ts"));

function classify(fn: Fn): { kind: Kind | null; problem?: string } {
  const spend = firstSpend(fn);
  if (!spend) return { kind: null };
  const [at, callee] = spend;
  const guard = fn.body.search(/\bguardRequest\(/);
  const run = fn.body.search(/\.run\(/);
  const trusted = fn.body.search(/\brunTrusted\(/);
  if (guard >= 0) {
    if (!/\.denied\)\s*return\s+\w+\.denied;/.test(fn.body)) return { kind: null, problem: "guardRequest's refusal is not returned" };
    if (run < 0 || run < guard) return { kind: null, problem: "provider work is not inside the guard's .run(...)" };
    if (at < run) return { kind: null, problem: `${callee}() is called before the request is admitted and run in scope` };
    return { kind: /cls:\s*"customer"/.test(fn.body) ? "customer" : "guarded" };
  }
  if (trusted >= 0) {
    if (at < trusted) return { kind: null, problem: `${callee}() is called before runTrusted(...)` };
    const reason = /runTrusted\(\s*"([a-z-]+)"/.exec(fn.body)?.[1];
    const before = fn.body.slice(0, trusted);
    const auth = reason === "cron-secret" ? /\bauthorised\(/ : reason === "admin-session" ? /\bverifyAdminCookie\(/ : null;
    if (!auth) return { kind: null, problem: `unknown trusted reason ${reason}` };
    if (!auth.test(before) && !(reason === "admin-session" && /verifyAdminCookie\(/.test(fn.body.slice(0, at)))) return { kind: null, problem: `runTrusted("${reason}") without ${reason} authentication before it` };
    return { kind: "trusted" };
  }
  return { kind: null, problem: `${callee}() reaches a paid provider with no guardRequest or runTrusted` };
}

const FOUND = new Map<string, Kind>();
const PROBLEMS: string[] = [];
for (const file of ROUTES) {
  for (const fn of BY_FILE.get(file)!.values()) {
    if (!HANDLER.test(fn.name)) continue;
    const c = classify(fn);
    if (c.kind) FOUND.set(`${file} ${fn.name}`, c.kind);
    else if (c.problem) PROBLEMS.push(`${file} ${fn.name}: ${c.problem}`);
  }
}

describe("every route handler that reaches a paid provider is metered or trusted", () => {
  it("has no unmetered path (and names it if one is added)", () => {
    expect(PROBLEMS).toEqual([]);
  });

  it("finds exactly the spending routes we know about, so the analysis cannot go blind", () => {
    expect(Object.fromEntries([...FOUND].sort())).toEqual({
      "app/api/admin/deliverables/route.ts PATCH": "trusted",
      "app/api/admin/proposal/route.ts POST": "trusted",
      "app/api/chat/route.ts POST": "guarded",
      "app/api/cron/watches/route.ts GET": "trusted",
      "app/api/deliverable/[token]/bids/route.ts POST": "customer",
      "app/api/deliverable/[token]/evidence-run/route.ts POST": "customer",
      "app/api/deliverable/[token]/quotes/route.ts POST": "customer",
      "app/api/intake/[token]/route.ts POST": "customer",
      "app/api/power/compare/route.ts POST": "guarded",
      "app/api/power/compare/save/route.ts POST": "guarded",
      "app/api/power/deploy/cases/[token]/route.ts POST": "guarded",
      "app/api/power/deploy/cases/route.ts POST": "guarded",
      "app/api/projects/[token]/packages/[package]/comparison/route.ts POST": "guarded",
      "app/api/projects/[token]/packages/[package]/responses/route.ts POST": "guarded",
      "app/api/projects/[token]/packages/route.ts POST": "guarded",
      "app/api/qualify/route.ts POST": "guarded",
      "app/api/siting-analysis/route.ts POST": "customer",
      "app/api/watch/[token]/route.ts POST": "customer",
    });
  });

  it("recognises the spenders by what they do: the engine helpers, the chat orchestration and the Anthropic callers", () => {
    for (const id of [
      "lib/qualify.ts#callEngine", "lib/power-deploy.ts#callEngine", "lib/power-deploy.ts#runDeploymentAssessment",
      "lib/ttp-compare-server.ts#runCompare", "lib/cost-evidence.ts#submitQuotes", "lib/cost-evidence.ts#runWithEvidence",
      "lib/deliverables.ts#compareBids", "lib/deliverables.ts#renderDeliverable", "lib/deliverables.ts#generateAndStore",
      "lib/watches.ts#runWatch", "lib/ai/tools.ts#callEngineTool", "lib/ai/agent.ts#runTurn", "lib/extract.ts#extractLead",
      "lib/project-procurement.ts#generateRfqPackage", "lib/project-procurement.ts#submitSupplierResponse",
      "lib/project-procurement.ts#runPackageComparison",
    ]) expect(SPENDERS.has(id), id).toBe(true);
  });

  it("does not mistake store-only helpers for spenders (no false alarms to normalise ignoring the test)", () => {
    for (const id of ["lib/power-deploy.ts#latestDeploymentCase", "lib/projects.ts#getProjectByToken", "lib/project-http.ts#readJson", "lib/deliverables.ts#getByToken"]) {
      expect(SPENDERS.has(id), id).toBe(false);
    }
  });

  it("a server component never reaches a paid provider", () => {
    const pages = FILES.filter((f) => f.endsWith("page.tsx"));
    const bad = pages.filter((p) => {
      const fns = BY_FILE.get(p)!;
      const host: Fn = { id: `${p}#(file)`, file: p, name: "(file)", body: SRC.get(p)!, start: 0 };
      return callsIn(host.body).some((c) => { const t = resolve(host, c) ?? (fns.get(c)?.id); return t !== undefined && SPENDERS.has(t); });
    });
    expect(bad).toEqual([]);
  });

  it("a mutation is detected: remove the guard from a spending handler and the analysis reports it", () => {
    const fn = BY_FILE.get("app/api/qualify/route.ts")!.get("POST")!;
    const stripped: Fn = { ...fn, body: fn.body.replace(/guardRequest\(/g, "notAGuard(") };
    expect(classify(fn).kind).toBe("guarded");
    expect(classify(stripped).kind).toBeNull();
    expect(classify(stripped).problem).toMatch(/no guardRequest or runTrusted/);
    // ...and so is spending BEFORE admission:
    const early: Fn = { ...fn, body: fn.body.replace("const g = await guardRequest", "await callEngine(input); const g = await guardRequest") };
    expect(classify(early).problem).toMatch(/before the request is admitted/);
  });
});

// 3. bypasses ---------------------------------------------------------------------------------------------------------
/** Raw fetches of the engine that deliberately do not go through the gate, and why. Each must match exactly one real call. */
const RAW_ENGINE_FETCH_ALLOWED: { file: string; snippet: string; why: string }[] = [
  { file: "lib/cost-evidence.ts", snippet: "/v1/version", why: "GET of the engine's public provenance (digest and version): no units, read by GET routes that have no spend scope, and cheap enough to be bounded by the route's own request limits" },
  { file: "lib/power-deploy.ts", snippet: "/v1/version", why: "GET of the engine's public provenance digest, made once AFTER a successful metered assessment (so an over-budget caller never reaches it) to record which build produced a case revision; no units, and bounded by the case route's own request limit" },
  { file: "lib/engine-capabilities.ts", snippet: "/v1/version", why: "a key-less GET of the engine's public route list, cached for five minutes per process, so that /llms.txt and the pages advertise only routes the deployed engine serves; it spends no units and carries no credential" },
  { file: "lib/api-readiness.ts", snippet: "/v1/version", why: "a GET with a minted probe key and the operator key to prove key issuance works; never the platform key, cached per process" },
  { file: "lib/api-readiness.ts", snippet: "/v1/admin/ledger", why: "a one-row GET of the operator-only ledger with the operator key, to prove the engine can serve the usage records an invoice is built from before a free or pay-as-you-go key is issued; spends no units, cached per process" },
  { file: "lib/api-access.ts", snippet: "/v1/version", why: "a GET with a throwaway one-day probe key, to prove the engine verifies the keys this site signs before a rotation revokes the key it replaces; spends no units, never the platform key" },
  { file: "lib/api-access.ts", snippet: "/v1/revoke", why: "revokes a customer's key with the operator key when a subscription ends or is withdrawn; not the platform key" },
  { file: "lib/payg-analytics.ts", snippet: "/v1/admin/economics", why: "the admin economics report reads the engine's operator-only measured-compute summary with the operator key (never the platform key); it spends no units and runs only behind the admin session" },
  { file: "lib/payg-usage.ts", snippet: "/v1/admin/ledger", why: "the daily cron reads the engine's operator-only usage ledger with the operator key (never the platform key); it spends no units and runs only behind CRON_SECRET" },
];

const rawFetches = (file: string, src: string) =>
  [...src.matchAll(/(?<![\w.$])fetch\(([^\n]{0,200})/g)]
    .map((m) => ({ file, arg: m[1], at: m.index! }))
        // `/v1/` is the engine's path prefix; Supabase's own /rest/v1, /storage/v1 and /auth/v1 are not the engine.
    .filter((m) => /\bbase\b|\be\.base\b|(?<!\/rest|\/storage|\/auth)\/v1\/|anthropic\.com/.test(m.arg));

describe("nothing reaches a provider around the gate", () => {
  const raw = [...SRC].filter(([f]) => f !== GATE_FILE).flatMap(([f, s]) => rawFetches(f, s));

  it("every raw fetch of the engine or Anthropic is on the reasoned allow-list", () => {
    const unlisted = raw.filter((r) => !RAW_ENGINE_FETCH_ALLOWED.some((a) => a.file === r.file && r.arg.includes(a.snippet)));
    expect(unlisted.map((r) => `${r.file}: fetch(${r.arg.slice(0, 80)}`)).toEqual([]);
  });

  it("the allow-list holds no stale entry: each matches exactly one real call and carries a reason", () => {
    for (const a of RAW_ENGINE_FETCH_ALLOWED) {
      expect(a.why.length, a.file).toBeGreaterThan(30);
      expect(raw.filter((r) => r.file === a.file && r.arg.includes(a.snippet)), `${a.file} ${a.snippet}`).toHaveLength(1);
    }
  });

  it("every Anthropic client is built with the gate's fetch", () => {
    const clients = [...SRC].filter(([f]) => f !== GATE_FILE).flatMap(([f, s]) => [...s.matchAll(/new Anthropic\(\{[^}]*\}\)/g)].map((m) => ({ f, text: m[0] })));
    expect(clients.length).toBeGreaterThanOrEqual(3); // agent, extract, siting
    for (const c of clients) expect(c.text, c.f).toMatch(/fetch:\s*anthropicFetch/);
  });

  it("a raw provider fetch added to a helper would be found (the detector sees what it is meant to)", () => {
    const sample = "const res = await fetch(`${base}/v1/study`, { method: 'POST' });";
    expect(rawFetches("lib/new-helper.ts", sample)).toHaveLength(1);
    expect(rawFetches("lib/new-helper.ts", "await engineFetch(`${base}/v1/study`)")).toHaveLength(0);
    expect(rawFetches("lib/new-helper.ts", "await fetch(`${url}/rest/v1/leads`)")).toHaveLength(0); // the store is not a provider
  });
});

describe("the registry says what is true about the guard", () => {
  it("states that the guard fails closed until migration 0024 is applied, and is live only because the deployed engine serves /v1/compare", async () => {
    const c = CAPABILITY_REGISTRY.find((x) => x.capability_id === "ttp_compare")!;
    expect(c.entitlement).toMatch(/guardRequest/);
    expect(c.entitlement).toMatch(/503 until migration 0024 is applied/);
    const { default: deployedSnapshot } = await import("@/lib/engine-deployed.json");
    expect(c.rest_endpoint).toBe("/v1/compare");
    expect(deployedSnapshot.endpoints).toContain("/v1/compare");
    expect(c.production_status).toBe("live");
  });
});

describe("the buyer page in the capability registry", () => {
  const c = CAPABILITY_REGISTRY.find((x) => x.capability_id === "project_buyer_page");
  it("is declared without a price, a SKU or a claim to be live", () => {
    expect(c).toMatchObject({ family: "project", status: "free", stripe_product_or_price: "none", production_status: "not_deployed", web_route: "/p/[shareToken]" });
    expect(c!.product_id).toBeUndefined();
  });
  it("names the tables it reads and states that only a hash of the link is kept", () => {
    expect(c!.database_record).toMatch(/project_shares \(hash of the link only\)/);
    expect(c!.entitlement).toMatch(/Only the SHA-256 of the link is stored/);
  });
});
