// Shared helpers for the Observatory core tests: a routed fake fetch (no real network, ever) and upstream payload builders.
export const T0 = Date.UTC(2026, 9, 25, 10, 30, 0); // 2026-10-25T10:30:00Z
export const H = 3600_000;
export const MIN = 60_000;

export const EIA_KEY = "eia-secret-key-9f3a7c1e5b";

export interface Call { url: string; init: Record<string, unknown> | undefined }

export type Handler = (url: string) => Response | Promise<Response>;
export interface Routes { market?: Handler; grid?: Handler; eia?: Handler }

export const jsonResponse = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });

export const NEVER: Handler = () => new Promise<Response>(() => {});

/** A fetch that answers by host and records every call. An unrouted host is a test failure, not a network call. */
export function routedFetch(routes: Routes) {
  const calls: Call[] = [];
  const fn = (async (input: unknown, init?: Record<string, unknown>) => {
    const url = String(input);
    calls.push({ url, init });
    const h = url.includes("awattar") ? routes.market : url.includes("energy-charts") ? routes.grid : url.includes("api.eia.gov") ? routes.eia : undefined;
    if (!h) throw new Error(`unrouted fetch in test: ${url.replace(/api_key=[^&]*/, "api_key=***")}`);
    return h(url);
  }) as unknown as typeof fetch;
  return { fn, calls, count: (host: string) => calls.filter((c) => c.url.includes(host)).length };
}

export interface HourRow { start_timestamp: number; end_timestamp: number; marketprice: number; unit: string }
export function interval(start: number, lengthMs: number, price: number): HourRow {
  return { start_timestamp: start, end_timestamp: start + lengthMs, marketprice: price, unit: "Eur/MWh" };
}
/** n consecutive hourly rows from `start`, price = base + index. */
export function hourly(start: number, n: number, base = 50): HourRow[] {
  return Array.from({ length: n }, (_, i) => interval(start + i * H, H, base + i));
}
export const awattar = (rows: unknown[]): Handler => () => jsonResponse({ data: rows });

/** An Energy-Charts payload whose latest complete interval is at `lastSecs`. */
export function energyCharts(lastSecs: number) {
  const secs = [lastSecs - 1800, lastSecs - 900, lastSecs];
  return {
    unix_seconds: secs,
    production_types: [
      { name: "Wind onshore", data: [100, 200, 300] },
      { name: "Solar", data: [0, 50, 100] },
      { name: "Fossil gas", data: [50, 60, 70] },
      { name: "Load", data: [999, 999, 999] },
    ],
  };
}
export const grid = (lastSecs: number): Handler => () => jsonResponse(energyCharts(lastSecs));

export const eiaRow = (period: string, value: number | string, respondent: string | null = "US48"): Handler => () =>
  jsonResponse({ response: { data: [{ period, value, ...(respondent ? { respondent } : {}) }] } });
