import { NextResponse } from "next/server";

/**
 * Live German day-ahead power price (EPEX Spot via aWATTar, DE-LU zone).
 *
 * Fetched SERVER-SIDE so there's no CORS issue and the upstream fair-use limit
 * is respected via caching (revalidate 30 min → well under 100 req/day). This
 * endpoint returns ONLY real fetched data. On any upstream failure it returns
 * { ok: false } — the client shows "unavailable", never a fabricated number.
 *
 * aWATTar response shape: { data: [{ start_timestamp, end_timestamp,
 * marketprice, unit: "Eur/MWh" }, ...] } — prices from now up to ~24h ahead.
 */

const AWATTAR_DE = "https://api.awattar.de/v1/marketdata";
export const revalidate = 1800; // 30 minutes

type AwattarEntry = {
  start_timestamp: number;
  end_timestamp: number;
  marketprice: number;
  unit: string;
};

const r2 = (n: number) => Math.round(n * 100) / 100;

export async function GET() {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    const res = await fetch(AWATTAR_DE, {
      signal: ctrl.signal,
      headers: { Accept: "application/json" },
      next: { revalidate: 1800 },
    });
    clearTimeout(timer);

    if (!res.ok) {
      return NextResponse.json({ ok: false, reason: `upstream ${res.status}` });
    }

    const json = (await res.json()) as { data?: AwattarEntry[] };
    const rows = Array.isArray(json.data) ? json.data : [];
    const series = rows
      .filter(
        (r) =>
          typeof r.marketprice === "number" &&
          typeof r.start_timestamp === "number"
      )
      .map((r) => ({ t: r.start_timestamp, price: r2(r.marketprice) }));

    if (series.length === 0) {
      return NextResponse.json({ ok: false, reason: "empty" });
    }

    const prices = series.map((s) => s.price);
    const now = Date.now();
    const currentRow = rows.find(
      (r) => now >= r.start_timestamp && now < r.end_timestamp
    );
    const current = currentRow ? r2(currentRow.marketprice) : series[0].price;
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    const avg = r2(prices.reduce((a, b) => a + b, 0) / prices.length);

    return NextResponse.json({
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
    });
  } catch {
    return NextResponse.json({ ok: false, reason: "fetch-failed" });
  }
}
