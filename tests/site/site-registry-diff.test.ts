import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  NOW_POINT, START_POINT, aspectsBetween, buildChains, cautions, diffPoints, evidenceLine, evidenceShift, pointsOf, stateAt, successions, type Point,
} from "@/lib/site-registry-diff";
import { DiffView, FILE_STATUS_NOTE, StepsView } from "@/components/SiteRegistryDiff";
import type { RegistryInput } from "@/lib/site-registry-model";

// "What changed": which kinds of change are found between two points, that a change never appears without the evidence it rests on, and the limits of a partial history.

let seq = 0;
const claim = (over: Partial<RegistryInput> & { id: string; day: string }): RegistryInput => {
  const { day, ...rest } = over;
  return {
    fieldPath: "grid.firm_capacity_mva", value: 40, unit: "MVA", evidenceClass: "E0", origin: "assumed", asOf: "2026-01-01", recordedBy: "eng@acme.example",
    recordedAt: `${day}T10:00:${String(seq++ % 60).padStart(2, "0")}.000000+00:00`, supersedesId: null, superseded: false, source: null, ...rest,
  } as RegistryInput;
};
const verified = { kind: "project_evidence", id: "e1", filename: "meter.pdf", reviewStatus: "verified" };

// firm capacity: assumed 40 E0 (Jan 10) -> measured 42 E5 with a verified file (Feb 10).  contracted: first recorded Feb 10.  peak: 10 (Jan 10), then withdrawn as missing (Feb 10).  rack: unchanged since Jan 10.
const A1 = claim({ id: "a1", day: "2026-01-10" });
const A2 = claim({ id: "a2", day: "2026-02-10", value: 42, origin: "measured", evidenceClass: "E5", source: verified, supersedesId: "a1" });
const B1 = claim({ id: "b1", day: "2026-02-10", fieldPath: "grid.contracted_mw", value: 30, unit: "MW", evidenceClass: "E1" });
const C1 = claim({ id: "c1", day: "2026-01-10", fieldPath: "grid.current_site_peak_mw", value: 10, unit: "MW" });
const C2 = claim({ id: "c2", day: "2026-02-10", fieldPath: "grid.current_site_peak_mw", value: null, unit: null, origin: "missing", supersedesId: "c1" });
const D1 = claim({ id: "d1", day: "2026-01-10", fieldPath: "hall.rack_positions", value: 200, unit: null });
const ALL = [A2, A1, B1, C2, C1, D1];                                  // newest first within the history, as the API gives it

const pt = (id: string): Point => pointsOf(ALL).find((p) => p.id === id)!;

describe("chains and points", () => {
  it("groups claims by field and orders each oldest to newest by following the supersedes links", () => {
    const chains = buildChains([A2, A1, C2, C1, D1]);
    expect(chains.get("grid.firm_capacity_mva")!.claims.map((c) => c.id)).toEqual(["a1", "a2"]);
    expect(chains.get("grid.current_site_peak_mw")!.claims.map((c) => c.id)).toEqual(["c1", "c2"]);
    expect([...chains.values()].every((c) => c.complete)).toBe(true);
  });
  it("a claim given twice (in the history and among the current figures) counts once", () => {
    expect(buildChains([A1, A2, A2, A1]).get("grid.firm_capacity_mva")!.claims).toHaveLength(2);
  });
  it("a chain whose first claim is not loaded is marked incomplete", () => {
    expect(buildChains([A2]).get("grid.firm_capacity_mva")!.complete).toBe(false);
  });
  it("the points are now, the end of each day something was recorded (newest first), and the start", () => {
    expect(pointsOf(ALL).map((p) => p.id)).toEqual(["now", "2026-02-10", "2026-01-10", "start"]);
    expect(pt("2026-02-10").at).toBe(Date.parse("2026-02-10T23:59:59.999Z"));
    expect(NOW_POINT.at).toBeNull();
    expect(START_POINT.at).toBe(Number.NEGATIVE_INFINITY);
  });
  it("a field's state at a point is the latest claim recorded by then; before its first claim it is none (complete) or unknown (incomplete)", () => {
    const full = buildChains(ALL).get("grid.firm_capacity_mva")!;
    expect(stateAt(full, pt("2026-01-10").at)).toMatchObject({ kind: "claim", claim: { id: "a1" } });
    expect(stateAt(full, pt("2026-02-10").at)).toMatchObject({ kind: "claim", claim: { id: "a2" } });
    expect(stateAt(full, null)).toMatchObject({ kind: "claim", claim: { id: "a2" } });
    expect(stateAt(full, START_POINT.at)).toEqual({ kind: "none" });
    expect(stateAt(buildChains([A2]).get("grid.firm_capacity_mva")!, START_POINT.at)).toEqual({ kind: "unknown" });
  });
});

describe("two points: changed, added, withdrawn, unchanged", () => {
  const diff = (from: string, to: string) => {
    const r = diffPoints(buildChains(ALL), pt(from), pt(to));
    if (!r.ok) throw new Error(r.error);
    return r.diff;
  };
  const kindOf = (d: ReturnType<typeof diff>, path: string) => d.rows.find((r) => r.path === path)?.kind;

  it("January to now: capacity changed, contracted added, peak withdrawn, racks unchanged", () => {
    const d = diff("2026-01-10", "now");
    expect(kindOf(d, "grid.firm_capacity_mva")).toBe("changed");
    expect(kindOf(d, "grid.contracted_mw")).toBe("added");
    expect(kindOf(d, "grid.current_site_peak_mw")).toBe("withdrawn");
    expect(kindOf(d, "hall.rack_positions")).toBe("unchanged");
    expect(d.counts).toEqual({ added: 1, changed: 1, withdrawn: 1, unchanged: 1, unknown: 0 });
  });
  it("from the start, everything recorded is added", () => {
    const d = diff("start", "now");
    expect(d.rows.map((r) => r.kind).sort()).toEqual(["added", "added", "added", "added"]);
  });
  it("between two points with nothing in between, everything is unchanged", () => {
    const d = diff("2026-02-10", "now");
    expect(d.counts.unchanged).toBe(4);
    expect(d.counts.changed + d.counts.added + d.counts.withdrawn).toBe(0);
  });
  it("the changed row lists every respect: value, origin, class, file, file status — and calls out the shift with its evidence", () => {
    const row = diff("2026-01-10", "now").rows.find((r) => r.path === "grid.firm_capacity_mva")!;
    expect(row.aspects.map((a) => a.what)).toEqual(["value", "declared origin", "declared class", "source file", "file review status"]);
    expect(row.aspects[0]).toMatchObject({ from: "40 MVA", to: "42 MVA", note: "+2 MVA (+5%)" });
    expect(row.aspects.find((a) => a.what === "declared class")).toMatchObject({ from: "E0", to: "E5", direction: "raised" });
    expect(row.aspects.find((a) => a.what === "declared origin")).toMatchObject({ from: "declared assumed", to: "declared measured" });
    expect(row.aspects.find((a) => a.what === "source file")).toMatchObject({ from: "no file cited", to: "meter.pdf" });
    expect(row.aspects.find((a) => a.what === "file review status")).toMatchObject({ from: "no file", to: "reviewed and verified" });
    expect(evidenceShift(row.before, row.after!)).toBe("declared assumed E0, no file cited → declared measured E5, meter.pdf (file reviewed and verified)");
    expect(row.between).toBe(1);
  });
  it("withdrawn means the value was replaced by a record that it is missing, and says what it rested on", () => {
    const row = diff("2026-01-10", "now").rows.find((r) => r.kind === "withdrawn")!;
    expect(row.before!.value).toBe(10);
    expect(row.after!.origin).toBe("missing");
    expect(row.aspects.find((a) => a.what === "value")).toMatchObject({ from: "10 MW", to: "missing" });
  });
  it("a correction that restates the same content is unchanged, with a note", () => {
    const again = claim({ id: "a3", day: "2026-03-01", supersedesId: "a2", value: 42, origin: "measured", evidenceClass: "E5", source: verified, asOf: "2026-01-01" });
    const chains = buildChains([...ALL, again]);
    const r = diffPoints(chains, pointsOf([...ALL, again]).find((p) => p.id === "2026-02-10")!, NOW_POINT);
    expect(r.ok && r.diff.rows.find((x) => x.path === "grid.firm_capacity_mva")).toMatchObject({ kind: "unchanged", note: "Recorded again with the same content." });
  });
  it("the earlier point must not be later than the later point", () => {
    expect(diffPoints(buildChains(ALL), NOW_POINT, pt("2026-01-10"))).toEqual({ ok: false, error: "Choose an earlier point first and a later point second." });
    expect(diffPoints(buildChains(ALL), pt("2026-01-10"), pt("2026-01-10"))).toMatchObject({ ok: true });
  });
  it("is deterministic: the same history in any order gives the same result", () => {
    const shuffled = [D1, C1, A1, B1, C2, A2];
    const a = diffPoints(buildChains(ALL), pt("2026-01-10"), NOW_POINT);
    const b = diffPoints(buildChains(shuffled), pt("2026-01-10"), NOW_POINT);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  describe("a history that was not fully loaded", () => {
    it("a field whose first claim is missing is UNKNOWN for a point before its first loaded claim, not 'added'", () => {
      const partial = [A2, B1, C2, D1];                     // a1 and c1 (the Jan 10 claims of two fields) were not loaded
      const r = diffPoints(buildChains(partial), pt("2026-01-10"), NOW_POINT);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.diff.rows.find((x) => x.path === "grid.firm_capacity_mva")).toMatchObject({ kind: "unknown", note: expect.stringMatching(/Older history of this field was not loaded/) });
      expect(r.diff.rows.find((x) => x.path === "grid.current_site_peak_mw")?.kind).toBe("unknown");
      expect(r.diff.rows.find((x) => x.path === "hall.rack_positions")?.kind).toBe("unchanged");
      expect(r.diff.counts.unknown).toBe(2);
    });
    it("after the first loaded claim the state is known even if older claims are missing", () => {
      const partial = [A2];
      const r = diffPoints(buildChains(partial), pt("2026-02-10"), NOW_POINT);
      expect(r.ok && r.diff.rows[0]!.kind).toBe("unchanged");
    });
  });
});

describe("a change is never shown without the evidence class it rests on", () => {
  it("every changed, withdrawn or added row, rendered, carries the AFTER side's declared class, origin and file in the same list item", () => {
    const r = diffPoints(buildChains(ALL), pt("start"), NOW_POINT);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const html = renderToStaticMarkup(React.createElement(DiffView, { diff: r.diff }));
    const items = html.split("<li").slice(1).filter((i) => /data-kind="(added|changed|withdrawn)"/.test(i));
    expect(items).toHaveLength(4);
    for (const row of r.diff.rows) {
      const item = items.find((i) => i.includes(row.path))!;
      expect(item, row.path).toContain("Rests on:");
      expect(item, row.path).toContain(row.after!.evidenceClass);
      expect(item, row.path).toContain(row.after!.origin === "missing" ? "missing" : `declared ${row.after!.origin}`);
    }
    const cap = items.find((i) => i.includes("grid.firm_capacity_mva"))!;
    expect(cap).toContain("meter.pdf (file reviewed and verified)");
    expect(cap).toContain("E5");
  });
  it("the words 'improved', 'better' and 'saves' are not used", () => {
    const r = diffPoints(buildChains(ALL), pt("2026-01-10"), NOW_POINT);
    if (!r.ok) throw new Error();
    const html = renderToStaticMarkup(React.createElement(DiffView, { diff: r.diff }));
    expect(html).not.toMatch(/improv|better|worse|gain|saving/i);
  });
  it("a rise in the declared class is labelled as declared, and is cautioned when the file does not stand behind it now", () => {
    const rejectedFile = claim({ id: "x2", day: "2026-03-01", supersedesId: "a2", value: 42, origin: "measured", evidenceClass: "E5", source: { ...verified, reviewStatus: "rejected" } });
    expect(cautions(A2, rejectedFile).join()).toMatch(/since been rejected/);
    const unreviewed = claim({ id: "x3", day: "2026-03-01", value: 50, origin: "measured", evidenceClass: "E5", source: { ...verified, reviewStatus: "unverified" } });
    expect(cautions(A1, unreviewed).join()).toMatch(/declared class E5 is the recorder's declaration; the file is not shown as reviewed and verified now/);
    expect(cautions(A1, A2)).toEqual([]);                                                    // E5 on a verified file: nothing to add
    const noFile = claim({ id: "x4", day: "2026-03-01", value: 50, origin: "measured", evidenceClass: "E2" });
    expect(cautions(A1, noFile).join()).toMatch(/Declared measured with no file cited/);
    expect(aspectsBetween(A1, unreviewed).find((a) => a.what === "declared class")?.direction).toBe("raised");
    expect(aspectsBetween(A2, A1).find((a) => a.what === "declared class")?.direction).toBe("lowered");
  });
  it("evidenceLine puts origin, class and file status in one phrase", () => {
    expect(evidenceLine(A1)).toBe("declared assumed E0, no file cited");
    expect(evidenceLine(A2)).toBe("declared measured E5, meter.pdf (file reviewed and verified)");
    expect(evidenceLine(C2)).toBe("missing E0, none (missing)");
  });
  it("the panel says that file status is the live one", () => {
    expect(FILE_STATUS_NOTE).toMatch(/status now/);
  });
});

describe("one field's successive values", () => {
  it("lists each claim against the one it replaced, oldest first, with what changed and what it rests on", () => {
    const mid = claim({ id: "a15", day: "2026-01-20", value: 41, evidenceClass: "E1", supersedesId: "a1" });
    const a2 = { ...A2, supersedesId: "a15" };
    const chain = buildChains([a2, mid, A1]).get("grid.firm_capacity_mva")!;
    const steps = successions(chain);
    expect(steps.map((s) => s.after.id)).toEqual(["a1", "a15", "a2"]);
    expect(steps[0]!.before).toBeNull();
    expect(steps[1]!.aspects.map((a) => a.what)).toEqual(["value", "declared class"]);
    expect(steps[2]!.aspects.map((a) => a.what)).toContain("file review status");
    const html = renderToStaticMarkup(React.createElement(StepsView, { steps }));
    expect(html).toContain("First recorded");
    expect(html.match(/Correction/g)).toHaveLength(2);
    expect(html.match(/Rests on:/g)).toHaveLength(3);
    expect(html).toContain("declared assumed E1, no file cited → declared measured E5, meter.pdf (file reviewed and verified)");
  });
});
