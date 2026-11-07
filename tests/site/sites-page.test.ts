import fs from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {}, replace: () => {} }), usePathname: () => "/account/sites" }));

import SitesPage, { metadata, dynamic } from "@/app/account/sites/page";
import { InputsTable, NewHall, NewSite, RecordInput } from "@/components/SitesWorkspace";
import { EXPECTED_HALL_FIELDS } from "@/lib/site-registry-fields";

// The page's structure and honesty, without a browser. The browser-level run (a production build, a real database, a verified session at 1440 and
// 390 px, the keyboard path and the console) is reported with the change; it is not re-run here.

const html = (el: React.ReactElement) => renderToStaticMarkup(el);
const noop = async () => {};
const hall = { id: "h1", siteId: "s1", label: "Hall 1" };
const site = { id: "s1", orgId: "o1", name: "North campus", country: "DE", dataOrigin: "synthetic" as const };
const org = { id: "o1", name: "Acme", role: "owner" as const };
const input = (over: Record<string, unknown> = {}) => ({
  id: "i1", fieldPath: "grid.firm_capacity_MVA", value: 40, unit: "MVA", evidenceClass: "E1", origin: "assumed" as const, asOf: "2026-01-15", recordedBy: "eng@acme.example", source: null, ...over,
});

describe("the page shell", () => {
  it("is a server page, never statically rendered, not indexed, and carries no data", () => {
    expect(dynamic).toBe("force-dynamic");
    expect(metadata.robots).toEqual({ index: false, follow: false });
    const out = html(React.createElement(SitesPage));
    expect(out).toContain('aria-label="Loading"');
    expect(out).not.toMatch(/Acme|North campus|@/);       // nothing about anyone's organisation is in the server HTML
  });
  it("requires a session in the browser the way /account does, and sends the bearer token to the API", () => {
    const src = fs.readFileSync("components/SitesWorkspace.tsx", "utf8");
    expect(src).toContain("mayHaveSession()");
    expect(src).toContain('router.replace("/account/login")');
    expect(src).toMatch(/Authorization: "Bearer " \+ token/);
    expect(src).toContain("CONFIRM_EMAIL_TEXT");                                   // an unconfirmed address is told to confirm, not shown data
  });
});

describe("the figures table", () => {
  it("shows every expected field, and an unrecorded one as 'missing' in the value and origin cells, never blank", () => {
    const out = html(React.createElement(InputsTable, { inputs: [input()] }));
    for (const f of EXPECTED_HALL_FIELDS) expect(out).toContain(f.path);
    const rows = out.split("<tr").slice(2);
    expect(rows.length).toBe(EXPECTED_HALL_FIELDS.length);
    const unrecorded = rows.find((r) => r.includes("grid.contracted_MW"))!;
    expect(unrecorded.match(/missing/g)!.length).toBeGreaterThanOrEqual(2);
    expect(unrecorded).toContain("none: nothing recorded");
    expect(unrecorded).not.toMatch(/<td[^>]*><\/td>/);                              // no empty cell
  });

  it("has the seven columns, headers with scope, and says the class and origin are declared", () => {
    const out = html(React.createElement(InputsTable, { inputs: [] }));
    for (const h of ["Field", "Value", "Origin", "Evidence class", "As of", "Source", "Recorded by"]) expect(out).toMatch(new RegExp(`<th scope="col"[^>]*>${h}</th>`));
    expect(out).toMatch(/<caption[^>]*>[^<]*declared by the person who recorded the figure, not verified/);
  });

  it("a recorded figure shows its origin, class, date, source file with its review state, and who recorded it", () => {
    const out = html(React.createElement(InputsTable, { inputs: [input({ origin: "measured", evidenceClass: "E5", source: { kind: "project_evidence", id: "e1", filename: "meter.pdf", reviewStatus: "unverified" } })] }));
    expect(out).toContain("40 MVA");
    expect(out).toContain("measured");
    expect(out).toContain("E5");
    expect(out).toContain("2026-01-15");
    expect(out).toContain("meter.pdf (file not yet reviewed)");
    expect(out).toContain("eng@acme.example");
  });

  it("an assumed figure is never described as measured, and a figure recorded as missing says missing", () => {
    const assumed = html(React.createElement(InputsTable, { inputs: [input()] }));
    const row = assumed.split("<tr").find((r) => r.includes("40 MVA"))!;
    expect(row).toContain("assumed");
    expect(row).not.toMatch(/measured|verified/i);
    const gap = html(React.createElement(InputsTable, { inputs: [input({ origin: "missing", value: null, evidenceClass: "E0" })] }));
    expect(gap.split("<tr").find((r) => r.includes("grid.firm_capacity_MVA"))).toContain(">missing<");
  });

  it("a recorded field outside the expected list is still listed", () => {
    const out = html(React.createElement(InputsTable, { inputs: [input({ fieldPath: "transformers[0].unit_rating_MVA" })] }));
    expect(out).toContain("transformers[0].unit_rating_MVA");
  });
});

describe("the forms are accessible and honest", () => {
  const forms: [string, React.ReactElement][] = [
    ["new site", React.createElement(NewSite, { org, onDone: noop })],
    ["new hall", React.createElement(NewHall, { site, onDone: noop })],
    ["record a figure", React.createElement(RecordInput, { hall, current: [input()], onDone: noop })],
  ];
  for (const [name, el] of forms) {
    it(`${name}: every control has a label for its id, and errors have a live region`, () => {
      const out = html(el);
      const controls = [...out.matchAll(/<(input|select)\b[^>]*>/g)].map((m) => m[0]);
      expect(controls.length).toBeGreaterThan(0);
      for (const tag of controls) {
        const id = /\bid="([^"]+)"/.exec(tag)?.[1];
        expect(id, tag).toBeTruthy();
        expect(out, id).toMatch(new RegExp(`<label[^>]*for="${id}"`));
      }
      expect(out).toMatch(/role="alert"/);
      expect(out).toMatch(/role="status"/);
      expect(out).toMatch(/<form[^>]*novalidate/i);
    });
  }
  it("the site form asks for the kind of data and does not pre-select one", () => {
    const out = html(React.createElement(NewSite, { org, onDone: noop }));
    expect(out).toContain("What kind of data does this site hold?");
    for (const k of ["production", "test", "synthetic"]) expect(out).toContain(`<option value="${k}">`);
    expect(out).not.toMatch(/<option value="(production|test|synthetic)" selected/);
    expect(out).toMatch(/aria-required="true"/);
  });
  it("recording over a field that has a value says it will replace it and keep the history", () => {
    const src = fs.readFileSync("components/SitesWorkspace.tsx", "utf8");
    expect(src).toContain("the earlier figure stays in the history");
    expect(src).toContain("supersedes: replaces?.id");
  });
  it("the source and class hints say what the database enforces", () => {
    const out = html(React.createElement(RecordInput, { hall, current: [], onDone: noop }));
    expect(out).toContain("Evidence class (your declaration)");
    expect(out).toContain("An assumed or modelled figure cannot claim a class above E3.");
    expect(out).toMatch(/<option value="E4" disabled="">/);          // the form does not even offer a class the database would refuse
    expect(fs.readFileSync("components/SitesWorkspace.tsx", "utf8")).toContain("Declared by you, not checked here.");
  });
});

describe("the wording", () => {
  const src = fs.readFileSync("components/SitesWorkspace.tsx", "utf8") + fs.readFileSync("app/account/sites/page.tsx", "utf8") + fs.readFileSync("lib/site-registry-fields.ts", "utf8");
  it("never uses the retired product name or claims verification of a figure", () => {
    expect(src).not.toMatch(/Verified Power Record/i);
    expect(src).not.toMatch(/\bverified (figure|record|capacity|hall)/i);
    expect(src).not.toMatch(/guarantee|certified|bankable/i);
  });
  it("says that origin and class are declarations", () => {
    expect(src).toContain("are that person&apos;s declaration; nothing on this page");
    expect(src).toContain("the file may not");
  });
});
