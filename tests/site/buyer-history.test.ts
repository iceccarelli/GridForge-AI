/**
 * The buyer page lists the project's saved comparisons, and only what an allow-list lets through.
 *
 * Data-level tests use synthetic rows carrying owner-only values that must never reach a buyer; the page tests run the
 * REAL Python engine (as buyer-page.test.ts does) through the real save route and render the real page.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { siteUrl } from "@/lib/site";
import { BUYER_HISTORY_MAX, historyOf } from "@/lib/buyer-view";
import type { ComparisonRow } from "@/lib/project-comparisons";
import { resetMemoryLimiter } from "@/lib/rate-limit";
import { PostgrestFake } from "./postgrest-fake";
import { installProjectRpcs } from "./project-rpc-fake";

const OWNER_ONLY = ["SECRET-DSO", "SECRET-QUEUE-NOTE", "SECRET-SUPPLIER", "SECRET-REVIEWER", "SECRET-REF", "SECRET-CLIENT", "SECRET-TOKEN"];

function row(i: number, over: Partial<ComparisonRow> = {}): ComparisonRow {
  return {
    id: `id-${i}`,
    project_id: "p",
    request: { intake: { grid: { dso: "SECRET-DSO", queue_note: "SECRET-QUEUE-NOTE" }, project: { client: "SECRET-CLIENT", reference: "SECRET-REF" } }, project_token: "SECRET-TOKEN" },
    result: {
      ranking: { leader: "s2" },
      scenarios: [{ id: "s1", name: "Retained air" }, { id: "s2", name: "Full liquid cooling" }],
      cost_evidence: { used: [{ supplier: "SECRET-SUPPLIER", reviewer: "SECRET-REVIEWER", value: 123456 }] },
    } as unknown as ComparisonRow["result"],
    schema: "gridforge/ttp-compare/1",
    request_digest: `${String(i).padStart(2, "0")}abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdef12`,
    provenance_digest: "x",
    engine_version: "1.2.3",
    grade: "indicative",
    evidence_ids: i % 2 ? ["q1", "q2"] : [],
    saved_at: `2026-10-${String(30 - i).padStart(2, "0")}T10:00:00Z`,
    ...over,
  };
}

describe("historyOf: the allow-list", () => {
  it("carries date, grade, the scenario ranked first, a short digest, engine version and a quotation COUNT", () => {
    const h = historyOf([row(0), row(1)]);
    expect(h).toEqual([
      { saved_at: "2026-10-30T10:00:00Z", grade: "indicative", leader: "Full liquid cooling", request_digest: "00abcdefabcdefab", engine_version: "1.2.3", quotation_lines: 0, shown: true },
      { saved_at: "2026-10-29T10:00:00Z", grade: "indicative", leader: "Full liquid cooling", request_digest: "01abcdefabcdefab", engine_version: "1.2.3", quotation_lines: 2, shown: false },
    ]);
  });
  it("NEGATIVE: nothing the owner typed, no supplier, reviewer, price, token or request reaches it", () => {
    const text = JSON.stringify(historyOf([row(0), row(1), row(2)]));
    for (const s of OWNER_ONLY) expect(text, s).not.toContain(s);
    expect(text).not.toMatch(/123456|request"|intake|project_token|evidence_ids|id-\d/);
  });
  it("a comparison that ranked nothing first says so, and a malformed stored result does not throw", () => {
    const none = row(0, { result: { ranking: { leader: null }, scenarios: [] } as unknown as ComparisonRow["result"] });
    expect(historyOf([none])[0].leader).toBeNull();
    expect(() => historyOf([row(0, { result: {} as unknown as ComparisonRow["result"] })])).not.toThrow();
  });
  it("is bounded", () => {
    const many = Array.from({ length: BUYER_HISTORY_MAX + 10 }, (_, i) => row(i % 28));
    expect(historyOf(many)).toHaveLength(BUYER_HISTORY_MAX);
  });
});

// ------------------------------------------------------------------ the rendered page, on the real engine

const hasPython = spawnSync("python3", ["--version"]).status === 0;
const KEY = "buyer-history-key";
let engine: ChildProcess | null = null;
let ENGINE = "";
const realFetch = globalThis.fetch;
let db: PostgrestFake;
let restoreDb: () => void;

async function startEngine(): Promise<string> {
  const code = [
    "import os", `os.environ['GRIDFORGE_API_KEYS']='${KEY}'`, "os.environ['GRIDFORGE_RATE_LIMIT']='0'",
    "from gridforge.api.server import Handler, make_server", "Handler.limiter.per_minute=0",
    "h=make_server('127.0.0.1',0)", "print(h.server_address[1],flush=True)", "h.serve_forever()",
  ].join("\n");
  engine = spawn("python3", ["-c", code], { cwd: process.cwd(), stdio: ["ignore", "pipe", "inherit"] });
  return await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error("engine did not start")), 20_000);
    engine!.stdout!.once("data", (d) => { clearTimeout(t); res(`http://127.0.0.1:${String(d).trim()}`); });
  });
}
beforeAll(async () => { if (hasPython) ENGINE = await startEngine(); }, 30_000);
afterAll(() => engine?.kill());

const TABLES = [
  "projects", "project_links", "project_events", "project_evidence", "procurement_packages", "procurement_responses",
  "procurement_comparisons", "project_observations", "project_observation_reviews", "supplier_actuals", "supplier_actual_reviews",
  "supplier_reality", "cost_evidence_state", "cost_evidence_runs", "deliverables", "watches", "watch_notes", "leads",
  "engagement_deposits", "project_comparisons", "project_shares", "rate_limit_windows",
];
beforeEach(() => {
  resetMemoryLimiter();
  process.env.SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_test";
  process.env.GRIDFORGE_API_URL = ENGINE;
  process.env.GRIDFORGE_API_KEY = KEY;
  db = new PostgrestFake(TABLES);
  db.appendOnly.add("project_comparisons");
  installProjectRpcs(db);
  restoreDb = db.install();
  const dbFetch = globalThis.fetch;
  globalThis.fetch = (async (i: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof i === "string" ? i : i instanceof URL ? i.href : i.url;
    return ENGINE && url.startsWith(ENGINE) ? realFetch(i as RequestInfo, init) : dbFetch(i, init);
  }) as typeof fetch;
});
afterEach(() => { restoreDb(); globalThis.fetch = realFetch; vi.restoreAllMocks(); vi.unstubAllEnvs(); });

const HALL = {
  siteName: "Synthetic Hall", hallId: "H1", metro: "Dublin", dso: "SECRET-DSO", queueNote: "SECRET-QUEUE-NOTE",
  firmCapacityMVA: 15, contractedMW: 12, currentPeakMW: 7.4, currentItLoadMW: 4.9, buswayAmpacityA: 400, tapoffMaxA: 63,
  floorLoadingKPa: 12, positionsAvailable: 180, plantCapacityKW: 6000, plantSupplyC: 6, platform: "gb300_nvl72",
  transformers: [{ id: "TX-A/B", unit_rating_MVA: 10, units: 3, redundancy: "N+1", replacement_lead_time_weeks: 160 }],
  ups: [{ id: "UPS-1", unit_rating_kW: 2500, units: 6, redundancy: "N+1" }],
};
const post = (path: string, body: unknown) =>
  new Request(siteUrl(path), { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.5" }, body: JSON.stringify(body) });
const save = async (project: Record<string, unknown>, compare: Record<string, unknown>) =>
  (await import("@/app/api/power/compare/save/route")).POST(post("/api/power/compare/save", { compare, project }));
const ctx = (token: string) => ({ params: Promise.resolve({ token }) });
async function issue(token: string): Promise<string> {
  const { POST } = await import("@/app/api/projects/[token]/share/route");
  const r = await POST(new Request(siteUrl("/x"), { method: "POST" }), ctx(token));
  return ((await r.json()).share_path as string).replace("/p/", "");
}
async function page(shareToken: string) {
  const mod = await import("@/app/p/[shareToken]/page");
  return renderToStaticMarkup(await mod.default({ params: Promise.resolve({ shareToken }) }));
}

describe.runIf(hasPython)("the buyer page lists the saved comparisons", () => {
  async function projectWith(n: number) {
    const first = await (await save({ project_name: "North Hall expansion", company: "North Hall Ltd" }, { hall: HALL, objective: "fastest" })).json();
    const token = first.project_token as string;
    // each later save changes the request, so each is a distinct comparison
    for (let i = 1; i < n; i++) {
      const r = await save({ project_token: token }, { hall: { ...HALL, currentPeakMW: 7.4 + i / 10, queueNote: `SECRET-QUEUE-NOTE-${i}` }, objective: i % 2 ? "max_compute" : "fastest" });
      expect(r.status, `save ${i}`).toBeLessThan(300);
    }
    return token;
  }

  it("shows every saved comparison with date, grade, what ranked first and the digest, newest first, the latest marked", async () => {
    const token = await projectWith(3);
    const html = await page(await issue(token));
    const rows = db.rows("project_comparisons");
    expect(rows).toHaveLength(3);
    expect(html).toContain("Saved comparisons for this project");
    expect(html).toContain("2 earlier saved comparisons");
    for (const r of rows) expect(html).toContain((r.request_digest as string).slice(0, 16));
    expect(html).toContain("(shown above)");
    expect(html.match(/\(shown above\)/g)).toHaveLength(1);
    expect(html).toMatch(/<th scope="col"[^>]*>Saved<\/th>/);
    // newest first: the digest of the latest saved row appears before that of the earliest
    const byTime = [...rows].sort((a, b) => String(b.saved_at).localeCompare(String(a.saved_at)));
    expect(html.indexOf((byTime[0].request_digest as string).slice(0, 16))).toBeLessThan(html.indexOf((byTime[2].request_digest as string).slice(0, 16)));
  });

  it("NEGATIVES: no private DSO name, queue note (any revision), project token, owner reference or quotation line", async () => {
    const token = await projectWith(3);
    const html = await page(await issue(token));
    expect(html).not.toContain(token);
    expect(html).not.toMatch(/SECRET-DSO|SECRET-QUEUE-NOTE|Private DSO/);
    expect(html).not.toMatch(/workspace\?project|<form|Request \(JSON\)|Copy request/);
    // the history section itself carries no supplier or reviewer wording at all (the rest of the page has its own, existing copy)
    const section = html.slice(html.indexOf('id="history"'), html.indexOf("</section>", html.indexOf('id="history"')));
    expect(section.length).toBeGreaterThan(200);
    expect(section).not.toMatch(/supplier|reviewer|response_ref|quotation line.*[A-Z]{3,}/i);
  });

  it("a project with one saved comparison shows no history table, as before", async () => {
    const token = await projectWith(1);
    const html = await page(await issue(token));
    expect(html).not.toContain("Saved comparisons for this project");
    expect(html).not.toMatch(/earlier saved comparison/);
  });

  it("the count stays true past the bound, and says how many are listed", async () => {
    const token = await projectWith(2);
    const proj = db.rows("projects").find((p) => p.project_token === token)!;
    const base = db.rows("project_comparisons")[0];
    // append-only for the API, so seed the extra history directly
    db.appendOnly.delete("project_comparisons");
    for (let i = 0; i < BUYER_HISTORY_MAX + 4; i++) {
      db.insertRow("project_comparisons", { ...base, id: undefined, project_id: proj.id, request_digest: `e${String(i).padStart(2, "0")}${"0".repeat(61)}`, saved_at: `2026-0${1 + (i % 9)}-01T00:00:00Z` });
    }
    const html = await page(await issue(token));
    const total = db.rows("project_comparisons").filter((c) => c.project_id === proj.id).length;
    expect(html).toContain(`${total - 1} earlier saved comparisons`);
    expect(html).toContain(`The ${BUYER_HISTORY_MAX} most recent of ${total} are listed.`);
    expect(html.match(/<tr /g)!.length).toBeLessThanOrEqual(BUYER_HISTORY_MAX + 1 + 40); // bounded table (other tables on the page add their own rows)
  });
});
