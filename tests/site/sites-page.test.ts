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
