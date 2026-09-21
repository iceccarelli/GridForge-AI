"use client";

import { Clock } from "lucide-react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { EvidenceBadge, ProvenanceLine } from "./EvidenceBadge";
import type { TimeToPowerMetricBlock } from "./types";

export function TimeToPowerCard({ block }: { block: TimeToPowerMetricBlock }) {
  const hasSeries = !!block.series && block.series.length > 0;

  return (
    <div className="panel p-5">
      <div className="flex items-center gap-2 mb-3">
        <Clock size={16} className="text-power shrink-0" />
        <div>
          <div className="eyebrow">TIME TO POWER</div>
          <h4 className="text-base font-semibold text-ghost mt-0.5">{block.hallLabel}</h4>
        </div>
      </div>

      {hasSeries && (
        <div className="h-[180px] w-full mb-4" aria-hidden>
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={block.series} margin={{ top: 8, right: 8, bottom: 4, left: -20 }}>
              <CartesianGrid stroke="rgba(0,229,255,0.06)" vertical={false} />
              <XAxis
                dataKey="month"
                tick={{ fill: "#5A6478", fontSize: 10, fontFamily: "var(--font-mono), monospace" }}
                tickLine={false}
                axisLine={{ stroke: "#1E2942" }}
                tickFormatter={(v) => `mo ${v}`}
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
                labelFormatter={(v) => `Month ${v}`}
                formatter={(value: number, name: string) => [`${value} MW`, name]}
              />
              <Area
                type="stepAfter"
                dataKey="queueMW"
                name="New grid connection"
                stroke="#FFB020"
                fill="#FFB020"
                fillOpacity={0.16}
                strokeWidth={1.6}
                isAnimationActive={false}
                connectNulls
              />
              <Area
                type="stepAfter"
                dataKey="onSiteMW"
                name="Headroom ladder (this hall)"
                stroke="#00E5FF"
                fill="#00E5FF"
                fillOpacity={0.22}
                strokeWidth={1.6}
                isAnimationActive={false}
                connectNulls
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-px bg-line rounded-xl overflow-hidden border border-line">
        <Metric label="Grid queue" q={block.queueMonths} tone="text-queue" />
        <Metric label="On-site (ladder)" q={block.onSiteMonths} tone="text-power" />
        <Metric label="Recovered" q={block.monthsRecovered} tone="text-verified" />
      </div>
    </div>
  );
}

function Metric({
  label,
  q,
  tone,
}: {
  label: string;
  q: TimeToPowerMetricBlock["queueMonths"];
  tone: string;
}) {
  return (
    <div className="bg-panel p-4">
      <div className="flex items-center justify-between mb-1">
        <span className="text-[11px] text-faint uppercase tracking-wide">{label}</span>
      </div>
      <div className={`data text-2xl font-semibold ${tone}`}>
        {q.value}
        <span className="text-xs text-faint ml-1">{q.unit}</span>
      </div>
      <div className="mt-1">
        <EvidenceBadge evidenceClass={q.evidenceClass} provenance={q.provenance} />
      </div>
      <ProvenanceLine provenance={q.provenance} />
    </div>
  );
}
