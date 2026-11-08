/**
 * A reference-template comparison, end to end to the buyer: click a template, change one value, save it to a project, open the buyer link.
 * The buyer must see EVERY template figure (the figures the site marked assumed (E0) are stored as {value, evidence, note}, not as bare numbers),
 * each labelled as a reference-template value marked assumed, and a visible line that the comparison started from a template. The owner's project
 * state says the same. Real routes and the REAL Python engine (spawned, not stubbed) against the in-memory PostgREST; fixtures are SYNTHETIC.
 * The real-engine suite uses describe.runIf(hasPython); the guard test at the end FAILS when GRIDFORGE_REQUIRE_ENGINE=1 or CI=true and python3
 * is missing, so CI cannot skip it silently.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { siteUrl } from "@/lib/site";
import { ASSUMED_TEMPLATE_LABEL, assumptionsOf } from "@/lib/buyer-view";
import { PRESET_VALUE_KEYS, presetById, presetFormState } from "@/lib/hall-presets";
import { buildCompareBody } from "@/components/TtpCompare";
import { ASSUMED_VALUE_NOTE, SITE_ANNOTATIONS_KEY, templateDerivedCount } from "@/lib/ttp-compare";
import { resetMemoryLimiter } from "@/lib/rate-limit";
import { PostgrestFake } from "./postgrest-fake";
import { installProjectRpcs } from "./project-rpc-fake";
import { engineAvailable } from "./_engine-guard";

const ROOT = path.resolve(__dirname, "../..");
const hasPython = spawnSync("python3", ["--version"]).status === 0;
const KEY = "template-buyer-key";
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
  engine = spawn("python3", ["-c", code], { cwd: ROOT, stdio: ["ignore", "pipe", "inherit"] });
  return await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error("engine did not start")), 20_000);
    engine!.stdout!.once("data", (d) => { clearTimeout(t); res(`http://127.0.0.1:${String(d).trim()}`); });
  });
}
const TABLES = [
  "projects", "project_links", "project_events", "project_evidence", "procurement_packages", "procurement_responses",
  "procurement_comparisons", "project_observations", "project_observation_reviews", "supplier_actuals", "supplier_actual_reviews",
  "supplier_reality", "cost_evidence_state", "cost_evidence_runs", "deliverables", "watches", "watch_notes", "leads",
  "engagement_deposits", "project_comparisons", "project_shares", "rate_limit_windows",
];
const post = (p: string, body?: unknown) =>
  new Request(siteUrl(p), { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.31" }, body: body === undefined ? undefined : JSON.stringify(body) });
const ctx = (token: string) => ({ params: Promise.resolve({ token }) });

beforeAll(async () => { if (hasPython) ENGINE = await startEngine(); }, 30_000);
afterAll(() => engine?.kill());
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

const text = (html: string) => html.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");

describe("assumptionsOf reads a figure the site marked assumed", () => {
  const intake = (tap: unknown) => ({ intake: { lv: { tapoff_max_A: tap, busway_ampacity_A: 400 }, site: { design_drybulb_C: { value: 32, evidence: "E0", note: ASSUMED_VALUE_NOTE } } } });
  it("unwraps {value, evidence: E0} to the number and marks it; a bare number is shown unmarked", () => {
    const rows = assumptionsOf(intake({ value: 32, evidence: "E0", note: ASSUMED_VALUE_NOTE }));
    expect(rows).toContainEqual({ label: "Tap-off rating (max)", value: "32 A", assumed: true });
    expect(rows).toContainEqual({ label: "Busway ampacity", value: "400 A" });
    expect(rows).toContainEqual({ label: "Summer design dry-bulb", value: "32 °C", assumed: true });
  });
  it("an annotated figure with another class is shown as a number but is not called a template value; the note text is never copied", () => {
    const rows = assumptionsOf(intake({ value: 63, evidence: "E5", note: "confidential note about the DSO" }));
    expect(rows).toContainEqual({ label: "Tap-off rating (max)", value: "63 A" });
    expect(JSON.stringify(rows)).not.toContain("confidential");
  });
  it("a hostile annotated figure (text or non-finite value) is dropped, not printed", () => {
    for (const bad of [{ value: "32", evidence: "E0" }, { value: null }, { value: { v: 1 } }, [1], "x"]) {
      expect(assumptionsOf(intake(bad)).find((r) => r.label === "Tap-off rating (max)"), JSON.stringify(bad)).toBeUndefined();
    }
  });
});

describe.runIf(hasPython)("a template, edited once and saved, as the buyer and the owner see it", () => {
  async function saveEdited() {
    const p = presetById("legacy_air_to_dlc")!;
    const edited = { ...presetFormState(p), tapoffMaxA: "125" };
    const saved = await (await import("@/app/api/power/compare/save/route")).POST(post("/api/power/compare/save", { compare: buildCompareBody(edited, [], p.objective, p), project: { project_name: "Template project" } }));
    expect(saved.status, await saved.clone().text()).toBeLessThan(300);
    const token = (await saved.json()).project_token as string;
    const link = await (await import("@/app/api/projects/[token]/share/route")).POST(post("/x"), ctx(token));
    expect(link.status).toBe(201);
    const shareToken = ((await link.json()).share_path as string).replace("/p/", "");
    return { p, token, shareToken };
  }
  const page = async (shareToken: string) => {
    const mod = await import("@/app/p/[shareToken]/page");
    return renderToStaticMarkup(await mod.default({ params: Promise.resolve({ shareToken }) }));
  };

  it("the buyer page lists all 14 figures, 13 labelled as reference-template values marked assumed and the edited one as the owner's, with the template line", async () => {
    const { shareToken } = await saveEdited();
    const html = await page(shareToken);
    const t = text(html);
    expect(t).toContain("Started from a reference template.");
    expect(t).toContain("13 of the figures below are synthetic template values, marked assumed (E0) by this site");
    for (const label of ["Contracted grid capacity", "Firm connection capacity", "Current site peak", "Current IT load", "Busway ampacity", "Tap-off rating (max)", "Free rack positions", "Floor loading", "Chilled-water plant capacity", "Chilled-water design supply", "Pumped flow available", "Other heat already on the plant", "Summer design dry-bulb", "Air removal per rack position"]) {
      expect(t, label).toContain(label);
    }
    expect((html.match(new RegExp(ASSUMED_TEMPLATE_LABEL.replace(/[()]/g, "\\$&"), "g")) ?? []).length).toBe(PRESET_VALUE_KEYS.length - 1);
    // the edited figure is shown as a number and is not called a template value
    expect(t).toMatch(/Tap-off rating \(max\) 125 A(?! assumed \(E0\), reference)/);
    // the site's own note text is never copied to the page
    expect(t).not.toContain(ASSUMED_VALUE_NOTE);
  });

  it("the owner's project state carries the count, and the saved request records it for any later reader", async () => {
    const { token } = await saveEdited();
    const state = await (await (await import("@/app/api/projects/[token]/route")).GET(new Request(siteUrl("/x")), ctx(token))).json();
    expect(state.comparisons.items[0].template_derived).toBe(PRESET_VALUE_KEYS.length - 1);
    const stored = db.rows("project_comparisons")[0] as { request: Record<string, any> };
    expect(stored.request[SITE_ANNOTATIONS_KEY]).toMatchObject({ template_derived_fields: PRESET_VALUE_KEYS.length - 1 });
    expect(templateDerivedCount(stored.request)).toBe(PRESET_VALUE_KEYS.length - 1);
  });

  it("a comparison of the owner's own hall carries no template line and no template label", async () => {
    const p = presetById("legacy_air_to_dlc")!;
    const own = { ...buildCompareBody(presetFormState(p), [], p.objective, p), assumed_fields: [] as string[] };
    const saved = await (await import("@/app/api/power/compare/save/route")).POST(post("/api/power/compare/save", { compare: own, project: { project_name: "Own hall" } }));
    expect(saved.status).toBeLessThan(300);
    const token = (await saved.json()).project_token as string;
    const link = await (await import("@/app/api/projects/[token]/share/route")).POST(post("/x"), ctx(token));
    const t = text(await page(((await link.json()).share_path as string).replace("/p/", "")));
    expect(t).not.toContain("Started from a reference template");
    expect(t).not.toContain(ASSUMED_TEMPLATE_LABEL);
    expect(t).toContain("Tap-off rating (max)");
  });
});

describe("the real-engine suite cannot be skipped silently where it is required", () => {
  it("python3 is present whenever GRIDFORGE_REQUIRE_ENGINE=1 or CI=true", () => {
    const g = engineAvailable(hasPython);
    expect(g.ok, g.reason).toBe(true);
  });
});
