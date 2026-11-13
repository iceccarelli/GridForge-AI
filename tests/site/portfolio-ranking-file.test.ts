// The Portfolio Screen's stored ranking file must carry everything the engine said about the ranking, not only the four figures it began
// with. The engine now qualifies a portfolio total (halls that cannot be compared, halls that share one grid connection, a total that is
// null when nothing is comparable); a delivered file that dropped those would show a buyer a bare `total_racks` the engine no longer
// stands behind. These tests fail if the pass-through is reverted to a four-key copy.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { portfolioRankingFile } from "@/lib/portfolio-ranking";

// The shape of a real /v1/portfolio answer after the comparability work (synthetic values; the keys are the engine's).
const ANSWER = {
  objective: "max_compute",
  halls: [{ hall: "H1", racks: 28, rankable: true, shares_site_connection: [] }, { hall: "H2", racks: 28, rankable: false, required_gaps: ["ups"] }],
  total_racks: 56,
  total_racks_evidence: "E0",
  comparable_total_racks: 28,
  comparable_total_racks_evidence: "E0",
  total_racks_upper_bound: 56,
  incomparable_halls: ["H2"],
  constraint_rollup: { as_found: { ups_capacity: 1 } },
  totals_note: "The total is for the chosen objective; H2 is not in it.",
  warnings: ["H2 has required inputs missing and is not comparable."],
  document: { title: "Portfolio", document: "<html/>" },
  model_packs: { "H1": { pack: true } },
};

describe("portfolioRankingFile", () => {
  const parsed = () => JSON.parse(portfolioRankingFile(ANSWER));

  it("keeps the four original keys first and in their original order", () => {
    expect(Object.keys(parsed()).slice(0, 4)).toEqual(["objective", "halls", "total_racks", "total_racks_evidence"]);
  });

  it("carries every qualifier the engine gave, so a total is never delivered bare", () => {
    const f = parsed();
    expect(f.comparable_total_racks).toBe(28);
    expect(f.total_racks_upper_bound).toBe(56);
    expect(f.incomparable_halls).toEqual(["H2"]);
    expect(f.constraint_rollup).toEqual({ as_found: { ups_capacity: 1 } });
    expect(f.totals_note).toContain("not in it");
    expect(f.warnings).toEqual(["H2 has required inputs missing and is not comparable."]);
    expect(f.halls[1].required_gaps).toEqual(["ups"]);
  });

  it("does not repeat the parts that are delivered as their own files", () => {
    const f = parsed();
    expect("document" in f).toBe(false);
    expect("model_packs" in f).toBe(false);
  });

  it("passes through a key the engine adds later, rather than silently dropping it", () => {
    const f = JSON.parse(portfolioRankingFile({ ...ANSWER, some_future_key: { a: 1 } }));
    expect(f.some_future_key).toEqual({ a: 1 });
  });

  it("keeps a null comparable total as null: no comparable total is not zero racks", () => {
    const f = JSON.parse(portfolioRankingFile({ ...ANSWER, comparable_total_racks: null }));
    expect(f.comparable_total_racks).toBeNull();
  });

  it("is what the deliverable generator actually stores (not a four-key copy)", () => {
    const src = readFileSync(path.join(process.cwd(), "lib", "deliverables.ts"), "utf8");
    expect(src).toContain("portfolioRankingFile(");
    expect(src).not.toMatch(/total_racks_evidence:\s*html\.total_racks_evidence/);
  });
});
