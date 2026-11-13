import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { LadderBars } from "@/components/diagrams/LadderBars";
import { PathList } from "@/components/for/PathList";
import { PageJsonLd } from "@/components/PageJsonLd";
import { QuestionList } from "@/components/QuestionList";
import K from "@/lib/engineering-constants.json";
import { EVIDENCE_CLASSES } from "@/lib/evidence-classes";
import { FOUNDER_ID, orgRef } from "@/lib/entity";
import { formatLeadTime } from "@/lib/date-basis";
import { breadcrumbJsonLd, webPageJsonLd } from "@/lib/jsonld";
import { pageImages } from "@/lib/page-cards";
import pageDates from "@/lib/page-lastmod.json";
import {
  COMPARISON_ID,
  RESIDUAL_AIR_ID,
  d1,
  displayBasis,
  faqItems,
  firstSentences,
  f1,
  fmt,
  fmtLead,
  fmtQty,
  lc,
  leadProvenanceFor,
  leadSourceFor,
  loadGuideModel,
  type GuideModel,
  type OrderedLimit,
  sentencesMatching,
  suppliedBandNote,
  type Qty,
  words,
} from "@/lib/retrofit-order-data";
import { OG_BASE, SITE, siteUrl } from "@/lib/site";

const PATH = "/guides/retrofit-order-of-limits";
// The heading, the structured-data headline and the search-result title are one string. The site name is added to the title (16 characters),
// so the title as shown is at most 60 characters (tests/site/metadata-limits.test.ts).
const TITLE = "The order of limits in a 100-150 kW retrofit";
const DESCRIPTION =
  "Which limit binds first when a hall built for lower density takes 100-150 kW racks, and in what order to relieve them. Worked on a synthetic hall.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: PATH },
  twitter: { card: "summary_large_image", images: pageImages("guide-retrofit-order") },
  openGraph: { ...OG_BASE, images: pageImages("guide-retrofit-order"), title: TITLE, description: DESCRIPTION, url: PATH },
};

// The date the sources were checked and the guide written. The date it last changed is NOT typed: it is the sitemap's own record
// (lib/page-lastmod.json, maintained by scripts/page-lastmod.mjs), and it is omitted while that record has no entry for this page.
const PUBLISHED = "2026-11-12";

function lastmodOf(route: string): string | null {
  const pages = (pageDates as unknown as { pages?: Record<string, { lastmod?: unknown }> }).pages;
  const d = pages?.[route]?.lastmod;
  return typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
}

const longDate = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

const P = "mt-3 text-[15px] leading-relaxed text-mute";
const H2 = "scroll-mt-24 text-xl font-semibold text-ghost";
const TH = "p-3 font-mono text-xs uppercase tracking-[0.1em] text-faint";
const A = "text-power underline";

/** A wide table in a region the keyboard can reach and scroll. */
function Scroll({ label, children }: { label: string; children: ReactNode }) {
  // The cue is text, always shown, and named by the region (aria-describedby): a reader who cannot see a clipped column is told it is there.
  const cue = `scroll-cue-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
  return (
    <>
      <p id={cue} className="mt-4 text-xs text-faint">
        Scroll sideways to see every column. <span aria-hidden="true">↔</span>
      </p>
      <div className="mt-1 overflow-x-auto rounded border border-line" role="region" aria-label={label} aria-describedby={cue} tabIndex={0}>
        {children}
      </div>
    </>
  );
}

/** The source the pack records for a lead time, shown under it where the pack records one. */
function Src({ m, name }: { m: GuideModel; name: string }) {
  const label = leadSourceFor(m.scenario, name);
  return label ? <span className="mt-1 block text-[13px] text-faint">Source in the pack: {label}</span> : null;
}

/** The in-page list of sections: real anchors to the h2s, directly under the short answer. */
function JumpList({ m }: { m: GuideModel | null }) {
  const items: [string, string][] = [
    ["who-h", "Terms, and how this relates to the method"],
    ...(m
      ? ([
          ["case-h", "The case this guide shows"],
          ["arch-h", "Which cooling architectures can carry the rack"],
          ["order-h", "The order the limits bind in"],
          ["air-h", "Why liquid cooling does not remove the air-side limit"],
          ["seq-h", "The order to relieve them in"],
          ["limits-h", "Limit by limit, in the order they bind"],
          ["evidence-h", "How the evidence class changes the confidence"],
        ] as [string, string][])
      : ([["nodata-h", "The worked example"]] as [string, string][])),
    ["unknown-h", "What is not known, and what would establish it"],
    ["next-h", "Run it on your own hall"],
    ...(m ? ([["faq-h", "Common questions"]] as [string, string][]) : []),
  ];
  return (
    <nav aria-label="On this page" className="mt-6 rounded-lg border border-line p-4">
      <p className="data text-xs tracking-[0.14em] text-faint">ON THIS PAGE</p>
      <ol className="mt-2 grid gap-x-8 text-[15px] sm:grid-cols-2">
        {items.map(([id, label]) => (
          <li key={id}>
            <a href={`#${id}`} className="inline-flex min-h-11 items-center text-power underline underline-offset-4">{label}</a>
          </li>
        ))}
      </ol>
    </nav>
  );
}

const docOf = (m: GuideModel, id: string) => m.docs.get(id)!;
const joinAnd = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
const classOf = (evidence: string) => evidence.slice(0, 2);
const leadText = (q: Qty | null) => (q ? `${fmtQty(q)} (${classOf(q.evidence)})` : "none stated");
const leadProse = (q: Qty | null) => (q ? fmtLead(q) : "no lead time stated");

function LimitName({ m, id, className }: { m: GuideModel; id: string; className?: string }) {
  const d = docOf(m, id);
  return (
    <Link href={`/constraints/${d.slug}`} className={className ?? "underline underline-offset-4 hover:text-power"}>
      {d.name}
    </Link>
  );
}

function statePhrase(o: OrderedLimit, m: GuideModel): string {
  const after = m.scenario.afterLadder.racks;
  switch (o.state) {
    case "fails":
      return "A pass-or-fail gate, closed: it permits 0 racks as found.";
    case "passes":
      return "A pass-or-fail gate: the engine's check comes out as a pass on these inputs, so it attaches no rack count. That is the result of the stated arithmetic on the stated inputs, not an approval.";
    case "not_assessed":
      return "Not assessed in this example: the engine attaches no rack count, so this limit has not been shown adequate. That is not the same as passing.";
    case "not_applicable":
      return "Not used by this architecture, so it attaches no rack count.";
    default:
      return o.rungs.length === 0 && (o.racks as number) > after
        ? `A ceiling of ${fmt(o.racks as number)} racks as found, above the ${fmt(after)} the hall carries after the ladder, so it does not bind in this example.`
        : `A ceiling of ${fmt(o.racks as number)} racks as found.`;
  }
}

function src(m: GuideModel, name: string): string {
  const label = leadSourceFor(m.scenario, name);
  return label ? `; the pack records its source as “${label}”` : "";
}

function rungPhrase(o: OrderedLimit, m: GuideModel): string | null {
  if (!o.rungs.length) return null;
  return o.rungs
    .map((r) =>
      r.taken
        ? `Relieved at step ${r.step}: ${fmt(r.racksBefore)} → ${fmt(r.racksAfter)} racks, lead time ${leadProse(r.leadTime)}${src(m, r.name)}.`
        : `The next limit after the ladder (step ${r.step}); the engine does not take its relief: ${r.notTakenReason ?? "no reason stated"}.`,
    )
    .join(" ");
}

export default async function Guide() {
  const m = await loadGuideModel();
  const modified = lastmodOf(PATH);
  const article = {
    "@context": "https://schema.org",
    "@type": "TechArticle",
    headline: TITLE,
    description: DESCRIPTION,
    url: siteUrl(PATH),
    datePublished: PUBLISHED,
    // Present only once the sitemap record has an entry for this page; never a typed date.
    ...(modified ? { dateModified: modified } : {}),
    inLanguage: "en",
    author: { "@id": FOUNDER_ID },
    publisher: orgRef(),
    about: ["Data-centre power capacity", "Rack density", "Direct liquid cooling retrofit", "Time to power"],
    isBasedOn: [siteUrl("/reference/model_pack.json"), siteUrl("/reference/platforms.json")],
    mainEntityOfPage: siteUrl(PATH),
  };
  return (
    <div className="mx-auto w-full max-w-3xl px-5 pb-24 pt-28 sm:px-8">
      <PageJsonLd
        data={[article, webPageJsonLd(PATH, TITLE, DESCRIPTION), breadcrumbJsonLd([{ name: "Time to Power", path: "/" }, { name: "The order of limits in a retrofit", path: PATH }])]}
      />
      <nav aria-label="Breadcrumb" className="mb-4 text-[12px] text-faint">
        <Link href="/" className="hover:text-power">Home</Link> / <span className="text-mute">The order of limits in a retrofit</span>
      </nav>
      <p className="eyebrow mb-3 !text-xs text-power">GUIDE · EXISTING AI HALLS</p>
      <h1 className="[overflow-wrap:anywhere] text-3xl font-semibold leading-tight text-ghost sm:text-4xl">{TITLE}</h1>
      <p className="mt-2 text-[13px] text-faint">
        {SITE.founder} · <time dateTime={PUBLISHED}>{longDate(PUBLISHED)}</time>
        {modified && modified !== PUBLISHED ? <> · updated <time dateTime={modified}>{longDate(modified)}</time></> : null} · founder-led, pilot-stage practice
      </p>

      <p data-definition className="mt-6 text-[16px] leading-relaxed text-ghost">
        In this guide, a limit binds when it is the smallest of the ceilings on the racks a hall can run, or a pass-or-fail gate that holds that number at zero, and the order of limits
        is the sequence in which the binding limit changes as each is relieved in turn.
      </p>

      <p className="mt-4 text-[15px] leading-relaxed text-mute">
        <strong className="text-ghost">For:</strong> the owner, operator or engineer of an existing data hall, built for lower density, who has been told that the racks to be hosted draw 100 to 150 kW each.{" "}
        <strong className="text-ghost">The problem:</strong> the contracted megawatts are the first number anyone quotes, whether they are the first limit to bind is a separate question, and the answer decides what to fix first, what
        to order first and what to measure before committing.
      </p>

      {m ? <ShortAnswer m={m} /> : null}

      <JumpList m={m} />

      <section className="mt-10" aria-labelledby="who-h">
        <h2 id="who-h" className={H2}>Terms, and how this relates to the method</h2>
        <p className={P}>
          The method is the one in <Link href="/guides/nameplate-vs-useful-compute" className={A}>Nameplate power is not useful AI compute</Link>: the racks a hall can run are the smallest of a chain of
          limits. That guide shows the smallest. This one shows the sequence: which limit comes next once the smallest is relieved, and why that sequence differs from the order of the power chain and
          from the order in which the work should be started.
        </p>
        <dl className="mt-4 grid gap-3 text-[14px] leading-relaxed sm:grid-cols-2">
          {[
            ["Limit", "One of the constraints the engine checks in an existing hall. Each has its own page."],
            ["Ceiling", "A limit that permits a number of racks. The smallest ceiling sets the hall's count."],
            ["Gate", "A pass-or-fail limit. A gate that fails permits zero racks until it is relieved; one that passes attaches no count."],
            ["Residual air", "The heat of a liquid-cooled rack that still leaves it as warm air: rack power × (1 − the share captured by liquid)."],
            ["Headroom ladder", "Relieve the binding limit, price and date the relief, solve again. Each solve is a step."],
            ["Evidence class", "E0 (assumed) to E7 (observed in operation): how much has been done to a number. A result carries the weakest class that went into it."],
          ].map(([t, d]) => (
            <div key={t} className="rounded border border-line bg-panel p-3">
              <dt className="font-semibold text-ghost">{t}</dt>
              <dd className="mt-1 text-mute">{d}</dd>
            </div>
          ))}
        </dl>
      </section>

      {m ? (
        <>
          <CaseSection m={m} />
          <ArchitectureSection m={m} />
          <OrderSection m={m} />
          <ResidualAirSection m={m} />
          <SequenceSection m={m} />
          <LimitsSection m={m} />
          <EvidenceSection m={m} />
        </>
      ) : (
        <section className="mt-12" aria-labelledby="nodata-h">
          <h2 id="nodata-h" className={H2}>The worked example</h2>
          <p className={P}>The engine&rsquo;s published model pack, platform library or constraint reference could not be read on this deployment, or is not the version this guide was written against, so no worked figures are shown rather than quoting any from memory.</p>
        </section>
      )}

      <UnknownSection m={m} />

      <section className="mt-12" aria-labelledby="next-h">
        <h2 id="next-h" className={H2}>Run it on your own hall</h2>
        <p className={P}>
          None of the figures above is about your hall. The steps below take the same method to your numbers, in the order in which they ask for more of them and cost more. Prices are the catalogue&rsquo;s.
        </p>
        <PathList
          label="Next steps"
          path={[
            { kind: "qualifier", why: "Seven numbers you already know, free. It names the limit likely to bind first and what it had to assume. The tap-off rating is one of the seven." },
            { kind: "density_screen", why: "One hall, on your numbers: the limit that binds first, the racks as found and after the costed ladder, the item that sets the date, and the inputs nobody has measured, as a data request for your own engineers." },
            { kind: "envelope_study_deposit", why: "The whole ladder for your hall across the cooling architectures, with time to power and economics. The deposit opens a scoping conversation with a person; nothing is produced until the scope and fee are agreed." },
            { kind: "procurement_spec", why: "Once one relief is chosen, for example the long-lead item, a tender specification with every duty derived from the model at your site conditions, then your bids compared in racks and weeks." },
          ]}
        />
        <p className={P}>
          To see how cooling scenarios compare before any of that, the <Link href="/power/compare" className={A}>free scenario comparison</Link> takes a hall and dates a scenario only where its lead times support it.
          The thirteen limits are in <Link href="/constraints" className={A}>the constraint reference</Link>.
        </p>
      </section>

      {m ? <QuestionList id="faq-h" items={faqItems(m)} /> : null}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------------------------------------------

function ShortAnswer({ m }: { m: GuideModel }) {
  const { platform, pack, zero, order, band, starts } = m;
  const ceilings = order.filter((o) => o.state === "ceiling" && o.rungs.some((r) => r.taken));
  const airs = band ? band.rows.flatMap((r) => r.air.map((a) => a.kw)) : [];
  const first = starts[0];
  return (
    <section aria-labelledby="answer-h" className="mt-6 rounded-lg border border-line bg-panel p-5">
      <h2 id="answer-h" className="data scroll-mt-24 text-xs tracking-[0.14em] text-power">THE SHORT ANSWER</h2>
      <p className="mt-2 text-[16px] leading-relaxed text-ghost">
        In a hall built for lower density the limits do not bind in the order of the power chain from the grid. In the synthetic hall below, a rack of {platform.name} ({d1(platform.rack_kW)} kW)
        cannot run at all until {zero.length === 1 ? "one limit that applies to a single rack position is" : `${words(zero.length)} limits that apply to a single rack position are`} relieved:{" "}
        {joinAnd(zero.map((z) => lc(z.name)))}. {zero.length === 1 ? "It holds" : "They hold"} the count at zero racks before any capacity limit is reached. Only then do the hall-level ceilings
        take over, in this order: {joinAnd(ceilings.map((c) => lc(c.name)))}.
      </p>
      <p className="mt-3 text-[16px] leading-relaxed text-ghost">
        Liquid cooling does not remove the air-side limit. It moves most of the rack&rsquo;s heat into water, and the rest is still warm air: {d1(platform.residual_air_kW)} kW per rack here, against the{" "}
        {d1(pack.hall.residualAirKw.value)} kW that one position can remove.
        {airs.length ? <> Across the 100 to 150 kW band, at the library&rsquo;s liquid shares, the air-side load is {f1(Math.min(...airs))} to {f1(Math.max(...airs))} kW{airs.every((a) => a > pack.hall.residualAirKw.value) ? ", and no point of the band fits" : ""}.</> : null}
      </p>
      {first ? (
        <p className="mt-3 text-[16px] leading-relaxed text-ghost">
          The relief to start first is not the limit that binds first. {first.name} has the longest lead time in the example, {fmtLead(first.lead)}. {leadProvenanceFor(m.scenario, first.name)}
        </p>
      ) : null}
    </section>
  );
}

function CaseSection({ m }: { m: GuideModel }) {
  const { pack, platform, libraryPlatforms, scenario, comparison } = m;
  const h = pack.hall;
  const digest = scenario.afterLadder.digest;
  const items: [string, string][] = [
    ["Grid agreement", `${d1(h.contractedMW)} MW contracted, ${d1(h.firmCapacityMVA)} MVA firm; site peak ${d1(h.sitePeakMW)} MW; existing IT load ${d1(h.itLoadMW)} MW.`],
    ["Hall", `${fmt(h.rackPositions)} rack positions, ${fmt(h.positionsAvailable)} available; designed for ${fmt(h.designDensityKw)} kW per rack; ${h.containment.replace(/_/g, " ")} containment on a ${h.floorType.replace(/_/g, " ")}; built ${h.buildYear}.`],
    ["Rack feed", `${fmt(h.tapoffA)} A tap-off units on ${fmt(h.buswayA)} A busway, ${fmt(h.buswayRuns)} runs, ${d1(h.buswayUtilisation)} continuous-load limit, ${fmt(h.voltageV)} V.`],
    ["Per-position air capability", `${d1(h.residualAirKw.value)} kW per rack position (${h.residualAirKw.evidence}). ${h.residualAirKw.note}.`],
    ["Transformers", `${fmt(h.transformer.units)} × ${d1(h.transformer.ratingMVA)} MVA, ${h.transformer.redundancy}, derated to ${d1(h.transformer.derating)}.`],
    ["UPS", `${fmt(h.ups.units)} × ${fmt(h.ups.ratingKW)} kW, ${h.ups.redundancy}.`],
    ["Chilled-water plant", `${fmt(h.plant.capacityKW)} kW, ${fmt(h.plant.supplyC)} °C supply, ${fmt(h.plant.pumpFlowLpm)} l/min pump flow.`],
    ["Connection", h.queueNote],
  ];
  return (
    <section className="mt-12" aria-labelledby="case-h">
      <h2 id="case-h" className={H2}>The case this guide shows</h2>
      <p className="mt-3 rounded-lg border border-line bg-panel px-4 py-3 text-[15px] text-ghost" data-synthetic>
        <strong>Synthetic.</strong> {pack.notice}
      </p>
      <p className={P}>
        Every figure below is read from the engine&rsquo;s published <a href="/reference/model_pack.json" className={A}>model pack</a> (schema <span className="font-mono">{pack.schema}</span>, generated{" "}
        {pack.generated}){digest ? <>; the pack&rsquo;s deployable-load figure for the scenario followed here carries the provenance digest <span className="font-mono">{digest}</span>{scenario.afterLadder.model ? <> from <span className="font-mono">{scenario.afterLadder.model}</span></> : null}</> : null}
        {scenario.time.calculationVersion ? <>, and its schedule is calculated by <span className="font-mono">{scenario.time.calculationVersion}</span></> : null}. The hall is invented to demonstrate the
        method. It is not a customer asset, and nothing in it was measured.
      </p>
      <dl className="mt-4 grid gap-3 text-[14px] leading-relaxed sm:grid-cols-2">
        {items.map(([t, d]) => (
          <div key={t} className="rounded border border-line bg-panel p-3">
            <dt className="font-semibold text-ghost">{t}</dt>
            <dd className="mt-1 text-mute">{d}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-3 text-[13px] leading-relaxed text-faint">{h.floorLoadingNote}. The engine treats a declared rating as supplied by the client (class E5), not as measured.</p>

      <h3 className="mt-8 text-lg font-semibold text-ghost">The rack</h3>
      <p className={P}>
        The target platform is <span className="font-mono">{platform.id}</span>. The library holds the figures below as assumptions, taken from the sources cited. A source marked [V] is a vendor or marketing
        claim, and stays one: it is never treated here as validated performance. See <Link href={`/platforms/${platform.id}`} className={A}>the {platform.name} page</Link>.
      </p>
      <Scroll label="Rack platforms in the library at this density">
        <table className="w-full min-w-[640px] text-left text-sm">
          <caption className="sr-only">Rack power, liquid share, air-side load and feed current of the sourced NVL72 platforms in the engine&rsquo;s library, with their sources</caption>
          <thead>
            <tr className="border-b border-line">
              <th scope="col" className={TH}>Platform</th>
              <th scope="col" className={TH}>Rack kW (peak)</th>
              <th scope="col" className={TH}>Liquid share</th>
              <th scope="col" className={TH}>Air-side kW</th>
              <th scope="col" className={TH}>Feed A ({K.rack_feed.library_feed_current_class}, ±{Math.round(K.rack_feed.library_feed_current_band_fraction * 100)}%)</th>
              <th scope="col" className={TH}>Sources</th>
            </tr>
          </thead>
          <tbody>
            {libraryPlatforms.map((p) => (
              <tr key={p.id} className="border-t border-line/60 align-top">
                <th scope="row" className="p-3 font-normal text-ghost"><Link href={`/platforms/${p.id}`} className="inline-flex min-h-11 items-center underline underline-offset-4 hover:text-power">{p.name}</Link></th>
                <td className="p-3 font-mono text-ghost">{d1(p.rack_kW)} ({d1(p.peak_rack_kW)})</td>
                <td className="p-3 font-mono text-ghost">{Math.round(p.liquid_fraction * 100)}%</td>
                <td className="p-3 font-mono text-ghost">{d1(p.residual_air_kW)}</td>
                <td className="p-3 font-mono text-ghost">{p.rack_feed_current_A ?? "n/a"}</td>
                <td className="p-3 text-mute">{p.sources.join("; ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Scroll>

      <h3 className="mt-8 text-lg font-semibold text-ghost">Which cases are shown, and which are not</h3>
      <ul className="mt-3 list-disc space-y-2 pl-5 text-[15px] leading-relaxed text-mute">
        <li>
          <strong className="text-ghost">Shown:</strong> one rack, the library&rsquo;s {platform.name} at {d1(platform.rack_kW)} kW, solved by the engine in {fmt(pack.scenarios.length)} scenarios. The guide follows
          &ldquo;{scenario.name}&rdquo;: {lc(firstSentences(scenario.rationale, 1).replace(/\.$/, ""))}.{comparison ? <> It sets &ldquo;{comparison.name}&rdquo; beside it where the order differs.</> : null}
        </li>
        <li>
          <strong className="text-ghost">Not shown:</strong> separate engine solves at {m.band ? `${joinAnd(m.band.rows.map((r) => d1(r.kw)))} kW` : "each rack power in the band"}. The pack does not contain them and this guide does not run new ones. Those figures are the points
          where the library&rsquo;s practical per-rack ranges for the two liquid architectures start and stand (the architecture table below shows the ranges). The two per-position limits can be read across that band by arithmetic on
          their published relations, and are, in a section that says it is arithmetic and not a solve.
        </li>
        <li>
          <strong className="text-ghost">Not shown:</strong> any other hall, any other platform solved, or any real hall. The order is a property of this hall&rsquo;s ratings.
        </li>
      </ul>
    </section>
  );
}

function ArchitectureSection({ m }: { m: GuideModel }) {
  const { pack, platform } = m;
  return (
    <section className="mt-12" aria-labelledby="arch-h">
      <h2 id="arch-h" className={H2}>Which cooling architectures can carry the rack at all</h2>
      <p className={P}>
        Before capacity, the engine asks a yes-or-no question: can the cooling architecture hold a rack of this power at all? The library&rsquo;s practical range per rack is a default for the architecture, not a
        manufacturer&rsquo;s rating or a site measurement. See <LimitName m={m} id="architecture_capability" className={A} />. The 100 to 150 kW band of this guide is where the two liquid architectures sit.
      </p>
      <Scroll label="Practical per-rack capability of each architecture, and the result after the ladder">
        <table className="w-full min-w-[680px] text-left text-sm">
          <caption className="sr-only">For each cooling architecture the engine solved: the library&rsquo;s practical per-rack range against the platform&rsquo;s draw, and the racks and binding limit after the ladder</caption>
          <thead>
            <tr className="border-b border-line">
              <th scope="col" className={TH}>Architecture</th>
              <th scope="col" className={TH}>Practical range against the rack (class)</th>
              <th scope="col" className={TH}>After the ladder</th>
            </tr>
          </thead>
          <tbody>
            {pack.scenarios.map((s) => {
              const cap = s.constraints.find((c) => c.id === "architecture_capability");
              const bind = m.docs.get(s.afterLadder.binding)?.name ?? s.afterLadder.binding;
              return (
                <tr key={s.id} className="border-t border-line/60 align-top">
                  <th scope="row" className="p-3 font-normal text-ghost">{s.name}</th>
                  <td className="p-3 text-mute">{cap ? displayBasis(cap.basis) : "not stated"}</td>
                  <td className="p-3 text-mute"><span className="font-mono text-ghost">{fmt(s.afterLadder.racks)}</span> racks{s.afterLadder.racks > 0 ? <>, bound next by {lc(bind)}</> : <>: {cap?.racks === 0 ? "the architecture cannot hold the rack" : "no rack runs"}</>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Scroll>
      <p className="mt-3 text-[13px] leading-relaxed text-faint">
        The pack notes one modelling limit: the platform&rsquo;s peak rack power ({d1(platform.peak_rack_kW)} kW) is used by no constraint, and every limit is sized on the rack power figure ({d1(platform.rack_kW)} kW). Transients above
        the sustained figure are not added, so the transformer and UPS headroom printed below may be overstated.
      </p>
    </section>
  );
}

function OrderSection({ m }: { m: GuideModel }) {
  const { scenario, comparison } = m;
  const steps = scenario.ladder;
  const noGain = steps.filter((s) => s.taken && s.racksAfter === s.racksBefore);
  const twice = [...new Set(steps.filter((s) => s.taken).map((s) => s.constraint))].filter((id) => steps.filter((s) => s.taken && s.constraint === id).length > 1);
  const notTaken = steps.filter((s) => !s.taken);
  const afterBinding = m.docs.get(scenario.afterLadder.binding)?.name;
  const toFirstRack = comparison ? comparison.ladder.findIndex((s) => s.racksAfter > 0) : -1;
  const cmpSteps = comparison && toFirstRack >= 0 ? comparison.ladder.slice(0, toFirstRack + 1) : [];
  const fullKeepsAir = cmpSteps.some((s) => s.constraint === RESIDUAL_AIR_ID) && m.zero.every((z) => cmpSteps.some((s) => s.constraint === z.id));
  const fullAddsWater = cmpSteps.some((s) => s.constraint === "tcs_supply_achievable");
  return (
    <section className="mt-12" aria-labelledby="order-h">
      <h2 id="order-h" className={H2}>The order the limits bind in</h2>
      <p className={P}>
        The headroom ladder solves the hall, names the binding limit, relieves it and solves again. For &ldquo;{scenario.name}&rdquo; the sequence is below. As found the hall carries{" "}
        <strong className="text-ghost">{fmt(scenario.asFound.racks)} racks</strong>, bound by {lc(scenario.asFound.bindingName)}. After {fmt(steps.filter((s) => s.taken).length)} costed steps it carries{" "}
        <strong className="text-ghost">{fmt(scenario.afterLadder.racks)}</strong>{afterBinding ? <>, bound next by {lc(afterBinding)}</> : null}.
      </p>
      <div className="mt-5">
        <LadderBars
          idPrefix="ladder"
          eyebrow="SYNTHETIC HALL, ENGINE-MODELLED"
          heading="Zero racks across the first steps, then each ceiling in turn."
          steps={steps.map((s) => ({ step: s.step, name: s.name, before: s.racksBefore, after: s.racksAfter, taken: s.taken }))}
        />
      </div>
      <p className="mt-3 text-[13px] leading-relaxed text-faint">Every plotted value is in the table below. Source: the pack&rsquo;s <span className="font-mono">ladder</span> for <span className="font-mono">{scenario.id}</span>. Lead times are assumptions (class E0), not quotations; the pack says where one of them came from, in the section on the order to relieve them in.</p>

      <Scroll label="The headroom ladder for the scenario followed in this guide">
        <table className="w-full min-w-[720px] text-left text-sm">
          <caption className="sr-only">The headroom ladder: each step, the limit relieved, the racks before and after, what relieves it and its assumed lead time in weeks</caption>
          <thead>
            <tr className="border-b border-line">
              <th scope="col" className={TH}>Step</th>
              <th scope="col" className={TH}>Limit that binds</th>
              <th scope="col" className={TH}>Racks before → after</th>
              <th scope="col" className={TH}>What relieves it</th>
              <th scope="col" className={TH}>Lead time, weeks</th>
            </tr>
          </thead>
          <tbody>
            {steps.map((s) => (
              <tr key={s.step} className="border-t border-line/60 align-top">
                <td className="p-3 font-mono text-ghost">{s.step}</td>
                <th scope="row" className="p-3 font-normal text-ghost">
                  {m.docs.has(s.constraint) ? <LimitName m={m} id={s.constraint} /> : s.name}
                  {!s.taken ? <span className="data ml-2 text-xs text-queue">NOT TAKEN</span> : null}
                </th>
                <td className="p-3 font-mono text-ghost">{fmt(s.racksBefore)} → {fmt(s.racksAfter)}</td>
                <td className="p-3 text-mute">
                  {s.relief}
                  {s.risk ? <span className="mt-1 block text-[13px] text-faint">{s.risk}</span> : null}
                  {!s.taken && s.notTakenReason ? <span className="mt-1 block text-[13px] text-faint">Not taken: {s.notTakenReason}.</span> : null}
                </td>
                <td className="p-3 text-mute">{leadText(s.leadTime)}<Src m={m} name={s.name} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Scroll>

      <h3 className="mt-8 text-lg font-semibold text-ghost">How to read the sequence</h3>
      <ul className="mt-3 list-disc space-y-2 pl-5 text-[15px] leading-relaxed text-mute">
        {noGain.length ? (
          <li>
            {noGain.length === 1 ? "Step" : "Steps"} {joinAnd(noGain.map((s) => String(s.step)))} {noGain.length === 1 ? "relieves" : "relieve"} {joinAnd(noGain.map((s) => lc(s.name)))} and leave{noGain.length === 1 ? "s" : ""} the count at{" "}
            {joinAnd([...new Set(noGain.map((s) => fmt(s.racksBefore)))])}: another limit was already as low. The engine names one binding limit at a time. When several gates are at zero, relieving one shows the next, which is why
            the ladder, and not the single name in the headline, is the record of the order.
          </li>
        ) : null}
        {twice.map((id) => (
          <li key={id}>
            {docOf(m, id).name} binds twice, at steps {joinAnd(steps.filter((s) => s.taken && s.constraint === id).map((s) => String(s.step)))}: once the limits below it have been raised it is the smallest again.
          </li>
        ))}
        {notTaken.map((s) => (
          <li key={s.step}>
            {s.name} is next and the engine does not take its relief: &ldquo;{s.notTakenReason}&rdquo;. The count stays at {fmt(s.racksAfter)}.
          </li>
        ))}
        <li>The lead times in the table are assumptions. The order of the steps follows the ratings and the rack. The lead times decide how long each step takes and which to start first, in the sequencing section below.</li>
      </ul>

      {comparison && toFirstRack >= 0 ? (
        <>
          <h3 className="mt-8 text-lg font-semibold text-ghost">The same hall with a dedicated warm-water loop</h3>
          <p className={P}>
            In &ldquo;{comparison.name}&rdquo; the ladder needs {words(toFirstRack + 1)} steps before the first rack runs.{fullKeepsAir ? " The per-position air limit is still among them." : ""}
          </p>
          <Scroll label="The first steps of the ladder for the full direct liquid cooling scenario">
            <table className="w-full min-w-[560px] text-left text-sm">
              <caption className="sr-only">The steps of the full direct liquid cooling ladder up to the first one that adds racks</caption>
              <thead>
                <tr className="border-b border-line">
                  <th scope="col" className={TH}>Step</th>
                  <th scope="col" className={TH}>Limit that binds</th>
                  <th scope="col" className={TH}>Racks before → after</th>
                  <th scope="col" className={TH}>Lead time, weeks</th>
                </tr>
              </thead>
              <tbody>
                {cmpSteps.map((s) => (
                  <tr key={s.step} className="border-t border-line/60 align-top">
                    <td className="p-3 font-mono text-ghost">{s.step}</td>
                    <th scope="row" className="p-3 font-normal text-ghost">{m.docs.has(s.constraint) ? <LimitName m={m} id={s.constraint} /> : s.name}</th>
                    <td className="p-3 font-mono text-ghost">{fmt(s.racksBefore)} → {fmt(s.racksAfter)}</td>
                    <td className="p-3 text-mute">{leadText(s.leadTime)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Scroll>
          <p className={P}>
            {fullAddsWater && fullKeepsAir ? <>A fully liquid architecture adds a limit of its own, the temperature of the facility water, and removes neither per-position limit. </> : null}Which architecture is cheaper, faster or more efficient is a
            question for the Envelope Study; this guide is about the order.
          </p>
        </>
      ) : null}
    </section>
  );
}

function ResidualAirSection({ m }: { m: GuideModel }) {
  const { pack, platform, band, libraryPlatforms } = m;
  const air = pack.hall.residualAirKw.value;
  const exceeds = platform.residual_air_kW > air;
  const ratio = platform.rack_kW / platform.residual_air_kW;
  const bandMin = band ? Math.min(...band.rows.map((r) => r.kw)) : null;
  const allBelow = band && bandMin !== null ? band.maxRackOnAir.every((a) => a.kw < bandMin) : false;
  const relief = docOf(m, RESIDUAL_AIR_ID);
  const reliefStep = m.scenario.ladder.find((s) => s.constraint === RESIDUAL_AIR_ID && s.taken);
  const allZero = pack.scenarios.every((s) => s.constraints.find((c) => c.id === RESIDUAL_AIR_ID)?.racks === 0);
  // Scenarios whose row is the same sentence and the same count are one row of the table.
  const airRows: { basis: string; racks: number | null; names: string[] }[] = [];
  for (const s of pack.scenarios) {
    const c = s.constraints.find((x) => x.id === RESIDUAL_AIR_ID);
    const basis = c ? displayBasis(c.basis) : "not stated";
    const hit = airRows.find((r) => r.basis === basis && r.racks === (c?.racks ?? null));
    if (hit) hit.names.push(s.name);
    else airRows.push({ basis, racks: c?.racks ?? null, names: [s.name] });
  }
  const feedClosed = band ? band.rows.every((r) => r.feedLowA > pack.hall.tapoffA) : false;
  return (
    <section className="mt-12" aria-labelledby="air-h">
      <h2 id="air-h" className={H2}>Why liquid cooling does not remove the air-side limit</h2>
      <p className={P}>
        Direct liquid cooling captures most of a rack&rsquo;s heat in cold plates. The remainder is not captured, leaves the rack as warm air, and a position that was
        designed for {fmt(pack.hall.designDensityKw)} kW has to take it. The relation is on <LimitName m={m} id={RESIDUAL_AIR_ID} className={A} />:
        residual air = rack power × (1 − the share captured by liquid). For the {platform.name} that is {d1(platform.rack_kW)} × (1 − {String(platform.liquid_fraction)}) = {d1(platform.residual_air_kW)} kW.
      </p>

      <h3 className="mt-8 text-lg font-semibold text-ghost">What the engine finds, architecture by architecture</h3>
      <Scroll label="Air-side load against what one rack position can remove, for each architecture">
        <table className="w-full min-w-[640px] text-left text-sm">
          <caption className="sr-only">For each architecture the engine solved: the air-side load of one rack against what one position in the hall can remove, with evidence classes, and the racks the limit permits</caption>
          <thead>
            <tr className="border-b border-line">
              <th scope="col" className={TH}>Architecture</th>
              <th scope="col" className={TH}>Air-side load against position capability (class)</th>
              <th scope="col" className={TH}>Racks</th>
            </tr>
          </thead>
          <tbody>
            {airRows.map((r) => (
              <tr key={r.basis} className="border-t border-line/60 align-top">
                <th scope="row" className="p-3 font-normal text-ghost">{r.names.join("; ")}</th>
                <td className="p-3 text-mute">{r.basis}</td>
                <td className="p-3 font-mono text-ghost">{r.racks === null ? "passes" : fmt(r.racks)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Scroll>
      {exceeds ? (
        <p className={P}>
          Going from an air-cooled rack to direct liquid cooling takes the air-side load per rack from {d1(platform.rack_kW)} kW to {d1(platform.residual_air_kW)} kW, about {d1(Math.round(ratio * 10) / 10)} times lower. That is a large fall,
          and it is not enough: {d1(platform.residual_air_kW)} kW is still more than the {d1(air)} kW this hall&rsquo;s positions can remove{allZero ? <>, so the limit holds the count at
          zero in every scenario the engine solved, the liquid ones included. A full liquid architecture does not change that: the limit is about the air that is left, not about how the liquid is rejected</> : null}.
        </p>
      ) : null}

      {band ? (
        <>
          <h3 className="mt-8 text-lg font-semibold text-ghost">The same arithmetic across 100 to 150 kW</h3>
          <p className={P}>
            <strong className="text-ghost">Arithmetic, not an engine solve.</strong> The rack powers below are the points where the library&rsquo;s practical ranges for the two liquid architectures start and stand. Feed current is the
            library&rsquo;s {platform.name} figure ({fmt(platform.rack_feed_current_A ?? 0)} A at {d1(platform.rack_kW)} kW) scaled in proportion to rack power. It is one of the library&rsquo;s working values (class {band.feed.evidence}, band ±{Math.round(band.feed.bandFraction * 100)}%, stated at {fmt(band.feed.voltageV)} V three-phase), not an OEM figure, to be confirmed against an OEM drawing; the brackets show its band. Air-side load is rack power × (1 − liquid share), with the liquid
            share of each sourced NVL72 platform in the library; a rack of another power is not a library platform, so for it the share is an assumption. Capability is the hall&rsquo;s: {fmt(pack.hall.tapoffA)} A
            tap-offs and {d1(air)} kW per position.
          </p>
          <Scroll label="Feed current and air-side load for racks of 100 to 150 kW, against this hall's tap-off rating and position capability">
            <table className="w-full min-w-[640px] text-left text-sm">
              <caption className="sr-only">For each rack power in the band: the feed current against the installed tap-off, and the air-side load at each library platform&rsquo;s liquid share against the position capability</caption>
              <thead>
                <tr className="border-b border-line">
                  <th scope="col" className={TH}>Rack kW</th>
                  <th scope="col" className={TH}>Why this point</th>
                  <th scope="col" className={TH}>Feed A ({band.feed.evidence}, ±{Math.round(band.feed.bandFraction * 100)}%), tap-off {fmt(pack.hall.tapoffA)}</th>
                  {libraryPlatforms.map((p) => (
                    <th key={p.id} scope="col" className={TH}>Air kW at {Math.round(p.liquid_fraction * 100)}% liquid (position {d1(air)})</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {band.rows.map((r) => (
                  <tr key={r.kw} className="border-t border-line/60 align-top">
                    <th scope="row" className="p-3 font-mono font-normal text-ghost">{d1(r.kw)}</th>
                    <td className="p-3 text-mute">{r.from.join("; ")}</td>
                    <td className="p-3 font-mono text-ghost">{fmt(Math.round(r.feedA))} [{fmt(Math.round(r.feedLowA))}–{fmt(Math.round(r.feedHighA))}]</td>
                    {r.air.map((a) => (
                      <td key={a.platformId} className="p-3 font-mono text-ghost">{f1(a.kw)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </Scroll>
          <ul className="mt-3 list-disc space-y-2 pl-5 text-[15px] leading-relaxed text-mute">
            <li>
              A {fmt(pack.hall.tapoffA)} A tap-off feeds a rack of up to {f1(band.maxRackOnTapoffKw)} kW at the library ratio, and at most {f1(band.maxRackOnTapoffHighKw)} kW if the library&rsquo;s current were {Math.round(band.feed.bandFraction * 100)}% too high.{feedClosed ? <> Every point of the band needs more than the installed tap-off even at the low end of its band, so the feed limit
              ({lc(docOf(m, "rack_feed_tapoff").name)}) is closed even at &minus;{Math.round(band.feed.bandFraction * 100)}%.</> : null}
            </li>
            <li>
              A position that removes {d1(air)} kW supports a rack of up to {band.maxRackOnAir.map((a) => `${f1(a.kw)} kW at ${Math.round(a.liquidShare * 100)}% liquid`).join(" or ")}.
              {allBelow ? " Both are below the lowest point of the band, so the air-side limit is closed across the whole band as well." : ""}
            </li>
            {band.check.feedMatches && band.check.airMatches ? (
              <li>
                Check: at the library&rsquo;s own {d1(platform.rack_kW)} kW the same arithmetic gives {fmt(Math.round(band.check.feedA))} A and {f1(band.check.airKw)} kW, the values the library publishes for the {platform.name}.
              </li>
            ) : null}
          </ul>
          <p className={P}>
            This does not say a 100 kW rack would be solved identically by the engine, and it says nothing about the capacity limits, whose order depends on the rack and the hall. It says the two per-position limits do not
            move across the band in this hall, so they come first whatever rack power in it is chosen.
          </p>
        </>
      ) : null}

      <h3 className="mt-8 text-lg font-semibold text-ghost">What relieves it</h3>
      <p className={P}>
        {relief.relief} {relief.relief_risk}{" "}
        {reliefStep ? <>In the ladder this is step {reliefStep.step}, with a lead time of {leadProse(reliefStep.leadTime)}. </> : null}
        The hall&rsquo;s per-position air capability is an estimate (class {pack.hall.residualAirKw.evidence}), and the intake&rsquo;s own note on it reads &ldquo;{pack.hall.residualAirKw.note}&rdquo;. The second gate depends on it, so it is the figure to confirm by measurement before an order is placed for it.
      </p>
    </section>
  );
}

function SequenceSection({ m }: { m: GuideModel }) {
  const { scenario, starts } = m;
  const t = scenario.time;
  const gateSteps = [...new Set(m.zero.flatMap((z) => z.rungs.filter((r) => r.taken).map((r) => r.step)))].sort((a, b) => a - b);
  const lastGate = gateSteps.length ? gateSteps[gateSteps.length - 1] : 0;
  const afterGates = scenario.ladder.find((s) => s.step === lastGate)?.racksAfter;
  const caveats = t.limitation ? sentencesMatching(t.limitation, /first-rack/) : [];
  const bandNote = starts[0] ? suppliedBandNote(scenario, starts[0].lead) : null;
  const startPosition = starts[0] ? m.order.find((o) => o.id === starts[0].id)?.position : undefined;
  return (
    <section className="mt-12" aria-labelledby="seq-h">
      <h2 id="seq-h" className={H2}>The order to relieve them in</h2>
      <p className={P}>There are two orders, and they differ. The first is the order in which the limits bind, above. The second is the order in which the work should be started, which follows lead time.</p>
      <ol className="mt-3 list-decimal space-y-3 pl-5 text-[15px] leading-relaxed text-mute">
        <li>
          <strong className="text-ghost">Clear every gate before paying for capacity.</strong>{" "}
          {gateSteps.length && afterGates !== undefined ? <>The ladder takes the gate{gateSteps.length > 1 ? "s" : ""} first, at step{gateSteps.length > 1 ? "s" : ""} {joinAnd(gateSteps.map(String))}. The count is zero until {gateSteps.length > 1 ? "they are" : "it is"} done and {fmt(afterGates)} when {gateSteps.length > 1 ? "they are" : "it is"}; capacity relief from step {lastGate + 1} takes it from there to {fmt(scenario.afterLadder.racks)}. A capacity relief finished before the gates adds no rack.</> : null}
        </li>
        <li>
          <strong className="text-ghost">Start in order of lead time, not in order of binding.</strong> The reliefs the ladder takes are listed below by lead time. The longest, {starts[0] ? `${lc(starts[0].name)} at ${fmtLead(starts[0].lead)}` : "none"}, is the first
          to order{startPosition ? `, though it is only number ${startPosition} in the order the limits bind` : ""}.
        </li>
        <li>
          <strong className="text-ghost">Solve again after every relief.</strong> The next binding limit changes with each one, and a limit can come back: the ladder above has one that binds twice.
        </li>
        <li>
          <strong className="text-ghost">Do not read a date out of it.</strong> The model&rsquo;s own label for the programme is &ldquo;{t.dateLabel ?? "no date"}&rdquo;.
        </li>
      </ol>
      {t.limitation ? (
        <figure className="mt-4 rounded border border-line bg-panel p-4">
          <figcaption className="data text-xs text-faint">The pack&rsquo;s own statement of what the schedule does not model</figcaption>
          <blockquote className="mt-2 text-[14px] leading-relaxed text-mute">{t.limitation}</blockquote>
        </figure>
      ) : null}

      <p className={P}>
        <strong className="text-ghost">Where the lead times come from.</strong> The pack records a source only for the lead time that sets the date: {t.controllingComponent ?? "none named"}, {t.leadTimeSourceLabel ? <>“{t.leadTimeSourceLabel}”</> : "source not recorded"}.
        {m.suppliedLeadTimes.length ? <> The intake lists {joinAnd(m.suppliedLeadTimes)} among the inputs it supplies.</> : null} For the other reliefs the pack does not mark a source per row, and its limitation text, printed below, says a lead time here may be a library placeholder or a figure the customer supplied.{bandNote ? <> {bandNote}</> : null}
      </p>
      <Scroll label="Reliefs taken by the ladder, longest lead time first">
        <table className="w-full min-w-[520px] text-left text-sm">
          <caption className="sr-only">The reliefs the ladder takes, longest assumed lead time first, with the ladder steps that use each</caption>
          <thead>
            <tr className="border-b border-line">
              <th scope="col" className={TH}>Relief</th>
              <th scope="col" className={TH}>Ladder step(s)</th>
              <th scope="col" className={TH}>Lead time, weeks (class)</th>
              <th scope="col" className={TH}>Source of the lead time</th>
            </tr>
          </thead>
          <tbody>
            {starts.map((s) => (
              <tr key={s.id} className="border-t border-line/60 align-top">
                <th scope="row" className="p-3 font-normal text-ghost">{m.docs.has(s.id) ? <LimitName m={m} id={s.id} /> : s.name}</th>
                <td className="p-3 font-mono text-ghost">{s.steps.join(", ")}</td>
                <td className="p-3 text-mute">{fmtQty(s.lead)} ({classOf(s.lead.evidence)})</td>
                <td className="p-3 text-mute">{leadSourceFor(scenario, s.name) ?? "not marked in the pack"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Scroll>

      {t.curve.length ? (
        <>
          <h3 className="mt-8 text-lg font-semibold text-ghost">When the racks arrive, if the lead times held</h3>
          <Scroll label="Racks against elapsed weeks for the scenario followed in this guide">
            <table className="w-full min-w-[520px] text-left text-sm">
              <caption className="sr-only">Racks the hall carries against elapsed weeks, with what unlocks each count; every elapsed figure is an assumed lead time, not a date</caption>
              <thead>
                <tr className="border-b border-line">
                  <th scope="col" className={TH}>Elapsed weeks</th>
                  <th scope="col" className={TH}>Racks</th>
                  <th scope="col" className={TH}>Unlocked by</th>
                </tr>
              </thead>
              <tbody>
                {t.curve.map((p, i) => (
                  <tr key={i} className="border-t border-line/60 align-top">
                    <td className="p-3 font-mono text-ghost">{formatLeadTime(p.weeks, t.dateClass ?? "E0")}</td>
                    <td className="p-3 font-mono text-ghost">{fmt(p.racks)}</td>
                    <td className="p-3 text-mute">{p.unlockedBy}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Scroll>
          <p className="mt-3 text-[13px] leading-relaxed text-faint">
            Every elapsed figure is an assumed lead time (class {t.dateClass ?? "E0"}), not an energisation date.{caveats.length ? <> {caveats.join(" ")}</> : null}
          </p>
        </>
      ) : null}
    </section>
  );
}

function LimitsSection({ m }: { m: GuideModel }) {
  return (
    <section className="mt-12" aria-labelledby="limits-h">
      <h2 id="limits-h" className={H2}>Limit by limit, in the order they bind</h2>
      <p className={P}>
        All {fmt(m.order.length)}, in the order the ladder reaches them, then the ones it does not. Each links to its reference page. The basis is the engine&rsquo;s own sentence for this hall, with the evidence class of each figure in brackets, cut where the pack&rsquo;s note turns to modelling limits (those are in the <a href="/reference/model_pack.json" className={A}>model pack</a>).
      </p>
      <div className="mt-2 divide-y divide-line/60">
        {m.order.map((o) => {
          const d = docOf(m, o.id);
          const rungs = rungPhrase(o, m);
          return (
            <article key={o.id} className="py-5" aria-labelledby={`lim-${o.id}`}>
              <h3 id={`lim-${o.id}`} className="text-lg font-semibold text-ghost">
                <span className="data mr-2 text-xs text-faint">{String(o.position).padStart(2, "0")}</span>
                <Link href={`/constraints/${d.slug}`} className="underline underline-offset-4 hover:text-power">{d.name}</Link>
                <span className="data ml-2 text-xs uppercase tracking-[0.12em] text-faint">{d.domain}</span>
              </h3>
              <p className={P}><span className="text-ghost">What it limits.</span> {d.limits}</p>
              <p className={P}><span className="text-ghost">In this hall.</span> {statePhrase(o, m)} {rungs}</p>
              {o.id === "floor_loading" ? <FloorBlock m={m} o={o} /> : null}
              <p className="mt-3 text-[13px] leading-relaxed text-faint"><span className="text-mute">Basis.</span> {o.basis}</p>
              <p className="mt-2 text-[13px] leading-relaxed text-faint">
                <span className="text-mute">Evidence.</span> {o.classes.length ? `${o.classes.join(", ")}; weakest ${o.weakest}.` : "No class is named in the basis."}
              </p>
              <p className={P}><span className="text-ghost">Relief.</span> {d.relief}</p>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function EvidenceSection({ m }: { m: GuideModel }) {
  const { order, withE0, calibration, libraryPlatforms } = m;
  const present = EVIDENCE_CLASSES.filter((c) => order.some((o) => o.classes.includes(c.code)));
  const e3 = order.filter((o) => o.classes.includes("E3")).length;
  return (
    <section className="mt-12" aria-labelledby="evidence-h">
      <h2 id="evidence-h" className={H2}>How the evidence class changes the confidence</h2>
      <p className={P}>
        Every comparison above sets a figure from the hall against a figure from the rack, and each carries a class. A result is stated at the weakest class that went into it
        (<Link href="/evidence" className={A}>how the classes work</Link>). In this example {fmt(withE0)} of {fmt(order.length)} limits name an E0 figure in their basis, so none of those results can be stronger than E0, whatever the class of the other side.
      </p>
      <Scroll label="Evidence classes named in the limits of this example">
        <table className="w-full min-w-[560px] text-left text-sm">
          <caption className="sr-only">The evidence classes that appear in the basis of the limits, how the engine words each, and how many limits name it</caption>
          <thead>
            <tr className="border-b border-line">
              <th scope="col" className={TH}>Class</th>
              <th scope="col" className={TH}>The class's definition</th>
              <th scope="col" className={TH}>In this example</th>
              <th scope="col" className={TH}>Limits naming it</th>
            </tr>
          </thead>
          <tbody>
            {present.map((c) => (
              <tr key={c.code} className="border-t border-line/60 align-top">
                <th scope="row" className="p-3 font-mono font-normal text-ghost">{c.code} <span className="font-sans text-mute">{c.verb}</span></th>
                <td className="p-3 text-mute">{c.meaning}</td>
                <td className="p-3 text-mute">{IN_THIS_EXAMPLE[c.code] ?? "Named in the basis of at least one limit."}</td>
                <td className="p-3 font-mono text-ghost">{fmt(order.filter((o) => o.classes.includes(c.code)).length)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Scroll>
      <p className={P}>
        <strong className="text-ghost">No engineer reviewed this synthetic hall.</strong> {fmt(e3)} of {fmt(order.length)} limits name E3 in their basis. The definition above is what the class means in the engine&rsquo;s list; it is not what happened here. Read the E3 rows as the engine&rsquo;s own estimate: arithmetic on supplied ratings and estimated inputs, in a hall whose inputs are invented, with the engine capping a threshold comparison at E3. Nobody checked them against practice.
      </p>
      <ul className="mt-4 list-disc space-y-2 pl-5 text-[15px] leading-relaxed text-mute">
        <li>
          <strong className="text-ghost">A vendor claim stays a vendor claim.</strong> The platform figures come from sources the library marks [V] ({libraryPlatforms.map((p) => p.name).join(" and ")}). The guide uses them as the library holds them, as assumptions, and does not present any of
          them as validated performance.
        </li>
        <li>
          <strong className="text-ghost">What would raise a class.</strong> The hall&rsquo;s own drawings and ratings make a hall-side figure E5, supplied by the client and not measured by us. A review by a qualified engineer against practice is what the class E3 is defined to mean, and none was done here. Only a measurement
          reconciled with the model reaches E6.
        </li>
        <li>
          <strong className="text-ghost">What the record shows today.</strong>{" "}
          {calibration ? (
            <>The calibration record reads &ldquo;{calibration.state}&rdquo;: {fmt(calibration.observations)} reconciled observations across {fmt(calibration.sites)} sites, covering {fmt(calibration.keysWithSiteObservations)} of {fmt(calibration.keysAsserted)} model outputs. Every figure here is modelled.</>
          ) : (
            <>The calibration record could not be read here; the <Link href="/evidence" className={A}>evidence page</Link> carries it.</>
          )}{" "}
          The uncertainty bands come from input uncertainty propagated through the model, not from a comparison with a real hall.
        </li>
      </ul>
    </section>
  );
}

function UnknownSection({ m }: { m: GuideModel | null }) {
  const h = m?.pack.hall;
  return (
    <section className="mt-12" aria-labelledby="unknown-h">
      <h2 id="unknown-h" className={H2}>What is not known, and what would establish it</h2>
      <ul className="mt-3 space-y-3 text-[15px] leading-relaxed text-mute">
        <li>
          <strong className="text-ghost">Your hall&rsquo;s data.</strong> Nothing above is about your hall. {h ? <>Even in the example, the per-position air capability is an estimate to be confirmed by measurement.</> : null} The free capacity check takes seven numbers you already hold; the Density Screen
          lists the inputs nobody has measured as a data request for your engineers. Neither measures the hall: both use what you supply and label what they had to assume.
        </li>
        <li>
          <strong className="text-ghost">Vendor quotations.</strong> {m?.costBasis === "library_default" ? "Every price in the ladder is a library default (class E0)." : "The prices in the ladder carry the bases the pack states."} Every lead time is an assumption (class E0), whether it came from the library or was supplied in the intake. Today the engine keeps a supplied lead time at E0, so a quotation improves the input but not its label. The Procurement
          Specification is how the quotations are asked for and compared in racks and weeks.
        </li>
        <li>
          <strong className="text-ghost">A structural survey.</strong> The floor-loading limit is arithmetic on a library rack mass and footprint against a design value from the building record. It is not a structural assessment, and none of the engagements is one. {m?.floorNote ? <>The engine&rsquo;s own note for a raised floor: {m.floorNote} </> : null}A structural engineer decides.
        </li>
        <li>
          <strong className="text-ghost">Local grid rules.</strong> The utility&rsquo;s conditions are outside the model. The example assumes no increase in connection capacity inside the study horizon, so the grid limit is where the ladder ends; a different answer from your
          utility changes the order, and only the utility can give it.
        </li>
        <li>
          <strong className="text-ghost">Dependencies between works.</strong> The schedule assumes the reliefs run in parallel and models no dependency between them. A chain of works that must run one after another takes longer than the figure the model prints.
        </li>
        <li>
          <strong className="text-ghost">Transient loads, protection and commissioning.</strong> Limits are sized on sustained rack power. Peak power, step loads, protection settings and commissioning are outside this screening method, which is not a design, an
          approval or a statement that a hall can be loaded.
        </li>
      </ul>
      <p className={P}>
        Time to Power sells no equipment. The reliefs named here are modelled so that a buyer can compare them, and are not offered for sale.
      </p>
      {m ? (
        <p className="mt-3 text-[13px] leading-relaxed text-faint">
          Sources, all published by the engine: <a href="/reference/model_pack.json" className={A}>model pack</a>, <a href="/reference/platforms.json" className={A}>platform library</a>,{" "}
          <a href="/reference/constraints.json" className={A}>constraint reference</a> and <a href="/reference/calibration.json" className={A}>calibration record</a>. The full worked deliverable is on{" "}
          <Link href="/reference" className={A}>the worked-example page</Link>. The comparison scenario here is <span className="font-mono">{COMPARISON_ID}</span>.
        </p>
      ) : null}
    </section>
  );
}

// What the arithmetic behind the floor-loading row is, and who decides. Every figure is read from the published files.
function FloorBlock({ m, o }: { m: GuideModel; o: OrderedLimit }) {
  const { platform, pack, floorNote } = m;
  const perFootprint = platform.rack_mass_kg / platform.rack_footprint_m2;
  const basis = /^([\d,.]+) \[/.exec(o.basis);
  const capacity = /against ([\d,.]+) kg\/m2/.exec(o.basis);
  const imposed = basis ? Number(basis[1].replace(/,/g, "")) : null;
  const cap = capacity ? Number(capacity[1].replace(/,/g, "")) : null;
  const risk = m.scenario.constraints.find((c) => c.id === o.id)?.relief?.risk;
  return (
    <div className="mt-3 rounded border border-line bg-panel p-4 text-[14px] leading-relaxed text-mute">
      <p>
        <strong className="text-ghost">What the arithmetic is.</strong> The engine&rsquo;s imposed figure{imposed !== null ? <> ({fmt(imposed)} kg/m²)</> : null} is the rack&rsquo;s mass averaged over the aisle pitch, the floor area its row takes at the pitch installed
        ({d1(pack.hall.aislePitchM)} m in the intake). The same rack over its own footprint is {fmt(platform.rack_mass_kg)} kg / {String(platform.rack_footprint_m2)} m² = {fmt(Math.round(perFootprint))} kg/m².
        The design capacity is {cap !== null ? <>{fmt(cap)} kg/m², which is </> : null}{d1(pack.hall.floorLoadingKPa)} kPa: {pack.hall.floorLoadingNote.toLowerCase()}.
        {imposed !== null && cap !== null ? <> The pitch-averaged figure is {imposed <= cap ? "below" : "above"} it and the per-footprint figure is {perFootprint <= cap ? "below" : "above"} it.</> : null} Point loads under the castors are a separate check that this guide does not compute.
      </p>
      <p className="mt-2">
        This is arithmetic on library values, not a structural assessment, and it is not a verdict: a structural engineer decides which basis applies and whether the floor can carry the rack. {floorNote ? <>{floorNote}</> : <>The published study does not carry the engine&rsquo;s raised-floor note, so none is shown.</>}{risk ? <> The pack records against the relief: {risk}</> : null}
      </p>
    </div>
  );
}

/** What each class means on the rows of this example, in plain words. The definitions beside them are the engine's list (lib/evidence-classes.ts). */
const IN_THIS_EXAMPLE: Record<string, string> = {
  E0: "A library default or an assumption: the platform's figures and every lead time.",
  E3: "The engine's own estimate on supplied ratings and estimated inputs. Nobody reviewed it.",
  E5: "The hall's declared ratings, which in this example are invented.",
};
