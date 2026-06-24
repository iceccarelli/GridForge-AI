import { NextResponse } from "next/server";

/**
 * Live German generation mix + renewable share (Fraunhofer ISE, Energy-Charts).
 *
 * Source: https://api.energy-charts.info/public_power?country=de — no token,
 * CC BY 4.0. Returns { unix_seconds: [...], production_types: [{ name, data:
 * [MW|null] }] }. We snapshot the latest fully-reported interval and classify
 * each source as renewable or not to compute a live renewable share.
 *
 * Real data only. On any failure → { ok: false }; the client shows
 * "unavailable", never a fabricated number. Cached 15 min.
 */

const URL = "https://api.energy-charts.info/public_power?country=de";
export const dynamic = "force-dynamic"; // never fetch upstream at build time
export const revalidate = 900; // 15 minutes (request-time cache)

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

export async function GET() {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    const res = await fetch(URL, {
      signal: ctrl.signal,
      headers: { Accept: "application/json" },
      next: { revalidate: 900 },
    });
    clearTimeout(timer);
    if (!res.ok) return NextResponse.json({ ok: false, reason: `upstream ${res.status}` });

    const json = (await res.json()) as { unix_seconds?: number[]; production_types?: PT[] };
    const secs = json.unix_seconds ?? [];
    const gen = (json.production_types ?? []).filter(
      (p) => Array.isArray(p.data) && !isExcluded(p.name)
    );
    if (secs.length === 0 || gen.length === 0)
      return NextResponse.json({ ok: false, reason: "empty" });

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
    if (idx < 0) return NextResponse.json({ ok: false, reason: "no-data" });

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

    return NextResponse.json({
      ok: true,
      source: "Fraunhofer ISE · Energy-Charts",
      country: "Germany",
      asOf: secs[idx] * 1000,
      totalMW: Math.round(total),
      renewablePct,
      mix: top,
    });
  } catch {
    return NextResponse.json({ ok: false, reason: "fetch-failed" });
  }
}
