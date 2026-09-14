"use client";

import React, { useEffect, useState } from "react";

/**
 * What actually binds — the published distribution.
 *
 * One measure across categories, so one hue and a value printed on every bar.
 * The mark colour is a dimmed step of the brand's `power`: #00E5FF is an interface
 * colour and sits outside the usable lightness band as a data mark on this surface.
 *
 * Below the publication threshold this renders the honest version — how many halls
 * are in, and what it will take to publish — rather than a chart of four rows.
 */

interface Insights {
  published: boolean;
  halls: number;
  threshold?: number;
  reason?: string;
  blocked_as_found?: number;
  constraints?: { constraint: string; halls: number; share: number }[];
  medians?: {
    contracted_headroom_pct: number | null;
    tapoff_A: number | null;
    busway_A: number | null;
    plant_supply_C: number | null;
  };
  metros?: string[];
  basis?: string;
}

export function BindingConstraintInsights({ compact = false }: { compact?: boolean }) {
  const [data, setData] = useState<Insights | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch("/api/insights")
      .then((r) => r.json())
      .then((b) => alive && (b?.ok ? setData(b as Insights) : setFailed(true)))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, []);

  if (failed || !data) return null;

  if (!data.published) {
    return (
      <div className="rounded border border-dashed border-line px-5 py-6">
        <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">
          What actually binds
        </p>
        <p className="mt-2 text-sm text-mute">
          {data.halls} hall{data.halls === 1 ? "" : "s"} through the engine so far. {data.reason}
        </p>
      </div>
    );
  }

  const top = Math.max(...(data.constraints ?? []).map((c) => c.halls), 1);
  const rows = compact ? (data.constraints ?? []).slice(0, 4) : (data.constraints ?? []);

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">
            What actually binds
          </p>
          <p className="mt-1 text-sm text-mute">
            Across {data.halls} halls run through the engine
            {typeof data.blocked_as_found === "number"
              ? ` · ${data.blocked_as_found} cannot host the target platform as they stand`
              : ""}
            .
          </p>
        </div>
        {data.medians?.tapoff_A ? (
          <p className="font-mono text-xs text-faint">
            median tap-off {data.medians.tapoff_A} A · busway {data.medians.busway_A} A · plant{" "}
            {data.medians.plant_supply_C}&nbsp;°C
          </p>
        ) : null}
      </div>

      <div className="grid gap-2">
        {rows.map((c) => (
          <div key={c.constraint} className="rounded border border-line bg-panel-2 p-3">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-sm text-ghost">{c.constraint}</span>
              <span className="font-mono text-sm text-chart">
                {c.halls}
                <span className="text-faint"> · {Math.round(c.share * 100)}%</span>
              </span>
            </div>
            <div className="mt-2 h-1.5 w-full rounded bg-line">
              <div
                className="h-1.5 rounded bg-chart"
                style={{ width: `${Math.max(2, Math.round((c.halls / top) * 100))}%` }}
                title={`${c.constraint}: ${c.halls} halls`}
              />
            </div>
          </div>
        ))}
      </div>

      {!compact && data.basis ? (
        <p className="mt-4 max-w-3xl text-[11px] leading-relaxed text-faint">{data.basis}</p>
      ) : null}
    </div>
  );
}
