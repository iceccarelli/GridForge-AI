"use client";

import { shownConstraintName } from "@/lib/observatory/journey";
import type { ConstraintResult } from "@/lib/observatory/types";
import { EvidenceChip } from "@/components/observatory/EvidenceChip";
import { Cell, DataTable, Row, RowHead } from "@/components/observatory/Table";
import { fmtNumber } from "@/components/observatory/format";

export interface RankedConstraint extends ConstraintResult {
  rank: number | null;
}

/** True when the engine reports a finite limit. A null racksAllowed (`passes`) means NO finite limit: it does not limit the hall. */
export function limits(c: Pick<ConstraintResult, "racksAllowed" | "passes">): boolean {
  return !c.passes && c.racksAllowed !== null;
}

/**
 * Ascending racks allowed (the tightest first); competition ranking so ties share a rank. A constraint that passes (no finite
 * limit) does not limit the hall, so it takes no rank and sorts last.
 */
export function rankConstraints(list: ConstraintResult[]): RankedConstraint[] {
  const sorted = [...list].sort((a, b) => {
    if (!limits(a) && !limits(b)) return a.name.localeCompare(b.name);
    if (!limits(a)) return 1;
    if (!limits(b)) return -1;
    return (a.racksAllowed as number) - (b.racksAllowed as number) || a.name.localeCompare(b.name);
  });
  let prev: number | null = null;
  let prevRank = 0;
  return sorted.map((c, i) => {
    if (!limits(c)) return { ...c, rank: null };
    const rank = c.racksAllowed === prev ? prevRank : i + 1;
    prev = c.racksAllowed;
    prevRank = rank;
    return { ...c, rank };
  });
}

export function ConstraintsPanel({ constraints, bindingAfterPlanKey }: { constraints: ConstraintResult[]; bindingAfterPlanKey: string | null }) {
  const ranked = rankConstraints(constraints);
  const max = ranked.reduce((m, c) => (limits(c) && (c.racksAllowed as number) > m ? (c.racksAllowed as number) : m), 0);
  return (
    <DataTable
      caption={`${constraints.length} constraints ranked by the racks each one alone allows, as found. The lowest binds first; a constraint that passes does not limit the hall. Each carries the evidence class of its basis.`}
      head={["Rank", "Constraint", "Racks allowed", "Binds", "Basis", "Evidence"]}
    >
      {ranked.map((c) => (
        <Row key={c.key} emphasis={c.binds}>
          <Cell label="Rank">
            {c.rank === null ? (
              <>
                <span aria-hidden="true" className="text-mute">
                  –
                </span>
                <span className="sr-only">no rank: does not limit the hall</span>
              </>
            ) : (
              <span className="data text-ghost">{c.rank}</span>
            )}
          </Cell>
          <RowHead label="Constraint">
            <span>{shownConstraintName(c.name)}</span>
            <span className="block font-mono text-[10px] uppercase tracking-wider text-mute">{c.domain}</span>
          </RowHead>
          <Cell label="Racks allowed">
            {!limits(c) ? (
              <span className="text-ghost">does not limit the hall (passes)</span>
            ) : (
              <span className="flex items-center justify-end gap-2 md:justify-start">
                <span className="data text-ghost">{fmtNumber(c.racksAllowed as number)}</span>
                <span className="hidden h-1.5 w-20 overflow-hidden rounded-full bg-ink md:block" aria-hidden="true">
                  <span className="block h-full rounded-full bg-chart" style={{ width: `${max > 0 ? Math.round(((c.racksAllowed as number) / max) * 100) : 0}%` }} />
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
