// The routes were hardened (verified identity, reviewed-hash release) and the callers must follow,
// or the hardening ships as a dead button. These read the client sources because the components
// are not rendered in this suite; the route behaviour itself is covered by the route tests.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const account = readFileSync("app/account/page.tsx", "utf8");
const pipeline = readFileSync("components/EngagementPipeline.tsx", "utf8");

describe("account page calls the subscriber routes with a verified identity", () => {
  it("sends a bearer token and never an email in the query or body of the paid routes", () => {
    expect(account).toContain("Authorization");
    expect(account).not.toMatch(/\/api\/scenarios\?email=/);
    expect(account).not.toMatch(/\/api\/siting-analysis[\s\S]{0,200}JSON\.stringify\(\{\s*email/);
    expect(account).not.toMatch(/\/api\/subscription-status[\s\S]{0,200}JSON\.stringify\(\{\s*email/);
  });
  it("attaches the auth header to every paid route call", () => {
    for (const route of ["/api/subscription-status", "/api/scenarios", "/api/siting-analysis"]) {
      const re = new RegExp("(?:fetch\\(|authHeaders\\(\\)\\s*\\.then\\(\\(h\\) => fetch\\()\\s*\"" + route.replace(/\//g, "\\/"), "g");
      const hits = [...account.matchAll(re)];
      expect(hits.length).toBeGreaterThan(0);
      for (const m of hits) expect(account.slice(m.index!, m.index! + 320)).toMatch(/authHeaders\(\)|headers: h/);
    }
  });
});

describe("the release control sends the hash of the draft that was reviewed", () => {
  it("passes reviewed_hash on release and offers reopen", () => {
    expect(pipeline).toContain("reviewed_hash");
    expect(pipeline).toMatch(/act\(d\.token, "release", d\.document_hash/);
    expect(pipeline).toContain('"reopen"');
  });
});
