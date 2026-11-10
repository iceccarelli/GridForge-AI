import { describe, expect, it } from "vitest";
import { TOKEN_HEADERS, TOKEN_ROUTES, securityHeaderRules } from "@/lib/security-headers";

// /commissioned?session_id=cs_... is a credential-bearing URL: for an API plan or Hall Watch the page shows the portal link, guarded only by the
// Stripe session id in the query string. It must get the same treatment as every other token page (no cache, no referrer, no indexing).
describe("the checkout success page is a token page", () => {
  it("is listed in TOKEN_ROUTES", () => {
    expect(TOKEN_ROUTES).toContain("/commissioned");
  });
  it("gets the token headers (never cached, never a referrer, never indexed)", () => {
    const rules = securityHeaderRules();
    const rule = rules.find((r) => r.source === "/commissioned");
    expect(rule, "a header rule for /commissioned").toBeTruthy();
    const names = new Map(rule!.headers.map((h) => [h.key.toLowerCase(), h.value]));
    for (const h of TOKEN_HEADERS) expect(names.get(h.key.toLowerCase()), h.key).toBe(h.value);
  });
});
