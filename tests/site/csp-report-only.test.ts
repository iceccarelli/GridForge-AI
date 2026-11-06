/**
 * Content-Security-Policy-Report-Only. The enforced CSP stays the three nonce-free directives; this adds a read-only policy that tells us what an
 * enforced one would block, and a minimal route that receives the browser's reports. Report-Only blocks nothing, so it cannot break a page.
 *
 *   header   a conservative script/connect/img/style policy the site's own pages satisfy (Next's inline bootstrap and the JSON-LD blocks need
 *            'unsafe-inline' for scripts until a nonce policy exists; eval is NOT allowed), with report-uri /api/csp-report
 *   route    POST only, 8 KB body cap, the repo's rate-limit guard, 204, and a log line with the violated directive and the blocked ORIGIN only
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { siteUrl } from "@/lib/site";
import { resetMemoryLimiter, RATE_POLICIES } from "@/lib/rate-limit";
import { GLOBAL_HEADERS, cspReportOnly, securityHeaderRules } from "@/lib/security-headers";

const header = (k: string) => GLOBAL_HEADERS.find((h) => h.key === k)?.value;
const directives = (policy: string) => new Map(policy.split(";").map((d) => d.trim()).filter(Boolean).map((d) => { const [name, ...v] = d.split(/\s+/); return [name, v] as const; }));

describe("the Report-Only header", () => {
  it("is on every page, beside (not instead of) the enforced CSP", () => {
    expect(header("Content-Security-Policy-Report-Only")).toBeTruthy();
    expect(header("Content-Security-Policy")).toBe("frame-ancestors 'self'; base-uri 'self'; object-src 'none'");
    expect(securityHeaderRules()[0].source).toBe("/:path*");
  });
  it("defaults to the site itself and states script, connect, image and style sources explicitly", () => {
    const d = directives(header("Content-Security-Policy-Report-Only")!);
    expect(d.get("default-src")).toEqual(["'self'"]);
    for (const k of ["script-src", "connect-src", "img-src", "style-src", "font-src", "frame-src", "form-action", "report-uri"]) expect(d.has(k), k).toBe(true);
    expect(d.get("report-uri")).toEqual(["/api/csp-report"]);
    expect(d.get("script-src")).toContain("'self'");
    expect(d.get("connect-src")).toContain("'self'");
  });
  it("never allows eval, a wildcard, or a plain-http or any-https source for scripts", () => {
    const d = directives(header("Content-Security-Policy-Report-Only")!);
    const script = d.get("script-src")!;
    expect(script).not.toContain("'unsafe-eval'");
    expect(script.filter((s) => s === "*" || s === "http:" || s === "https:")).toEqual([]);
    expect(d.get("object-src") ?? ["'none'"]).toEqual(["'none'"]);
  });
  it("lists only the outside hosts the site's own pages use: images.unsplash.com for images; the engine and the auth host for connect, from the deployment's own settings", () => {
    const base = directives(cspReportOnly({}));
    expect(base.get("img-src")).toEqual(expect.arrayContaining(["'self'", "data:", "blob:", "https://images.unsplash.com"]));
    expect(base.get("connect-src")).toContain("https://gridforge-engine.fly.dev");
    const withEnv = directives(cspReportOnly({ GRIDFORGE_API_URL: "https://engine.example.test/some/path?x=1", NEXT_PUBLIC_SUPABASE_URL: "https://abc.supabase.co" }));
    expect(withEnv.get("connect-src")).toEqual(expect.arrayContaining(["'self'", "https://engine.example.test", "https://abc.supabase.co"]));
    // a path or query never reaches the header
    expect(cspReportOnly({ GRIDFORGE_API_URL: "https://engine.example.test/some/path?x=1" })).not.toMatch(/some\/path|x=1/);
  });
  it("a hostile or malformed setting cannot inject a directive or a header break", () => {
    for (const bad of ["https://a.test; script-src *", "https://a.test\r\nSet-Cookie: x=1", "javascript:alert(1)", "not a url", "ftp://x.test", "https://a.test, https://b.test"]) {
      const p = cspReportOnly({ GRIDFORGE_API_URL: bad, NEXT_PUBLIC_SUPABASE_URL: bad });
      expect(p, bad).not.toMatch(/[\r\n]/);
      expect(p, bad).not.toContain("script-src *");
      expect(p.split(";").length, bad).toBe(cspReportOnly({}).split(";").length);
    }
  });
});

describe("POST /api/csp-report", () => {
  let logs: string[];
  beforeEach(() => {
    delete process.env.SUPABASE_URL; delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    resetMemoryLimiter();
    logs = [];
    for (const m of ["error", "warn", "log", "info", "debug"] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { logs.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")); });
  });
  afterEach(() => vi.restoreAllMocks());
  let n = 0;
  const post = (body: string, ip = `10.9.${Math.floor(++n / 250)}.${(n % 250) + 1}`, type = "application/csp-report") =>
    new Request(siteUrl("/api/csp-report"), { method: "POST", headers: { "content-type": type, "x-real-ip": ip }, body });
  const report = (over: Record<string, unknown> = {}) => JSON.stringify({ "csp-report": { "document-uri": "https://site.example/q/SECRETTOKEN123?email=a@b.c", "violated-directive": "script-src-elem", "effective-directive": "script-src-elem", "blocked-uri": "https://cdn.evil.example/path/lib.js?key=SECRET#frag", disposition: "report", ...over } });
  const route = () => import("@/app/api/csp-report/route");

  it("answers 204 with no body and logs the violated directive and the blocked ORIGIN, never a path, query, fragment or the page address", async () => {
    const res = await (await route()).POST(post(report()));
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    const line = logs.find((l) => /csp/i.test(l));
    expect(line, logs.join("\n")).toBeDefined();
    expect(line).toContain("script-src-elem");
    expect(line).toContain("https://cdn.evil.example");
    for (const leak of ["/path", "lib.js", "SECRET", "frag", "SECRETTOKEN123", "a@b.c", "document-uri", "/q/"]) expect(logs.join("\n"), leak).not.toContain(leak);
  });
  it("names the keyword sources honestly (inline, eval, data, blob) and keeps anything odd to a fixed word", async () => {
    const { POST } = await route();
    for (const [blocked, expectWord] of [["inline", "inline"], ["eval", "eval"], ["data", "data"], ["blob:https://site.example/abc-def", "blob"], ["", "none"], ["about:blank", "other"], ["x".repeat(500), "other"]] as const) {
      logs.length = 0;
      expect((await POST(post(report({ "blocked-uri": blocked })))).status).toBe(204);
      expect(logs.find((l) => /csp/i.test(l)), blocked.slice(0, 20)).toMatch(new RegExp(`blocked=${expectWord}\\b`));
    }
  });
  it("only the leading directive NAME of a report is ever logged, and anything that is not a plain name is 'unknown', so a report cannot write what it likes into the log", async () => {
    const { POST } = await route();
    expect((await POST(post(report({ "violated-directive": "script-src\nFAKE LOG LINE", "effective-directive": undefined })))).status).toBe(204);
    expect(logs.join("\n")).not.toContain("FAKE LOG LINE");
    expect(logs.find((l) => /csp/i.test(l))).toContain("directive=script-src ");
    logs.length = 0;
    expect((await POST(post(report({ "effective-directive": "<script>alert(1)</script>" })))).status).toBe(204);
    expect(logs.find((l) => /csp/i.test(l))).toContain("directive=unknown");
    expect(logs.join("\n")).not.toContain("alert(1)");
  });
  it("accepts the modern reports+json shape as well", async () => {
    const body = JSON.stringify([{ type: "csp-violation", body: { effectiveDirective: "img-src", blockedURL: "https://img.example/a.png" } }]);
    const res = await (await route()).POST(post(body, undefined, "application/reports+json"));
    expect(res.status).toBe(204);
    expect(logs.find((l) => /csp/i.test(l))).toMatch(/img-src.*https:\/\/img\.example/);
  });
  it("caps the body at 8 KB (413) and refuses non-JSON (400), logging neither", async () => {
    const { POST } = await route();
    const big = await POST(post(report({ "script-sample": "x".repeat(9000) })));
    expect(big.status).toBe(413);
    expect((await POST(post("<html>"))).status).toBe(400);
    expect(logs.join("\n")).not.toMatch(/xxxx|<html>/);
  });
  it("is rate-limited per caller by the repo's guard, with the 429 the guard gives (Retry-After included)", async () => {
    const { POST } = await route();
    const limit = RATE_POLICIES.csp_report.limit;
    for (let i = 0; i < limit; i++) expect((await POST(post(report(), "10.250.0.1"))).status).toBe(204);
    const denied = await POST(post(report(), "10.250.0.1"));
    expect(denied.status).toBe(429);
    expect(denied.headers.get("retry-after")).toBeTruthy();
    expect((await POST(post(report(), "10.250.0.2"))).status).toBe(204); // another caller is unaffected
  });
  it("exports POST only: a GET is not a route", async () => {
    const mod = (await route()) as Record<string, unknown>;
    expect(typeof mod.POST).toBe("function");
    expect(mod.GET).toBeUndefined();
  });
});
