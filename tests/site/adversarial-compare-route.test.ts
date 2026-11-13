/**
 * Adversarial acceptance tests for the Time-to-Power comparison route (POST /api/power/compare): the REAL Next route handler, the REAL
 * Python engine (spawned, not stubbed), hostile bodies and numbers. Independent QA pass: no product code, assumption or existing test is
 * touched.
 *
 * A passing `it` pins correct behaviour. An `it.fails` pins a CONFIRMED DEFECT on this commit: the body below asserts what a correct system
 * does, it throws today, so the suite stays green, and the day the product is fixed `it.fails` turns red so the marker is removed on
 * purpose. Each docstring says what correct means: REFUSE (a structured 4xx, never a 5xx), DEGRADE WITH DISCLOSURE, or QUALIFY.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { siteUrl } from "@/lib/site";
import { resetMemoryLimiter } from "@/lib/rate-limit";
import { engineAvailable } from "./_engine-guard";

const hasPython = spawnSync("python3", ["--version"]).status === 0;
const KEY = "adversarial-compare-key";
let engine: ChildProcess | null = null;
let ENGINE = "";

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
beforeEach(() => {
  resetMemoryLimiter();
  process.env.GRIDFORGE_API_URL = ENGINE;
  process.env.GRIDFORGE_API_KEY = KEY;
});

const HALL = {
  siteName: "Synthetic Hall", hallId: "H1", metro: "Dublin", firmCapacityMVA: 15, contractedMW: 12, currentPeakMW: 7.4,
  currentItLoadMW: 4.9, buswayAmpacityA: 400, tapoffMaxA: 63, floorLoadingKPa: 12, positionsAvailable: 180,
  plantCapacityKW: 6000, plantSupplyC: 6, platform: "gb300_nvl72",
};
const BESS = { id: "b1", kind: "bess", capacity_MW: 2, lead_time_weeks: 30, energy_MWh: 8 };

type Raw = string | Uint8Array;
async function send(body: unknown, opts: { raw?: Raw; headers?: Record<string, string> } = {}) {
  resetMemoryLimiter();                 // one visitor, many probes: the limiter is not what is under test here
  const { POST } = await import("@/app/api/power/compare/route");
  const res = await POST(
    new Request(siteUrl("/api/power/compare"), {
      method: "POST",
      headers: { "content-type": "application/json", ...(opts.headers ?? {}) },
      body: (opts.raw ?? JSON.stringify(body)) as BodyInit,
    }),
  );
  const json = (await res.json().catch(() => ({}))) as Record<string, any>;
  return { status: res.status, json };
}
const racks = (json: Record<string, any>, id: string) => json.result.scenarios.find((s: any) => s.id === id).after_ladder.racks as number;
const refused = (r: { status: number }) => r.status >= 400 && r.status < 500;

describe.runIf(hasPython)("the comparison route refuses hostile bodies cleanly", () => {
  it("answers the control request (so every refusal below means something)", async () => {
    const r = await send({ hall: HALL });
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(racks(r.json, "full_dlc")).toBe(28);
  });

  it("REFUSE: a body over the 64 KiB limit is a 413 before the engine is asked", async () => {
    const r = await send({ hall: { ...HALL, siteName: "x".repeat(70_000) } });
    expect(r.status).toBe(413);
  });

  it("REFUSE: a declared Content-Length over the limit is a 413 without reading the stream", async () => {
    const r = await send(null, { raw: "{}", headers: { "content-length": String(10 ** 9) } });
    expect(r.status).toBe(413);
  });

  it.each([["not json", "{nope"], ["trailing comma", '{"hall":{},}'], ["empty", ""], ["lone brace", "{"], ["single quotes", "{'hall': 1}"], ["NaN literal", '{"hall": {"contractedMW": NaN}}']])(
    "REFUSE: malformed JSON (%s) is a 400 with a message and no engine call",
    async (_n, raw) => {
      const r = await send(null, { raw });
      expect(r.status).toBe(400);
      expect(r.json.ok).toBe(false);
    },
  );

  it.each([["array", "[]"], ["null", "null"], ["number", "7"], ["string", '"x"'], ["boolean", "true"]])(
    "REFUSE: a top-level %s is a 422 naming the problem",
    async (_n, raw) => {
      const r = await send(null, { raw });
      expect(r.status).toBe(422);
      expect(r.json.error).toBe("Validation failed");
    },
  );

  it.each([["object", (n: number) => '{"a":'.repeat(n) + "1" + "}".repeat(n)], ["array", (n: number) => "[".repeat(n) + "]".repeat(n)]])(
    "REFUSE: 10,000 levels of nesting (%s) is a 4xx, not a stack overflow or a 500",
    async (_n, make) => {
      const r = await send(null, { raw: make(10_000) });
      expect(refused(r)).toBe(true);
    },
  );

  it("REFUSE: a deeply nested value where the hall belongs is a 422", async () => {
    const r = await send(null, { raw: `{"hall": ${"[".repeat(5000)}${"]".repeat(5000)}}` });
    expect(r.status).toBe(422);
  });

  it("REFUSE: prototype-pollution keys never reach the engine body or change the answer", async () => {
    const polluted = await send(null, { raw: `{"hall": ${JSON.stringify(HALL)}, "__proto__": {"admin": true}, "constructor": {"prototype": {"x": 1}}}` });
    const clean = await send({ hall: HALL });
    expect(polluted.status).toBe(200);
    expect(polluted.json.result.request_digest).toBe(clean.json.result.request_digest);
    expect(({} as any).admin).toBeUndefined();
    expect(JSON.stringify(polluted.json.request)).not.toContain("__proto__");
  });

  it("QUALIFY: a byte-order mark never changes the meaning of the request (refused, or the identical answer)", async () => {
    const plain = await send({ hall: HALL });
    const bom = await send(null, { raw: "﻿" + JSON.stringify({ hall: HALL }) });
    expect(bom.status === 400 || (bom.status === 200 && bom.json.result.request_digest === plain.json.result.request_digest)).toBe(true);
  });

  it("REFUSE: unknown objective, scenario and baseline values are 422s", async () => {
    for (const extra of [{ objective: "cheapest" }, { scenarios: ["retained_air", "magic"] }, { scenarios: ["retained_air"] }, { baseline: "magic" }, { scenarios: ["rdhx", "full_dlc"], baseline: "retained_air" }]) {
      const r = await send({ hall: HALL, ...extra });
      expect(r.status).toBe(422);
    }
  });
});

describe.runIf(hasPython)("hostile numbers in the hall form", () => {
  const FIELDS = ["contractedMW", "currentPeakMW", "currentItLoadMW", "buswayAmpacityA", "tapoffMaxA", "positionsAvailable", "plantSupplyC"] as const;

  it.each(FIELDS.flatMap((f) => [[f, "1e308", 1e308], [f, "kW string", "12 kW"], [f, "unicode digits", "١٢"], [f, "object", { v: 1 }], [f, "negative", -5e9]] as const))(
    "REFUSE: %s = %s is a 422 that names the field",
    async (field, _label, value) => {
      const r = await send({ hall: { ...HALL, [field]: value } });
      expect(r.status).toBe(422);
      expect(JSON.stringify(r.json.problems)).toContain(field);
    },
  );

  it("QUALIFY: -0 is a zero, never a negative or NaN leaking into the answer", async () => {
    const r = await send({ hall: { ...HALL, currentItLoadMW: -0 } });
    expect(r.status).toBe(200);
    expect(r.json.result.scenarios.every((s: any) => s.after_ladder.racks >= 0)).toBe(true);
    expect(JSON.stringify(r.json)).not.toMatch(/NaN|Infinity/);
  });

  it("REFUSE: zero free positions is refused or answered as a zero-rack hall that says nothing is deployable", async () => {
    const r = await send({ hall: { ...HALL, positionsAvailable: 0 } });
    expect(r.status === 422 || (r.status === 200 && r.json.result.scenarios.every((s: any) => s.after_ladder.racks === 0))).toBe(true);
  });

  it("REFUSE: a firm capacity far beyond the plausibility ceiling is a 422", async () => {
    expect((await send({ hall: { ...HALL, firmCapacityMVA: 5e6 } })).status).toBe(422);
  });

  it("REFUSE a required figure that is blank, null, an empty list or a boolean - the schema's z.coerce.number() reads '' / null / [] as 0 and true as 1, so a blank contracted capacity is answered as a confident 0-rack hall - lib/engagement-intake.ts:40 (num = z.coerce.number()), lib/ttp-compare.ts:35", async () => {
    // Reproducer: POST /api/power/compare {"hall": {...contractedMW: ""}} -> 200, every scenario 0 racks.
    for (const bad of ["", null, [], true, false]) {
      const r = await send({ hall: { ...HALL, contractedMW: bad } });
      expect(r.status).toBe(422);
    }
  });

  it("FIXED: a boolean (or a blank) for a count is refused - positionsAvailable: true was coerced to 1 position and a 1-rack answer returned (lib/qualify-number.ts)", async () => {
    for (const bad of [true, false, null, "", "   ", []]) {
      const r = await send({ hall: { ...HALL, positionsAvailable: bad } });
      expect(r.status, JSON.stringify(bad)).toBe(422);
    }
  });

  it.fails("confirmed defect: REFUSE a boolean battery power - btm_options[].capacity_MW: true is coerced to a 1 MW battery and ranked - lib/ttp-compare.ts:35", async () => {
    const r = await send({ hall: HALL, btm_options: [{ ...BESS, capacity_MW: true }] });
    expect(r.status).toBe(422);
  });
});

describe.runIf(hasPython)("contradictory inputs reach the site unchallenged", () => {
  it("FIXED (engine plausibility finding): a site peak below the IT load already on it is named in the caveats instead of silently inflating the answer", async () => {
    // REFUSE (422) or DEGRADE WITH DISCLOSURE (a caveat naming the peak and the IT load).
    const r = await send({ hall: { ...HALL, currentPeakMW: 0 } });
    if (r.status === 200) {
      expect((r.json.result.caveats as string[]).some((c) => /peak/i.test(c) && /it load/i.test(c))).toBe(true);
    } else {
      expect(r.status).toBe(422);
    }
  });

  it("DEGRADE WITH DISCLOSURE: an IT load beyond the firm supply ceiling is named in the caveats", async () => {
    const r = await send({ hall: { ...HALL, currentItLoadMW: 400 } });
    expect(r.status).toBe(200);
    expect((r.json.result.caveats as string[]).join(" ")).toMatch(/cannot cover the current IT load/);
  });

  it("DEGRADE WITH DISCLOSURE: a contracted capacity above the firm connection is named in the caveats", async () => {
    const r = await send({ hall: { ...HALL, contractedMW: 40 } });
    expect(r.status).toBe(200);
    expect((r.json.result.caveats as string[]).join(" ")).toMatch(/more than the firm connection/);
  });

  it("REFUSE: a battery without its energy rating is a 422 (a power rating alone does not say how long it carries the hall)", async () => {
    const { energy_MWh: _drop, ...noEnergy } = BESS;
    expect((await send({ hall: HALL, btm_options: [noEnergy] })).status).toBe(422);
    expect((await send({ hall: HALL, btm_options: [{ ...BESS, energy_MWh: 0 }] })).status).toBe(422);
  });

  it.fails("confirmed defect: a 2000 MW battery that stores 0.001 MWh (about 2 ms) is ranked as firm supply and the comparison carries no word about it - the engine's battery warning is dropped by /v1/compare: gridforge/api/server.py:388", async () => {
    // DEGRADE WITH DISCLOSURE: the caveats must name the battery's energy problem.
    const r = await send({ hall: HALL, btm_options: [{ ...BESS, capacity_MW: 2000, energy_MWh: 0.001 }] });
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.json.result)).toMatch(/sustains that for|firm_capacity_factor/);
  });

  it("QUALIFY: with a battery the comparison never claims more racks than positions exist", async () => {
    const r = await send({ hall: HALL, btm_options: [{ ...BESS, capacity_MW: 2000, energy_MWh: 8000 }] });
    expect(r.status).toBe(200);
    for (const s of r.json.result.scenarios) expect(s.after_ladder.racks).toBeLessThanOrEqual(HALL.positionsAvailable);
  });
});

describe.runIf(hasPython)("what the site does to the bytes it forwards", () => {
  it.fails("confirmed defect: REFUSE invalid UTF-8 - the body is decoded with a non-fatal TextDecoder, so a stray 0xFF byte in the site name silently becomes U+FFFD and the request is answered 200 as if it were what the client sent - lib/http-body.ts:36", async () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ hall: { ...HALL, siteName: "AAAA" } }));
    const at = Array.from(bytes).findIndex((_b, i) => bytes[i] === 0x41 && bytes[i + 1] === 0x41);
    const patched = Uint8Array.from(bytes);
    patched[at] = 0xff;
    const r = await send(null, { raw: patched });
    expect(r.status).toBe(400);
  });

  it.fails("confirmed defect: REFUSE duplicate JSON keys - the last 'hall' silently wins (JSON.parse), so a gateway that keeps the first sees another request than the engine solves - lib/http-body.ts:42", async () => {
    const r = await send(null, { raw: `{"hall": {"siteName": "first"}, "hall": ${JSON.stringify(HALL)}}` });
    expect(r.status).toBe(400);
  });

  it.fails("confirmed defect: REFUSE a wrong Content-Type - text/plain (a browser's no-preflight cross-site content type) is parsed as JSON and answered 200 - app/api/power/compare/route.ts:21", async () => {
    const r = await send({ hall: HALL }, { headers: { "content-type": "text/plain" } });
    expect([400, 415]).toContain(r.status);
  });

  it("QUALIFY: the request returned for reproduction is exactly what the engine accepts, with no site-only fields", async () => {
    const r = await send({ hall: HALL, btm_options: [BESS] });
    expect(r.status).toBe(200);
    expect(Object.keys(r.json.request).sort()).toEqual(["intake", "objective"]);
    expect(JSON.stringify(r.json.request)).not.toMatch(/cost_evidence|api_key|x-api-key/i);
  });
});

describe("the real-engine tests in this file cannot be skipped silently where they are required", () => {
  it("python3 is present whenever GRIDFORGE_REQUIRE_ENGINE=1 or CI=true", () => {
    const g = engineAvailable(hasPython);
    expect(g.ok, g.reason).toBe(true);
  });
});
