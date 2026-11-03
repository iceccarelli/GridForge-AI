import type { Metadata } from "next";
import fs from "node:fs/promises";
import path from "node:path";
import Link from "next/link";
import { PageJsonLd } from "@/components/PageJsonLd";
import { CLAIM_FLOORS, EVIDENCE_CLASSES } from "@/lib/evidence-classes";
import { breadcrumbJsonLd, webPageJsonLd } from "@/lib/jsonld";
import { OG_BASE } from "@/lib/site";
import { pageImages } from "@/lib/page-cards";
import { QUALIFY_LINK } from "@/lib/nav";
import { EvidenceBoundary } from "@/components/diagrams/EvidenceBoundary";
import { MARKET_EVIDENCE, isPublishable, verificationLabel } from "@/lib/market-evidence";

const TITLE = "Evidence classes E0 to E7 — how much the world has tested a number";
const DESCRIPTION =
  "Every figure the engine returns carries an evidence class from E0 (assumed) to E7 (observed in operation), arithmetic takes the weakest input, and the calibration record states how far the model has been checked against real sites.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "/evidence" },
  twitter: { card: "summary_large_image", images: pageImages("evidence") },
  openGraph: {
    ...OG_BASE,
    images: pageImages("evidence"), title: TITLE, description: DESCRIPTION, url: "/evidence" },
};

interface Calibration {
  state: string;
  statement: string;
  observations: number;
  sites: number;
  keys_asserted: number;
  keys_calibrated: number;
}

async function calibration(): Promise<Calibration | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(process.cwd(), "public", "reference", "calibration.json"), "utf8")) as Calibration;
  } catch {
    return null;
  }
}

export default async function EvidencePage() {
  const cal = await calibration();
  // The visible questions and the FAQPage markup are one list, so the structured data can never say what the page does not.
  const faq: { q: string; a: string }[] = [
    {
      q: "Is the engine validated against real sites?",
      a: cal
        ? `Not yet. The calibration record is "${cal.state}": ${cal.statement}`
        : "The calibration record could not be read on this deployment, so no validation claim is made here.",
    },
    {
      q: "What does an evidence class mean?",
      a: "It is a claim about how much the world has tested a number, from E0 (an assumption or library default) to E7 (an outcome observed in operation). Classes are ordered, and arithmetic takes the minimum: a result is never stronger than the weakest input it came from.",
    },
    {
      q: "Can I quote an E0 or E1 figure as a property of a physical asset?",
      a: "No. An E0 or E1 figure is assumed or modelled, not measured. If you quote one, say so.",
    },
  ];
  return (
    <div className="mx-auto w-full max-w-4xl px-5 pb-24 pt-28 sm:px-8">
      <PageJsonLd
        data={[
          webPageJsonLd("/evidence", TITLE, DESCRIPTION),
          {
            "@context": "https://schema.org",
            "@type": "FAQPage",
            mainEntity: faq.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })),
          },
          breadcrumbJsonLd([
            { name: "Time to Power", path: "/" },
            { name: "Evidence classes", path: "/evidence" },
          ]),
        ]}
      />
      <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-power">Method</p>
      <h1 className="mt-3 text-3xl font-semibold leading-tight text-ghost sm:text-4xl">
        How much has the world tested this number?
      </h1>
      <p className="mt-4 text-mute">
        A capacity figure for a data hall is only as good as what stands behind it. Every number the engine returns carries an
        evidence class and a provenance digest, and a computed value is never stronger than the weakest input it came from.
      </p>

      <div className="mt-8 overflow-x-auto rounded border border-line" role="region" aria-label="Evidence classes" tabIndex={0}>
        <table className="w-full min-w-[560px] text-sm">
          <thead>
            <tr className="border-b border-line text-left font-mono text-[10px] uppercase tracking-[0.14em] text-faint">
              <th className="p-3">Class</th>
              <th className="p-3">Described as</th>
              <th className="p-3">What has been done to the number</th>
            </tr>
          </thead>
          <tbody>
            {EVIDENCE_CLASSES.map((c) => (
              <tr key={c.code} className="border-t border-line/60 align-top">
                <td className="p-3 font-mono font-semibold text-power">{c.code}</td>
                <td className="p-3 text-ghost">{c.verb}</td>
                <td className="p-3 text-mute">{c.meaning}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <section className="mt-10" aria-labelledby="floor-h">
        <h2 id="floor-h" className="text-xl font-semibold text-ghost">The floor a claim must clear</h2>
        <p className="mt-2 text-sm text-mute">
          A claim of each kind may not reach a customer below a minimum class. The engine enforces this; it is not a guideline.
        </p>
        <ul className="mt-3 list-disc space-y-1 pl-5 text-[15px] text-mute">
          {CLAIM_FLOORS.map((f) => (
            <li key={f.kind}>
              {f.label}: at least <span className="font-mono text-ghost">{f.floor}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-10" aria-labelledby="cal-h">
        <h2 id="cal-h" className="text-xl font-semibold text-ghost">Calibration status</h2>
        {cal ? (
          <>
            <p className="mt-2 text-[15px] text-mute">{cal.statement}</p>
            <dl className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
              {[
                ["State", cal.state],
                ["Reconciled observations", String(cal.observations)],
                ["Sites", String(cal.sites)],
                ["Model outputs calibrated", `${cal.keys_calibrated} of ${cal.keys_asserted}`],
              ].map(([k, v]) => (
                <div key={k} className="rounded border border-line bg-panel-2 px-4 py-3">
                  <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">{k}</dt>
                  <dd className="mt-1 font-mono text-lg font-semibold text-power">{v}</dd>
                </div>
              ))}
            </dl>
          </>
        ) : (
          <p className="mt-2 text-sm text-mute">The calibration record is not built on this deployment.</p>
        )}
        <p className="mt-3 text-sm text-faint">
          This page reads the same file the deliverables do (<span className="font-mono">/reference/calibration.json</span>). When the
          number of reconciled observations changes, this page changes with it.
        </p>
      </section>

      <div className="mt-10">
        <EvidenceBoundary />
      </div>

      <section className="mt-12" aria-labelledby="market-figures-h" id="market-figures">
        <h2 id="market-figures-h" className="text-xl font-semibold text-ghost">Market figures used on this site, and how each was checked</h2>
        <p className="mt-2 text-sm text-mute">
          These describe the market, not Time to Power&rsquo;s results. Each record gives the publisher, date, period, geography and definition, and says
          plainly whether the publisher&rsquo;s own page was read or only press coverage that quotes it. A figure we could not trace is listed as withdrawn
          and is not shown anywhere else. Checked on 3 November 2026; market figures go stale, so treat the date as part of the figure.
        </p>
        <ul className="mt-5 space-y-4">
          {MARKET_EVIDENCE.map((f) => (
            <li key={f.id} className="rounded border border-line bg-panel-2 p-4">
              <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">
                {isPublishable(f) ? verificationLabel(f.verification) : "Withdrawn: no source found"} · {f.kind}
              </p>
              <p className="mt-1 text-[15px] text-ghost">{isPublishable(f) ? f.statement : `Wording previously used: ${f.statement}`}</p>
              <dl className="mt-3 grid gap-x-6 gap-y-1 text-[13px] text-mute sm:grid-cols-2">
                {f.publisher ? <div><dt className="inline text-faint">Publisher: </dt><dd className="inline">{f.publisher}{f.published ? `, ${f.published}` : ""}</dd></div> : null}
                {f.period ? <div><dt className="inline text-faint">Period: </dt><dd className="inline">{f.period}</dd></div> : null}
                {f.geography ? <div><dt className="inline text-faint">Geography: </dt><dd className="inline">{f.geography}</dd></div> : null}
                {f.definition ? <div className="sm:col-span-2"><dt className="inline text-faint">Definition: </dt><dd className="inline">{f.definition}</dd></div> : null}
              </dl>
              <p className="mt-2 text-[13px] leading-relaxed text-mute"><span className="text-faint">Limits of the check: </span>{f.caveat}</p>
              {f.url ? (
                <p className="mt-2 text-[13px]"><a href={f.url} target="_blank" rel="noopener noreferrer" className="break-all text-power underline">Source</a></p>
              ) : null}
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-10" aria-labelledby="faq-h">
        <h2 id="faq-h" className="text-xl font-semibold text-ghost">Questions</h2>
        <dl className="mt-3 space-y-5">
          {faq.map((f) => (
            <div key={f.q}>
              <dt className="font-semibold text-ghost">{f.q}</dt>
              <dd className="mt-1 text-[15px] text-mute">{f.a}</dd>
            </div>
          ))}
        </dl>
      </section>

      <div className="mt-10 flex flex-wrap items-center gap-4 border-t border-line pt-8">
        <Link href="/qualify" className="rounded bg-power px-5 py-2.5 font-semibold text-ink">
          {QUALIFY_LINK.label}
        </Link>
        <Link href="/constraints" className="text-sm text-power hover:underline">
          The thirteen constraints
        </Link>
        <Link href="/reference" className="text-sm text-power hover:underline">
          The worked example
        </Link>
      </div>
    </div>
  );
}
