/**
 * /qualify reference templates and engine parity.
 *
 * The free qualifier takes seven plain numbers. A visitor with no figures to hand may start from a reference template (lib/hall-presets.ts),
 * whose values are synthetic and nobody measured. Sent as plain numbers they would be classed E5, customer data, in the result's own basis.
 * POST /v1/qualify therefore accepts `assumed_fields` (gridforge/api/server.py), the engine reports those figures as E0, and the site shows the
 * template selector ONLY when the deployed engine's /v1/version advertises `capabilities.qualify_assumed_fields`.
 *
 * Layers proved here: the request body and the schema (lib/qualify.ts); the capability reader (lib/engine-capabilities.ts); the route, against a
 * stub and against the REAL engine (python3 spawned: it FAILS, not skips, where GRIDFORGE_REQUIRE_ENGINE=1 or CI=true and python3 is missing);
 * the form and the result as rendered; and the order and reality of the next steps. Interaction in a real browser is checked separately.
 */
import fs from "node:fs";
import path from "node:path";
import React from "react";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { siteUrl } from "@/lib/site";
import {
  QUALIFY_ASSUMABLE,
  assumedEngineFields,
  intakePrefill,
  qualifySchema,
  toEngineBody,
  type QualifyResult,
  type StoredQualification,
} from "@/lib/qualify";
import {
  HALL_PRESETS,
  PRESET_DISCLOSURE,
  QUALIFY_PRESET_KEYS,
  isUntouchedQualifyTemplate,
  qualifyTemplateState,
  stillTemplateQualifyValues,
  switchQualifyTemplate,
} from "@/lib/hall-presets";
import { QUALIFY_ASSUMED_FIELDS_FLAG, capabilityFlagsFromVersion, deployedEngineFlags, engineHas } from "@/lib/engine-capabilities";
import { NEXT_STEPS, NEXT_STEP_HREFS } from "@/lib/qualify-next-steps";
import { QUALIFY_ENGINE_PATH, assumedRecordMatches, type QualifyAssumable } from "@/lib/qualify-assumed";
import { CapacityQualifier, QualifyReadout, TemplateNotice } from "@/components/CapacityQualifier";
import { resetMemoryLimiter } from "@/lib/rate-limit";
import { resetEngineCapabilityCache } from "@/lib/engine-capabilities";
import { engineAvailable } from "./_engine-guard";
import { FULL_ENGINE, stubEngine } from "./engine-stub";
import { PostgrestFake } from "./postgrest-fake";

const funnel = vi.hoisted(() => ({ events: [] as { name: string; props: unknown }[] }));
vi.mock("@/lib/funnel", async (orig) => ({
  ...(await orig<typeof import("@/lib/funnel")>()),
  recordFunnelEvent: async (name: string, props: unknown) => {
    funnel.events.push({ name, props });
    return true;
  },
}));

const ROOT = path.resolve(__dirname, "../..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const hasPython = spawnSync("python3", ["--version"]).status === 0;
const text = (html: string) => html.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

const SEVEN = {
  siteName: "North Hall", platform: "gb300_nvl72", contractedMW: 12, currentPeakMW: 7.4, currentItLoadMW: 4.9, buswayAmpacityA: 400,
  tapoffMaxA: 63, plantSupplyC: 6, positionsAvailable: 180,
};
const post = (body: unknown) =>
  new Request(siteUrl("/api/qualify"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

// ------------------------------------------------------------------------------------------------ the request body
describe("the request: assumed_fields is in the engine body only when a figure is declared assumed", () => {
  it("a plain request is exactly the body it always was (no assumed_fields key)", () => {
    const body = toEngineBody(qualifySchema.parse(SEVEN));
    expect(body).toEqual({
      client: "Website qualifier", site_name: "North Hall", hall_id: undefined, metro: undefined, country: undefined, platform: "gb300_nvl72",
      contracted_MW: 12, current_site_peak_MW: 7.4, current_it_load_MW: 4.9, busway_ampacity_A: 400, tapoff_max_A: 63, plant_supply_C: 6, positions_available: 180,
    });
    expect("assumed_fields" in body).toBe(false);
    expect("assumed_fields" in toEngineBody(qualifySchema.parse({ ...SEVEN, assumedFields: [] }))).toBe(false);
  });

  it("names each declared figure by the engine's name, once, in the qualifier's order", () => {
    const q = qualifySchema.parse({ ...SEVEN, assumedFields: ["positionsAvailable", "contractedMW", "tapoffMaxA"] });
    expect((toEngineBody(q) as { assumed_fields: string[] }).assumed_fields).toEqual(["contracted_MW", "tapoff_max_A", "positions_available"]);
    expect(assumedEngineFields(q)).toEqual(["contracted_MW", "tapoff_max_A", "positions_available"]);
  });

  it("the names are the engine's own: every one is a QUALIFY_FIELDS key in gridforge/api/server.py", () => {
    const server = read("gridforge/api/server.py");
    const block = server.slice(server.indexOf("QUALIFY_FIELDS = {"), server.indexOf("}", server.indexOf("QUALIFY_FIELDS = {")));
    for (const engineName of Object.values(QUALIFY_ASSUMABLE)) expect(block, engineName).toContain(`"${engineName}"`);
    expect(Object.keys(QUALIFY_ASSUMABLE)).toEqual([...QUALIFY_PRESET_KEYS]);
  });

  it("the engine path recorded for each figure is the engine's own QUALIFY_FIELDS mapping", () => {
    const server = read("gridforge/api/server.py");
    const block = server.slice(server.indexOf("QUALIFY_FIELDS = {"), server.indexOf("}", server.indexOf("QUALIFY_FIELDS = {")));
    for (const [form, engineName] of Object.entries(QUALIFY_ASSUMABLE)) expect(block, form).toContain(`"${engineName}": "${QUALIFY_ENGINE_PATH[form as QualifyAssumable]}"`);
  });

  it.each([
    ["an unknown name", ["firmCapacityMVA"]],
    ["an engine name where the form's is expected", ["contracted_MW"]],
    ["a repeated name", ["tapoffMaxA", "tapoffMaxA"]],
    ["a class instead of a name", ["E5"]],
    ["a non-list", "tapoffMaxA"],
    ["an object", { tapoffMaxA: "E5" }],
    ["more than seven", Array(8).fill("tapoffMaxA")],
  ])("refuses %s", (_label, value) => {
    expect(qualifySchema.safeParse({ ...SEVEN, assumedFields: value }).success).toBe(false);
  });
});

// ------------------------------------------------------------------------------------------------ the capability reader
describe("the capability flags a /v1/version body declares", () => {
  it("counts only a flag whose value is exactly true", () => {
    expect([...capabilityFlagsFromVersion({ capabilities: { qualify_assumed_fields: true, other: false, text: "true", one: 1, nul: null } })]).toEqual(["qualify_assumed_fields"]);
  });
  it.each([[null], [undefined], [[]], ["x"], [{}], [{ capabilities: null }], [{ capabilities: [] }], [{ capabilities: "qualify_assumed_fields" }], [{ capabilities: ["qualify_assumed_fields"] }]])(
    "reads nothing from %j",
    (body) => {
      expect(capabilityFlagsFromVersion(body).size).toBe(0);
    }
  );

  describe("engineHas, against the engine it can reach", () => {
    afterEach(() => resetEngineCapabilityCache());
    it("is true only when the live engine declares the flag", async () => {
      let stop = stubEngine(FULL_ENGINE, { [QUALIFY_ASSUMED_FIELDS_FLAG]: true });
      expect(await engineHas(QUALIFY_ASSUMED_FIELDS_FLAG)).toBe(true);
      stop();
      stop = stubEngine(FULL_ENGINE, { [QUALIFY_ASSUMED_FIELDS_FLAG]: false });
      expect(await engineHas(QUALIFY_ASSUMED_FIELDS_FLAG)).toBe(false);
      stop();
    });
    it("is false for an engine that has the route but not the key (the deployed engine today), and for an unreadable or malformed one", async () => {
      for (const [routes, caps] of [[FULL_ENGINE, undefined], [FULL_ENGINE, "malformed"], ["down", undefined]] as const) {
        const stop = stubEngine(routes as string[] | "down", caps as Record<string, unknown> | "malformed" | undefined);
        expect(await engineHas(QUALIFY_ASSUMED_FIELDS_FLAG), String(routes === "down" ? "down" : caps)).toBe(false);
        expect([...(await deployedEngineFlags())]).toEqual([]);
        stop();
      }
    });
    it("reads no flag from a body whose route list is not a /v1/version answer", async () => {
      const previous = globalThis.fetch;
      resetEngineCapabilityCache();
      globalThis.fetch = (async () => new Response(JSON.stringify({ capabilities: { [QUALIFY_ASSUMED_FIELDS_FLAG]: true } }), { status: 200 })) as typeof fetch;
      expect(await engineHas(QUALIFY_ASSUMED_FIELDS_FLAG)).toBe(false);
      globalThis.fetch = previous;
    });
  });

  it("the committed deployed-engine snapshot does not claim the flag: nothing here marks the sub-feature live", () => {
    const snap = JSON.parse(read("lib/engine-deployed.json"));
    expect("capabilities" in snap).toBe(false);
    const reg = read("lib/capability-registry.ts");
    const qualify = reg.slice(reg.indexOf('capability_id: "qualify"'), reg.indexOf('capability_id: "density_screen"'));
    expect(qualify).toContain('production_status: "live"');
    expect(qualify).toContain("only once it is redeployed");
    expect(qualify).not.toMatch(/qualify_assumed_fields[^.]*\blive\b[^.]*deployed/);
  });
});

// ------------------------------------------------------------------------------------------------ the route, against a stub
const ENGINE = "http://engine.test";
let db: PostgrestFake;
let restoreDb: () => void;
let restoreEngine: () => void;
let qualifyBodies: Record<string, unknown>[];
let versionBody: Record<string, unknown> | "down";
/** What the stub does with assumed_fields: record them (an engine that has the capability), ignore the key (an older machine), or record only some. */
let recordMode: "records" | "ignores" | "partial" | "wrong-class" = "records";
const PATH_OF: Record<string, string> = Object.fromEntries(Object.entries(QUALIFY_ASSUMABLE).map(([k, engineName]) => [engineName, QUALIFY_ENGINE_PATH[k as QualifyAssumable]]));

function installStubEngine() {
  const previous = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(ENGINE)) return previous(input as RequestInfo, init);
    if (url.endsWith("/v1/version")) {
      if (versionBody === "down") throw new Error("engine unreachable");
      return new Response(JSON.stringify(versionBody), { status: 200, headers: { "content-type": "application/json" } });
    }
    const sent = JSON.parse(String(init?.body));
    qualifyBodies.push(sent);
    const asked: string[] = Array.isArray(sent.assumed_fields) ? sent.assumed_fields : [];
    const rows = asked.map((n) => ({ path: PATH_OF[n], input: n, unit: "-", value: 1, evidence: recordMode === "wrong-class" ? "E5" : "E0", note: "n" }));
    const recorded = recordMode === "ignores" || rows.length === 0 ? {} : { inputs_declared_assumed: recordMode === "partial" ? rows.slice(1) : rows };
    return new Response(
      JSON.stringify({
        ...recorded,
        platform: { id: "gb300_nvl72", name: "NVIDIA GB300 NVL72" },
        as_found: { racks: 0, binding_constraint: "Rack feed / tap-off rating", domain: "electrical", basis: "b", it_load_kW: { evidence: "E0_ASSUMPTION" } },
        after_relief: { racks: 28, architecture: "full_dlc", then_binds_on: null, sets_the_date: "plant" },
        first_three_constraints: [],
        intake: { completeness: 0.5, required_inputs_missing: 8, recommended_engagement: "density_screen", gaps: [] },
        notice: "n",
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;
  return () => { globalThis.fetch = previous; };
}

const ADVERTISES = { version: "0.9.0", endpoints: FULL_ENGINE, capabilities: { [QUALIFY_ASSUMED_FIELDS_FLAG]: true } };
const PREDATES = { version: "0.9.0", endpoints: FULL_ENGINE };           // the deployed engine today: no `capabilities` key

describe("POST /api/qualify with figures declared assumed", () => {
  beforeEach(() => {
    process.env.SUPABASE_URL = "https://stub.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_test";
    process.env.GRIDFORGE_API_URL = ENGINE;
    resetMemoryLimiter();
    resetEngineCapabilityCache();
    funnel.events.length = 0;
    qualifyBodies = [];
    versionBody = ADVERTISES;
    recordMode = "records";
    db = new PostgrestFake(["qualifications"]);
    restoreDb = db.install();
    restoreEngine = installStubEngine();
  });
  afterEach(() => { restoreEngine(); restoreDb(); resetEngineCapabilityCache(); });

  it("an engine that advertises the flag is sent assumed_fields, and the answer is flagged template-derived, unsaved and unshared", async () => {
    const { POST } = await import("@/app/api/qualify/route");
    const res = await POST(post({ ...SEVEN, assumedFields: ["contractedMW", "tapoffMaxA"] }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(qualifyBodies).toHaveLength(1);
    expect(qualifyBodies[0].assumed_fields).toEqual(["contracted_MW", "tapoff_max_A"]);
    expect(body).toMatchObject({ ok: true, templateDerived: true, share: null, saved: false, qualificationId: null, qualificationToken: null });
    // not a hall: nothing stored (so nothing joins a purchase, feeds the benchmark or seeds an intake), not counted as a completed qualification
    expect(db.rows("qualifications")).toHaveLength(0);
    // a template read is not a hall: neither a started nor a completed qualification
    expect(funnel.events.map((e) => e.name)).toEqual([]);
  });

  it("an engine that does NOT advertise it is never sent the field, and nothing is calculated (it would be answered as customer data)", async () => {
    const { POST } = await import("@/app/api/qualify/route");
    for (const v of [PREDATES, { ...PREDATES, capabilities: { [QUALIFY_ASSUMED_FIELDS_FLAG]: false } }, "down"] as const) {
      resetEngineCapabilityCache();
      versionBody = v as typeof versionBody;
      const res = await POST(post({ ...SEVEN, assumedFields: ["contractedMW"] }));
      expect(res.status, JSON.stringify(v)).toBe(409);
      const body = await res.json();
      expect(body).toMatchObject({ ok: false, reason: "template_not_supported" });
      expect(body.error).toMatch(/Enter your own figures/);
    }
    expect(qualifyBodies).toEqual([]);
    expect(db.rows("qualifications")).toHaveLength(0);
  });

  it.each(["ignores", "partial", "wrong-class"] as const)(
    "an engine that advertises the flag but did not record the declared figures as assumed (%s: a rolling deploy or a rollback) shows nothing",
    async (mode) => {
      recordMode = mode;
      const { POST } = await import("@/app/api/qualify/route");
      const res = await POST(post({ ...SEVEN, assumedFields: ["contractedMW", "tapoffMaxA"] }));
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body).toMatchObject({ ok: false, reason: "template_not_supported" });
      expect(body).not.toHaveProperty("result");
      expect(body).not.toHaveProperty("headline");
      expect(JSON.stringify(body)).not.toMatch(/racks|binding|tap-off/i);
      expect(db.rows("qualifications")).toHaveLength(0);
    }
  );

  it("a plain request is not held to that check, and the check demands exactly what was declared", () => {
    const rec = (paths: string[], evidence = "E0") => ({ inputs_declared_assumed: paths.map((path) => ({ path, evidence })) });
    const two: QualifyAssumable[] = ["contractedMW", "tapoffMaxA"];
    expect(assumedRecordMatches(rec(["grid.contracted_MW", "lv.tapoff_max_A"]), two)).toBe(true);
    expect(assumedRecordMatches(rec(["lv.tapoff_max_A", "grid.contracted_MW"]), two)).toBe(true);            // order is not the engine's promise
    for (const bad of [{}, null, undefined, rec([]), rec(["grid.contracted_MW"]), rec(["grid.contracted_MW", "lv.tapoff_max_A", "hall.positions_available"]),
      rec(["grid.contracted_MW", "grid.contracted_MW"]), rec(["grid.contracted_MW", "lv.busway_ampacity_A"]), rec(["grid.contracted_MW", "lv.tapoff_max_A"], "E5"),
      { inputs_declared_assumed: "grid.contracted_MW" }, { inputs_declared_assumed: [null, null] }]) {
      expect(assumedRecordMatches(bad, two), JSON.stringify(bad)).toBe(false);
    }
    expect(assumedRecordMatches({}, [])).toBe(true);
    expect(assumedRecordMatches(rec(["grid.contracted_MW"]), [])).toBe(false);           // nothing declared, yet the engine lists some
  });

  it("the selector is offered only where /api/qualify can run: no engine configured, no selector, whatever /v1/version says", async () => {
    const { engineConfigured } = await import("@/lib/qualify");
    expect(engineConfigured()).toBe(true);
    delete process.env.GRIDFORGE_API_URL;
    expect(engineConfigured()).toBe(false);
    const { default: Qualify } = await import("@/app/qualify/page");
    const stop = stubEngine(FULL_ENGINE, { [QUALIFY_ASSUMED_FIELDS_FLAG]: true });
    expect(renderToStaticMarkup(await Qualify())).not.toContain("qualify-template");
    stop();
    process.env.GRIDFORGE_API_URL = ENGINE;
  });

  it("an unsaved NON-template read says so beside the next steps; a saved one does not", () => {
    expect(text(readout(null, null))).toContain("It was not saved to a page on this deployment, so copy the figures above before you leave.");
    expect(text(readout(null, "/q/tok"))).not.toContain("It was not saved to a page");
    expect(text(readout({ name: "T", assumed: 7, total: 7, untouched: true, fields: ALL_FIELDS }, null))).not.toContain("copy the figures above");
  });

  it("a plain request does not depend on the flag at all: it works against an engine without it, is stored, and carries no assumed_fields", async () => {
    versionBody = PREDATES;
    const { POST } = await import("@/app/api/qualify/route");
    const body = await (await POST(post(SEVEN))).json();
    expect(body).toMatchObject({ ok: true, templateDerived: false, saved: true });
    expect(qualifyBodies[0]).not.toHaveProperty("assumed_fields");
    expect(db.rows("qualifications")).toHaveLength(1);
    expect(funnel.events.map((e) => e.name)).toEqual(["qualify_started", "qualify_completed"]);        // a plain read is counted as before
  });

  it("an empty assumedFields is a plain request", async () => {
    versionBody = PREDATES;
    const { POST } = await import("@/app/api/qualify/route");
    const body = await (await POST(post({ ...SEVEN, assumedFields: [] }))).json();
    expect(body).toMatchObject({ ok: true, templateDerived: false });
    expect(qualifyBodies[0]).not.toHaveProperty("assumed_fields");
  });

  it("hostile assumedFields is refused as a validation failure before anything is called", async () => {
    const { POST } = await import("@/app/api/qualify/route");
    for (const bad of [["nope"], "contractedMW", [1], [["contractedMW"]], [{ value: 1, evidence: "E5" }], ["contractedMW", "contractedMW"]]) {
      const res = await POST(post({ ...SEVEN, assumedFields: bad }));
      expect(res.status, JSON.stringify(bad)).toBe(422);
    }
    expect(qualifyBodies).toEqual([]);
  });

  it("a stored read never carries a template's figure into the engagement intake as the buyer's own", () => {
    const q = { inputs: { ...SEVEN, assumedFields: ["contractedMW", "tapoffMaxA"] } } as unknown as StoredQualification;
    const pre = intakePrefill(q);
    expect(pre.contractedMW).toBeUndefined();
    expect(pre.tapoffMaxA).toBeUndefined();
    expect(pre.currentPeakMW).toBe("7.4");
    expect(intakePrefill({ inputs: SEVEN } as unknown as StoredQualification).contractedMW).toBe("12");
  });
});

// ------------------------------------------------------------------------------------------------ the form and the template state
describe("the template state", () => {
  it("every template defines all seven qualifier figures", () => {
    for (const p of HALL_PRESETS) {
      const { raw, platform } = qualifyTemplateState(p);
      expect(Object.keys(raw), p.id).toEqual([...QUALIFY_PRESET_KEYS]);
      for (const v of Object.values(raw)) expect(Number.isFinite(Number(v)) && v.trim() !== "").toBe(true);
      expect(platform).toBe(p.platform);
    }
  });
  it("a figure is the template's until its text differs (trimmed); retyping the same number keeps it the template's", () => {
    const p = HALL_PRESETS[0];
    const raw: Record<string, string> = { ...qualifyTemplateState(p).raw };
    expect(isUntouchedQualifyTemplate(p, raw)).toBe(true);
    expect(stillTemplateQualifyValues(p, raw)).toHaveLength(7);
    raw.tapoffMaxA = ` ${p.values.tapoffMaxA} `;
    expect(stillTemplateQualifyValues(p, raw)).toHaveLength(7);
    raw.tapoffMaxA = "250";
    expect(stillTemplateQualifyValues(p, raw)).toHaveLength(6);
    expect(stillTemplateQualifyValues(p, raw)).not.toContain("tapoffMaxA");
    expect(isUntouchedQualifyTemplate(p, raw)).toBe(false);
    raw.contractedMW = "";
    expect(stillTemplateQualifyValues(p, raw)).not.toContain("contractedMW");
  });
});

describe("the seven fields start empty: their examples are placeholders, never values", () => {
  it("renders every field with an empty value and the example as placeholder text, with or without the flag", () => {
    for (const out of [renderToStaticMarkup(React.createElement(CapacityQualifier)), renderToStaticMarkup(React.createElement(CapacityQualifier as React.ComponentType<{ presetsAvailable: boolean }>, { presetsAvailable: true }))]) {
      for (const [k, ex] of Object.entries({ contractedMW: 12, currentPeakMW: 7.4, currentItLoadMW: 4.9, buswayAmpacityA: 400, tapoffMaxA: 63, plantSupplyC: 6, positionsAvailable: 180 })) {
        const tag = new RegExp(`<input[^>]*id="qualify-${k}"[^>]*>`).exec(out)![0];
        expect(tag, k).toMatch(/value=""/);
        expect(tag, k).toContain(`placeholder="e.g. ${ex}"`);
      }
      expect(out.match(/aria-required="true"/g)?.length).toBe(7);
    }
  });
  it("pressing the button on an untouched form sends nothing: the existing validation names all seven", () => {
    const src = read("components/CapacityQualifier.tsx");
    expect(src).toContain('if (raw.trim() === "") return "Enter a value.";');
    expect(src).toMatch(/const EMPTY_RAW = Object\.fromEntries\(Object\.keys\(DEFAULTS\)\.map\(\(k\) => \[k, ""\]\)\) as Raw;/);
    expect(src).not.toMatch(/String\(v\)\]\)\) as Raw/);
  });
});

describe("choosing a template never overwrites what the visitor typed", () => {
  const [a, b] = [HALL_PRESETS[0], HALL_PRESETS[1]];
  const empty = Object.fromEntries(QUALIFY_PRESET_KEYS.map((k) => [k, ""])) as Record<(typeof QUALIFY_PRESET_KEYS)[number], string>;
  it("from empty fields it loads every value; with 'no template' it empties the fields it filled", () => {
    const loaded = switchQualifyTemplate(empty, null, a);
    expect(loaded.raw).toEqual(qualifyTemplateState(a).raw);
    expect(loaded.kept).toEqual([]);
    expect(switchQualifyTemplate(loaded.raw, a, null)).toEqual({ raw: empty, kept: [] });
  });
  it("keeps a figure the visitor typed (and says so) when another template, or none, is chosen", () => {
    const edited = { ...qualifyTemplateState(a).raw, tapoffMaxA: "250", contractedMW: "" };
    const toB = switchQualifyTemplate(edited, a, b);
    expect(toB.kept).toEqual(["tapoffMaxA"]);
    expect(toB.raw.tapoffMaxA).toBe("250");
    expect(toB.raw.contractedMW).toBe(b.values.contractedMW);             // a cleared field takes the new template's value
    expect(toB.raw.positionsAvailable).toBe(b.values.positionsAvailable);
    const none = switchQualifyTemplate(edited, a, null);
    expect(none.raw.tapoffMaxA).toBe("250");
    expect(none.raw.positionsAvailable).toBe("");
  });
  it("typed figures survive even when no template was active before", () => {
    const typed = { ...empty, contractedMW: "14" };
    const r = switchQualifyTemplate(typed, null, a);
    expect(r.kept).toEqual(["contractedMW"]);
    expect(r.raw.contractedMW).toBe("14");
    expect(r.raw.tapoffMaxA).toBe(a.values.tapoffMaxA);
  });
});

describe("the form as rendered", () => {
  type Props = { presetsAvailable?: boolean; initialTemplateId?: string | null };
  const html = (props: Props) => renderToStaticMarkup(React.createElement(CapacityQualifier as React.ComponentType<Props>, props));

  it("without the flag the form is what it was: no selector, no template text, seven required numbers", () => {
    for (const out of [html({}), html({ presetsAvailable: false }), html({ presetsAvailable: false, initialTemplateId: HALL_PRESETS[0].id })]) {
      expect(out).not.toContain("qualify-template");
      expect(text(out)).not.toMatch(/reference template|Template value/i);
      expect(out.match(/aria-required="true"/g)?.length).toBe(7);
      expect(out).toContain("qualify-contractedMW");
    }
  });

  it("with the flag: one selector offering the three templates and 'no template'; no disclosure or tags until one is chosen", () => {
    const out = html({ presetsAvailable: true });
    expect(out).toContain('id="qualify-template"');
    expect(out.match(/<select\b/g)?.length).toBe(2);                    // the template and the platform
    for (const p of HALL_PRESETS) expect(text(out)).toContain(p.name);
    expect(out).toContain("No template");
    expect(out).not.toContain("qualify-template-disclosure");
    expect(text(out)).not.toContain("Template value");
    expect(out.match(/aria-required="true"/g)?.length).toBe(7);
  });

  it("an empty live region is on the page from the first paint, so a template choice is announced; the visible notices are not live regions of their own", () => {
    const out = html({ presetsAvailable: true });
    expect(out).toMatch(/<div id="qualify-template-live" role="status" aria-live="polite" aria-atomic="true" class="sr-only"><\/div>/);
    const chosen = html({ presetsAvailable: true, initialTemplateId: HALL_PRESETS[0].id });
    expect(chosen).not.toMatch(/role="status"[^>]*data-testid="qualify-template-disclosure"/);
    expect(chosen.match(/role="status"/g)?.length).toBe(1);               // the one region, nothing inserted alongside its message
    expect(renderToStaticMarkup(React.createElement(TemplateNotice, { template: { name: "T", assumed: 7, total: 7, untouched: true, fields: ALL_FIELDS }, recorded: resultFor(ALL_FIELDS).inputs_declared_assumed! }))).not.toContain("role=");
    expect(html({})).not.toContain("qualify-template-live");
  });

  it("a template loads its values, shows PRESET_DISCLOSURE, and tags every figure as the template's", () => {
    const p = HALL_PRESETS[1];
    const out = html({ presetsAvailable: true, initialTemplateId: p.id });
    expect(text(out)).toContain(PRESET_DISCLOSURE);
    expect(out).toContain('data-testid="qualify-template-disclosure"');
    expect(text(out)).toContain("7 of 7 figures are still the template's");
    expect(out.match(/Template value · assumed \(E0\)/g)?.length).toBe(7);
    expect(out).not.toContain("Your value");
    for (const k of QUALIFY_PRESET_KEYS) expect(out, k).toMatch(new RegExp(`id="qualify-${k}"[^>]*value="${p.values[k].replace(".", "\\.")}"`));
    // each tag is tied to its field, so a screen reader reads it with the value
    expect(out).toMatch(/aria-describedby="qualify-contractedMW-hint qualify-contractedMW-tag"/);
    expect(out).toContain('id="qualify-contractedMW-tag"');
  });

  it("the disclosure, tags and selector are wired to the edit: the tag flips on the field's own text, and the disclosure never depends on it", () => {
    const src = read("components/CapacityQualifier.tsx");
    expect(src).toContain("const still = value.trim() === preset.values[fieldKey");
    expect(src).toContain('{still ? `Template value · assumed (${PRESET_VALUE_CLASS})` : "Your value"}');
    // the disclosure renders for any chosen template, edited or not
    expect(src).toMatch(/\{preset \? \(\s*<div data-testid="qualify-template-disclosure"/);
    // only figures still holding the template's value are sent as assumed
    expect(src).toContain("const assumedFields = preset ? stillTemplateQualifyValues(preset, raw) : [];");
    expect(src).toContain("...(assumedFields.length ? { assumedFields } : {})");
    // choosing a template (or none) goes through switchQualifyTemplate: what the visitor typed is kept, the rest is the template's or empty
    expect(src).toContain("switchQualifyTemplate(raw, preset, p)");
    // and a result is shown only when the engine's own record confirms the declared figures
    expect(src).toContain("if (used && !assumedRecordMatches(body.result, used.fields))");
  });
});

// ------------------------------------------------------------------------------------------------ the result
const RESULT: QualifyResult = {
  platform: { id: "gb300_nvl72", name: "NVIDIA GB300 NVL72", rack_kW: { value: 135, low: 120, high: 150, unit: "kW", evidence: "E3", label: "rack" }, gpus_per_rack: 72 },
  as_found: { racks: 0, it_load_kW: { value: 0, low: 0, high: 0, unit: "kW", evidence: "E0_ASSUMPTION", label: "IT" }, binding_constraint: "Rack feed / tap-off rating", domain: "electrical", basis: "installed tap-offs rated 63 A (E0)" },
  after_relief: { racks: 28, architecture: "Full DLC", then_binds_on: null, sets_the_date: "Chilled-water plant capacity" },
  first_three_constraints: [],
  intake: { completeness: 0.29, required_inputs_missing: 3, can_issue_a_study: false, warnings: [],
    gaps: [{ input: "Site power factor", unit: "-", required: false, assumed: "0.97 [0.95–0.99] (E0)", why_it_binds: "Converts MVA into MW.", how_to_get_it: "Utility bills." }], recommended_engagement: "Sell the Density Screen." },
  notice: "n",
};
const ALL_FIELDS = Object.keys(QUALIFY_ENGINE_PATH) as QualifyAssumable[];
/** A result whose engine record lists exactly the declared figures, as a real engine's does. */
const resultFor = (fields: QualifyAssumable[]): QualifyResult => ({
  ...RESULT,
  ...(fields.length ? { inputs_declared_assumed: fields.map((k) => ({ path: QUALIFY_ENGINE_PATH[k], input: `Input ${k}`, unit: "A", value: 63, evidence: "E0", note: "n" })) } : {}),
});
const readout = (template: React.ComponentProps<typeof QualifyReadout>["template"], share: string | null, result: QualifyResult = resultFor(template ? template.fields : [])) =>
  renderToStaticMarkup(
    React.createElement(QualifyReadout, { result, headline: "About 0 racks today.", share, qualificationId: share ? "id" : null, qualificationToken: share ? "tok" : null, template })
  );

describe("the result", () => {
  const untouched = { name: HALL_PRESETS[0].name, assumed: 7, total: 7, untouched: true, fields: ALL_FIELDS };
  const partly = { name: HALL_PRESETS[0].name, assumed: 3, total: 7, untouched: false, fields: ["contractedMW", "currentPeakMW", "tapoffMaxA"] as QualifyAssumable[] };

  it("an untouched template result carries the template notice and offers nothing to keep or commission", () => {
    const out = readout(untouched, null);
    expect(text(out)).toContain(PRESET_DISCLOSURE);
    expect(text(out)).toContain("not for any hall: all 7 figures are the template's and are classed assumed (E0)");
    expect(text(out)).toContain("It is not saved and has no share link.");
    expect(text(out)).toContain("· Input tapoffMaxA: 63 A · E0 assumed");
    expect(out).not.toMatch(/Commission the/);
    expect(out).not.toContain("Send this to whoever owns the capex");
    // the completeness score would count the template's figures as supplied, so it is not displayed
    expect(text(out)).toContain("Assumed, because nobody supplied it");
    expect(text(out)).not.toMatch(/intake \d+% complete/);
    expect(text(out)).toContain("the engine's completeness score would count them as supplied, so it is not shown for a template");
  });

  it("asserts E0 only when the engine's record lists exactly the declared figures: otherwise it claims nothing", () => {
    const t = { name: "T", assumed: 3, total: 7, untouched: false, fields: ["contractedMW", "currentPeakMW", "tapoffMaxA"] as QualifyAssumable[] };
    for (const recorded of [[], resultFor(["contractedMW"]).inputs_declared_assumed!, resultFor(ALL_FIELDS).inputs_declared_assumed!, resultFor(["contractedMW", "currentPeakMW", "tapoffMaxA"]).inputs_declared_assumed!.map((r) => ({ ...r, evidence: "E5" }))]) {
      const out = text(renderToStaticMarkup(React.createElement(TemplateNotice, { template: t, recorded })));
      expect(out).toContain(PRESET_DISCLOSURE);
      expect(out).toContain("the engine did not confirm which figures it recorded as assumed");
      expect(out).not.toMatch(/classed assumed|E0 assumed/);
    }
    const ok = text(renderToStaticMarkup(React.createElement(TemplateNotice, { template: t, recorded: resultFor(t.fields).inputs_declared_assumed! })));
    expect(ok).toContain("classed assumed (E0)");
  });

  it("an edited template result says how many figures are still the template's, and the disclosure persists", () => {
    const out = text(readout(partly, null));
    expect(out).toContain(PRESET_DISCLOSURE);
    expect(out).toContain("3 of 7 figures in this read are still the template's");
    expect(out).toContain("the others are yours");
  });

  it("a plain result has no template notice, keeps its completeness line, and offers the commission button", () => {
    const out = text(readout(null, "/q/tok"));
    expect(out).not.toMatch(/Reference template|Template value/);
    expect(out).toMatch(/intake 29% complete/);
    expect(out).toContain("Commission the Density Screen");
  });
});

describe("what to do next: compare, then a free key, then the paid Density Screen", () => {
  const order = (html: string) => ["compare", "free-key", "density-screen"].map((id) => html.indexOf(`data-next-step="${id}"`));

  it("are three steps in that order, for a plain read and for a template read", () => {
    for (const out of [readout(null, "/q/tok"), readout({ name: "T", assumed: 7, total: 7, untouched: true, fields: ALL_FIELDS }, null)]) {
      const [a, b, c] = order(out);
      expect(a).toBeGreaterThan(-1);
      expect(b).toBeGreaterThan(a);
      expect(c).toBeGreaterThan(b);
      expect(text(out)).toMatch(/1\. Compare the relief scenarios · free.*2\. Get a free API key · no card.*3\. The Density Screen · paid/);
      expect(out).toContain(`href="${NEXT_STEP_HREFS.compare}"`);
      expect(out).toContain("Get the free allowance");                           // the existing free-allowance form
    }
  });

  it("the paid step is the existing commission flow for a real read, and the product page for a template read", () => {
    const real = readout(null, "/q/tok");
    expect(real.slice(real.indexOf('data-next-step="density-screen"'))).toContain("Commission the Density Screen");
    const tpl = readout({ name: "T", assumed: 7, total: 7, untouched: true, fields: ALL_FIELDS }, null);
    const tail = tpl.slice(tpl.indexOf('data-next-step="density-screen"'));
    expect(tail).toContain(`href="${NEXT_STEP_HREFS.densityScreen}"`);
    expect(tail).not.toContain("Commission the");
  });

  it("each step resolves to a real route or workflow in this repository", () => {
    expect(NEXT_STEPS.map((s) => [s.id, s.cost])).toEqual([["compare", "free"], ["free-key", "free"], ["density-screen", "paid"]]);
    for (const s of NEXT_STEPS) {
      expect(fs.existsSync(path.join(ROOT, s.page)), `${s.id}: ${s.page}`).toBe(true);
      if (s.workflowRoute) expect(fs.existsSync(path.join(ROOT, s.workflowRoute)), `${s.id}: ${s.workflowRoute}`).toBe(true);
    }
    // fragments land on a real element
    expect(read("app/developers/page.tsx")).toContain('id="rates"');
    expect(read("app/pricing/page.tsx")).toContain('id="engagements"');
    // the product page slug exists in the catalogue the dynamic route serves
    expect(read("lib/product-pages.ts")).toContain('slug: "density-screen"');
    expect(read("lib/payg-client.ts")).toContain("/api/free-account");
    expect(read("components/CapacityQualifier.tsx")).toContain('fetch("/api/checkout"');
  });
});

describe("the page", () => {
  afterEach(() => resetEngineCapabilityCache());
  it("shows the selector only while the live engine advertises the flag", async () => {
    const { default: Qualify } = await import("@/app/qualify/page");
    let stop = stubEngine(FULL_ENGINE, { [QUALIFY_ASSUMED_FIELDS_FLAG]: true });
    expect(renderToStaticMarkup(await Qualify())).toContain('id="qualify-template"');
    stop();
    for (const [routes, caps] of [[FULL_ENGINE, undefined], ["down", undefined]] as const) {
      stop = stubEngine(routes as string[] | "down", caps);
      const out = renderToStaticMarkup(await Qualify());
      expect(out).not.toContain("qualify-template");
      expect(out).toContain("qualify-contractedMW");                              // the form itself is untouched
      stop();
    }
  });
  it("re-reads the engine without a site redeploy", () => {
    expect(read("app/qualify/page.tsx")).toMatch(/export const revalidate = 300;/);
  });
});

// ------------------------------------------------------------------------------------------------ the real engine
const KEY = "qualify-presets-key";
let engine: ChildProcess | null = null;
let ENGINE_URL = "";
const realFetch = globalThis.fetch;

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

describe.runIf(hasPython)("through the real engine", () => {
  beforeAll(async () => { ENGINE_URL = await startEngine(); }, 30_000);
  afterAll(() => engine?.kill());
  beforeEach(() => {
    process.env.SUPABASE_URL = "https://stub.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_test";
    process.env.GRIDFORGE_API_URL = ENGINE_URL;
    resetMemoryLimiter();
    resetEngineCapabilityCache();
    funnel.events.length = 0;
    db = new PostgrestFake(["qualifications"]);
    restoreDb = db.install();
    const dbFetch = globalThis.fetch;
    globalThis.fetch = (async (i: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof i === "string" ? i : i instanceof URL ? i.href : i.url;
      return url.startsWith(ENGINE_URL) ? realFetch(i as RequestInfo, init) : dbFetch(i, init);
    }) as typeof fetch;
  });
  afterEach(() => { restoreDb(); globalThis.fetch = realFetch; resetEngineCapabilityCache(); });

  it("the engine in this repository advertises the capability in /v1/version, and the site reads it", async () => {
    const v = await (await realFetch(`${ENGINE_URL}/v1/version`)).json();
    expect(v.capabilities).toEqual({ [QUALIFY_ASSUMED_FIELDS_FLAG]: true });
    expect(await engineHas(QUALIFY_ASSUMED_FIELDS_FLAG)).toBe(true);
    const { default: Qualify } = await import("@/app/qualify/page");
    expect(renderToStaticMarkup(await Qualify())).toContain('id="qualify-template"');
  });

  it("a template's figure comes back classed E0 in the result's own basis and evidence, never E5; the other figures stay the visitor's", async () => {
    const { POST } = await import("@/app/api/qualify/route");
    const body = await (await POST(post({ ...SEVEN, assumedFields: ["tapoffMaxA"] }))).json();
    expect(body.ok, JSON.stringify(body)).toBe(true);
    const r = body.result as QualifyResult;
    expect(r.as_found.basis).toContain("installed tap-offs rated 63 A (E0)");
    expect(r.as_found.basis).not.toContain("63 A (E5)");
    expect(r.as_found.it_load_kW.evidence).toBe("E0_ASSUMPTION");
    expect(r.inputs_declared_assumed).toEqual([expect.objectContaining({ path: "lv.tapoff_max_A", evidence: "E0", value: 63 })]);
    expect(body).toMatchObject({ templateDerived: true, share: null, saved: false });
    expect(db.rows("qualifications")).toHaveLength(0);
    // beside it, a figure that is the visitor's own is still customer data
    const own = await (await POST(post({ ...SEVEN, assumedFields: ["contractedMW"] }))).json();
    expect(own.result.as_found.basis).toContain("installed tap-offs rated 63 A (E5)");
  });

  it("a plain request gives the same answer as before: no inputs_declared_assumed, E5 on the visitor's figure, stored", async () => {
    const { POST } = await import("@/app/api/qualify/route");
    const body = await (await POST(post(SEVEN))).json();
    expect(body.result).not.toHaveProperty("inputs_declared_assumed");
    expect(body.result.as_found.basis).toContain("installed tap-offs rated 63 A (E5)");
    expect(body).toMatchObject({ templateDerived: false, saved: true });
    expect(db.rows("qualifications")).toHaveLength(1);
  });

  it("every template, untouched, is answered by the engine with all seven figures recorded E0", async () => {
    const { POST } = await import("@/app/api/qualify/route");
    for (const p of HALL_PRESETS) {
      const t = qualifyTemplateState(p);
      const nums = Object.fromEntries(QUALIFY_PRESET_KEYS.map((k) => [k, Number(t.raw[k])]));
      const res = await POST(post({ ...nums, platform: t.platform, assumedFields: [...QUALIFY_PRESET_KEYS] }));
      const body = await res.json();
      if (body.ok) {
        expect(body.result.inputs_declared_assumed.map((r: { evidence: string }) => r.evidence), p.id).toEqual(Array(7).fill("E0"));
      } else {
        // a template the engine refuses must be refused with a reason, not answered as a hall
        expect(res.status, p.id).toBeGreaterThanOrEqual(400);
        expect(typeof body.error, p.id).toBe("string");
      }
    }
  });
});

describe("the real-engine suite cannot be skipped silently where it is required", () => {
  it("python3 is present whenever GRIDFORGE_REQUIRE_ENGINE=1 or CI=true", () => {
    const g = engineAvailable(hasPython);
    expect(g.ok, g.reason).toBe(true);
  });
});
