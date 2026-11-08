import fs from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {}, replace: () => {} }), usePathname: () => "/account/sites" }));

import SitesPage, { metadata, dynamic } from "@/app/account/sites/page";
import { AddedNotice, FieldHistory, InputsTable, NewHall, NewSite, RecordInput, Timeline, originText, sourceText } from "@/components/SitesWorkspace";
import { EXPECTED_HALL_FIELDS } from "@/lib/site-registry-fields";
import SiteRegistryDiff from "@/components/SiteRegistryDiff";
import SiteRegistryExport from "@/components/SiteRegistryExport";
import SiteRegistryImport, { PreviewTable, ReportView } from "@/components/SiteRegistryImport";
import { buildPreview, type ImportReport } from "@/lib/site-registry-import";

// The page's structure and honesty, without a browser. The browser-level run (a production build, a real database, a verified session at 1440 and
// 390 px, the keyboard path and the console) is reported with the change; it is not re-run here.

const html = (el: React.ReactElement) => renderToStaticMarkup(el);
const noop = async () => {};
const hall = { id: "h1", siteId: "s1", label: "Hall 1" };
const site = { id: "s1", orgId: "o1", name: "North campus", country: "DE", dataOrigin: "synthetic" as const };
const org = { id: "o1", name: "Acme", role: "owner" as const };
const input = (over: Record<string, unknown> = {}) => ({
  id: "i1", fieldPath: "grid.firm_capacity_mva", value: 40, unit: "MVA", evidenceClass: "E1", origin: "assumed" as const, asOf: "2026-01-15", recordedBy: "eng@acme.example", source: null, ...over,
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
    const unrecorded = rows.find((r) => r.includes("grid.contracted_mw"))!;
    expect(unrecorded.match(/missing/g)!.length).toBeGreaterThanOrEqual(2);
    expect(unrecorded).toContain("none: nothing recorded");
    expect(unrecorded).not.toMatch(/<td[^>]*><\/td>/);                              // no empty cell
  });

  it("has the seven columns, headers with scope, and says the class and origin are declared", () => {
    const out = html(React.createElement(InputsTable, { inputs: [] }));
    for (const h of ["Field", "Value", "Origin", "Declared class", "As of", "Source", "Recorded by"]) expect(out).toMatch(new RegExp(`<th scope="col"[^>]*>${h}</th>`));
    expect(out).toMatch(/<caption[^>]*>[^<]*declared by the person who recorded the figure, not verified/);
  });

  it("a recorded figure shows its origin, class, date, source file with its review state, and who recorded it", () => {
    const out = html(React.createElement(InputsTable, { inputs: [input({ origin: "measured", evidenceClass: "E5", source: { kind: "project_evidence", id: "e1", filename: "meter.pdf", reviewStatus: "unverified" } })] }));
    expect(out).toContain("40 MVA");
    expect(out).toContain("declared measured");
    expect(out).toContain("E5");
    expect(out).toContain("2026-01-15");
    expect(out).toContain("meter.pdf (file not yet reviewed)");
    expect(out).toContain("eng@acme.example");
  });

  it("an assumed figure is never described as measured, and a figure recorded as missing says missing", () => {
    const assumed = html(React.createElement(InputsTable, { inputs: [input()] }));
    const row = assumed.split("<tr").find((r) => r.includes("40 MVA"))!;
    expect(row).toContain("declared assumed");
    expect(row).not.toMatch(/measured|verified/i);
    const gap = html(React.createElement(InputsTable, { inputs: [input({ origin: "missing", value: null, evidenceClass: "E0" })] }));
    expect(gap.split("<tr").find((r) => r.includes("grid.firm_capacity_mva"))).toContain(">missing<");
  });

  it("a recorded field outside the expected list is still listed", () => {
    const out = html(React.createElement(InputsTable, { inputs: [input({ fieldPath: "transformers[0].unit_rating_mva" })] }));
    expect(out).toContain("transformers[0].unit_rating_mva");
  });
});

describe("the forms are accessible and honest", () => {
  const forms: [string, React.ReactElement][] = [
    ["new site", React.createElement(NewSite, { org, onCreated: () => {} })],
    ["new hall", React.createElement(NewHall, { site, onCreated: () => {} })],
    ["record a figure", React.createElement(RecordInput, { hall, current: [input()], onRecorded: () => {} })],
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
    const out = html(React.createElement(NewSite, { org, onCreated: () => {} }));
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
    const out = html(React.createElement(RecordInput, { hall, current: [], onRecorded: () => {} }));
    expect(out).toContain("Declared evidence class (your declaration)");
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


describe("labels say what a figure is: declared, and how reviewable its source is", () => {
  it("the Origin cell prints declared <origin> for every origin but missing", () => {
    for (const o of ["measured", "observed", "vendor", "quotation", "modelled", "assumed"] as const) expect(originText(o)).toBe(`declared ${o}`);
    expect(originText("missing")).toBe("missing");
    const out = html(React.createElement(InputsTable, { inputs: [input({ origin: "observed", evidenceClass: "E3", source: { kind: "project_evidence", id: "e", filename: "a.pdf", reviewStatus: "verified" } })] }));
    expect(out).toContain("declared observed");
  });
  it("a purchased engagement's file reads 'not reviewable', never 'no review status'; a project file shows its live status", () => {
    const src = (kind: string, reviewStatus: string | null) => ({ kind, id: "x", filename: "f.pdf", reviewStatus });
    expect(sourceText(input({ source: src("intake_evidence", null) }))).toBe("f.pdf (file not reviewable)");
    expect(sourceText(input({ source: src("project_evidence", "unverified") }))).toBe("f.pdf (file not yet reviewed)");
    expect(sourceText(input({ source: src("project_evidence", "verified") }))).toBe("f.pdf (file reviewed and verified)");
    expect(sourceText(input({ source: src("project_evidence", "rejected") }))).toBe("f.pdf (file rejected)");
    expect(fs.readFileSync("components/SitesWorkspace.tsx", "utf8")).not.toContain("no review status");
  });
  it("the word class is always preceded by declared wherever a class is shown", () => {
    const src = fs.readFileSync("components/SitesWorkspace.tsx", "utf8");
    expect(src).not.toMatch(/>Evidence class</);
    expect(src).toContain("declared class ${e.evidenceClass}");
    expect(src).toContain("declared class {i.evidenceClass}");
  });
});

describe("the timeline says when older events are not shown and offers them", () => {
  const ev = [{ occurredAt: "2026-01-02T00:00:00Z", kind: "project_event", summary: "Project: x", origin: "recorded", evidenceClass: null, basis: "log entry", superseded: false }];
  it("without more pages there is no notice and no control", () => {
    const out = html(React.createElement(Timeline, { events: ev, more: false }));
    expect(out).not.toContain("Older events are not shown");
    expect(out).not.toContain("Load older events");
  });
  it("with more pages it says so, in words tied to the control, and the control is a keyboard-reachable button", () => {
    const out = html(React.createElement(Timeline, { events: ev, more: true, onOlder: () => {}, older: { busy: false, error: null } }));
    expect(out).toContain("Older events are not shown. This is the newest 1.");
    expect(out).toMatch(/<button[^>]*aria-describedby="older-note"[^>]*>Load older events<\/button>/);
    expect(out).toMatch(/role="alert"/);
  });
  it("the page wires the control to the cursor the server gave, untouched", () => {
    const src = fs.readFileSync("components/SitesWorkspace.tsx", "utf8");
    expect(src).toContain("&cursor=${encodeURIComponent(nextCursor)}");
    expect(src).toContain("nextCursor");
    expect(src).not.toMatch(/new Date\(nextCursor/);
  });
});

describe("history, leaving, and the requests a page makes", () => {
  it("each recorded field has a History control, and the history is read with ?history=1&field=", () => {
    const out = html(React.createElement(InputsTable, { inputs: [input()], onHistory: () => {} }));
    expect(out).toContain('aria-label="History of grid.firm_capacity_mva"');
    expect(out.match(/>History</g)).toHaveLength(1);                                  // only the field that has a figure
    const src = fs.readFileSync("components/SitesWorkspace.tsx", "utf8");
    expect(src).toContain("/inputs?history=1&field=${encodeURIComponent(path)}");
    const h = html(React.createElement(FieldHistory, { hall, path: "grid.firm_capacity_mva", onClose: () => {} }));
    expect(h).toContain('aria-labelledby="history-title"');
  });
  it("a membership someone else created is announced with who added you and a Leave control", () => {
    const out = html(React.createElement(AddedNotice, { org: { ...org, role: "viewer", addedBy: "boss@acme.example", addedAt: "2026-03-01T00:00:00Z", memberId: "m1" }, onLeave: async () => null }));
    expect(out).toContain("Added by");
    expect(out).toContain("boss@acme.example");
    expect(out).toContain("You did not have to accept");
    expect(out).toContain("Leave Acme");
    expect(out).toMatch(/role="alert"/);
    const src = fs.readFileSync("components/SitesWorkspace.tsx", "utf8");
    expect(src).toContain("/members?id=${org.memberId}");
  });
  it("the page loads with two requests and no per-site request", () => {
    const src = fs.readFileSync("components/SitesWorkspace.tsx", "utf8");
    const load = src.slice(src.indexOf("const load = useCallback"), src.indexOf("useEffect(() => {\n    if (!mayHaveSession())"));
    expect(load.match(/api\(/g)).toHaveLength(2);
    expect(load).not.toMatch(/\/halls/);
    expect(load).not.toMatch(/map\(async/);
  });
  it("the field's unit survives a recorded figure and the field is matched case-insensitively, so a correction does not lose its unit", () => {
    const src = fs.readFileSync("components/SitesWorkspace.tsx", "utf8");
    expect(src).toContain('setValue(""); setSrcId(""); setSrcKind("none");          // the field and its unit stay');
    expect(src).toContain("path.trim().toLowerCase()");
    expect(src).toContain("const p = next.trim().toLowerCase();");
  });
  it("a write updates local state from its own answer instead of reloading everything", () => {
    const src = fs.readFileSync("components/SitesWorkspace.tsx", "utf8");
    expect(src).not.toMatch(/onDone=\{load\}/);
    expect(src).toContain("onCreated={addedSite}");
    expect(src).toContain("onRecorded={recorded}");
  });
});


describe("export, import and what-changed in a hall", () => {
  const api = async () => ({ status: 200, body: {} });
  const panels: [string, React.ReactElement][] = [
    ["export", React.createElement(SiteRegistryExport, { hall, api })],
    ["import", React.createElement(SiteRegistryImport, { hall, api, onWritten: () => {} })],
    ["what changed", React.createElement(SiteRegistryDiff, { hall, api, current: [input()], refreshKey: 0 })],
  ];
  for (const [name, el] of panels) {
    it(`${name}: a labelled section, every control labelled for its id, buttons are real buttons`, () => {
      const out = html(el);
      expect(out).toMatch(/<section[^>]*aria-labelledby="[a-z-]+-title"/);
      for (const tag of [...out.matchAll(/<(input|select)\b[^>]*>/g)].map((m) => m[0])) {
        const id = /\bid="([^"]+)"/.exec(tag)?.[1];
        expect(id, tag).toBeTruthy();
        expect(out, id).toMatch(new RegExp(`<label[^>]*for="${id}"`));
      }
      expect(out).not.toMatch(/<(div|span)[^>]*onclick/i);
    });
  }
  it("export: three downloads, the declaration is on the page, nothing is promised that the file lacks, and any member may use it", () => {
    const out = html(panels[0]![1]);
    for (const b of ["Download JSON (figures and timeline)", "Download CSV: current figures", "Download CSV: timeline"]) expect(out).toContain(b);
    expect(out).toContain("declaration of the person who recorded each figure");
    expect(out).toContain("It holds no file contents, storage locations or link tokens.");
    expect(out).toMatch(/role="alert"/);
    expect(out).toMatch(/role="status"/);
    const src = fs.readFileSync("components/SitesWorkspace.tsx", "utf8");
    expect(src).toMatch(/\{inputs && <SiteRegistryExport /);                            // not behind canWrite: a viewer can read, so a viewer can export
    expect(src).toMatch(/\{inputs && canWrite && <SiteRegistryImport /);                // writing is for editors and owners
  });
  it("import: a labelled file input with its hint, both templates, the limits, and the promise that nothing is written before the preview is confirmed", () => {
    const out = html(panels[1]![1]);
    expect(out).toContain("File to import (CSV or JSON)");
    expect(out).toMatch(/<input id="import-file"[^>]*type="file"[^>]*accept="\.csv,\.json,text\/csv,application\/json"/);
    expect(out).toMatch(/aria-describedby="import-file-hint"/);
    expect(out).toContain("Download CSV template");
    expect(out).toContain("Download JSON template");
    expect(out).toContain("up to 200 rows and 256 KB");
    expect(out).toContain("it writes nothing");
    expect(out).toContain("never changed to fit");
    expect(out).toContain("nothing here checks them against the real hall");
    expect(out).not.toContain("import-confirm");                                      // no confirm control until there is a preview
    expect(out).not.toMatch(/Write \d+ figure/);
  });
  it("import: the confirm is explicit (a button, disabled until the replacements are acknowledged), rows are sent one at a time, text is never injected as HTML", () => {
    const src = fs.readFileSync("components/SiteRegistryImport.tsx", "utf8");
    expect(src).toContain("disabled={!canConfirm}");
    expect(src).toContain("(c.supersede === 0 || okReplace)");
    expect(src).toContain("I understand that");
    expect(src).toContain("await runImport(");
    expect(src).not.toMatch(/Promise\.all|dangerouslySetInnerHTML|innerHTML|eval\(/);
    expect(src).toContain("tabIndex={-1}");                                            // the preview and the report take focus
    expect(src).toMatch(/role="alert"/);
    expect(src).toContain("beforeunload");                                           // leaving mid-run is confirmed
  });
  it("what changed: closed until asked for, says it compares recorded claims (not a recalculated capacity) and that file status is the live one", () => {
    const out = html(panels[2]![1]);
    expect(out).toContain("Show what changed");
    expect(out).toMatch(/aria-expanded="false"/);
    expect(out).toContain("It is not a recalculated capacity result.");
    expect(out).toContain("its status now");
    expect(out).not.toMatch(/improv|better|saving/i);
  });
  it("the wording of the new panels never claims verification of a figure", () => {
    const text = ["SiteRegistryExport", "SiteRegistryImport", "SiteRegistryDiff"].map((n) => fs.readFileSync(`components/${n}.tsx`, "utf8")).join("\n")
      + ["site-registry-export", "site-registry-import", "site-registry-diff"].map((n) => fs.readFileSync(`lib/${n}.ts`, "utf8")).join("\n");
    expect(text).not.toMatch(/Verified Power Record/i);
    expect(text).not.toMatch(/\bverified (figure|record|capacity|hall)/i);
    expect(text).not.toMatch(/guarantee|certified|bankable/i);
  });
  it("the sign-in token still goes with every request, and the allowance's Retry-After is read from the response", () => {
    const src = fs.readFileSync("components/SitesWorkspace.tsx", "utf8");
    expect(src).toMatch(/Authorization: "Bearer " \+ token/);
    expect(src).toContain('res.headers.get("Retry-After")');
  });
});


describe("rework: the preview, the report and the run are keyboard- and screen-reader-safe and honest", () => {
  const preview = buildPreview([
    { n: 1, fromCsv: false, cells: { field_path: "grid.firm_capacity_mva", value: 44, unit: "MVA", origin: "measured", class: "E5", as_of: "2026-10-01", source_kind: "project", source_id: "11111111-1111-4111-8111-111111111111" } },
    { n: 2, fromCsv: false, cells: { field_path: "nope", value: 1, origin: "assumed", class: "E0", as_of: "2026-10-01" } },
  ], { current: [input()], today: "2026-11-07" }, 2);

  it("the preview table sits in a focusable, named region (a sideways-scrolling area must be reachable by keyboard)", () => {
    const out = html(React.createElement(PreviewTable, { rows: preview.rows }));
    expect(out).toMatch(/<div[^>]*role="region"[^>]*aria-labelledby="import-preview-title"[^>]*tabindex="0"[^>]*>\s*<table/);
    expect(out).toContain('data-status="supersede"');
    expect(out).toContain('data-status="rejected"');
  });
  it("a replacement that raises the class and changes the origin says so in its row, in its own list", () => {
    const out = html(React.createElement(PreviewTable, { rows: preview.rows }));
    expect(out).toContain('aria-label="Provenance changes"');
    expect(out).toContain("Raises the declared class E1 → E5.");
    expect(out).toContain("Changes the declared origin: declared assumed → declared measured.");
  });
  it("the confirm needs the generic acknowledgement AND the provenance one; the second is worded for what it covers", () => {
    const src = fs.readFileSync("components/SiteRegistryImport.tsx", "utf8");
    expect(src).toContain("(c.supersede === 0 || okReplace) && (c.flagged === 0 || okFlagged)");
    expect(src).toContain('id="import-confirm-flagged"');
    expect(src).toContain("raise the declared class, change the origin or withdraw a figure");
    expect(preview.counts.flagged).toBe(1);
  });
  it("the summary says how many comment lines were skipped", () => {
    const src = fs.readFileSync("components/SiteRegistryImport.tsx", "utf8");
    expect(src).toContain("comment line");
    expect(src).toContain("(starting with #) skipped");
    expect(preview.commentLines).toBe(2);
  });
  it("a run started from the keyboard moves focus to Stop; progress is announced every ten rows, not per row, in a stable live region", () => {
    const src = fs.readFileSync("components/SiteRegistryImport.tsx", "utf8");
    expect(src).toContain("if (running) stopButton.current?.focus()");
    expect(src).toContain('ref={stopButton}');
    expect(src).toContain("p.done % 10 === 0");
    expect(src).toMatch(/<p role="status" id="import-announce" className="sr-only">\{announce\}<\/p>/);
    expect(src).not.toMatch(/<p role="status"[^>]*id="import-progress"/);                   // the per-row text is not a live region
    const out = html(React.createElement(SiteRegistryImport, { hall, api: async () => ({ status: 200, body: {} }), onWritten: () => {} }));
    expect(out).toContain('id="import-announce"');                                         // mounted from the start, so a change is announced
  });
  it("hall, site and organisation navigation is paused while an import runs, with a visible reason", () => {
    const src = fs.readFileSync("components/SitesWorkspace.tsx", "utf8");
    expect(src).toContain("disabled={locked && hallId !== h.id}");
    expect(src).toContain("onImportRunning={setLocked}");
    expect(src).toContain("onRunning={onImportRunning}");
    expect(src).toContain("are paused until it finishes or you stop it");
    const imp = fs.readFileSync("components/SiteRegistryImport.tsx", "utf8");
    expect(imp).toContain("onRunning?.(running)");
    expect(imp).toContain("return () => onRunning?.(false)");                              // a stuck lock is impossible
    const locked = html(React.createElement(AddedNotice, { org: { ...org, role: "viewer", addedBy: "boss@acme.example", memberId: "m1" }, onLeave: async () => null, locked: true }));
    expect(locked).toMatch(/<button[^>]*disabled=""[^>]*>Leave Acme/);
    const free = html(React.createElement(AddedNotice, { org: { ...org, role: "viewer", addedBy: "boss@acme.example", memberId: "m1" }, onLeave: async () => null }));
    expect(free).not.toMatch(/<button[^>]*disabled=""[^>]*>Leave Acme/);
  });
  it("an unknown result is worded as unknown, never as 'NOT written', and the re-read is reported", () => {
    const report: ImportReport = {
      outcome: "stopped", written: [{ n: 1, fieldPath: "grid.f1", id: "x", input: null }], notAttempted: [{ n: 3, fieldPath: "grid.f3" }],
      failed: { n: 2, fieldPath: "grid.f2", status: 503, outcomeUnknown: true, message: "The result of this row is unknown — reload and check the hall's figures before importing again. (The server answered 503.)" },
      afterStop: { read: true, landed: [2], absent: [3], current: [] },
    };
    const out = html(React.createElement(ReportView, { report, headRef: { current: null }, hallLabel: "Hall 1" }));
    expect(out).toContain("The result of this row is unknown");
    expect(out).not.toMatch(/was NOT written|Nothing was changed/);
    expect(out).toContain("Rows 2 ARE in the hall");
    expect(out).toContain("Rows 3 are not in the hall");
    const refused = html(React.createElement(ReportView, { report: { ...report, failed: { ...report.failed!, outcomeUnknown: false, status: 400, message: "No." }, afterStop: { read: false, landed: [], absent: [], current: null } }, headRef: { current: null }, hallLabel: "Hall 1" }));
    expect(refused).toContain("was NOT written: No.");
    expect(refused).toContain("could not be read again after the stop");
  });
  it("a stopped import hands the re-read figures back so the table is not stale; the diff drops its old result when a refresh fails", () => {
    const ws = fs.readFileSync("components/SitesWorkspace.tsx", "utf8");
    expect(ws).toContain("onSynced={synced}");
    const imp = fs.readFileSync("components/SiteRegistryImport.tsx", "utf8");
    expect(imp).toContain("if (result.afterStop?.current) onSynced?.(result.afterStop.current)");
    const diff = fs.readFileSync("components/SiteRegistryDiff.tsx", "utf8");
    expect(diff.match(/setHistory\(null\); setError\(/g)).toHaveLength(2);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// The engine-backed capacity diff: the panel above the field-by-field diff, and "Run the engine on this preview" in the import. The browser-level run is
// tests/e2e/sites-journey.mjs; what can be pinned without a browser is pinned here.

import EngineDiffRun, { EngineResult, MissingList, type EngineAnswer } from "@/components/SiteRegistryEngineDiff";
import { ENGINE_DIFF_LABEL } from "@/lib/site-registry-engine";

describe("the engine capacity-envelope diff panel", () => {
  const api = async () => ({ status: 200, body: {} });
  const idle = (over: Record<string, unknown> = {}) => html(React.createElement(EngineDiffRun, { api, hallId: "h1", from: { asOf: "2026-01-10" }, to: { now: true }, enabled: true, ...over } as never));

  it("is titled, says what it is and is not, and states the cost and the allowance BEFORE the button that spends them", () => {
    const out = idle();
    expect(out).toContain("Engine capacity-envelope diff");
    expect(out).toContain("Modelled by the engine from the figures as recorded; origin and class are the recorder&#x27;s declaration. Not a measurement.");
    expect(ENGINE_DIFF_LABEL).toBe("Modelled by the engine from the figures as recorded; origin and class are the recorder's declaration. Not a measurement.");
    expect(out).toContain("Counts as 1 of your 3 engine runs this hour (and 10 today); the run is not billed to you.");
    expect(out).not.toMatch(/units?\b/i);                                                                   // the operator's cost is not a member's concern, and is never shown as theirs
    expect(out.indexOf("Run the engine")).toBeLessThan(out.indexOf("Counts as 1 of your"));        // the button is the first thing; the cost is its description
    expect(out).toMatch(/<button[^>]*id="engine-diff-run"[^>]*aria-describedby="engine-diff-cost"/);
    expect(out).not.toContain('data-testid="engine-result"');                                                 // nothing is run, and nothing is shown, until it is asked for
  });

  it("is asked on a click only: the request is made from the click handler and from nowhere else", () => {
    const src = fs.readFileSync("components/SiteRegistryEngineDiff.tsx", "utf8");
    expect(src.match(/\{ method: "POST"/g)).toHaveLength(1);                                                        // the one POST; the other /diff request is the GET that asks whether it is switched on
    expect(src).toContain("onClick={() => void run()}");
    expect(src.match(/(?<!function )\brun\(\)/g)).toHaveLength(1);                                                  // the one call is the click handler's
    expect(src).toMatch(/if \(!from \|\| !to \|\| reason\) return;/);
    const diff = fs.readFileSync("components/SiteRegistryDiff.tsx", "utf8");
    expect(diff).not.toMatch(/\/diff`/);                                                                      // the page component never calls it itself
  });

  it("sits ABOVE the field-by-field provenance diff, inside the opened panel", () => {
    const diff = fs.readFileSync("components/SiteRegistryDiff.tsx", "utf8");
    expect(diff.indexOf("<EngineDiffRun")).toBeGreaterThan(0);
    expect(diff.indexOf("<EngineDiffRun")).toBeLessThan(diff.indexOf("<DiffView diff={result.diff} />"));
    expect(html(React.createElement(SiteRegistryDiff, { hall, api: noopApi, current: [input()], refreshKey: 0 }))).not.toContain("Engine capacity-envelope diff");   // closed: nothing of it
  });

  it("is disabled, with the reason beside it, when there is no hall to read (the start of the record), or no pair of points", () => {
    const none = idle({ from: null, blocked: "Choose a day on which something was recorded as the earlier point." });
    expect(none).toMatch(/<button[^>]*id="engine-diff-run"[^>]*disabled=""/);
    expect(none).toContain("Choose a day on which something was recorded as the earlier point.");
    expect(idle({ from: null })).toContain("Choose two points first.");
    expect(idle()).not.toMatch(/<button[^>]*id="engine-diff-run"[^>]*disabled=""/);
  });

  const answer = (over: Partial<EngineAnswer> = {}): EngineAnswer => ({
    ok: true, ran: true, hall: { id: "h1", label: "Hall 1" }, from: { kind: "asOf", asOf: "2026-01-10", label: "the record at the end of 2026-01-10 (UTC)" }, to: { kind: "now", asOf: "2026-11-08", label: "the figures now" },
    label: ENGINE_DIFF_LABEL, historyTruncated: false, missing: [], classNotes: [{ path: "grid.firm_capacity_mva", side: "to", declared: "E5", sent: "E3", why: "The file it cites is not reviewed and verified now, so it is carried at E3 at most." }],
    placeholders: [{ path: "economics.electricity_eur_per_mwh", label: "All-in grid electricity price", fallback: "library placeholder of 140 EUR/MWh (E0)", sides: ["from", "to"] }], notUsed: [{ path: "grid.queue_position", reason: "The engine's intake has no such input, so it takes no part in the run.", sides: ["to"] }],
    ceiling: { cls: "E1", paths: ["hall.rack_positions"] }, classChanges: [], engine: { version: "0.9.0", digest: "ab".repeat(32) }, carriedBy: "E0",
    diff: {
      summary: "Lowers the rack count by 19 (from 28 to 9); what binds first holds (Rack feed / tap-off rating); time to full capacity: +8 wk (assumed lead time, not a date (E0; set by transformer capacity)).", material: true, racksDelta: -19, explainedRacks: -19, unexplainedRacks: 0,
      before: { racksAsFound: 0, racksAfterLadder: 28, bindingName: "Rack feed / tap-off rating", bindingBasis: "platform needs 205 A per rack; tap-offs rated 63 A (E3)", scenario: "Full DLC, grid only" },
      after: { racksAsFound: 0, racksAfterLadder: 9, bindingName: "Rack feed / tap-off rating", bindingBasis: "platform needs 205 A per rack; tap-offs rated 63 A (E3)", scenario: "Full DLC, grid only" },
      bindingMoved: false, racksClass: "E0", inputs: "changed", notAttributed: [],
      drivers: [{ path: "grid.contracted_mw", enginePath: "grid.contracted_MW", label: "Contracted capacity", before: 12, after: 9, direction: "lowers", racksDelta: -19, flipsBindingTo: null, racksClass: "E0" }],
      weeks: { delta: 8, basis: "assumed", evidenceClass: "E0", bindingItem: "Transformer capacity", label: "assumed lead time, not a date (E0; set by transformer capacity)" },
    },
    ...over,
  });

  it("shows the headline, the rack delta as 'raises/lowers by N' with the class that carries it, explained and unexplained, the drivers table, binding, and the weeks with what they rest on", () => {
    const out = html(React.createElement(EngineResult, { a: answer() }));
    expect(out).toContain("In short: ");
    expect(out).toContain("Lowers the rack count by 19 (from 28 to 9); what binds first holds (Rack feed / tap-off rating); time to full capacity: +8 wk");
    expect(out).not.toContain("The engine&#x27;s headline");
    expect(out).toContain("Lowers the rack count by 19 (from 28 to 9), carried by class E0.");
    expect(out).toContain("explains -19 racks; +0 racks are not explained by any one input");
    expect(out).toMatch(/<th scope="col"[^>]*>Recorded input<\/th>/);
    expect(out).toContain("grid.contracted_mw");
    expect(out).toContain("Contracted capacity");
    expect(out).toContain("Lowers by 19");
    expect(out).toContain("What binds first: Rack feed / tap-off rating");
    expect(out).toContain("it holds");
    expect(out).toContain("Time to full capacity: +8 wk (assumed lead time, not a date (E0; set by transformer capacity)).");
    expect(out).toContain("held to E1 because this recorded figure carries no class in the engine: hall.rack_positions");
    expect(out).toContain("Engine 0.9.0");
    expect(out).toContain(">abababababab<");
    expect(out).not.toMatch(/units used|capex/i);
    expect(out).toContain("Modelled by the engine from the figures as recorded");
    expect(out).toMatch(/role="region"[^>]*aria-label="Which recorded inputs moved the rack count"[^>]*tabindex="0"/);          // the table scrolls sideways at 390 px: reachable by keyboard
  });

  it("a rise is 'raises', no movement is 'does not change', and nothing is ever called an improvement or a saving", () => {
    const up = answer(); up.diff = { ...up.diff!, racksDelta: 4, before: { ...up.diff!.before, racksAfterLadder: 20 }, after: { ...up.diff!.after, racksAfterLadder: 24 }, drivers: [{ ...up.diff!.drivers[0]!, direction: "raises", racksDelta: 4 }] };
    const out = html(React.createElement(EngineResult, { a: up }));
    expect(out).toContain("Raises the rack count by 4 (from 20 to 24), carried by class E0.");
    expect(out).toContain("Raises by 4");
    const flat = answer(); flat.diff = { ...flat.diff!, racksDelta: 0, drivers: [], weeks: { delta: null, basis: "none", evidenceClass: null, bindingItem: null, label: "no date: nothing is deployable or a lead time on the path is missing" } };
    const o2 = html(React.createElement(EngineResult, { a: flat }));
    expect(o2).toContain("Does not change the rack count (9)");
    expect(o2).toContain("The engine attributes the movement to no recorded input.");
    expect(o2).toContain("Time to full capacity: no date: nothing is deployable or a lead time on the path is missing.");
    for (const text of [out, o2]) expect(text).not.toMatch(/improv|better|worse|\bgain|saving/i);
    const src = fs.readFileSync("components/SiteRegistryEngineDiff.tsx", "utf8") + fs.readFileSync("lib/site-registry-engine.ts", "utf8");
    expect(src).not.toMatch(/improv|better|worse|\bgain|saving|guarantee|certified|bankable/i);
    expect(src).not.toMatch(/\bverified (figure|record|capacity|hall)/i);
  });

  it("says which figures were sent below their declared class, which the engine filled from its library, and which recorded fields took no part", () => {
    const out = html(React.createElement(EngineResult, { a: answer() }));
    expect(out).toContain("Figures sent at a lower class than declared (1)");
    expect(out).toContain("grid.firm_capacity_mva (later point): declared E5, sent as E3.");
    expect(out).toContain("Not recorded: the engine used its own placeholder for 1 input");
    expect(out).toContain("library placeholder of 140 EUR/MWh (E0)");
    expect(out).toContain("Recorded but not used (1)");
    expect(out).toContain("behind-the-meter options and the scenario set are not recorded figures");
  });

  it("when figures are missing it names each, with its reason, the points it is needed at, and a one-click action to record it (or the import)", () => {
    const missing = [
      { path: "compute.platform", label: "Target platform", unit: "", sides: ["from", "to"] as ("from" | "to")[], reason: "It is not recorded.", need: "engine_required" as const, inTemplate: false },
      { path: "hall.rack_positions", label: "Rack positions (total)", unit: "", sides: ["to"] as ("from" | "to")[], reason: "It is recorded as missing.", need: "no_gap_default" as const, inTemplate: true },
    ];
    const out = html(React.createElement(MissingList, { missing, canRecord: true, canImport: true, onJump: () => {}, onImport: () => {} }));
    expect(out).toContain("compute.platform");
    expect(out).toContain("Target platform");
    expect(out).toContain("Needed at both points.");
    expect(out).toContain("Needed at the later point.");
    expect(out).toContain("The engine&#x27;s intake requires it.");
    expect(out).toContain("without listing it as a gap");
    expect(out.match(/Record this figure/g)).toHaveLength(2);
    expect(out).toContain('aria-label="Record compute.platform"');
    expect(out).toContain("Go to the import and its template");
    const viewer = html(React.createElement(MissingList, { missing, canRecord: false, canImport: false, onJump: () => {}, onImport: () => {} }));
    expect(viewer).not.toContain("Record this figure");
    expect(viewer).toContain("ask an owner or an editor to record it");
    expect(viewer).not.toContain("Go to the import");
  });

  it("the import preview offers 'Run the engine on this preview' with the same cost line, only when there is a preview, sending the rows the preview did not reject", () => {
    const src = fs.readFileSync("components/SiteRegistryImport.tsx", "utf8");
    expect(src).toContain('buttonLabel="Run the engine on this preview"');
    expect(src).toContain("to={proposed}");
    expect(src).toContain('p.status === "rejected"');
    expect(src.indexOf("<EngineDiffRun")).toBeGreaterThan(src.indexOf("<PreviewTable rows={preview.rows} />"));
    expect(src.indexOf("<EngineDiffRun")).toBeLessThan(src.indexOf('id="import-confirm-replace"'));
    const empty = html(React.createElement(SiteRegistryImport, { hall, api: async () => ({ status: 200, body: {} }), onWritten: () => {} }));
    expect(empty).not.toContain("Run the engine on this preview");
    const out = html(React.createElement(EngineDiffRun, { api, hallId: "h1", from: { now: true }, to: { proposed: [{ n: 1, fromCsv: false, cells: { field_path: "grid.contracted_mw" } }] }, idPrefix: "engine-import", title: "What the engine makes of this preview", buttonLabel: "Run the engine on this preview" }));
    expect(out).toContain("Run the engine on this preview");
    expect(out).toContain("Counts as 1 of your 3 engine runs this hour (and 10 today)");
  });
});

describe("the engine diff is off unless the deployment switches it on", () => {
  const api = async () => ({ status: 200, body: {} });
  it("when it is not switched on the panel says so INSTEAD of the Run button, and the cost line is gone", () => {
    const out = html(React.createElement(EngineDiffRun, { api, hallId: "h1", from: { asOf: "2026-01-10" }, to: { now: true }, enabled: false } as never));
    expect(out).toContain("The engine diff is not switched on for this deployment.");
    expect(out).toContain("Nothing is run and nothing is charged.");
    expect(out).not.toContain("engine-diff-run");
    expect(out).not.toContain("Counts as 1 of your");
  });
  it("until the server has said, the button is not offered (it is disabled), and a probe that fails leaves the route to answer for itself", () => {
    const pending = html(React.createElement(EngineDiffRun, { api, hallId: "h1", from: { asOf: "2026-01-10" }, to: { now: true } } as never));
    expect(pending).toMatch(/<button[^>]*id="engine-diff-run"[^>]*disabled=""/);
    const src = fs.readFileSync("components/SiteRegistryEngineDiff.tsx", "utf8");
    expect(src).toContain("r.body.enabled === false ? false : true");
    expect(src).toContain('r.body?.reason === "feature_off"');
  });
});

const noopApi = async () => ({ status: 200, body: {} });
