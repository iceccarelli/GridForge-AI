import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, Ban } from "lucide-react";
import { platformLibrary } from "@/lib/constraints";

export const metadata: Metadata = {
  title: "AI rack platforms — power, liquid fraction, flow and floor loading",
  description:
    "Published rack power, liquid capture fraction, residual air load, technology-loop flow and floor loading for the AI platforms a retrofit has to carry — and the platforms we deliberately do not list, because the manufacturer has not published a rack power.",
  alternates: { canonical: "/platforms" },
  openGraph: {
    title: "AI rack platforms — what an existing hall has to carry",
    description:
      "Rack power, liquid fraction, residual air, flow and floor loading. Plus what is deliberately absent and why.",
    url: "/platforms",
  },
};

/**
 * The platform library, published — including the absences.
 *
 * The absences are the most credible thing on the page. Every competitor's table
 * carries a row for the platforms nobody has published a rack power for, with a
 * number somebody estimated. Ours says so instead, and that is the whole argument
 * for believing the rows that do have numbers.
 */
export default async function PlatformsPage() {
  const lib = await platformLibrary();
  if (!lib) {
    return (
      <main className="mx-auto w-full max-w-4xl px-5 pb-24 pt-28 sm:px-8">
        <p className="text-mute">The platform library is not built on this deployment.</p>
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-6xl px-5 pb-24 pt-28 sm:px-8">
      <header className="max-w-3xl">
        <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-power">
          Platform library
        </p>
        <h1 className="mt-3 text-3xl font-semibold leading-tight text-ghost sm:text-4xl">
          What an existing hall is actually being asked to carry.
        </h1>
        <p className="mt-4 text-mute">
          Every figure below comes from the manufacturer&rsquo;s own published material and is
          used unchanged by the engine that screens halls. Vendor-sourced values are marked as
          such in the provenance of every study they appear in.
        </p>
      </header>

      <div className="mt-10 overflow-x-auto rounded border border-line">
        <table className="w-full min-w-[820px] text-sm">
          <thead>
            <tr className="border-b border-line text-left font-mono text-[10px] uppercase tracking-[0.14em] text-faint">
              <th className="p-3">Platform</th>
              <th className="p-3 text-right">Rack kW</th>
              <th className="p-3 text-right">Peak</th>
              <th className="p-3 text-right">Liquid</th>
              <th className="p-3 text-right">Residual air</th>
              <th className="p-3 text-right">Max inlet</th>
              <th className="p-3 text-right">Flow</th>
              <th className="p-3 text-right">Floor</th>
              <th className="p-3 text-right">Feed</th>
            </tr>
          </thead>
          <tbody>
            {lib.platforms.map((p) => (
              <tr key={p.id} className="border-t border-line/60 align-top">
                <td className="p-3">
                  <span className="font-semibold text-ghost">{p.name}</span>
                  <span className="block text-[11px] text-faint">
                    {p.gpus_per_rack} GPUs · {p.status}
                  </span>
                  {p.generic ? (
                    <span className="mt-1 inline-block rounded bg-queue/15 px-1.5 py-0.5 text-[10px] text-queue">
                      generic archetype — no manufacturer, no source
                    </span>
                  ) : (
                    <span className="mt-1 block text-[10px] text-faint">
                      {p.sources.join(" · ")}
                    </span>
                  )}
                </td>
                <td className="p-3 text-right font-mono text-power">{p.rack_kW}</td>
                <td className="p-3 text-right font-mono text-mute">{p.peak_rack_kW}</td>
                <td className="p-3 text-right font-mono text-mute">
                  {(p.liquid_fraction * 100).toFixed(0)}%
                </td>
                <td className="p-3 text-right font-mono text-queue">{p.residual_air_kW} kW</td>
                <td className="p-3 text-right font-mono text-mute">{p.max_inlet_liquid_C} °C</td>
                <td className="p-3 text-right font-mono text-mute">
                  {p.flow_l_per_min_per_rack} l/min
                </td>
                <td className="p-3 text-right font-mono text-mute">
                  {p.floor_loading_kg_per_m2.toLocaleString("en-IE")} kg/m²
                </td>
                <td className="p-3 text-right font-mono text-mute">
                  {p.rack_feed_current_A ? `${p.rack_feed_current_A} A` : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <Note
          k="Residual air"
          v="is not zero"
          n="Liquid cooling shrinks the air load; it does not remove it. The remainder still needs the plant the hall already has."
        />
        <Note
          k="Floor loading"
          v="against ~1,220 kg/m²"
          n="A TIA-942 Rated-3 raised floor design value. Two of these platforms exceed it distributed, before any point load at the castors."
        />
        <Note
          k="Max inlet"
          v="sets your approach"
          n="The gap between your facility water and this figure is the approach a CDU actually has to work at — rarely the 5 K on the datasheet."
        />
      </div>

      <section className="mt-10 rounded border border-queue/40 bg-queue/10 p-6">
        <h2 className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.12em] text-queue">
          <Ban className="h-3.5 w-3.5" /> Deliberately absent
        </h2>
        <p className="mt-2 max-w-3xl text-sm text-mute">{lib.notice}</p>
        <dl className="mt-4 space-y-3">
          {Object.entries(lib.deliberately_absent).map(([id, why]) => (
            <div key={id}>
              <dt className="font-mono text-sm text-ghost">{id}</dt>
              <dd className="text-sm text-mute">{why}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="mt-10 flex flex-wrap items-center gap-4 rounded border border-line bg-panel-2 p-6">
        <div className="min-w-64 flex-1">
          <h2 className="text-lg font-semibold text-ghost">
            Can your hall take one of these?
          </h2>
          <p className="mt-1 text-sm text-mute">
            Pick the platform, give seven numbers about the hall, and the engine names the
            constraint that stops you first. Free.
          </p>
        </div>
        <Link
          href="/qualify"
          className="inline-flex items-center gap-2 rounded bg-power px-5 py-2.5 font-semibold text-ink"
        >
          Run your hall <ArrowRight className="h-4 w-4" />
        </Link>
        <Link
          href="/constraints"
          className="inline-flex items-center gap-2 rounded border border-line px-5 py-2.5 font-semibold text-ghost hover:border-power/50"
        >
          The thirteen constraints
        </Link>
      </section>
    </main>
  );
}

function Note({ k, v, n }: { k: string; v: string; n: string }) {
  return (
    <div className="rounded border border-line bg-panel-2 px-4 py-3">
      <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">{k}</p>
      <p className="mt-1 font-mono text-base font-semibold text-power">{v}</p>
      <p className="mt-1 text-xs text-faint">{n}</p>
    </div>
  );
}
