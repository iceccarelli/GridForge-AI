/**
 * The deployed-site smoke checks (scripts/production-smoke-checks.mjs) judge only what came back, so they are tested with
 * fixtures: the healthy shapes pass, and each way a page can degrade WITHOUT changing its status code fails. The case that
 * motivated them is pinned first: /observatory answering 200 with its own "data cannot be shown" panel.
 */
import { describe, expect, it } from "vitest";
import { CHECKS, runChecks } from "../../scripts/production-smoke-checks.mjs";
import { main, parseArgs } from "../../scripts/production-smoke.mjs";

type R = { status: number; headers: Record<string, string>; body: string };
const ok = (body: string, status = 200): R => ({ status, headers: {}, body });
const HALLS = "<h2>Synthetic Hall A</h2><h2>Synthetic Hall B</h2><h2>Synthetic Hall C</h2>";
const SHA = "a".repeat(64);
const ctxField = (basis: string, freshness = "fresh") => ({ value: {}, provenance: { basis, freshness } });
const CONTEXT = { dayAheadPrice: ctxField("day_ahead_auction"), generationMix: ctxField("observed"), queue: ctxField("published_report", "stale"), usDemand: ctxField("observed") };

const GOOD: Record<string, R> = {
  "/observatory": ok(`<main>${HALLS}<p>Latest reading, retrieved 3 min before this page was generated. Not a live reading.</p></main>`),
  "/observatory/scenarios.json": ok(JSON.stringify({ schema: "gridforge/observatory-scenarios/1", synthetic: true, scenarios: [{ id: "a" }], contentSha256: SHA })),
  "/api/observatory/context": ok(JSON.stringify(CONTEXT)),
  "/observatory/presenter?t=0&freeze=1": ok(`<html><head><meta name="robots" content="noindex, nofollow, nocache"/></head><body><div data-presenter="frame">Synthetic demonstration</div></body></html>`),
  "/robots.txt": ok("User-Agent: *\nDisallow: /observatory/presenter\n"),
  "/qualify": ok(`<main>${"The free qualifier takes seven numbers. ".repeat(20)}</main>`),
};
const serve = (over: Record<string, R | Error> = {}) => async (p: string) => {
  const r = p in over ? over[p] : GOOD[p];
  if (r instanceof Error) throw r;
  if (!r) throw new Error(`no fixture for ${p}`);
  return r;
};
const problemsFor = async (path: string, r: R | Error) => (await runChecks(serve({ [path]: r }))).find((c: { path: string }) => c.path === path)!.problems as string[];

describe("healthy responses pass every check", () => {
  it("all six", async () => {
    const res = await runChecks(serve());
    expect(res.map((c: { problems: string[] }) => c.problems)).toEqual(CHECKS.map(() => []));
    expect(res).toHaveLength(6);
  });
});

describe("the page can degrade without changing its status code", () => {
  const DEGRADED = `<main><div role="alert" data-observatory="data-unavailable"><h2>The demonstration data cannot be shown</h2><p>The scenario data for this page is missing or failed its checks.</p></div></main>`;
  it("the Observatory's own 'data cannot be shown' panel at HTTP 200 FAILS (the defect that reached production)", async () => {
    const p = await problemsFor("/observatory", ok(DEGRADED));
    expect(p.join(" ")).toMatch(/data cannot be shown/);
    expect(p.join(" ")).toMatch(/Synthetic Hall A is not on the page/);
  });
  it("a page missing one hall fails", async () => {
    expect(await problemsFor("/observatory", ok(HALLS.replace("Synthetic Hall C", "Hall C")))).toEqual(["Synthetic Hall C is not on the page"]);
  });
  it("a page that calls a reading live fails, but 'not a live reading' does not", async () => {
    expect((await problemsFor("/observatory", ok(`${HALLS}<p>Live reading</p>`))).join()).toMatch(/calls a reading live/);
    expect(await problemsFor("/observatory", ok(`${HALLS}<p>a published result, not a live reading</p>`))).toEqual([]);
  });
  it("a 500 or a 404 fails", async () => {
    expect((await problemsFor("/observatory", ok(HALLS, 500)))[0]).toMatch(/status 500/);
    expect((await problemsFor("/qualify", ok("", 404)))[0]).toMatch(/404/);
  });
  it("the presenter rendering its 'not available' state, a link, or a missing noindex each fail", async () => {
    const base = GOOD["/observatory/presenter?t=0&freeze=1"].body;
    const path = "/observatory/presenter?t=0&freeze=1";
    expect((await problemsFor(path, ok(base.replace('data-presenter="frame"', 'data-presenter="unavailable"')))).join()).toMatch(/not available/);
    expect((await problemsFor(path, ok(base.replace("</body>", '<a href="/pricing">buy</a></body>')))).join()).toMatch(/contains a link/);
    expect((await problemsFor(path, ok(base.replace("noindex, nofollow, nocache", "index, follow")))).join()).toMatch(/not marked noindex/);
  });
  it("robots.txt without the presenter rule fails", async () => {
    expect((await problemsFor("/robots.txt", ok("User-Agent: *\nDisallow: /admin\n"))).join()).toMatch(/no Disallow/);
  });
});

describe("the data endpoints are judged on their labels", () => {
  it("a scenario file with the wrong schema, not synthetic, or no digest fails", async () => {
    const f = (o: object) => ok(JSON.stringify({ schema: "gridforge/observatory-scenarios/1", synthetic: true, scenarios: [{}], contentSha256: SHA, ...o }));
    expect((await problemsFor("/observatory/scenarios.json", f({ schema: "x" }))).join()).toMatch(/schema/);
    expect((await problemsFor("/observatory/scenarios.json", f({ synthetic: false }))).join()).toMatch(/not marked synthetic/);
    expect((await problemsFor("/observatory/scenarios.json", f({ contentSha256: "abc" }))).join()).toMatch(/no content digest/);
    expect((await problemsFor("/observatory/scenarios.json", ok("<html>not json</html>")))[0]).toMatch(/not JSON/);
  });
  it("a context field without a basis, with an unknown freshness, or a mislabelled auction price fails", async () => {
    const c = (o: object) => ok(JSON.stringify({ ...CONTEXT, ...o }));
    expect((await problemsFor("/api/observatory/context", c({ queue: undefined }))).join()).toMatch(/queue missing/);
    expect((await problemsFor("/api/observatory/context", c({ usDemand: { value: {}, provenance: {} } }))).join()).toMatch(/usDemand has no basis/);
    expect((await problemsFor("/api/observatory/context", c({ generationMix: ctxField("observed", "live") }))).join()).toMatch(/freshness "live"/);
    expect((await problemsFor("/api/observatory/context", c({ dayAheadPrice: ctxField("observed") }))).join()).toMatch(/not labelled as an auction result/);
  });
  it("a failed request is a problem in the report, not a crash", async () => {
    expect(await problemsFor("/robots.txt", new Error("socket hang up"))).toEqual(["request failed: socket hang up"]);
  });
});

describe("the runner", () => {
  it("retries until a whole attempt passes (a new deployment takes minutes to go live)", async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const code = await main(["--base", "https://example.test", "--attempts", "5", "--interval", "7"], {
      sleep: async (s: number) => void sleeps.push(s),
      fetchOne: async (p: string) => {
        if (p === "/observatory" && ++calls <= 2) return ok("<main>data-observatory=\"data-unavailable\"</main>");
        return serve()(p);
      },
    });
    expect(code).toBe(0);
    expect(sleeps).toEqual([7, 7]);
  });
  it("fails, and says which check, when no attempt passes", async () => {
    const lines: string[] = [];
    const orig = console.log;
    console.log = (m: string) => void lines.push(String(m));
    try {
      const code = await main(["--base", "https://example.test", "--attempts", "2", "--interval", "0"], { sleep: async () => {}, fetchOne: serve({ "/robots.txt": ok("", 500) }) });
      expect(code).toBe(1);
    } finally {
      console.log = orig;
    }
    expect(lines.join("\n")).toMatch(/FAIL: robots\.txt keeps the presenter out of search/);
  });
  it("refuses a malformed command line", () => {
    expect(() => parseArgs(["--base", "ftp://x"], {})).toThrow(/http/);
    expect(() => parseArgs(["--attempts", "0"], {})).toThrow(/attempts/);
    expect(() => parseArgs(["--interval", "9999"], {})).toThrow(/interval/);
    expect(() => parseArgs(["--nope"], {})).toThrow(/unknown argument/);
    expect(parseArgs([], { SMOKE_BASE_URL: "https://staging.example/" }).base).toBe("https://staging.example");
  });
});
