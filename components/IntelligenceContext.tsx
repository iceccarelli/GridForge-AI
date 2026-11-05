"use client";

// Market and grid CONTEXT for the Intelligence dashboard: the same provenance-bearing data and the same panel the Observatory uses
// (lib/observatory/sources.ts via /api/observatory/context, components/observatory/ContextPanel.tsx), so every figure here carries its
// source, the time it describes, when it was retrieved and its basis, and a feed that failed says "Unavailable" with nothing in its
// place. The panel recomputes freshness from the clock at render time, so a tab left open turns its readings stale instead of fresh.
//
// This is context. A wholesale price or a grid mix is not site headroom, and a queue statistic is not a load-connection probability.
import { useEffect, useState } from "react";
import type { LiveContext } from "@/lib/observatory/types";
import { ContextPanel, type ContextState } from "@/components/observatory/ContextPanel";

/** How often an open tab asks again. The server caches the raw feeds for five minutes, so asking faster changes nothing. */
export const REFRESH_MS = 5 * 60_000;
/** How often an open tab re-reads the clock, so freshness is judged against now and not against the moment of the fetch. */
export const CLOCK_MS = 30_000;
export const CONTEXT_URL = "/api/observatory/context";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function isObserved(v: unknown): boolean {
  if (!isObj(v) || !isObj(v.provenance)) return false;
  const p = v.provenance;
  return typeof v.freshness === "string" && typeof p.source === "string" && typeof p.basis === "string" && "value" in v;
}

/** A response body as a ContextState: anything that is not a complete LiveContext is "unavailable", never a partial render. */
export function parseContext(body: unknown): ContextState {
  if (!isObj(body)) return { ok: false, reason: "the response was not in the expected form" };
  if (body.ok === false) return { ok: false, reason: "the server could not assemble it" };
  const keys = ["dayAheadPrice", "generationMix", "queue", "usDemand"] as const;
  if (typeof body.generatedAt !== "string" || typeof body.referenceRegion !== "string" || !keys.every((k) => isObserved(body[k]))) {
    return { ok: false, reason: "the response was not in the expected form" };
  }
  return { ok: true, context: body as unknown as LiveContext };
}

export type Loaded = { phase: "loading" } | { phase: "done"; state: ContextState };

export function IntelligenceContextView({ loaded, now }: { loaded: Loaded; now: Date }) {
  return (
    <section aria-labelledby="context-h" data-context-block>
      <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
        <h2 id="context-h" className="text-lg font-semibold tracking-tight">Market and grid context</h2>
        <span className="data text-xs text-mute border border-line rounded px-2 py-0.5">CONTEXT, NOT SITE DATA</span>
      </div>
      <p className="text-mute text-[13px] mb-4 max-w-3xl">
        Each figure below states its source, the time it describes and when it was retrieved. A price is a published auction price, not a measurement of now and not headroom at any site. A queue figure is not a connection probability.
      </p>
      {loaded.phase === "loading" ? (
        <p role="status" className="text-sm text-mute">Reading the market and grid feeds…</p>
      ) : (
        <ContextPanel state={loaded.state} now={now} />
      )}
    </section>
  );
}

export function IntelligenceContext() {
  const [loaded, setLoaded] = useState<Loaded>({ phase: "loading" });
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    let on = true;
    const load = async () => {
      let state: ContextState;
      try {
        const res = await fetch(CONTEXT_URL, { cache: "no-store" });
        state = res.ok ? parseContext(await res.json().catch(() => null)) : { ok: false, reason: `the server answered ${res.status}` };
      } catch {
        state = { ok: false, reason: "the request failed" };
      }
      if (!on) return;
      setNow(new Date());
      setLoaded({ phase: "done", state });
    };
    void load();
    const fetchId = setInterval(load, REFRESH_MS);
    const clockId = setInterval(() => on && setNow(new Date()), CLOCK_MS);
    return () => { on = false; clearInterval(fetchId); clearInterval(clockId); };
  }, []);

  return <IntelligenceContextView loaded={loaded} now={now} />;
}
