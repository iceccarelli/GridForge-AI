import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PageJsonLd } from "@/components/PageJsonLd";
import { platformLibrary } from "@/lib/constraints";
import { breadcrumbJsonLd } from "@/lib/jsonld";
import { PLATFORM_CONSTRAINT_SLUGS, derive, pageablePlatforms } from "@/lib/platform-pages";
import { OG_IMAGES, SITE, SITE_URL, siteUrl } from "@/lib/site";
import { QUALIFY_LINK } from "@/lib/nav";

export const dynamicParams = false;

async function pageable() {
  const lib = await platformLibrary();
  return lib ? pageablePlatforms(lib.platforms) : [];
}

export async function generateStaticParams() {
  return (await pageable()).map((p) => ({ id: p.id }));
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const p = (await pageable()).find((x) => x.id === id);
  if (!p) return {};
  const title = `${p.name} — rack power, liquid fraction, flow and floor loading`;
  const description = `${p.name}: ${p.rack_kW} kW per rack, ${(p.liquid_fraction * 100).toFixed(0)}% captured by liquid, ${p.residual_air_kW} kW residual air, ${p.flow_l_per_min_per_rack} l/min, ${p.floor_loading_kg_per_m2.toLocaleString("en-IE")} kg/m². Published figures with sources, and what an existing hall has to carry.`;
  return {
    title,
    description,
    alternates: { canonical: `/platforms/${id}` },
    openGraph: { images: OG_IMAGES, title, description, url: `/platforms/${id}` },
  };
}

export default async function PlatformPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const p = (await pageable()).find((x) => x.id === id);
  if (!p) notFound();
  const d = derive(p);
  const rows: [string, string][] = [
    ["Rack power", `${p.rack_kW} kW (peak ${p.peak_rack_kW} kW)`],
    ["GPUs per rack", String(p.gpus_per_rack)],
    ["Captured by liquid", `${(p.liquid_fraction * 100).toFixed(0)}%`],
    ["Residual air load", `${p.residual_air_kW} kW`],
    ["Maximum liquid inlet", `${p.max_inlet_liquid_C} °C`],
    ["Technology-loop flow", `${p.flow_l_per_min_per_rack} l/min per rack`],
    ["Rack mass", `${p.rack_mass_kg.toLocaleString("en-IE")} kg on ${p.rack_footprint_m2} m²`],
    ["Floor loading", `${p.floor_loading_kg_per_m2.toLocaleString("en-IE")} kg/m²`],
    ["Rack feed", p.rack_feed_current_A ? `${p.rack_feed_current_A} A` : "not published"],
    ["Power domain", p.voltage_domain],
  ];
  const dataset = {
    "@context": "https://schema.org",
    "@type": "Dataset",
    name: `${p.name} — published rack figures`,
    description: `Manufacturer-published rack power, liquid capture, flow, mass and floor loading for the ${p.name}, as used by the Time to Power capacity engine.`,
    url: siteUrl(`/platforms/${p.id}`),
    creator: { "@type": "Organization", name: SITE.name, url: SITE_URL },
    citation: p.sources,
    variableMeasured: rows.map(([name, value]) => ({ "@type": "PropertyValue", name, value })),
  };
  return (
    <main className="mx-auto w-full max-w-4xl px-5 pb-24 pt-28 sm:px-8">
      <PageJsonLd
        data={[
          dataset,
          breadcrumbJsonLd([
            { name: "Time to Power", path: "/" },
            { name: "AI rack platforms", path: "/platforms" },
            { name: p.name, path: `/platforms/${p.id}` },
          ]),
        ]}
      />
      <nav aria-label="Breadcrumb" className="mb-4 text-[12px] text-faint">
        <Link href="/" className="hover:text-power">Home</Link> /{" "}
        <Link href="/platforms" className="hover:text-power">Platforms</Link> / <span className="text-mute">{p.name}</span>
      </nav>
      <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-power">Platform library · {p.status}</p>
      <h1 className="mt-3 text-3xl font-semibold leading-tight text-ghost sm:text-4xl">
        What a {p.name} rack asks of an existing hall
      </h1>
      <p className="mt-4 text-mute">
        Each figure below is the manufacturer&rsquo;s own published value, used unchanged by the engine that screens halls. The
        sources are listed at the end. Where a figure was not published it says so; nothing is estimated to fill a gap.
      </p>

      <dl className="mt-8 divide-y divide-line/60 rounded border border-line">
        {rows.map(([k, v]) => (
          <div key={k} className="grid grid-cols-[12rem_1fr] gap-4 p-3 text-sm">
            <dt className="font-mono text-[11px] uppercase tracking-[0.12em] text-faint">{k}</dt>
            <dd className="text-ghost">{v}</dd>
          </div>
        ))}
      </dl>

      <section className="mt-10" aria-labelledby="arith-h">
        <h2 id="arith-h" className="text-xl font-semibold text-ghost">Arithmetic on those figures</h2>
        <p className="mt-2 text-sm text-mute">
          Plain arithmetic on the published values above, shown so you can check it. It is not a measurement of any hall.
        </p>
        <ul className="mt-3 list-disc space-y-2 pl-5 text-[15px] text-mute">
          <li>
            Liquid-captured heat per rack: {p.rack_kW} kW × {(p.liquid_fraction * 100).toFixed(0)}% ={" "}
            <span className="font-mono text-ghost">{d.liquid_kW.toFixed(1)} kW</span>.
          </li>
          <li>
            Loop flow per liquid-captured kW: {p.flow_l_per_min_per_rack} l/min ÷ {d.liquid_kW.toFixed(1)} kW ={" "}
            <span className="font-mono text-ghost">{d.flow_l_per_min_per_liquid_kW.toFixed(2)} l/min per kW</span>.
          </li>
          <li>
            Mass over footprint: {p.rack_mass_kg.toLocaleString("en-IE")} kg ÷ {p.rack_footprint_m2} m² ={" "}
            <span className="font-mono text-ghost">{Math.round(d.mass_over_footprint_kg_per_m2).toLocaleString("en-IE")} kg/m²</span>.
          </li>
          <li>
            Whole racks in 1 MW of IT load at the published rack power:{" "}
            <span className="font-mono text-ghost">{d.racks_per_MW_it}</span>. This is IT load only, before any cooling or
            distribution overhead, and says nothing about whether a given hall can feed them.
          </li>
        </ul>
      </section>

      <section className="mt-10" aria-labelledby="binds-h">
        <h2 id="binds-h" className="text-xl font-semibold text-ghost">Which of a hall&rsquo;s constraints it presses on</h2>
        <ul className="mt-3 space-y-2 text-[15px] text-mute">
          {PLATFORM_CONSTRAINT_SLUGS.map((c) => (
            <li key={c.slug}>
              <Link href={`/constraints/${c.slug}`} className="text-power underline">
                {c.slug.replace(/-/g, " ")}
              </Link>
              : {c.why}
            </li>
          ))}
        </ul>
        <p className="mt-3 text-sm text-mute">
          Which one binds first in a particular hall depends on that hall&rsquo;s numbers. The free qualifier finds out.
        </p>
      </section>

      <section className="mt-10" aria-labelledby="src-h">
        <h2 id="src-h" className="text-xl font-semibold text-ghost">Sources</h2>
        <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-mute">
          {p.sources.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ul>
        <p className="mt-3 text-sm text-faint">
          Vendor-sourced values are marked as such in the provenance of every study they appear in. Platforms whose rack power is
          unpublished are deliberately absent from the library; see the{" "}
          <Link href="/platforms" className="text-power underline">platform library</Link>.
        </p>
      </section>

      <div className="mt-10 flex flex-wrap items-center gap-4 border-t border-line pt-8">
        <Link href="/qualify" className="rounded bg-power px-5 py-2.5 font-semibold text-ink">
          {QUALIFY_LINK.label}
        </Link>
        <Link href="/products" className="text-sm text-power hover:underline">
          Engagements
        </Link>
      </div>
    </main>
  );
}
