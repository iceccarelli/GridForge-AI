/**
 * The API versioning and deprecation commitment (lib/api-policy.ts): one constant, printed on /developers, in /openapi.json's description and in
 * /llms.txt, and a dated changelog on /developers seeded with the commitment and the additive keys of 2026-11-13.
 *
 * It is a commitment, so what is pinned is (1) that all three surfaces carry the same words, (2) that the words do not promise anything the code
 * does not do (no Deprecation or Sunset header, no automated notice, no second path version that does not exist), (3) that the schema_version value
 * the changelog names is the one the engine sends, and (4) that every key the changelog says was added is really in the engine or its published
 * reference. The document stays free of prices.
 */
import fs from "node:fs";
import path from "node:path";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import honesty from "@/lib/openapi-honesty.json";
import { API_CHANGELOG, API_DEPRECATION_NOTICE_DAYS, API_POLICY_DATE, API_VERSIONING_POLICY } from "@/lib/api-policy";
import { API_SCHEMA_VERSION, buildOpenApi, type ToolsFile } from "@/lib/openapi";
import { FULL_ENGINE, stubEngine } from "./engine-stub";

const tools = JSON.parse(readFileSync("public/reference/tools.json", "utf8")) as ToolsFile;
const doc = buildOpenApi(tools, "https://example.invalid", "https://example.invalid/site-origin") as any;
const escapeHtml = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
const flat = (h: string) => h.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, " ").replace(/&#x27;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

async function developersHtml(): Promise<string> {
  const stop = stubEngine(FULL_ENGINE);
  try {
    return renderToStaticMarkup(await (await import("@/app/developers/page")).default()).replace(/<!-- -->/g, "");
  } finally {
    stop();
  }
}

describe("the commitment says what was decided", () => {
  it("within /v1 only additive changes; a meaning, a unit, a status code's meaning or a removal ships under a new path version", () => {
    expect(API_VERSIONING_POLICY).toContain("Within /v1 we make only additive changes: new endpoints, new optional request fields and new response keys.");
    expect(API_VERSIONING_POLICY).toMatch(/A change to the meaning of a response key, to a unit, or to the meaning of a status code, and the removal of anything, is a breaking change: it ships under a new path version and never inside \/v1\./);
  });

  it("the previous version keeps running at least 90 days after written notice to every active key holder's account email and a notice on /developers", () => {
    expect(API_DEPRECATION_NOTICE_DAYS).toBe(90);
    expect(API_VERSIONING_POLICY).toContain("keeps running for at least 90 days after we have given written notice to the account email of every active API-key holder and posted a notice on /developers");
  });

  it("schema_version is incremented on any change to a response shape, and a deprecation is a dated entry in the changelog on /developers", () => {
    expect(API_VERSIONING_POLICY).toContain("The schema_version field in every response is incremented on any change to a response shape, additive or breaking.");
    expect(API_VERSIONING_POLICY).toContain("A deprecation is announced with a dated entry in the changelog on /developers.");
  });

  it("promises no header and no automated notice, and says so", () => {
    expect(API_VERSIONING_POLICY).toContain("it sends no Deprecation or Sunset header, and the notice is our email and our entry on /developers");
    expect(API_VERSIONING_POLICY).not.toMatch(/\bwill (?:send|notify|be notified)|automatic|webhook|subscribe|RFC ?8594|Retry-After|guarantee/i);
    // The only places that say "Sunset" or "Deprecation" are the denial above; the claim "sends no header" is true of the engine's source.
    const apiDir = "gridforge/api";
    for (const f of fs.readdirSync(apiDir).filter((n) => n.endsWith(".py"))) {
      expect(fs.readFileSync(path.join(apiDir, f), "utf8"), f).not.toMatch(/Deprecation|Sunset/);
    }
  });

  it("states no price, and the engine has one path version (nothing is deprecated, and the changelog says so)", () => {
    expect(API_VERSIONING_POLICY).not.toMatch(/[€$]\s?\d|\bEUR\b/i);
    expect(fs.readFileSync("gridforge/api/server.py", "utf8")).not.toMatch(/["']\/v2[/"']/);
    expect(API_CHANGELOG[0].text).toContain("/v1 is the only path version and nothing is deprecated");
    expect(API_CHANGELOG.filter((e) => e.kind === "deprecation")).toEqual([]);
  });
});

describe("the three surfaces carry the same words", () => {
  it("/openapi.json's description carries the policy, a pointer to the changelog and no price", () => {
    expect(doc.info.description).toContain(`Versioning and deprecation: ${API_VERSIONING_POLICY}`);
    expect(doc.info.description).toContain("/developers#versioning");
    const text = JSON.stringify(doc).replace(/"currency":\s?"EUR"/g, '"currency":"<code>"');
    expect(text).not.toMatch(/[€$]\s?\d|\bEUR\b/i);
  });

  it("/developers has a 'Versioning and deprecation' section with the policy verbatim and the changelog list", async () => {
    const html = await developersHtml();
    expect(html).toContain('id="versioning"');
    expect(html).toContain("Versioning and deprecation</h2>");
    expect(html).toContain(`data-testid="versioning-policy">${escapeHtml(API_VERSIONING_POLICY)}</p>`);
    const list = /data-testid="api-changelog">([\s\S]*?)<\/ol>/.exec(html)![1];
    expect((list.match(/<li\b/g) ?? []).length).toBe(API_CHANGELOG.length);
    for (const e of API_CHANGELOG) {
      expect(list).toContain(`<time dateTime="${e.date}"`);
      expect(flat(list)).toContain(e.text);
    }
  });

  it("/llms.txt carries the policy and the changelog's address", async () => {
    const stop = stubEngine(FULL_ENGINE);
    try {
      const body = (await (await (await import("@/app/llms.txt/route")).GET()).text()).replace(/\s+/g, " ");
      expect(body).toContain(`Versioning and deprecation: ${API_VERSIONING_POLICY} The dated changelog is at `);
      expect(body).toContain("/developers#versioning.");
    } finally {
      stop();
    }
  });
});

describe("the changelog is seeded with the commitment and the additive keys of 2026-11-13, and each is real", () => {
  const additive = API_CHANGELOG.filter((e) => e.kind === "additive");

  it("is dated, starts with the commitment, and names assumed_fields, specification_available and currency as additions, then what the API layer added", () => {
    expect(API_POLICY_DATE).toBe("2026-11-13");
    expect(API_CHANGELOG[0]).toMatchObject({ date: "2026-11-13", kind: "policy" });
    expect(additive.map((e) => e.text.split(":")[0])).toEqual([
      "assumed_fields",
      "specification_available",
      "currency",
      "figures_not_supplied",
      "sets_the_date_reason",
      "racks_evidence",
      "allowed",
      "max_halls_per_request",
      "target_reachable and gap_racks_after_ladder",
      "changed_inputs_known, drivers_note and evidence_changed_inputs",
      "figure_checks and score_basis",
      "directional and directional_reason",
      "jsonrpc",
      "allow",
      "warnings",
    ]);
    // one correction, after the additions of the day, and no entry of a kind the renderer does not label
    expect(API_CHANGELOG.filter((e) => e.kind === "correction")).toHaveLength(1);
    expect(API_CHANGELOG[API_CHANGELOG.length - 1].kind).toBe("correction");
    for (const e of API_CHANGELOG) expect(["policy", "additive", "correction", "deprecation"]).toContain(e.kind);
    for (const e of API_CHANGELOG) expect(e.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("schema_version stays what the engine sends, and the entry says so", () => {
    expect(API_SCHEMA_VERSION).toBe("gridforge/api/1");
    expect(honesty.schema_version.value).toBe("gridforge/api/1");
    expect(/^API_SCHEMA = "([^"]+)"/m.exec(fs.readFileSync("gridforge/api/server.py", "utf8"))![1]).toBe("gridforge/api/1");
    expect(API_CHANGELOG[0].text).toContain("did not change schema_version, which stays gridforge/api/1");
  });

  it("assumed_fields is a request field of POST /v1/qualify and adds inputs_declared_assumed, assumed_count and assumed_count_note", () => {
    const server = fs.readFileSync("gridforge/api/server.py", "utf8");
    const payloads = fs.readFileSync("gridforge/api/payloads.py", "utf8");
    expect(server).toContain("assumed_fields");
    expect(server + payloads).toMatch(/inputs_declared_assumed/);
    expect(server + payloads).toMatch(/assumed_count_note/);
    expect(JSON.stringify(honesty.responses["/v1/qualify"])).toMatch(/inputs_declared_assumed.*assumed_count.*assumed_count_note/);
    expect(JSON.stringify(JSON.parse(readFileSync("lib/openapi-discovery.json", "utf8")))).toContain("qualify_assumed_fields");
  });

  it("specification_available is on every constraint of the published reference, and the engine's reference builder writes it", () => {
    expect(fs.readFileSync("gridforge/reference/build.py", "utf8")).toContain('"specification_available"');
    const ref = JSON.parse(readFileSync("public/reference/constraints.json", "utf8"));
    expect(ref.constraints.length).toBeGreaterThan(0);
    for (const c of ref.constraints) expect(typeof c.specification_available, c.id).toBe("boolean");
  });

  it("currency is a key of the response_template of POST /v1/spec and, in html and md, of POST /v1/power/deploy/spec", () => {
    const server = fs.readFileSync("gridforge/api/server.py", "utf8");
    expect(server).toMatch(/out\["response_template"\] = \{[\s\S]{0,400}"currency": ""/);
    expect(server).toMatch(/def _btm_response_template\(spec\) -> dict:[\s\S]{0,300}"currency": ""/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------
// Every key an entry says it added or corrected is in the engine. The first three entries are proved by the tests above; the table below proves
// each key of every entry once more, one by one, so that an entry cannot name a key the engine does not have: it is the guard the changelog
// is held to, and the keys of the API layer entries (qualify, compare, portfolio, diff, bids, assess, MCP, HTTP) are proved here.
// ---------------------------------------------------------------------------------------------------------------------------------------
type Proof = { file: string; pattern: RegExp };
const SERVER = "gridforge/api/server.py";
const PAYLOADS = "gridforge/api/payloads.py";
const toolsJson = JSON.parse(readFileSync("public/reference/tools.json", "utf8")) as {
  tools: { name: string; inputSchema: { required?: string[]; properties: Record<string, any> } }[];
  rate_card: { endpoint: string; units: number; max_halls_per_request?: number }[];
};
const qualifyTool = toolsJson.tools.find((t) => t.name === "gridforge_qualify")!;
const portfolioTool = toolsJson.tools.find((t) => t.name === "gridforge_portfolio")!;

/** Where in the engine's own source each key is written (or, for a published file, what that file says). Every pattern is a line of the engine, not a word. */
const PROOFS: Record<string, Proof[] | (() => boolean)> = {
  assumed_fields: [{ file: SERVER, pattern: /def qualify_assumed_fields\(/ }],
  inputs_declared_assumed: [{ file: PAYLOADS, pattern: /inputs_declared_assumed/ }],
  assumed_count: [{ file: PAYLOADS, pattern: /out\["intake"\]\["assumed_count"\] = len\(rows\)/ }],
  assumed_count_note: [{ file: PAYLOADS, pattern: /out\["intake"\]\["assumed_count_note"\]/ }],
  qualify_assumed_fields: [{ file: SERVER, pattern: /"qualify_assumed_fields": True/ }],
  specification_available: [{ file: "gridforge/reference/build.py", pattern: /"specification_available"/ }],
  currency: [{ file: SERVER, pattern: /"valid_until": "", "currency": ""/ }],
  figures_not_supplied: [{ file: PAYLOADS, pattern: /out\["figures_not_supplied"\] = not_supplied/ }],
  minimum_figures: [{ file: SERVER, pattern: /minimum_figures=QUALIFY_MIN_FIGURES/ }],
  figures_sent: [{ file: SERVER, pattern: /figures_sent=sent/ }],
  limit: [{ file: SERVER, pattern: /field=name, limit=ceiling/ }],
  sets_the_date_reason: [{ file: PAYLOADS, pattern: /"sets_the_date_reason": no_date_reason\(rec\.ladder, t\)/ }],
  date_label: [
    { file: "gridforge/envelope/time_to_power.py", pattern: /"no date: nothing is deployable in this scenario"/ },
    { file: "gridforge/envelope/time_to_power.py", pattern: /"no date: a lead time on the path is missing"/ },
  ],
  racks_evidence: [
    { file: PAYLOADS, pattern: /"racks_evidence": rack_evidence\(rec\.envelope\)\.short/ },
    { file: PAYLOADS, pattern: /"racks_evidence": rack_class\(rec\)\.short/ },
    { file: "gridforge/api/compare_payload.py", pattern: /"racks_evidence": rack_evidence\(res\.envelope\)\.short/ },
    { file: "gridforge/api/compare_payload.py", pattern: /"racks_evidence": rack_class\(res\)\.short/ },
  ],
  after_ladder: [{ file: "gridforge/api/compare_payload.py", pattern: /"after_ladder": \{"racks": res\.unlocked_racks/ }],
  allowed: [{ file: SERVER, pattern: /raise ApiError\(422, f"unknown format \{fmt\[:40\]!r\}", allowed=list\(allowed\)\)/ }],
  field: [{ file: SERVER, pattern: /field="scenario", allowed=ids/ }],
  scenario: [{ file: SERVER, pattern: /def _tender_scenario\(/ }],
  redundancy: [{ file: "gridforge/reporting/btm_assessment.py", pattern: /field="redundancy", allowed=allowed/ }],
  max_halls_per_request: () => toolsJson.rate_card.find((r) => r.endpoint === "/v1/portfolio")?.max_halls_per_request === 50,
  maxItems: () => portfolioTool.inputSchema.properties.intakes.maxItems === 50,
  max_halls: [{ file: SERVER, pattern: /portfolio_cap_message\(len\(body\["intakes"\]\)\), max_halls=MAX_PORTFOLIO_HALLS/ }],
  requests_needed: [{ file: SERVER, pattern: /requests_needed=-\(-halls \/\/ MAX_PORTFOLIO_HALLS\)/ }],
  units_per_hall: [{ file: SERVER, pattern: /units_per_hall=UNIT_COST\[_PORTFOLIO\]/ }],
  target_reachable: [{ file: "gridforge/reporting/readiness.py", pattern: /"target_reachable": gap_after_ladder == 0/ }],
  gap_racks_after_ladder: [{ file: "gridforge/reporting/readiness.py", pattern: /"gap_racks_after_ladder": gap_after_ladder/ }],
  ladder_action: [{ file: "gridforge/reporting/readiness.py", pattern: /"ladder_action": base\["action"\]/ }],
  changed_inputs_known: [{ file: SERVER, pattern: /"changed_inputs_known": not \(from_state and d\.inputs != "unchanged"\)/ }],
  drivers_note: [{ file: SERVER, pattern: /"drivers_note": _state_drivers_note\(d\) if from_state else None/ }],
  evidence_changed_inputs: [{ file: SERVER, pattern: /"evidence_changed_inputs": list\(d\.evidence_changes\)/ }],
  figure_checks: [{ file: SERVER, pattern: /"figure_checks": \[c\.to_dict\(\) for c in a\.contradictions\]/ }],
  score_basis: [{ file: SERVER, pattern: /"score_basis": a\.score_basis/ }],
  duty_at_site_conditions: [{ file: "gridforge/procurement/build.py", pattern: /DUTY_FIELD = "duty_at_site_conditions"/ }],
  validity_days: [{ file: "gridforge/procurement/schema.py", pattern: /response_key="validity_days"/ }],
  directional: [{ file: "gridforge/reporting/btm_assessment.py", pattern: /out\["directional"\] = True/ }],
  directional_reason: [{ file: "gridforge/reporting/btm_assessment.py", pattern: /out\["directional_reason"\] = load_profile_report\.directional_reason/ }],
  peak_plausible: [{ file: "gridforge/reporting/btm_assessment.py", pattern: /"peak_plausible": not profile_problem/ }],
  profile_problem: [{ file: "gridforge/reporting/btm_assessment.py", pattern: /"profile_problem": profile_problem/ }],
  jsonrpc: [{ file: SERVER, pattern: /message\.get\("jsonrpc"\) == "2\.0"/ }],
  name: [{ file: SERVER, pattern: /params\.name is \{got\}: name the tool to call/ }],
  available: [{ file: SERVER, pattern: /\{"available": sorted\(TOOLS_BY_NAME\)\}/ }],
  allow: [{ file: SERVER, pattern: /"allow": allow\}\)/ }],
  endpoints: [{ file: SERVER, pattern: /"endpoints": public_endpoints\(\)/ }],
  warnings: [{ file: SERVER, pattern: /non-finite figure withheld at \{p\}/ }],
  rank: [
    { file: "gridforge/reporting/portfolio.py", pattern: /"rank": rk, "site":/ },
    { file: "gridforge/reporting/portfolio.py", pattern: /out\.append\(None\)/ },
    { file: SERVER, pattern: /"rank": None if a\.disqualified else rank/ },
  ],
  position: [{ file: "gridforge/reporting/portfolio.py", pattern: /"position": i,/ }],
  required: () => qualifyTool.inputSchema.required === undefined,
  required_at_least: [{ file: SERVER, pattern: /required_at_least=list\(QUALIFY_FIELDS\), minimum_figures/ }],
  sets_the_date: [{ file: PAYLOADS, pattern: /"sets_the_date": t\.critical_item if full_capacity_band\(rec\.ladder, t\) is not None else None/ }],
  compliant: [{ file: "gridforge/procurement/evaluate.py", pattern: /return not self\.disqualified and not self\.mandatory_failed and not self\.unanswered/ }],
};

describe("every key a changelog entry claims is named in its text and is in the engine", () => {
  const claimed = API_CHANGELOG.flatMap((e) => (e.keys ?? []).map((key) => ({ key, e })));

  it("every additive and correction entry lists the keys it claims, and the policy entry claims none", () => {
    for (const e of API_CHANGELOG) {
      if (e.kind === "policy") expect(e.keys ?? [], e.text.slice(0, 40)).toEqual([]);
      else expect((e.keys ?? []).length, e.text.slice(0, 40)).toBeGreaterThan(0);
    }
  });

  it("each claimed key is written in the entry's own text, so the list cannot drift from what the page prints", () => {
    for (const { key, e } of claimed) expect(e.text, key).toContain(key);
  });

  it("each claimed key has a proof in the table, and the table proves nothing nobody claims", () => {
    for (const { key } of claimed) expect(PROOFS, key).toHaveProperty(key);
    expect(Object.keys(PROOFS).sort()).toEqual([...new Set(claimed.map((c) => c.key))].sort());
  });

  it.each(Object.keys(PROOFS))("%s is in the engine", (key) => {
    const proof = PROOFS[key];
    if (typeof proof === "function") {
      expect(proof(), key).toBe(true);
      return;
    }
    for (const p of proof) expect(fs.readFileSync(p.file, "utf8"), `${key} in ${p.file}`).toMatch(p.pattern);
  });

  it("the routes the entry names for the format refusal are the routes the engine's table refuses a format on", () => {
    const src = fs.readFileSync(SERVER, "utf8");
    const table = /ROUTE_FORMATS: dict\[[^\n]*\] = \{([\s\S]*?)\n\}/.exec(src)![1];
    const routes = [...table.matchAll(/"(\/v1\/[a-z]+)":/g)].map((m) => m[1]);
    expect([...routes].sort()).toEqual(["/v1/deck", "/v1/diff", "/v1/portfolio", "/v1/proposal", "/v1/screen", "/v1/spec", "/v1/study"]);
    const entry = API_CHANGELOG.find((e) => e.keys?.includes("allowed"))!;
    for (const r of routes) expect(entry.text, r).toContain(r);
  });

  it("the cap, the minimum and the load-profile limits the entries state are the engine's numbers", () => {
    const text = API_CHANGELOG.map((e) => e.text).join("\n");
    expect(Number(/^MAX_PORTFOLIO_HALLS = (\d+)/m.exec(fs.readFileSync("gridforge/api/metering.py", "utf8"))![1])).toBe(50);
    expect(text).toContain("over 50 halls");
    expect(text).toContain("more than 50 halls");
    expect(Number(/^QUALIFY_MIN_FIGURES = (\d+)/m.exec(fs.readFileSync(SERVER, "utf8"))![1])).toBe(3);
    expect(text).toContain("at least three of the seven figures");
    const load = fs.readFileSync("gridforge/power/load_profile.py", "utf8");
    expect(Number(/^MIN_SAMPLES_FOR_SIZING = (\d+)/m.exec(load)![1])).toBe(24);
    expect(Number(/^MIN_SPAN_HOURS_FOR_SIZING = ([\d.]+)/m.exec(load)![1])).toBe(24);
    expect(Number(/^PEAK_PLAUSIBILITY_FACTOR = ([\d.]+)/m.exec(load)![1])).toBe(100);
    expect(text).toContain("fewer than 24 readings or less than 24 hours");
    expect(text).toContain("more than 100 times below, or above, both the target and the grid capacity");
  });

  it("the correction says what each value was, and schema_version stays what the engine sends", () => {
    const correction = API_CHANGELOG.find((e) => e.kind === "correction")!;
    expect(correction.text).toContain("schema_version stays gridforge/api/1");
    expect(correction.text).toContain("rank on a /v1/portfolio hall row is null for a hall that is not ranked");
    expect(correction.text).toContain("it carried an ordinal");
    expect(correction.text).toContain("The published input schema of POST /v1/qualify has no required list");
    expect(correction.text).toContain("which the engine never required");
    expect(qualifyTool.inputSchema.required).toBeUndefined();
    // what an unsupported format used to be answered as is in the engine's own words
    expect(fs.readFileSync(SERVER, "utf8")).toMatch(/used to be answered as if it were the default/);
  });
});
