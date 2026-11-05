import type { Metadata } from "next";
import Link from "next/link";
import { ConstraintChain } from "@/components/diagrams/ConstraintChain";
import { RackDensityChart } from "@/components/diagrams/RackDensityChart";
import { PathList } from "@/components/for/PathList";
import { PageJsonLd } from "@/components/PageJsonLd";
import { constraintReference } from "@/lib/constraints";
import { GUIDE_SCENARIO_ID, guideScenario, modelPack, orderedConstraints } from "@/lib/guide-data";
import { breadcrumbJsonLd, webPageJsonLd } from "@/lib/jsonld";
import { pageImages } from "@/lib/page-cards";
import { FOUNDER_ID, ORG_ID } from "@/lib/entity";
import { OG_BASE, siteUrl } from "@/lib/site";

const PATH = "/guides/nameplate-vs-useful-compute";
const TITLE = "Nameplate megawatts are not useful AI compute";
const DESCRIPTION =
  "How the usable rack count of an existing AI hall is decided: the smallest of a chain of electrical, thermal and physical limits, not the first number on the contract. Method, a worked example from a synthetic reference hall, and what the method does not cover.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: PATH },
  twitter: { card: "summary_large_image", images: pageImages("guide-nameplate") },
  openGraph: { ...OG_BASE, images: pageImages("guide-nameplate"), title: TITLE, description: DESCRIPTION, url: PATH },
};

// Published on the date the check of its sources was made; there is no later "updated" claim because nothing has been updated since.
const PUBLISHED = "2026-11-03";

export default async function Guide() {
  const [pack, ref] = await Promise.all([modelPack(), constraintReference()]);
  const scenario = pack ? guideScenario(pack) : undefined;
  const grid = pack?.intake.document.grid;
  const ordered = scenario ? orderedConstraints(scenario) : null;
  const slugOf = (id: string) => ref?.constraints.find((c) => c.id === id)?.slug;
  const article = {
    "@context": "https://schema.org",
    "@type": "TechArticle",
    headline: TITLE,
    description: DESCRIPTION,
    url: siteUrl(PATH),
    datePublished: PUBLISHED,
    inLanguage: "en",
    author: { "@id": FOUNDER_ID },
    publisher: { "@id": ORG_ID },
    about: ["Data-centre power capacity", "Rack density", "Time to power"],
    isBasedOn: siteUrl("/reference/model_pack.json"),
    mainEntityOfPage: siteUrl(PATH),
  };
  return (
    <div className="mx-auto w-full max-w-3xl px-5 pb-24 pt-28 sm:px-8">
      <PageJsonLd
        data={[article, webPageJsonLd(PATH, TITLE, DESCRIPTION), breadcrumbJsonLd([{ name: "Time to Power", path: "/" }, { name: "Nameplate against useful compute", path: PATH }])]}
      />
      <nav aria-label="Breadcrumb" className="mb-4 text-[12px] text-faint">
        <Link href="/" className="hover:text-power">Home</Link> / <span className="text-mute">Nameplate against useful compute</span>
      </nav>
      <p className="eyebrow mb-3 text-power">GUIDE · EXISTING AI HALLS</p>
      <h1 className="[overflow-wrap:anywhere] text-3xl font-semibold leading-tight text-ghost sm:text-4xl">{TITLE}</h1>
      <p className="mt-2 text-[13px] text-faint">Vincenzo Grimaldi · <time dateTime={PUBLISHED}>3 November 2026</time> · founder-led, pilot-stage practice</p>

      <section aria-labelledby="answer-h" className="mt-8 rounded-lg border border-line bg-panel p-5">
        <h2 id="answer-h" className="data text-[11px] tracking-[0.14em] text-power">THE SHORT ANSWER</h2>
        <p className="mt-2 text-[16px] leading-relaxed text-ghost">
          The number of AI racks an existing hall can run is the <em>smallest</em> of a series of limits, one per stage between the utility connection and the rack, plus
          a few pass-or-fail gates. The contracted megawatts are only the first stage. In a hall built for lower density the smallest limit is usually a component
          nobody quoted when the capacity was sold, and it can be zero racks until that component is replaced.
        </p>
      </section>

      <section className="mt-10" aria-labelledby="method-h">
        <h2 id="method-h" className="text-xl font-semibold text-ghost">The method</h2>
        <ol className="mt-3 list-decimal space-y-2 pl-5 text-[15px] leading-relaxed text-mute">
          <li>For each constraint, work out how many racks of the target platform it permits, from the hall&rsquo;s own ratings, the platform&rsquo;s published rack power and the redundancy the hall keeps.</li>
          <li>Treat a pass-or-fail gate (can one rack position be fed at all? can the cooling architecture take this platform?) as zero racks until it passes.</li>
          <li>Take the minimum. That constraint binds; the others have headroom.</li>
          <li>Relieve the binding constraint, price and date the relief, and solve again. Repeating this is the headroom ladder.</li>
        </ol>
        <p className="mt-3 text-[15px] leading-relaxed text-mute">
          Counts are floored to whole racks, never rounded up. Each relation is public on its own page; start from{" "}
          <Link href="/constraints" className="text-power underline">the constraint reference</Link>. A figure&rsquo;s evidence class travels with it, and a result
          carries the weakest class that went into it (<Link href="/evidence" className="text-power underline">how the classes work</Link>).
        </p>
      </section>

      <div className="mt-8"><ConstraintChain /></div>

      <section className="mt-12" aria-labelledby="example-h">
        <h2 id="example-h" className="text-xl font-semibold text-ghost">Worked example: a synthetic reference hall</h2>
        {pack && scenario && grid && ordered ? (
          <>
            <p className="mt-3 text-[15px] leading-relaxed text-mute">
              This is the engine&rsquo;s published reference hall. It is <strong className="text-ghost">synthetic</strong>: invented to demonstrate the method, not a customer
              asset, and every figure below is modelled or assumed unless its basis says otherwise. The grid agreement is {grid.contracted_MW} MW contracted
              ({grid.firm_capacity_MVA} MVA firm), the site peak is {grid.current_site_peak_MW.value} MW and the existing IT load {grid.current_it_load_MW} MW. The target
              platform is <span className="font-mono">{pack.intake.document.compute.platform}</span>, in the scenario &ldquo;{scenario.name}&rdquo;.
            </p>
            <p className="mt-3 rounded-lg border border-line bg-panel px-4 py-3 text-[15px] text-ghost">
              As found, the hall carries <strong>{scenario.as_found.racks} racks</strong>, bound by <strong>{scenario.as_found.binding_name}</strong>. After the costed
              ladder it carries <strong>{scenario.after_ladder.racks}</strong>, bound next by <span className="font-mono">{scenario.after_ladder.binding}</span>.
            </p>
            <div className="mt-5 overflow-x-auto rounded border border-line" role="region" aria-label="Racks permitted by each constraint" tabIndex={0}>
              <table className="w-full min-w-[620px] text-left text-sm">
                <caption className="sr-only">Racks each constraint permits in the synthetic reference hall, smallest first, with the basis and evidence class</caption>
                <thead>
                  <tr className="border-b border-line font-mono text-[10px] uppercase tracking-[0.14em] text-faint">
                    <th scope="col" className="p-3">Constraint</th>
                    <th scope="col" className="p-3">Racks permitted</th>
                    <th scope="col" className="p-3">Basis (evidence class in brackets)</th>
                  </tr>
                </thead>
                <tbody>
                  {[...ordered.gates, ...ordered.counted].map((c) => {
                    const slug = slugOf(c.id);
                    return (
                      <tr key={c.id} className="border-t border-line/60 align-top">
                        <th scope="row" className="p-3 font-normal text-ghost">
                          {slug ? <Link href={`/constraints/${slug}`} className="inline-flex min-h-11 items-center underline underline-offset-4 hover:text-power">{c.name}</Link> : c.name}
                          {c.gate ? <span className="data ml-2 text-[10px] text-queue">GATE</span> : null}
                        </th>
                        <td className="p-3 font-mono text-ghost">{c.racks_permitted}</td>
                        <td className="p-3 text-mute">{c.basis}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="mt-3 text-[13px] leading-relaxed text-faint">
              Source: the engine&rsquo;s <a href="/reference/model_pack.json" className="text-power underline">published model pack</a> (schema{" "}
              <span className="font-mono">gridforge/model-pack/2</span>, generated {pack.generated}). Constraints the pack does not express as a count:{" "}
              {ordered.uncounted.map((c) => c.name).join(", ") || "none"}. The full document is on <Link href="/reference" className="text-power underline">the worked-example page</Link>.
            </p>
            <p className="mt-4 text-[15px] leading-relaxed text-mute">
              Read the table from the top: whichever row holds the smallest number sets the hall&rsquo;s capacity, however large the contracted figure and however
              many racks the other rows would allow. That is why the same hall can hold {grid.contracted_MW} MW of contract and run {scenario.as_found.racks} racks.
            </p>
          </>
        ) : (
          <p className="mt-3 text-[15px] text-mute">The reference model pack could not be read on this deployment, so no worked figures are shown rather than quoting any from memory.</p>
        )}
      </section>

      <section className="mt-12" aria-labelledby="density-h">
        <h2 id="density-h" className="text-xl font-semibold text-ghost">Why total power cannot answer the question</h2>
        <p className="mt-3 text-[15px] leading-relaxed text-mute">
          Dividing usable power by rack power gives how many racks you could feed if power were the only limit. It says nothing about whether any one position can
          be fed. The figure below applies the public rack-feed relation to a second, invented hall: with 63&nbsp;A tap-off units no rack above about 41&nbsp;kW can be fed, so
          the count is zero there even though total power would allow dozens.
        </p>
        <div className="mt-5"><RackDensityChart /></div>
      </section>

      <section className="mt-12" aria-labelledby="limits-h">
        <h2 id="limits-h" className="text-xl font-semibold text-ghost">What this does not cover</h2>
        <ul className="mt-3 list-disc space-y-2 pl-5 text-[15px] leading-relaxed text-mute">
          <li>It is a screening method, not a design, an approval or a statement that a hall can be loaded. Protection, commissioning, structural survey and the utility&rsquo;s own conditions are outside it.</li>
          <li>The reference hall is synthetic and the models have not been calibrated against measured data from a real hall: the calibration ledger is empty (<Link href="/evidence" className="text-power underline">see the evidence page</Link>).</li>
          <li>Where an input is not supplied, a labelled library default is used and listed in a data request. A missing value is never treated as zero and never produces a date.</li>
          <li>Lead times and costs are ranges from a reference library until a supplier quotation replaces them. They are not commitments.</li>
          <li>Time to Power sells no equipment. Relief options are modelled so a buyer can compare them, not offered for sale.</li>
        </ul>
      </section>

      <section className="mt-12" aria-labelledby="next-h">
        <h2 id="next-h" className="text-xl font-semibold text-ghost">Run it on your own hall</h2>
        <PathList path={[{ kind: "qualifier", why: "Seven numbers you already know, free. It names the constraint likely to bind first and what it had to assume." }, { kind: "density_screen", why: "One hall, with the first six rungs of the ladder and the inputs nobody has measured." }]} label="Next steps" />
      </section>
    </div>
  );
}
