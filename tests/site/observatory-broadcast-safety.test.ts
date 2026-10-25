import { describe, expect, it } from "vitest";
import {
  DEFAULT_ALLOW, allowListFromEnv, assertAllowedUrl, assertDiskSpace, checkDiskSpace, checkTargetUrl, estimateBytes, isAllowedSubrequest,
} from "../../observatory-broadcast/src/safety.mjs";
import { record } from "../../observatory-broadcast/src/record.mjs";

// The tool drives a real browser at a URL and publishes what it sees. Which URLs it may open is a safety property:
// presenter-mode only, never /admin, /account, /api, checkout or anything token-shaped. These run before any browser exists.

const ok = (u: string, allow?: string[]) => checkTargetUrl(u, { allow }).ok;
const why = (u: string, allow?: string[]) => { const r = checkTargetUrl(u, { allow }); return r.ok ? "" : r.reason; };

describe("observatory-broadcast: URL allow-list", () => {
  it("default allow-list is localhost and the presenter route only", () => {
    expect([...DEFAULT_ALLOW]).toEqual(["http://localhost", "http://127.0.0.1", "http://[::1]", "https://timetopower.ai/observatory/presenter"]);
  });

  it("allows localhost on any port (http or https) and the production presenter route with its frame parameters", () => {
    for (const u of [
      "http://localhost:3000/observatory/presenter",
      "http://localhost/observatory/presenter?scenario=hall-a&t=3.250&freeze=1",
      "http://127.0.0.1:8080/stage",
      "http://[::1]:3000/observatory/presenter",
      "https://localhost:3443/observatory/presenter",
      "https://timetopower.ai/observatory/presenter",
      "https://timetopower.ai/observatory/presenter/",
      "https://timetopower.ai/observatory/presenter?t=1.000&freeze=1",
      "https://timetopower.ai/observatory/presenter/hall-a",
    ]) expect(ok(u), u).toBe(true);
  });

  it("refuses everything else: other hosts, look-alike hosts, other paths on the real host, wrong protocol, ports", () => {
    for (const u of [
      "https://timetopower.ai/",
      "https://timetopower.ai/observatory",
      "https://timetopower.ai/observatory/presenterx",
      "https://timetopower.ai/pricing",
      "http://timetopower.ai/observatory/presenter",
      "https://timetopower.ai:8443/observatory/presenter",
      "https://evil.example/observatory/presenter",
      "https://timetopower.ai.evil.example/observatory/presenter",
      "https://evil.example/timetopower.ai/observatory/presenter",
      "http://localhost.evil.example/stage",
      "http://169.254.169.254/latest/meta-data",
      "http://0.0.0.0:3000/x",
      "https://www.timetopower.ai/observatory/presenter",
    ]) expect(ok(u), u).toBe(false);
  });

  it("refuses non-http(s) schemes, credentials in the URL, and unparseable input", () => {
    for (const u of ["file:///etc/passwd", "javascript:alert(1)", "data:text/html,<h1>x</h1>", "ftp://localhost/x", "chrome://settings", "about:blank", "rtmp://localhost/live", "", "not a url", "//localhost/x"]) {
      expect(ok(u), u).toBe(false);
    }
    expect(why("http://user:pw@localhost:3000/observatory/presenter")).toMatch(/credentials/);
  });

  it("never opens /admin, /account, /api, checkout (or sibling sensitive routes), even on localhost, at any depth, in any case", () => {
    for (const p of [
      "/admin", "/admin/payg", "/account", "/account/login", "/api/health", "/api/observatory/live", "/checkout", "/checkout/success",
      "/observatory/presenter/admin", "/observatory/Admin", "/ACCOUNT", "/observatory/presenter/api/x", "/billing", "/login", "/workspace", "/webhook", "/oauth/callback",
    ]) {
      expect(ok(`http://localhost:3000${p}`), p).toBe(false);
      expect(why(`http://localhost:3000${p}`), p).toMatch(/deny list/);
    }
    expect(ok("https://timetopower.ai/observatory/presenter/api/x")).toBe(false);
  });

  it("sees through encodings and traversal: %2e%2e, encoded slashes and backslashes, double-encoded segment names", () => {
    expect(ok("http://localhost:3000/observatory/presenter/%2e%2e/admin")).toBe(false);
    expect(ok("http://localhost:3000/observatory/%2Fadmin")).toBe(false);
    expect(ok("http://localhost:3000/observatory/%5cadmin")).toBe(false);
    expect(ok("http://localhost:3000/observatory/%2561dmin")).toBe(false);
    expect(ok("http://localhost:3000/%61dmin")).toBe(false);
    expect(ok("http://localhost:3000/observatory/%E0%A4%A")).toBe(false); // malformed percent-encoding
    expect(ok("https://timetopower.ai/observatory/presenter/../../admin")).toBe(false);
    expect(ok("https://timetopower.ai/observatory/presenter/../pricing")).toBe(false);
  });

  it("refuses URLs with a token-looking path segment, and credential-looking query parameters", () => {
    for (const seg of [
      "sk_live_51Habcdefghijklmnop", "whsec_abcdef1234567890", "eyJhbGciOiJIUzI1NiJ9abc", "0123456789abcdef0123456789abcdef", "550e8400-e29b-41d4-a716-446655440000",
      "a1B2c3D4e5F6g7H8i9J0kLmN", "AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEf",
    ]) {
      expect(ok(`http://localhost:3000/observatory/presenter/${seg}`), seg).toBe(false);
      expect(why(`http://localhost:3000/observatory/presenter/${seg}`), seg).toMatch(/token/);
    }
    for (const q of ["token=abc", "access_token=abc", "api_key=1", "secret=x", "password=x", "sig=abc", "session=1", "code=abc", "key=abc", "jwt=abc", "Authorization=x"]) {
      expect(ok(`http://localhost:3000/observatory/presenter?${q}`), q).toBe(false);
    }
  });

  it("ordinary route names are not mistaken for tokens", () => {
    for (const seg of ["observatory", "presenter", "first-milestone", "hall-a", "skeleton-scene", "grid-supply-2026", "scenario-01"]) {
      expect(ok(`http://localhost:3000/observatory/presenter/${seg}`), seg).toBe(true);
    }
  });

  it("OBS_ALLOW_URLS replaces the default list but the deny list still applies to every entry", () => {
    const env = { OBS_ALLOW_URLS: "https://staging.example.test/observatory/presenter, http://localhost" };
    const allow = allowListFromEnv(env);
    expect(allow).toEqual(["https://staging.example.test/observatory/presenter", "http://localhost"]);
    expect(ok("https://staging.example.test/observatory/presenter", allow)).toBe(true);
    expect(ok("https://timetopower.ai/observatory/presenter", allow)).toBe(false);
    expect(ok("https://staging.example.test/observatory/presenter/admin", allow)).toBe(false);
    expect(ok("https://staging.example.test/admin", ["https://staging.example.test"])).toBe(false);
    expect(allowListFromEnv({})).toEqual([...DEFAULT_ALLOW]);
    expect(allowListFromEnv({ OBS_ALLOW_URLS: "  " })).toEqual([...DEFAULT_ALLOW]);
  });

  it("assertAllowedUrl throws a url_refused ObsError with exit code 4 and a hint", () => {
    let err: any;
    try { assertAllowedUrl("https://example.com/"); } catch (e) { err = e; }
    expect(err).toMatchObject({ code: "url_refused", exitCode: 4 });
    expect(err.hint).toMatch(/presenter/);
    expect(assertAllowedUrl("http://localhost:1234/stage").port).toBe("1234");
  });

  it("page sub-requests are held to the scene's origin and the same deny list (no /api calls from the page)", () => {
    const scene = new URL("http://localhost:3000/observatory/presenter");
    expect(isAllowedSubrequest("http://localhost:3000/_next/static/chunks/app.js", scene)).toBe(true);
    expect(isAllowedSubrequest("http://localhost:3000/observatory/scenarios.json", scene)).toBe(true);
    expect(isAllowedSubrequest("data:image/png;base64,AAAA", scene)).toBe(true);
    expect(isAllowedSubrequest("blob:http://localhost:3000/abc", scene)).toBe(true);
    expect(isAllowedSubrequest("http://localhost:3000/api/observatory/live", scene)).toBe(false);
    expect(isAllowedSubrequest("http://localhost:3000/admin", scene)).toBe(false);
    expect(isAllowedSubrequest("https://cdn.example.com/x.js", scene)).toBe(false);
    expect(isAllowedSubrequest("http://localhost:4000/x", scene)).toBe(false);
    expect(isAllowedSubrequest("not a url", scene)).toBe(false);
  });

  it("record() refuses a bad URL before it loads Playwright or starts anything", async () => {
    const env = { PLAYWRIGHT_MODULE: "/nonexistent/playwright", PATH: process.env.PATH ?? "" };
    await expect(record({ url: "https://example.com/observatory/presenter", out: "/tmp/never.mp4", durationSec: 1, env })).rejects.toMatchObject({ code: "url_refused", exitCode: 4 });
    await expect(record({ url: "http://localhost:3000/admin", out: "/tmp/never.mp4", durationSec: 1, env })).rejects.toMatchObject({ code: "url_refused" });
    // a good URL gets past the allow-list and fails later, for a different reason (proving the order of checks)
    const e: any = await record({ url: "http://localhost:3000/observatory/presenter", out: "/tmp/obs-never/x.mp4", durationSec: 1, env: { ...env, OBS_FFMPEG: "/nonexistent/ffmpeg", OBS_FFPROBE: "/nonexistent/ffprobe" } }).catch((x) => x);
    expect(e.code).toBe("ffmpeg_missing");
  });
});

describe("observatory-broadcast: disk preflight", () => {
  const statfs = (freeBytes: number) => () => ({ bavail: freeBytes / 4096, bsize: 4096 });

  it("passes with enough free space and fails, with an actionable error, without", () => {
    expect(checkDiskSpace(process.cwd(), 1024, { statfs: statfs(10_000_000) })).toMatchObject({ ok: true, freeBytes: 10_000_000 });
    expect(checkDiskSpace(process.cwd(), 20_000_000, { statfs: statfs(10_000_000) }).ok).toBe(false);
    let err: any;
    try { assertDiskSpace(process.cwd(), 500_000_000, { statfs: statfs(1_000_000) }); } catch (e) { err = e; }
    expect(err).toMatchObject({ code: "disk_space", exitCode: 2 });
    expect(err.message).toMatch(/not enough free disk space/);
    expect(() => assertDiskSpace(process.cwd(), 1, { statfs: statfs(1_000_000) })).not.toThrow();
  });

  it("estimates a recording's size from duration and bitrate, with a floor", () => {
    expect(estimateBytes(10, 2500)).toBe(64 * 1024 * 1024);
    expect(estimateBytes(3600, 2500)).toBeGreaterThan(1_000_000_000);
  });

  it("handles bigint statfs fields (Node returns them for large filesystems when asked)", () => {
    expect(checkDiskSpace(process.cwd(), 1, { statfs: () => ({ bavail: BigInt(10 ** 9), bsize: BigInt(4096) }) }).ok).toBe(true);
  });
});
