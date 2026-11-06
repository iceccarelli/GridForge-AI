import { describe, expect, it } from "vitest";
import nextConfig from "../../next.config";
import { GLOBAL_HEADERS, TOKEN_API_ROUTES, TOKEN_HEADERS, TOKEN_ROUTES, securityHeaderRules } from "@/lib/security-headers";
import fs from "node:fs";
import path from "node:path";

const value = (h: { key: string; value: string }[], k: string) => h.find((x) => x.key === k)?.value;

describe("security headers", () => {
  it("next.config serves exactly the rules this module defines", async () => {
    expect(await nextConfig.headers!()).toEqual(securityHeaderRules());
  });

  it("every page gets transport security, no sniffing, no foreign framing, a referrer policy and a minimal permissions policy", () => {
    expect(value(GLOBAL_HEADERS, "Strict-Transport-Security")).toMatch(/max-age=\d{8,}/);
    expect(value(GLOBAL_HEADERS, "X-Content-Type-Options")).toBe("nosniff");
    expect(value(GLOBAL_HEADERS, "X-Frame-Options")).toBe("SAMEORIGIN");
    expect(value(GLOBAL_HEADERS, "Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    for (const f of ["camera", "microphone", "geolocation"]) expect(value(GLOBAL_HEADERS, "Permissions-Policy")).toContain(`${f}=()`);
  });

  it("the CSP sets only directives that cannot break inline JSON-LD or Next's bootstrap, and never allows unsafe-inline or eval for scripts", () => {
    const csp = value(GLOBAL_HEADERS, "Content-Security-Policy")!;
    expect(csp).toContain("frame-ancestors 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).not.toMatch(/script-src|default-src|unsafe-inline|unsafe-eval/);
  });

  it("a token URL is never cached by a shared cache, never sent as a referrer and never indexed", () => {
    expect(value(TOKEN_HEADERS, "Referrer-Policy")).toBe("no-referrer");
    expect(value(TOKEN_HEADERS, "Cache-Control")).toMatch(/no-store/);
    expect(value(TOKEN_HEADERS, "X-Robots-Tag")).toMatch(/noindex/);
  });

  it("every token route in the app has a rule, and every rule matches a route that exists", () => {
    const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name === "page.tsx" ? [path.join(d, e.name)] : []));
    const tokenPages = walk("app")
      .map((f) => "/" + path.relative("app", path.dirname(f)).split(path.sep).join("/"))
      .filter((r) => /\[(token|shareToken)\]/.test(r))
      .map((r) => r.replace(/\[(token|shareToken)\]/, ":token*"));
    const covered = new Set<string>(TOKEN_ROUTES);
    for (const r of tokenPages) expect(covered.has(r), `${r} carries a token and has no header rule`).toBe(true);
    // The API routes that authenticate with a token have no token in their path: each must be a real route handler.
    for (const r of TOKEN_API_ROUTES) expect(fs.existsSync(path.join("app", r, "route.ts")), `${r} has no route handler`).toBe(true);
    const api = new Set<string>(TOKEN_API_ROUTES);
    for (const r of TOKEN_ROUTES) expect(tokenPages.includes(r) || api.has(r), `${r} matches no page or route`).toBe(true);
  });

  it("serves AVIF before WebP and keeps remote images to the one allowed host", () => {
    expect(nextConfig.images!.formats).toEqual(["image/avif", "image/webp"]);
    expect(nextConfig.images!.remotePatterns).toHaveLength(1);
  });
});
