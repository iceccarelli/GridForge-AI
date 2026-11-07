/**
 * The behind-the-meter and project journeys have an entry in the site navigation.
 *
 * /power/deploy (the free BTM assessment) and /workspace (the project record) were absent from lib/nav.ts, so a visitor could reach the
 * Time-to-Power comparison from the footer but not the rest of the journey the registry describes. These tests pin the two links, their
 * groups and labels, that each resolves to a page, and that the registry's own web routes for those capabilities are the linked ones.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FOOTER_GROUPS, NAV_LINKS } from "@/lib/nav";
import { capabilityById } from "@/lib/capability-registry";

const group = (heading: string) => FOOTER_GROUPS.find((g) => g.heading === heading)!;
const pageExists = (href: string) => fs.existsSync(path.join(process.cwd(), "app", href, "page.tsx"));

describe("footer navigation reaches the whole power journey", () => {
  it("links the BTM assessment in 'How it works', beside the Time-to-Power comparison", () => {
    const links = group("How it works").links;
    expect(links.map((l) => l.href)).toEqual(expect.arrayContaining(["/power/compare", "/power/deploy"]));
    expect(links.find((l) => l.href === "/power/deploy")).toEqual({ href: "/power/deploy", label: "Behind-the-meter power assessment" });
    expect(links.findIndex((l) => l.href === "/power/deploy")).toBe(links.findIndex((l) => l.href === "/power/compare") + 1);
  });

  it("links the project workspace in 'Customer', after the client portal", () => {
    const links = group("Customer").links;
    expect(links.find((l) => l.href === "/workspace")).toEqual({ href: "/workspace", label: "Project workspace" });
    expect(links.findIndex((l) => l.href === "/workspace")).toBe(links.findIndex((l) => l.href === "/dashboard") + 1);
  });

  it("keeps the primary header short and free of application surfaces", () => {
    expect(NAV_LINKS.length).toBeLessThanOrEqual(6);
    for (const banned of ["/workspace", "/power/deploy", "/dashboard", "/account"]) expect(NAV_LINKS.map((l) => l.href)).not.toContain(banned);
  });

  it("every footer link that is a route resolves to an app/ page", () => {
    const hrefs = FOOTER_GROUPS.flatMap((g) => g.links).filter((l) => !l.hash).map((l) => l.href);
    const missing = hrefs.filter((h) => !pageExists(h) && !/^\/(products|platforms|constraints|for|guides)\//.test(h));
    expect(missing).toEqual([]);
  });

  it("the registry's web routes for the BTM assessment and the project record are the linked ones", () => {
    const linked = new Set(FOOTER_GROUPS.flatMap((g) => g.links).map((l) => l.href));
    expect(linked.has(capabilityById("btm_deploy_assess")!.web_route!)).toBe(true);
    expect(linked.has(capabilityById("project_record")!.web_route!)).toBe(true);
    expect(linked.has(capabilityById("ttp_compare")!.web_route!)).toBe(true);
  });
});
