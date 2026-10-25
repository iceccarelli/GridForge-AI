"use client";

import type { ConstraintResult } from "@/lib/observatory/types";
import { EvidenceChip } from "@/components/observatory/EvidenceChip";
import { Cell, DataTable, Row, RowHead } from "@/components/observatory/Table";
import { fmtNumber } from "@/components/observatory/format";

export interface RankedConstraint extends ConstraintResult {
  rank: number | null;
}

/** Ascending racks allowed (the tightest first); competition ranking so ties share a rank; unknown last, unranked. */
export function rankConstraints(list: ConstraintResult[]): RankedConstraint[] {
  const sorted = [...list].sort((a, b) => {
    if (a.racksAllowed === null && b.racksAllowed === null) return a.name.localeCompare(b.name);
    if (a.racksAllowed === null) return 1;
    if (b.racksAllowed === null) return -1;
    return a.racksAllowed - b.racksAllowed || a.name.localeCompare(b.name);
  });
  let prev: number | null = null;
  let prevRank = 0;
  return sorted.map((c, i) => {
    if (c.racksAllowed === null) return { ...c, rank: null };
    const rank = c.racksAllowed === prev ? prevRank : i + 1;
    prev = c.racksAllowed;
    prevRank = rank;
    return { ...c, rank };
  });
}

export function ConstraintsPanel({ constraints, bindingAfterPlanKey }: { constraints: ConstraintResult[]; bindingAfterPlanKey: string | null }) {
  const ranked = rankConstraints(constraints);
  const max = ranked.reduce((m, c) => (c.racksAllowed !== null && c.racksAllowed > m ? c.racksAllowed : m), 0);
  return (
    <DataTable
      caption={`${constraints.length} constraints ranked by the racks each one alone allows, as found. The lowest binds first. Each carries the evidence class of its basis.`}
      head={["Rank", "Constraint", "Racks allowed", "Binds", "Basis", "Evidence"]}
    >
      {ranked.map((c) => (
        <Row key={c.key} emphasis={c.binds}>
          <Cell label="Rank">
            <span className="data text-ghost">{c.rank === null ? "unranked" : c.rank}</span>
          </Cell>
          <RowHead label="Constraint">
            <span>{c.name}</span>
            <span className="block font-mono text-[10px] uppercase tracking-wider text-mute">{c.domain}</span>
          </RowHead>
          <Cell label="Racks allowed">
            {c.racksAllowed === null ? (
              <span className="text-mute">no figure given</span>
            ) : (
              <span className="flex items-center justify-end gap-2 md:justify-start">
                <span className="data text-ghost">{fmtNumber(c.racksAllowed)}</span>
                <span className="hidden h-1.5 w-20 overflow-hidden rounded-full bg-ink md:block" aria-hidden="true">
                  <span className="block h-full rounded-full bg-chart" style={{ width: `${max > 0 ? Math.round((c.racksAllowed / max) * 100) : 0}%` }} />
                </span>
              </span>
            )}
          </Cell>
          <Cell label="Binds">
            {c.binds ? (
              <span className="inline-block whitespace-nowrap rounded-full border border-queue bg-queue/15 px-2 py-px font-mono text-[10px] font-bold uppercase tracking-wide text-queue">
                Binds as found
              </span>
            ) : bindingAfterPlanKey === c.key ? (
              <span className="inline-block whitespace-nowrap rounded-full border border-power bg-power/10 px-2 py-px font-mono text-[10px] font-bold uppercase tracking-wide text-power">
                Binds after the plan
              </span>
            ) : (
              <span className="text-mute">no</span>
            )}
          </Cell>
          <Cell label="Basis">
            <span className="text-mute">{c.basis}</span>
          </Cell>
          <Cell label="Evidence">
            <EvidenceChip cls={c.evidence} />
          </Cell>
        </Row>
      ))}
    </DataTable>
  );
}
