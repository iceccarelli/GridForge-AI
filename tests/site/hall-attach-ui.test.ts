import fs from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {}, replace: () => {} }), usePathname: () => "/account/sites" }));

import { AttachProject, NON_PRODUCTION_ATTACH_WARNING, attachDisabled, attachNeedsConfirmation } from "@/components/SitesWorkspace";

// Attaching a project to a site that is not production permanently keeps its observations out of the calibration ledger (0052). The page must say so
// before the button works, and the request must carry the confirmation the server demands. The server's refusal is tested in the registry scenarios;
// this is the page's half. No browser here (the repository has no DOM test library): the markup, the pure rules the component uses, and its source.

const html = (el: React.ReactElement) => renderToStaticMarkup(el);
const hall = { id: "h1", siteId: "s1", label: "Hall 1" };
const render = (dataOrigin: "production" | "test" | "synthetic") => html(React.createElement(AttachProject, { hall, dataOrigin, onDone: async () => {} }));
const src = fs.readFileSync("components/SitesWorkspace.tsx", "utf8");

describe("the attach form on a site that is not production", () => {
  it.each(["test", "synthetic"] as const)("%s: a prominent warning saying plainly what is permanent, and a required, unticked checkbox", (origin) => {
    const out = render(origin);
    expect(out).toContain(`This is a ${origin} site. This cannot be undone.`);
    expect(out).toContain("PERMANENTLY excludes that project");
    expect(out).toContain("shared calibration ledger");
    expect(out).toContain("Detaching it later does not undo this");
    expect(out).toMatch(/<input id="attach-confirm" type="checkbox" required=""/);
    expect(out).not.toMatch(/<input id="attach-confirm"[^>]*checked/);
    expect(out).toMatch(/aria-describedby="attach-nonprod-title attach-nonprod-body"/);
    expect(out).toMatch(/<div id="attach-nonprod" role="alert"/);
    expect(out).not.toContain("migration");
    expect(out).toContain("The website checks this confirmation when you attach");
    expect(out).toMatch(/<label for="attach-confirm"/);
  });

  it.each(["test", "synthetic"] as const)("%s: the Attach button is aria-disabled until the box is ticked (not disabled, so Enter still reaches the handler's message), described by the warning, and the warning comes first", (origin) => {
    const out = render(origin);
    const button = out.match(/<button type="submit"[^>]*>Attach project<\/button>/)![0];
    expect(button).toContain('aria-disabled="true"');
    expect(button).not.toContain('disabled=""');
    expect(button).toContain('aria-describedby="attach-nonprod-title attach-nonprod-body"');
    expect(out.indexOf('id="attach-nonprod"')).toBeLessThan(out.indexOf("<button type=\"submit\""));          // reading order: consequence, then action
  });

  it("the rules the button and the request use: only a ticked box enables it, and only a non-production site sends the confirmation", () => {
    expect(attachDisabled(false, "test", false)).toBe(true);
    expect(attachDisabled(false, "test", true)).toBe(false);
    expect(attachDisabled(false, "synthetic", false)).toBe(true);
    expect(attachDisabled(false, "synthetic", true)).toBe(false);
    expect(attachDisabled(true, "test", true)).toBe(true);              // busy is always disabled
    expect(attachDisabled(true, "production", false)).toBe(true);
    expect(attachDisabled(false, "production", false)).toBe(false);
    // a value the page does not know is treated as NOT production: it fails safe
    for (const odd of ["", "Production", "PRODUCTION", "prod", "unclassified", "undefined"]) {
      expect(attachNeedsConfirmation(odd), odd).toBe(true);
      expect(attachDisabled(false, odd, false), odd).toBe(true);
    }
    expect(attachNeedsConfirmation("production")).toBe(false);
  });

  it("the warning wording is the page's, states what is permanent, and does not overclaim", () => {
    expect(NON_PRODUCTION_ATTACH_WARNING).toMatch(/PERMANENTLY excludes/);
    expect(NON_PRODUCTION_ATTACH_WARNING).toMatch(/does not undo/);
    expect(NON_PRODUCTION_ATTACH_WARNING).toMatch(/production site/);
    expect(NON_PRODUCTION_ATTACH_WARNING).not.toMatch(/migration|0052/);
  });
});

describe("the attach form on a production site", () => {
  it("shows no warning and no checkbox, and the button is enabled", () => {
    const out = render("production");
    expect(out).not.toContain("attach-confirm");
    expect(out).not.toContain("PERMANENTLY");
    expect(out).not.toContain("attach-nonprod");
    const button = out.match(/<button type="submit"[^>]*>Attach project<\/button>/)![0];
    expect(button).toContain('aria-disabled="false"');
    expect(button).not.toContain("aria-describedby");
    expect(out).not.toContain('disabled=""');
  });
});

describe("the request", () => {
  it("sends confirmNonProductionSite: true only when the site needs it, and refuses to send at all while unticked", () => {
    expect(src).toContain('...(needsConfirm ? { confirmNonProductionSite: true } : {})');
    const submit = src.slice(src.indexOf("export function AttachProject"), src.indexOf("export function Timeline"));
    expect(submit.indexOf("if (needsConfirm && !confirmed) return f.fail(")).toBeGreaterThan(-1);
    expect(submit.indexOf("if (needsConfirm && !confirmed) return f.fail(")).toBeLessThan(submit.indexOf("await api("));        // the guard precedes the call
    expect(submit).toContain("setConfirmed(false)");
    expect(submit).toContain("Tick the box to confirm");                       // the message Enter reaches while the button is aria-disabled                                                                           // a new attachment is a new decision
  });

  it("the workspace hands the form the site's own data origin", () => {
    expect(src).toContain("<AttachProject hall={hall} dataOrigin={site.dataOrigin} onDone={loadTimeline} />");
  });
});
