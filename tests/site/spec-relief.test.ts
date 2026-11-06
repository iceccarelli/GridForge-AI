/**
 * The buyer's choice of relief for a Procurement Specification.
 *
 * The engine's /v1/spec takes an optional `constraint`. The site never sent one, so the engine's default applied and the
 * buyer could not say which relief they wanted tendered. Absent must still be byte-identical to that old request.
 */
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SPEC_RELIEF_CONSTRAINTS, SPEC_RELIEF_IDS, parseSpecRelief } from "@/lib/project-spec-relief";
import { siteUrl } from "@/lib/site";
import { PostgrestFake } from "./postgrest-fake";

const ENGINE = "http://engine.test";

describe("the relief vocabulary is the engine's own", () => {
  const ref = JSON.parse(readFileSync("public/reference/constraints.json", "utf8")) as { constraints: { id: string; name: string }[] };

  it("matches the generated constraint reference exactly (ids, names, order)", () => {
    expect(SPEC_RELIEF_CONSTRAINTS.map((c) => [c.id, c.name])).toEqual(ref.constraints.map((c) => [c.id, c.name]));
  });

  it("matches the engine's authored registry in gridforge/reference/catalogue.py", () => {
    const py = readFileSync("gridforge/reference/catalogue.py", "utf8");
    const ids = [...py.matchAll(/ConstraintDoc\(\s*id="([a-z_]+)"/g)].map((m) => m[1]);
    expect(ids.length).toBeGreaterThan(0);
    expect([...SPEC_RELIEF_IDS]).toEqual(ids);
  });

  it("covers every constraint the engine writes a specification generator for", () => {
    const py = readFileSync("gridforge/procurement/build.py", "utf8");
    const block = py.slice(py.indexOf("GENERATORS = {"), py.indexOf("}", py.indexOf("GENERATORS = {")));
    const generators = [...block.matchAll(/"([a-z_]+)":/g)].map((m) => m[1]);
    expect(generators.length).toBeGreaterThan(0);
    for (const g of generators) expect(SPEC_RELIEF_IDS).toContain(g);
  });
});

describe("parseSpecRelief", () => {
  it("treats absence as 'let the engine choose'", () => {
    for (const v of [undefined, null, "", "   "]) expect(parseSpecRelief(v)).toEqual({ ok: true, constraint: null });
  });
  it("accepts each engine id exactly", () => {
    for (const id of SPEC_RELIEF_IDS) expect(parseSpecRelief(id)).toEqual({ ok: true, constraint: id });
  });
  it("refuses an unknown id and names the valid ones", () => {
    const r = parseSpecRelief("flux_capacitor");
    expect(r.ok).toBe(false);
    if (!r.ok) for (const id of SPEC_RELIEF_IDS) expect(r.error).toContain(id);
  });
  it("refuses non-strings, case variants and look-alikes", () => {
    for (const v of [1, true, {}, [], ["ups_capacity"], "UPS_CAPACITY", "ups_capacity;", "ups-capacity"]) {
      expect(parseSpecRelief(v).ok, JSON.stringify(v)).toBe(false);
    }
  });
});

// --------------------------------------------------------------------------------------------- the route

let db: PostgrestFake;
let restorePg: () => void;
let restoreEngine: () => void;
let calls: { url: string; body: Record<string, unknown>; raw: string }[] = [];
let listAnswer: "ok" | "down" = "ok";
/** Reliefs this synthetic hall can buy. */
const HALL_RELIEFS = ["rack_feed_tapoff", "transformer_capacity"];

const INTAKE = {
  siteName: "North Hall", hallId: "H1", metro: "Dublin", firmCapacityMVA: 15, contractedMW: 12, currentPeakMW: 7.4,
  currentItLoadMW: 4.9, buswayAmpacityA: 400, tapoffMaxA: 63, floorLoadingKPa: 12, positionsAvailable: 180,
  plantCapacityKW: 6000, plantSupplyC: 6, platform: "gb300_nvl72",
};

function installEngine() {
  const pgFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(ENGINE)) return pgFetch(input as RequestInfo, init);
    const raw = String(init?.body ?? "{}");
    const body = init?.body ? JSON.parse(raw) : {};
    calls.push({ url, body, raw });
    const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
    if (url.endsWith("/v1/version")) return json({ version: "test" });
    if (url.endsWith("/v1/spec")) {
      if (body.list) {
        if (listAnswer === "down") return json({ error: "down" }, 503);
        return json({ reliefs: HALL_RELIEFS.map((id) => ({ constraint_id: id, constraint: `Name of ${id}` })) });
      }
      const chosen = typeof body.constraint === "string" ? body.constraint : "rack_feed_tapoff"; // the engine's default
      return json({
        title: "Procurement Specification — North Hall",
        document: "<p>spec</p>",
        document_md: "spec",
        specification: { constraint_id: chosen, constraint: `Name of ${chosen}`, relief: `Relieve ${chosen}`, sized_for_racks: 40 },
        response_template: { supplier: "" },
      });
    }
    return json({});
  }) as typeof fetch;
  return () => {
    globalThis.fetch = pgFetch;
  };
}

function seed(kind = "procurement_spec") {
  db.seed("deliverables", [{ token: "engagement-token", kind, status: "awaiting_intake", company: "North Hall", stripe_session_id: "cs_1" }]);
}

const post = (body: unknown) =>
  new Request(siteUrl("/api/intake/engagement-token"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function submit(body: unknown) {
  const { POST } = await import("@/app/api/intake/[token]/route");
  return POST(post(body), { params: Promise.resolve({ token: "engagement-token" }) });
}

const specCalls = () => calls.filter((c) => c.url.endsWith("/v1/spec") && !c.body.list);

beforeEach(() => {
  process.env.SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_test";
  process.env.GRIDFORGE_API_URL = ENGINE;
  process.env.GRIDFORGE_API_KEY = "engine-key";
  calls = [];
  listAnswer = "ok";
  db = new PostgrestFake(["deliverables"]);
  restorePg = db.install();
  restoreEngine = installEngine();
});
afterEach(() => {
  restoreEngine();
  restorePg();
});

describe("POST /api/intake/[token] with a chosen relief", () => {
  it("passes the chosen constraint to every engine specification request and stores it with the inputs", async () => {
    seed();
    const res = await submit({ ...INTAKE, constraint: "transformer_capacity" });
    expect(res.status).toBe(200);
    expect(specCalls().length).toBeGreaterThanOrEqual(3); // html, md and the working-file bundle
    for (const c of specCalls()) expect(c.body.constraint, c.raw).toBe("transformer_capacity");
    const row = db.rows("deliverables")[0] as Record<string, any>;
    expect(row.status).toBe("draft");
    expect(row.intake._gridforge.spec_request).toEqual({ constraint_id: "transformer_capacity" });
    expect(row.intake._gridforge.spec.constraint_id).toBe("transformer_capacity");
  });

  it("never sends the relief, or our block, inside the customer's intake", async () => {
    seed();
    await submit({ ...INTAKE, constraint: "transformer_capacity" });
    for (const c of specCalls()) {
      expect(c.body.intake).not.toHaveProperty("constraint");
      expect(c.body.intake).not.toHaveProperty("_gridforge");
    }
    const row = db.rows("deliverables")[0] as Record<string, any>;
    expect(row.intake).not.toHaveProperty("constraint");
  });

  it("absent: the engine requests are byte-identical to the requests made without the feature, and nothing is recorded", async () => {
    seed();
    expect((await submit(INTAKE)).status).toBe(200);
    for (const c of specCalls()) {
      expect(Object.keys(c.body).sort()).toEqual(c.body.format === undefined ? ["intake"] : ["format", "intake"]);
      expect(c.raw).not.toContain("constraint");
    }
    // The `list` pre-check is only made for a chosen relief.
    expect(calls.some((c) => c.body.list)).toBe(false);
    const row = db.rows("deliverables")[0] as Record<string, any>;
    expect(row.intake._gridforge).not.toHaveProperty("spec_request");
  });

  it("an empty choice is the same as none", async () => {
    seed();
    expect((await submit({ ...INTAKE, constraint: "" })).status).toBe(200);
    for (const c of specCalls()) expect(c.raw).not.toContain("constraint");
  });

  it("refuses an unknown id with 422, naming the valid ones, and spends nothing", async () => {
    seed();
    const res = await submit({ ...INTAKE, constraint: "flux_capacitor" });
    expect(res.status).toBe(422);
    const body = await res.json();
    for (const id of SPEC_RELIEF_IDS) expect(body.error).toContain(id);
    expect(calls).toHaveLength(0);
    expect((db.rows("deliverables")[0] as Record<string, any>).status).toBe("awaiting_intake");
  });

  it("refuses a relief the hall cannot buy, naming the ones it can, before the submission is spent", async () => {
    seed();
    const res = await submit({ ...INTAKE, constraint: "floor_loading" });
    expect(res.status).toBe(422);
    const body = await res.json();
    for (const id of HALL_RELIEFS) expect(body.error).toContain(id);
    expect(specCalls()).toHaveLength(0);
    expect((db.rows("deliverables")[0] as Record<string, any>).status).toBe("awaiting_intake");
  });

  it("if the engine cannot list reliefs, the choice goes through and the engine decides", async () => {
    seed();
    listAnswer = "down";
    expect((await submit({ ...INTAKE, constraint: "ups_capacity" })).status).toBe(200);
    for (const c of specCalls()) expect(c.body.constraint).toBe("ups_capacity");
  });

  it("is refused for any other product", async () => {
    seed("density_screen");
    const res = await submit({ ...INTAKE, constraint: "ups_capacity" });
    expect(res.status).toBe(422);
    expect(calls).toHaveLength(0);
  });

  it("an operator regenerate keeps the buyer's choice (it is read from the stored block)", async () => {
    seed();
    await submit({ ...INTAKE, constraint: "transformer_capacity" });
    const { generateAndStore, getByToken, claimForGeneration, claimStamp } = await import("@/lib/deliverables");
    const row = (await getByToken("engagement-token"))!;
    await (await import("@/lib/deliverables")).updateByToken("engagement-token", { status: "engine_unavailable" });
    const now = new Date();
    const { _gridforge, ...doc } = row.intake as Record<string, unknown>;
    expect(await claimForGeneration("engagement-token", { ...doc, _gridforge }, ["engine_unavailable"], now)).toBe("claimed");
    calls = [];
    const stored = await generateAndStore({ ...row, claim: claimStamp(now) }, doc, "spec");
    expect(stored.ok).toBe(true);
    for (const c of specCalls()) expect(c.body.constraint).toBe("transformer_capacity");
    expect((db.rows("deliverables")[0] as Record<string, any>).intake._gridforge.spec_request).toEqual({ constraint_id: "transformer_capacity" });
  });
});

describe("what the buyer sees", () => {
  async function releasedPage(meta: Record<string, unknown>) {
    db.seed("deliverables", [
      {
        token: "released-token", kind: "procurement_spec", status: "released", company: "North Hall", stripe_session_id: "cs_2",
        released_at: "2026-11-01T10:00:00Z", title: "Procurement Specification", document_html: "<p>spec</p>", document_md: "spec",
        working_files: { "specification.json": "{}", "response_template.json": "{}" },
        intake: { _gridforge: meta },
      },
    ]);
    const { default: Page } = await import("@/app/deliverable/[token]/page");
    return renderToStaticMarkup(await Page({ params: Promise.resolve({ token: "released-token" }) }));
  }
  const spec = { constraint_id: "transformer_capacity", constraint: "Transformer capacity", relief: "Replace the transformer", sized_for_racks: 40 };

  it("says the relief is the one the buyer chose", async () => {
    const html = await releasedPage({ spec, spec_request: { constraint_id: "transformer_capacity" } });
    expect(html).toContain("Relief: Transformer capacity (transformer_capacity), the one you chose at intake.");
  });

  it("says the engine selected it when no relief was chosen", async () => {
    const html = await releasedPage({ spec });
    expect(html).toContain("selected by the engine; no relief was chosen at intake");
    expect(html).not.toContain("the one you chose");
  });

  it("is honest if the engine recorded a different relief than the one asked for", async () => {
    const html = await releasedPage({ spec, spec_request: { constraint_id: "ups_capacity" } });
    expect(html).toContain("You chose ups_capacity at intake; the engine recorded this one.");
  });

  it("the intake form offers 'Let the engine choose' first and the engine's reliefs, for a Procurement Specification only", () => {
    const src = readFileSync("components/EngagementIntake.tsx", "utf8");
    expect(src).toContain('meta?.kind === "procurement_spec" && !endpoint');
    expect(src).toContain("Let the engine choose");
    expect(src).toContain("SPEC_RELIEF_CONSTRAINTS.map");
  });
});
