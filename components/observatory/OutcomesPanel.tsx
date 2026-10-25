"use client";

import type { ConstraintResult, ScenarioOutcome } from "@/lib/observatory/types";
import { EvidenceChip } from "@/components/observatory/EvidenceChip";
import { shownConstraintName } from "@/lib/observatory/journey";
import { Fig } from "@/components/observatory/Fig";
import { Cell, DataTable, Row, RowHead } from "@/components/observatory/Table";
import { fmtNumber, viewCapex, viewTimeToCapacity } from "@/components/observatory/format";

/** The constraint's name as this alternative states it (the engine's supply name says "behind-the-meter" even for grid-only options). */
export function constraintName(key: string | null, constraints: ConstraintResult[], outcome?: ScenarioOutcome | null): string {
  if (!key) return "nothing identified";
  const c = constraints.find((x) => x.key === key);
  return c ? shownConstraintName(c.name, outcome) : key;
}

export function OutcomesPanel({
  outcomes,
  constraints,
  selectedId,
  onSelect,
}: {
  outcomes: ScenarioOutcome[];
  constraints: ConstraintResult[];
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  const maxRacks = outcomes.reduce((m, o) => Math.max(m, o.racksAfterPlan, o.racksAsFound), 0);
  return (
    <DataTable
      caption="The alternatives the engine compared for this hall. Choose one to show it on the stage. Racks are what the hall can carry; time and cost are programme figures with their evidence class."
      head={["Alternative", "Racks as found, after the plan", "Binds after the plan", "Time to capacity", "Capital cost", "Evidence"]}
    >
      {outcomes.map((o) => {
        const t = viewTimeToCapacity(o);
        const cx = viewCapex(o);
        const sel = o.id === selectedId;
        return (
          <Row key={o.id} emphasis={false}>
            <RowHead label="Alternative">
              <button
                type="button"
                onClick={() => onSelect(o.id)}
                aria-pressed={sel}
                className={`rounded-lg border px-3 py-1.5 text-left text-sm font-semibold transition-colors ${
                  sel ? "border-power bg-power/10 text-power" : "border-line text-ghost hover:border-power/60"
                }`}
              >
                {o.name}
                <span className="block text-[11px] font-normal text-mute">{sel ? "Shown on the stage" : "Show on the stage"}</span>
              </button>
            </RowHead>
            <Cell label="Racks as found, after the plan">
              <span className="data text-ghost">
                {fmtNumber(o.racksAsFound)} {"→"} {fmtNumber(o.racksAfterPlan)} racks
              </span>{" "}
              <EvidenceChip cls={o.evidence} compact />
              <span className="mt-1 block h-1.5 w-full max-w-[12rem] overflow-hidden rounded-full bg-ink md:max-w-none" aria-hidden="true">
                <span className="relative block h-full">
                  <span className="absolute inset-y-0 left-0 rounded-full bg-power/40" style={{ width: `${maxRacks > 0 ? (o.racksAfterPlan / maxRacks) * 100 : 0}%` }} />
                  <span className="absolute inset-y-0 left-0 rounded-full bg-chart" style={{ width: `${maxRacks > 0 ? (o.racksAsFound / maxRacks) * 100 : 0}%` }} />
                </span>
              </span>
              <span className="mt-1 block text-xs text-mute">
                IT load after the plan <Fig q={o.itLoadKwAfterPlan} />
              </span>
            </Cell>
            <Cell label="Binds after the plan">
              <span className="text-ghost">{constraintName(o.bindingAfterPlan, constraints, o)}</span>
            </Cell>
            <Cell label="Time to capacity">
              <span className={t.kind === "weeks" ? "data text-ghost" : "text-ghost"}>{t.text}</span> {t.evidence ? <EvidenceChip cls={t.evidence} /> : null}
              {t.note ? <span className="block text-xs text-mute">{t.note}</span> : null}
            </Cell>
            <Cell label="Capital cost">
              <span className={cx.kind === "unpriced" ? "text-ghost" : "data text-ghost"}>{cx.text}</span> {cx.evidence ? <EvidenceChip cls={cx.evidence} /> : null}
              {cx.qualifier ? <span className="block text-xs text-ghost">{cx.qualifier}</span> : null}
              {cx.pricing ? <span className="block text-xs text-queue">{cx.pricing}</span> : null}
              {cx.range ? <span className="block text-xs text-mute">{cx.range}</span> : null}
              {cx.note ? <span className="block text-xs text-mute">{cx.note}</span> : null}
            </Cell>
            <Cell label="Evidence">
              <EvidenceChip cls={o.evidence} />
              <span className="mt-1 block text-xs text-mute">weakest class behind this alternative</span>
            </Cell>
          </Row>
        );
      })}
    </DataTable>
  );
}
