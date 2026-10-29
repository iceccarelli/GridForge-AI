/**
 * The queue-cost calculator rests on MEASURED evidence, and says what that evidence is and is not.
 *
 * The wait times used to be hand-set figures presented as "latest published ISO reports". They are now the LBNL Queued Up
 * medians for generation and storage projects that reached operation, with the share of requests that never did shown beside
 * them. A figure that does not rest on a measurement is labelled an estimate; the behind-the-meter months are always an assumption.
 */
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import raw from "@/lib/queue-evidence.json";
import { DelayDemo } from "@/components/DelayDemo";
import {
  QUEUE_EVIDENCE_SOURCE,
  allMeasuredWaits,
  completionShare,
  measuredWait,
  measuredWaitCaption,
} from "@/lib/queue-evidence";
import { SITING_REGIONS, costOfDelay, queueBasisNote, withQueueEvidence } from "@/lib/siting";

const text = (html: string) => html.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();

describe("the evidence file", () => {
  it("is a consistent, attributed measurement", () => {
    expect(raw.source_id).toBe("lbnl-queued-up");
    expect(raw.provenance.workbook_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(QUEUE_EVIDENCE_SOURCE.licence).toBe("CC BY 4.0");
    expect(QUEUE_EVIDENCE_SOURCE.attribution).toContain("Lawrence Berkeley National Laboratory");
    expect(raw.definition).toMatch(/NOT a time-to-power for a load/);
    expect(raw.limits.join(" ")).toMatch(/Survivorship/);
    expect(allMeasuredWaits().length).toBeGreaterThanOrEqual(4);
    for (const w of allMeasuredWaits()) {
      expect(w.n).toBeGreaterThan(0);
      expect(w.p25Months).toBeLessThanOrEqual(w.medianMonths);
      expect(w.medianMonths).toBeLessThanOrEqual(w.p75Months);
    }
  });

  it("converts years to whole months without changing the ordering", () => {
    const ercot = measuredWait("ERCOT");
    expect(ercot).toEqual({ region: "ERCOT", n: 376, p25Months: 30, medianMonths: 45, p75Months: 56 });
    expect(measuredWait("EPEX (DE-LU)")).toBeUndefined();
    expect(measuredWait("__proto__")).toBeUndefined();
    expect(measuredWait("constructor")).toBeUndefined();
  });

  it("reports how few requests reach operation, from the cohort counts", () => {
    const c = completionShare();
    expect([c.fromYear, c.toYear]).toEqual([2010, 2015]);
    expect(c.entered).toBe(5633);
    expect(c.operational + c.withdrawn + c.unresolved).toBe(c.entered);
    expect(c.unresolved).toBeGreaterThanOrEqual(0);
    expect(c.operationalShare).toBeCloseTo(0.231, 3);
    expect(c.withdrawnShare).toBeCloseTo(0.737, 3);
    expect(c.operationalShare + c.withdrawnShare).toBeLessThanOrEqual(1);
  });

  it("the caption names the source, the denominator and the limit", () => {
    const w = measuredWait("PJM");
    expect(w).toBeDefined();
    const s = measuredWaitCaption(w!);
    expect(s).toContain("Median 59 months (middle half 39-77)");
    expect(s).toContain("427 completed PJM");
    expect(s).toContain("LBNL Queued Up, 2026 edition");
    expect(s).toContain("Only 23% of requests");
    expect(s).toContain("not for a load connection");
  });
});

describe("the siting regions", () => {
  it("US ISOs carry the measured median; other markets stay labelled as estimates", () => {
    for (const r of SITING_REGIONS) {
      const w = measuredWait(r.market);
      if (w) {
        expect(r.queueBasis).toBe("measured");
        expect(r.queueWaitMonths).toBe(w.medianMonths);
        expect(r.queueMeasured).toEqual(w);
      } else {
        expect(r.queueBasis).toBe("modeled");
        expect(r.queueMeasured).toBeUndefined();
      }
    }
    expect(SITING_REGIONS.filter((r) => r.queueBasis === "measured").map((r) => r.market).sort()).toEqual(["ERCOT", "MISO", "PJM", "SPP"]);
    expect(SITING_REGIONS.find((r) => r.market === "SPP")!.queueWaitMonths).toBe(58);
  });

  it("an estimate is never described as a measurement", () => {
    const de = SITING_REGIONS.find((r) => r.market === "EPEX (DE-LU)")!;
    expect(queueBasisNote(de)).toMatch(/not measured here/);
    expect(queueBasisNote(de)).not.toMatch(/LBNL/);
    const synthetic = withQueueEvidence({ ...de, market: "Nowhere", queueWaitMonths: 99 });
    expect(synthetic.queueWaitMonths).toBe(99);
    expect(synthetic.queueBasis).toBe("modeled");
  });

  it("the cost of delay uses the measured wait", () => {
    const pjm = SITING_REGIONS.find((r) => r.market === "PJM")!;
    const d = costOfDelay(100, pjm, 25000);
    expect(d.queueCostEur).toBe(100 * 25000 * 59);
  });
});

describe("the public calculator", () => {
  it("shows the queue basis, the survivorship caveat and that the BTM months are assumed", () => {
    const t = text(renderToStaticMarkup(React.createElement(DelayDemo)));
    expect(t).toContain("Median 59 months (middle half 39-77)");
    expect(t).toContain("Only 23% of requests");
    expect(t).toContain("not for a load connection");
    expect(t).toMatch(/\d+mo assumed/);
    expect(t).toContain("an assumption for this comparison, not a quotation or a delivery date");
    expect(t).toContain("on the assumptions below");
  });
});

describe("the Observatory queue snapshots", () => {
  it("the four US rows are the publisher's printed capacity and the measured median wait, not typed numbers", async () => {
    const { QUEUE_SNAPSHOTS, lbnlSnapshot, QUEUE_ACTIVE_CAPACITY_SOURCE } = await import("@/lib/queue-data");
    const cap = (await import("@/lib/queue-active-capacity.json")).default;
    const us = QUEUE_SNAPSHOTS.filter((q) => /LBNL/.test(q.source));
    expect(us.map((q) => q.market)).toEqual(["ERCOT", "PJM", "MISO", "SPP"]);
    for (const q of us) {
      const active = (cap.active as Record<string, { gw: number }>)[q.market];
      expect(q.activeProjectsGW).toBe(active.gw);
      expect(q.typicalWaitMonths).toBe(measuredWait(q.market)!.medianMonths);
      expect(q.asOf).toBe(cap.as_of);
      expect(q.source).toMatch(/CC BY 4\.0/);
    }
    expect(us.find((q) => q.market === "PJM")!.activeProjectsGW).toBe(144.3); // the typed figure was 290
    expect(QUEUE_ACTIVE_CAPACITY_SOURCE.workbookSha256).toBe(raw.provenance.workbook_sha256);
    expect(lbnlSnapshot("EPEX (DE-LU)")).toBeUndefined();
    expect(lbnlSnapshot("__proto__")).toBeUndefined();
  });

  it("anything that is not measured stays labelled modeled and is never described as a report", async () => {
    const { QUEUE_SNAPSHOTS } = await import("@/lib/queue-data");
    const rest = QUEUE_SNAPSHOTS.filter((q) => !/LBNL/.test(q.source));
    expect(rest.length).toBeGreaterThan(0);
    for (const q of rest) expect(q.source).toMatch(/modeled/);
  });

  it("the evidence file records its own limits: the unit check, the recomputation gap and the unread note", async () => {
    const cap = (await import("@/lib/queue-active-capacity.json")).default;
    expect(cap.provenance.unit_check).toMatch(/capacity of type 1 \(MW\)/);
    expect(cap.provenance.recomputation).toMatch(/hypothesis, not a finding/);
    expect(cap.provenance.note_3_as_read).toMatch(/rest was not read/);
    expect(cap.what_it_is).toMatch(/not available capacity/);
  });
});
