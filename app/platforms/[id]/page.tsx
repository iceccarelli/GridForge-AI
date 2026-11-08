import { QuestionList } from "@/components/QuestionList";
import { platformQuestions } from "@/lib/qa";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PageJsonLd } from "@/components/PageJsonLd";
import { platformLibrary } from "@/lib/constraints";
import { orgRef } from "@/lib/entity";
import { breadcrumbJsonLd } from "@/lib/jsonld";
import { PLATFORM_CONSTRAINT_SLUGS, derive, pageablePlatforms } from "@/lib/platform-pages";
import { OG_BASE, SITE, SITE_URL, siteUrl } from "@/lib/site";
import { QUALIFY_LINK } from "@/lib/nav";
import { fitText, pageTitle } from "@/lib/meta";
import { PLATFORM_FIGURES_NOTE, platformDefinition } from "@/lib/definitions";

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
  const heading = `${p.name}: rack power and floor loading`;
  const description = fitText(`${p.name}: ${p.rack_kW} kW per rack, ${(p.liquid_fraction * 100).toFixed(0)}% captured by liquid, ${p.residual_air_kW} kW residual air, ${p.flow_l_per_min_per_rack} l/min, ${p.floor_loading_kg_per_m2.toLocaleString("en-IE")} kg/m². Figures from cited sources, held as assumptions.`);
  return {
    title: pageTitle(heading, `${p.name} rack power`),
    description,
    alternates: { canonical: `/platforms/${id}` },
    openGraph: {
    ...OG_BASE, title: heading, description, url: `/platforms/${id}` },
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
    ["Rack feed", p.rack_feed_current_A ? `${p.rack_feed_current_A} A (assumed, at 400 V three-phase; confirm against an OEM drawing)` : "not in the library"],
    ["Power domain", p.voltage_domain],
  ];
  const dataset = {
    "@context": "https://schema.org",
    "@type": "Dataset",
    name: `${p.name} — published rack figures`,
    description: `Rack power, liquid capture, flow, mass and floor loading for the ${p.name} as the Time to Power capacity engine holds them: taken from the cited sources and carried as assumptions, not measurements.`,
    url: siteUrl(`/platforms/${p.id}`),
    creator: orgRef(),
    publisher: orgRef(),
    citation: p.sources,
    variableMeasured: rows.map(([name, value]) => ({ "@type": "PropertyValue", name, value })),
  };
  return (
    <div className="mx-auto w-full max-w-4xl px-5 pb-24 pt-28 sm:px-8">
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
      <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-power">Rack library · {p.status}</p>
      <h1 className="mt-3 text-3xl font-semibold leading-tight text-ghost sm:text-4xl">
        What a {p.name} rack asks of an existing hall
      </h1>
      <p data-definition className="mt-4 text-lg text-ghost">{platformDefinition(p)}</p>
      <p className="mt-3 text-mute">
        {PLATFORM_FIGURES_NOTE} The engine uses them as stated. The sources are listed at the end. Where the library holds no value for a field it says so.
      </p>

      <dl className="mt-8 divide-y divide-line/60 rounded border border-line">
        {rows.map(([k, v]) => (
          <div key={k} className="grid gap-1 p-3 text-sm sm:grid-cols-[12rem_1fr] sm:gap-4">
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

      <QuestionList id="questions-h" items={platformQuestions(p)} />

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
          <Link href="/platforms" className="text-power underline">rack library</Link>.
        </p>
      </section>

      <div className="mt-10 flex flex-wrap items-center gap-4 border-t border-line pt-8">
        <Link href="/qualify" className="inline-flex min-h-11 items-center rounded bg-power px-5 py-2.5 font-semibold text-ink">
          {QUALIFY_LINK.label}
        </Link>
        <Link href="/products" className="inline-flex min-h-11 items-center text-sm text-power underline">
          Engagements
        </Link>
      </div>
    </div>
  );
}
