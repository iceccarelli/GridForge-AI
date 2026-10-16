/**
 * A route that hands an anonymous visitor the platform engine key must ask the rate limiter first.
 *
 * This is a source-level ratchet, deliberately: the failure it prevents is a NEW route added later that calls
 * `runCompare` (the function that spends GRIDFORGE_API_KEY on a visitor's behalf) and forgets the guard. Behaviour of the
 * guard itself is tested in rate-limit.test.ts and buyer-page.test.ts.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CAPABILITY_REGISTRY } from "@/lib/capability-registry";

function routes(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? routes(p) : e.name === "route.ts" ? [p] : [];
  });
}
const ROUTES = routes(path.join(process.cwd(), "app", "api"));

describe("routes that spend the platform engine key for a visitor", () => {
  const spenders = ROUTES.filter((f) => /\brunCompare\(/.test(fs.readFileSync(f, "utf8")));

  it("finds the two comparison routes (so this test cannot pass by finding nothing)", () => {
    expect(spenders.map((f) => path.relative(process.cwd(), f)).sort()).toEqual([
      "app/api/power/compare/route.ts",
      "app/api/power/compare/save/route.ts",
    ]);
  });

  it.each(spenders.map((f) => [path.relative(process.cwd(), f), f]))("%s asks the limiter before the engine, and returns its refusal", (_n, file) => {
    const src = fs.readFileSync(file, "utf8");
    const guard = src.indexOf("enforceRateLimit(");
    const engine = src.indexOf("runCompare(");
    expect(guard, "enforceRateLimit is never called").toBeGreaterThan(-1);
    expect(guard).toBeLessThan(engine);
    // The refusal is returned, not just computed: `if (limited) return limited;`
    expect(src).toMatch(/if \(limited\) return limited;/);
  });

  it("the registry says the guard fails closed until migration 0024 is applied, and names no live status for it", () => {
    const c = CAPABILITY_REGISTRY.find((x) => x.capability_id === "ttp_compare")!;
    expect(c.entitlement).toMatch(/enforceRateLimit/);
    expect(c.entitlement).toMatch(/503 until migration 0024 is applied/);
    expect(c.production_status).toBe("not_deployed");
  });
});

describe("the buyer page in the capability registry", () => {
  const c = CAPABILITY_REGISTRY.find((x) => x.capability_id === "project_buyer_page");
  it("is declared without a price, a SKU or a claim to be live", () => {
    expect(c).toBeTruthy();
    expect(c).toMatchObject({ family: "project", status: "free", stripe_product_or_price: "none", production_status: "not_deployed", web_route: "/p/[shareToken]" });
    expect(c!.product_id).toBeUndefined();
  });
  it("names the tables it reads and states that only a hash of the link is kept", () => {
    expect(c!.database_record).toMatch(/project_comparisons/);
    expect(c!.database_record).toMatch(/project_shares \(hash of the link only\)/);
    expect(c!.entitlement).toMatch(/Only the SHA-256 of the link is stored/);
  });
  it("routes it names exist", () => {
    for (const rel of ["app/p/[shareToken]/page.tsx", "app/api/projects/[token]/share/route.ts", "app/api/power/compare/save/route.ts"]) {
      expect(fs.existsSync(path.join(process.cwd(), rel)), rel).toBe(true);
    }
  });
});
