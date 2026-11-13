import { describe, expect, it } from "vitest";
import nextConfig from "../../next.config";
import { GLOBAL_HEADERS, QUERY_TOKEN_PAGES, TOKEN_API_ROUTES, TOKEN_HEADERS, TOKEN_ROUTES, securityHeaderRules } from "@/lib/security-headers";
import robots from "@/app/robots";
import fs from "node:fs";
import path from "node:path";

const value = (h: { key: string; value: string }[], k: string) => h.find((x) => x.key === k)?.value;

/** Every .ts / .tsx file under `dir` (not node_modules, not .next). */
const walkSrc = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name === "node_modules" || e.name === ".next") return [];
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walkSrc(p) : /\.tsx?$/.test(e.name) ? [p] : [];
  });

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
    const handlers = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? handlers(path.join(dir, e.name)) : e.name === "route.ts" ? [path.join(dir, e.name)] : []));
    for (const r of TOKEN_API_ROUTES) {
      const dir = path.join("app", r.replace(/\/:path\*$/, ""));
      expect(handlers(dir).length, `${r} has no route handler`).toBeGreaterThan(0);
    }
    // Pages whose credential is in the query string must be real pages.
    for (const r of QUERY_TOKEN_PAGES) expect(fs.existsSync(path.join("app", r, "page.tsx")), `${r} is not a page`).toBe(true);
    const api = new Set<string>(TOKEN_API_ROUTES);
    const query = new Set<string>(QUERY_TOKEN_PAGES);
    for (const r of TOKEN_ROUTES) expect(tokenPages.includes(r) || api.has(r) || query.has(r), `${r} matches no page or route`).toBe(true);
  });

  it("every API route with a [token] segment is covered by a no-store / no-referrer / noindex rule (a token API response is as private as its page)", () => {
    // Walk every app/api route handler. A path segment named [token] or [shareToken] means the URL carries a bearer credential, and the JSON
    // it answers (a released deliverable, an intake, a project, a watch, a qualification) must not be stored by a shared cache, sent on as a
    // referrer or indexed. Adding such a route without a rule must fail here, not in a review.
    const handlers = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? handlers(path.join(dir, e.name)) : e.name === "route.ts" ? [path.join(dir, e.name)] : []));
    const tokenApiRoutes = handlers("app/api")
      .map((f) => "/" + path.relative("app", path.dirname(f)).split(path.sep).join("/"))
      .filter((r) => /\[(token|shareToken)\]/.test(r));
    expect(tokenApiRoutes.length, "found no token API routes: the walk is broken").toBeGreaterThan(10);
    const covers = (pattern: string, route: string) => {
      if (!pattern.endsWith("/:path*")) return pattern === route; // an exact pattern covers that route only
      const prefix = pattern.slice(0, -"/:path*".length);
      return route === prefix || route.startsWith(prefix + "/");
    };
    for (const r of tokenApiRoutes) {
      const rules = securityHeaderRules().filter((rule) => rule.source !== "/:path*" && covers(rule.source, r));
      expect(rules.length, `${r} carries a token in its path and no header rule covers it`).toBeGreaterThan(0);
      const merged = Object.fromEntries(rules.flatMap((rule) => rule.headers.map((h) => [h.key, h.value])));
      expect(merged["Cache-Control"], r).toMatch(/no-store/);
      expect(merged["Referrer-Policy"], r).toBe("no-referrer");
      expect(merged["X-Robots-Tag"], r).toMatch(/noindex/);
    }
    // The named prefixes (the audit found only keys, usage, payg and billing).
    for (const prefix of ["/api/deliverable", "/api/intake", "/api/watch", "/api/projects", "/api/qualify", "/api/power/deploy/cases"]) {
      expect(TOKEN_API_ROUTES as readonly string[], prefix).toContain(`${prefix}/:path*`);
    }
  });

  describe("a page whose credential is in the QUERY STRING (?project=<owner or edit token>) is as private as a path-token page", () => {
    /** The header rules that apply to `pathname` requested WITH the given query keys, merged the way Next applies them (later rules win a key). */
    const headersFor = (pathname: string, queryKeys: string[]) => {
      const rules = securityHeaderRules().filter((rule) => {
        if (rule.source === "/:path*" || rule.source !== pathname) return false;
        return (rule.has ?? []).every((h) => h.type === "query" && queryKeys.includes(h.key));
      });
      return { rules, merged: Object.fromEntries(rules.flatMap((r) => r.headers.map((h) => [h.key, h.value]))) as Record<string, string> };
    };
    const assertPrivate = (merged: Record<string, string>, what: string) => {
      expect(merged["Cache-Control"], what).toMatch(/no-store/);
      expect(merged["Referrer-Policy"], what).toBe("no-referrer");
      expect(merged["X-Robots-Tag"], what).toMatch(/noindex/);
    };
    it("/workspace and /power/compare, which carry ?project=, have the token headers (and /commissioned, ?session_id=, still does)", () => {
      assertPrivate(headersFor("/workspace", []).merged, "/workspace");
      assertPrivate(headersFor("/power/compare", ["project"]).merged, "/power/compare?project=");
      assertPrivate(headersFor("/commissioned", ["session_id"]).merged, "/commissioned");
    });

    it("every page the code links to with ?project= is covered, found by scanning app/, components/ and lib/ (not from a list typed here)", () => {
      const targets = new Set<string>();
      for (const f of ["app", "components", "lib"].flatMap(walkSrc)) {
        // The whole path, `${...}` pieces included, so an API call such as /api/halls/${id}/projects?project=<internal id> is read as the API
        // route it is (an authenticated request, not a page address a person opens) and skipped, not mistaken for a page called /projects.
        for (const m of fs.readFileSync(f, "utf8").matchAll(/(\/[a-z][a-z0-9/-]*(?:\$\{[^}]*\}[a-z0-9/-]*)*)\?project=/g)) {
          if (!m[1].startsWith("/api/")) targets.add(m[1]);
        }
      }
      expect([...targets].sort(), "the scan found the ?project= pages").toEqual(expect.arrayContaining(["/power/compare", "/workspace"]));
      for (const t of targets) {
        const { merged } = headersFor(t, ["project"]);
        assertPrivate(merged, `${t}?project=`);
        expect(fs.existsSync(path.join("app", t, "page.tsx")), `${t} is not a page`).toBe(true);
      }
    });

    it("/power/compare WITHOUT a token stays a public, cacheable, indexable page (the sitemap and llms.txt send people and crawlers to it)", () => {
      const { merged } = headersFor("/power/compare", []);
      expect(merged["X-Robots-Tag"]).toBeUndefined();
      expect(merged["Cache-Control"]).toBeUndefined();
      expect(merged["Referrer-Policy"]).toBeUndefined();
      expect(fs.readFileSync("app/sitemap.ts", "utf8")).toContain("/power/compare");
    });

    it("robots.txt closes both to every crawler: /workspace outright, /power/compare only with a token on it", () => {
      for (const r of robots().rules as { userAgent: string; disallow?: string | string[] }[]) {
        const dis = Array.isArray(r.disallow) ? r.disallow : r.disallow ? [r.disallow] : [];
        expect(dis, r.userAgent).toContain("/workspace");
        expect(dis, r.userAgent).toContain("/power/compare?project=");
        expect(dis, `${r.userAgent}: the public comparison page must stay crawlable`).not.toContain("/power/compare");
      }
    });
  });

  describe("/api/engagements returns document, intake and watch tokens in its body", () => {
    it("its URL is a token route: no-store, no-referrer, noindex", () => {
      expect(TOKEN_API_ROUTES as readonly string[]).toContain("/api/engagements");
      const rules = securityHeaderRules().filter((r) => r.source === "/api/engagements");
      expect(rules.length).toBeGreaterThan(0);
      const merged = Object.fromEntries(rules.flatMap((r) => r.headers.map((h) => [h.key, h.value])));
      expect(merged["Cache-Control"]).toMatch(/no-store/);
      expect(merged["Referrer-Policy"]).toBe("no-referrer");
      expect(merged["X-Robots-Tag"]).toMatch(/noindex/);
    });

    it("every route handler that puts documentToken / intakeToken / a watch `token` in a JSON body is covered by a token rule", () => {
      const handlers = walkSrc("app/api").filter((f) => f.endsWith("route.ts"));
      const returning = handlers.filter((f) => /\b(documentToken|intakeToken|ownerToken|editToken)\s*:/.test(fs.readFileSync(f, "utf8")));
      expect(returning.map((f) => f.replace(/\\/g, "/")), "the scan found the engagements route").toContain("app/api/engagements/route.ts");
      for (const f of returning) {
        const route = "/" + path.relative("app", path.dirname(f)).split(path.sep).join("/");
        const covered = securityHeaderRules().some((r) => r.source !== "/:path*" && (r.source === route || (r.source.endsWith("/:path*") && (route === r.source.slice(0, -7) || route.startsWith(r.source.slice(0, -6))))));
        expect(covered, `${route} returns a bearer token in its body and no header rule covers it`).toBe(true);
      }
    });
  });

  it("serves AVIF before WebP and keeps remote images to the one allowed host", () => {
    expect(nextConfig.images!.formats).toEqual(["image/avif", "image/webp"]);
    expect(nextConfig.images!.remotePatterns).toHaveLength(1);
  });
});
