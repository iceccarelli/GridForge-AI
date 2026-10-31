/**
 * robots.txt must not close the endpoints our own structured data and llms.txt tell crawlers to fetch. "/api/" is private; the licence/
 * citation and per-constraint JSON the metadata cites are the deliberate public exceptions.
 */
import { describe, expect, it } from "vitest";
import robots from "@/app/robots";

const rules = (robots().rules as { userAgent: string; allow?: string | string[]; disallow?: string | string[] }[]);
const arr = (v?: string | string[]) => (Array.isArray(v) ? v : v ? [v] : []);

describe("robots.txt and the endpoints our metadata cites", () => {
  it.each(rules.map((r) => [r.userAgent, r] as const))("%s may fetch /api/cite and /api/constraints but not the rest of /api/", (_ua, r) => {
    expect(arr(r.allow)).toEqual(expect.arrayContaining(["/api/cite", "/api/constraints"]));
    expect(arr(r.disallow)).toContain("/api/");
  });
});
