// Upstream fetch logic shared by the public routes /api/market, /api/grid and /api/queue and by the Observatory's live context
// (lib/observatory/sources.ts). It was lifted out of those routes WITHOUT changing what they answer: the request URLs, the
// request options, the arithmetic and the JSON each route returns are the same bytes as before
// (tests/site/observatory-core-routes-snapshot.test.ts pins that). Nothing here reads a clock or the network on its own: the
// caller passes fetch and now, and the defaults resolve to the globals at CALL time so a stubbed global fetch is honoured.
//
// Server-only in practice (it is only imported by route handlers and sources.ts), but it has no server-only imports.

export interface FeedOptions {
  /** Defaults to the global fetch at call time. */
  fetchImpl?: typeof fetch;
  /** Defaults to Date.now. */
  nowMs?: () => number;
  /** Abort the request after this long (the routes use 6000 and 5000, as before). */
  timeoutMs?: number;
  /** Extra request options merged in (the routes pass Next's `next: { revalidate }`). */
  init?: Record<string, unknown>;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

async function timedFetch(url: string, timeoutMs: number, opts: FeedOptions): Promise<Response> {
  const doFetch = opts.fetchImpl ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await doFetch(url, { signal: ctrl.signal, headers: { Accept: "application/json" }, ...(opts.init ?? {}) });
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// EPEX day-ahead via aWATTar
// ---------------------------------------------------------------------------------------------------------------------

export const AWATTAR_DE = "https://api.awattar.de/v1/marketdata";

type AwattarEntry = { start_timestamp: number; end_timestamp: number; marketprice: number; unit: string };

export interface MarketOk {
  ok: true;
  market: string;
  source: string;
  unit: string;
  /** The REQUEST time (ms), not the observation time of any price. */
  asOf: number;
  current: number;
  min: number;
  max: number;
  avg: number;
  spread: number;
  series: { t: number; price: number }[];
}
export type MarketBody = MarketOk | { ok: false; reason: string };

/** One published delivery interval, epoch ms, [start, end). */
export interface MarketInterval { start: number; end: number; eurPerMWh: number }

export async function fetchMarket(opts: FeedOptions = {}): Promise<{ body: MarketBody; intervals: MarketInterval[] }> {
  const fail = (reason: string) => ({ body: { ok: false, reason } as MarketBody, intervals: [] as MarketInterval[] });
  try {
    const res = await timedFetch(AWATTAR_DE, opts.timeoutMs ?? 6000, opts);
    if (!res.ok) return fail(`upstream ${res.status}`);

    const json = (await res.json()) as { data?: AwattarEntry[] };
    const rows = Array.isArray(json.data) ? json.data : [];
    const series = rows
      .filter((r) => typeof r.marketprice === "number" && typeof r.start_timestamp === "number")
      .map((r) => ({ t: r.start_timestamp, price: r2(r.marketprice) }));

    if (series.length === 0) return fail("empty");

    const prices = series.map((s) => s.price);
    const now = (opts.nowMs ?? Date.now)();
    const currentRow = rows.find((r) => now >= r.start_timestamp && now < r.end_timestamp);
    const current = currentRow ? r2(currentRow.marketprice) : series[0].price;
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    const avg = r2(prices.reduce((a, b) => a + b, 0) / prices.length);

    const body: MarketBody = {
      ok: true,
      market: "Germany / Luxembourg (DE-LU)",
      source: "EPEX Spot day-ahead via aWATTar",
      unit: "EUR/MWh",
      asOf: now,
      current,
      min,
      max,
      avg,
      spread: r2(max - min),
      series,
    };
    const intervals: MarketInterval[] = rows
      .filter(
        (r) =>
          typeof r.marketprice === "number" &&
          Number.isFinite(r.marketprice) &&
          Number.isFinite(r.start_timestamp) &&
          Number.isFinite(r.end_timestamp) &&
          r.end_timestamp > r.start_timestamp,
      )
      .map((r) => ({ start: r.start_timestamp, end: r.end_timestamp, eurPerMWh: r2(r.marketprice) }));
    return { body, intervals };
  } catch {
    return fail("fetch-failed");
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Fraunhofer ISE Energy-Charts generation mix
// ---------------------------------------------------------------------------------------------------------------------

export const ENERGY_CHARTS_DE = "https://api.energy-charts.info/public_power?country=de";

type PT = { name: string; data: (number | null)[] };

// Series that are NOT generation in MW (percentages, load, trade, charging).
const EXCLUDE = ["share", "load", "residual", "cross border", "pumped storage consumption"];
// Renewable generation keywords (pumped-storage discharge excluded explicitly).
const RENEW = ["solar", "wind", "hydro", "biomass", "geothermal"];

const isExcluded = (name: string) => {
  const n = name.toLowerCase();
  return EXCLUDE.some((e) => n.includes(e));
};
const isRenewable = (name: string) => {
  const n = name.toLowerCase();
  if (n.includes("pumped")) return false;
  return RENEW.some((r) => n.includes(r));
};

export interface GridOk {
  ok: true;
  source: string;
  country: string;
  /** The feed's own timestamp for the interval shown (ms): the time the data describes. */
  asOf: number;
  totalMW: number;
  renewablePct: number;
  mix: { name: string; mw: number; renewable: boolean }[];
}
export type GridBody = GridOk | { ok: false; reason: string };

export async function fetchGrid(opts: FeedOptions = {}): Promise<GridBody> {
  try {
    const res = await timedFetch(ENERGY_CHARTS_DE, opts.timeoutMs ?? 6000, opts);
    if (!res.ok) return { ok: false, reason: `upstream ${res.status}` };

    const json = (await res.json()) as { unix_seconds?: number[]; production_types?: PT[] };
    const secs = json.unix_seconds ?? [];
    const gen = (json.production_types ?? []).filter((p) => Array.isArray(p.data) && !isExcluded(p.name));
    if (secs.length === 0 || gen.length === 0) return { ok: false, reason: "empty" };

    // Walk backwards to the latest interval that actually has generation.
    let idx = -1;
    for (let i = secs.length - 1; i >= 0; i--) {
      let total = 0;
      let any = false;
      for (const p of gen) {
        const v = p.data[i];
        if (typeof v === "number") {
          any = true;
          if (v > 0) total += v;
        }
      }
      if (any && total > 0) {
        idx = i;
        break;
      }
    }
    if (idx < 0) return { ok: false, reason: "no-data" };

    let total = 0;
    let renew = 0;
    const mix = gen
      .map((p) => {
        const v = p.data[idx];
        const mw = typeof v === "number" && v > 0 ? v : 0;
        total += mw;
        const r = isRenewable(p.name);
        if (r) renew += mw;
        return { name: p.name, mw: Math.round(mw), renewable: r };
      })
      .filter((m) => m.mw > 0)
      .sort((a, b) => b.mw - a.mw);

    const top = mix.slice(0, 6);
    const otherMW = mix.slice(6).reduce((s, m) => s + m.mw, 0);
    if (otherMW > 0) top.push({ name: "Other", mw: Math.round(otherMW), renewable: false });

    const renewablePct = total > 0 ? Math.round((renew / total) * 1000) / 10 : 0;

    return {
      ok: true,
      source: "Fraunhofer ISE · Energy-Charts",
      country: "Germany",
      asOf: secs[idx] * 1000,
      totalMW: Math.round(total),
      renewablePct,
      mix: top,
    };
  } catch {
    return { ok: false, reason: "fetch-failed" };
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// EIA hourly demand overlay (only with EIA_API_KEY)
// ---------------------------------------------------------------------------------------------------------------------

export interface EiaLive { label: string; value: number; unit: string; asOf: string; source: string }

/**
 * The most recent hourly demand point from EIA open data, or null on any failure (best effort, as before).
 * `respondent` narrows to one reporting area ("US48" = Lower 48); the route passes none and so asks exactly what it always asked.
 * The key is placed in the request URL because EIA's API takes it there; this function never returns, logs or throws the URL.
 */
export async function fetchEiaDemand(
  key: string,
  opts: FeedOptions & { respondent?: string } = {},
): Promise<{ live: EiaLive; respondent: string | null } | null> {
  try {
    const url =
      "https://api.eia.gov/v2/electricity/rto/region-data/data/" +
      "?api_key=" + key +
      "&frequency=hourly&data[0]=value&facets[type][]=D" +
      (opts.respondent ? "&facets[respondent][]=" + encodeURIComponent(opts.respondent) : "") +
      "&sort[0][column]=period&sort[0][direction]=desc&length=1";
    const res = await timedFetch(url, opts.timeoutMs ?? 5000, opts);
    if (res.ok) {
      const j = await res.json();
      const row = j?.response?.data?.[0];
      if (row && typeof row.value !== "undefined") {
        return {
          live: {
            label: "US grid demand",
            value: Math.round(Number(row.value)),
            unit: "MW",
            asOf: row.period || "",
            source: "EIA open data (live)",
          },
          respondent: typeof row.respondent === "string" ? row.respondent : null,
        };
      }
    }
  } catch {
    // Live overlay is best-effort; snapshots always stand on their own.
  }
  return null;
}
