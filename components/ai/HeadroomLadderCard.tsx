"use client";

import { Layers } from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { EvidenceBadge, ProvenanceLine } from "./EvidenceBadge";
import type { HeadroomLadderMetricBlock } from "./types";

/**
 * Bars over rungs of the ladder. Uses the same recharts pattern as
 * components/LoadSimulator.tsx (ComposedChart / dark tooltip / mono axis
 * labels) so the workspace reads as one system with the marketing site. Every
 * bar's height is `step.racks.value`, which is required to carry an evidence
 * class and provenance digest on the type — this component cannot render a
 * step without one.
 */
export function HeadroomLadderCard({ block }: { block: HeadroomLadderMetricBlock }) {
  const data = block.steps.map((s) => ({
    name: `${s.step}. ${s.label}`,
    racks: s.racks.value,
    evidenceClass: s.racks.evidenceClass,
  }));

  return (
    <div className="panel p-5">
      <div className="flex items-center gap-2 mb-3">
        <Layers size={16} className="text-power shrink-0" />
        <div>
          <div className="eyebrow">HEADROOM LADDER</div>
          <h4 className="text-base font-semibold text-ghost mt-0.5">{block.hallLabel}</h4>
        </div>
      </div>

      <div className="h-[220px] w-full" aria-hidden>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 8, right: 8, bottom: 4, left: -20 }}>
            <CartesianGrid stroke="rgba(0,229,255,0.06)" vertical={false} />
            <XAxis
              dataKey="name"
              tick={{ fill: "#5A6478", fontSize: 9, fontFamily: "var(--font-mono), monospace" }}
              tickLine={false}
              axisLine={{ stroke: "#1E2942" }}
              interval={0}
              angle={-20}
              textAnchor="end"
              height={48}
            />
            <YAxis
              tick={{ fill: "#5A6478", fontSize: 10, fontFamily: "var(--font-mono), monospace" }}
              tickLine={false}
              axisLine={{ stroke: "#1E2942" }}
              width={40}
            />
            <Tooltip
              contentStyle={{
                background: "#0B1120",
                border: "1px solid #1E2942",
                borderRadius: 10,
                fontFamily: "var(--font-mono), monospace",
                fontSize: 12,
              }}
              labelStyle={{ color: "#8A94A6" }}
              formatter={(value: number) => [`${value.toLocaleString()} racks`, "Racks"]}
            />
            <Bar dataKey="racks" fill="#00E5FF" radius={[4, 4, 0, 0]} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      </div>

      <ol className="mt-4 space-y-2.5">
        {block.steps.map((s) => (
          <li key={s.step} className="rounded-lg border border-line bg-ink/40 p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[13px] text-ghost font-medium">
                {s.step}. {s.label}
              </span>
              <EvidenceBadge evidenceClass={s.racks.evidenceClass} provenance={s.racks.provenance} />
            </div>
            <div className="data text-lg font-semibold text-ghost mt-1">
              {s.racks.value.toLocaleString()} <span className="text-xs text-faint">racks</span>
            </div>
            {s.reliefDescription && (
              <div className="text-[12px] text-mute mt-1">{s.reliefDescription}</div>
            )}
            <div className="flex items-center gap-3 mt-1 text-[11px] text-faint">
              {s.capexEur && <span>{s.capexEur.value.toLocaleString()} {s.capexEur.unit}</span>}
              {s.leadTimeWeeks && <span>{s.leadTimeWeeks.value} wk lead</span>}
            </div>
            <ProvenanceLine provenance={s.racks.provenance} />
          </li>
        ))}
      </ol>
    </div>
  );
}
