import type { Metadata } from "next";
import Link from "next/link";
import { PageJsonLd } from "@/components/PageJsonLd";
import { constraintReference } from "@/lib/constraints";
import { orgRef } from "@/lib/entity";
import { breadcrumbJsonLd, webPageJsonLd } from "@/lib/jsonld";
import { OG_BASE, SITE, SITE_URL, siteUrl } from "@/lib/site";
import { pageImages } from "@/lib/page-cards";
import { QUALIFY_LINK } from "@/lib/nav";

const TITLE = "How long does it take to relieve each constraint in an AI data hall?";
const DESCRIPTION =
  "Indicative lead-time ranges, in weeks, for relieving each of the thirteen electrical, thermal and physical constraints that limit an existing hall, with what each range rests on. Library ranges, not quotations.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "/lead-times" },
  twitter: { card: "summary_large_image", images: pageImages("lead-times") },
  openGraph: {
    ...OG_BASE,
    images: pageImages("lead-times"), title: TITLE, description: DESCRIPTION, url: "/lead-times" },
};

export default async function LeadTimesPage() {
  const ref = await constraintReference();
  const rows = (ref?.constraints ?? [])
    .filter((c) => c.lead_time_weeks)
    .sort((a, b) => b.lead_time_weeks!.high - a.lead_time_weeks!.high);
  return (
    <div className="mx-auto w-full max-w-5xl px-5 pb-24 pt-28 sm:px-8">
      <PageJsonLd
        data={[
          webPageJsonLd("/lead-times", TITLE, DESCRIPTION),
          {
            "@context": "https://schema.org",
            "@type": "Dataset",
            name: "Indicative relief lead times by constraint",
            description: DESCRIPTION,
            url: siteUrl("/lead-times"),
            creator: orgRef(),
            publisher: orgRef(),
            isBasedOn: siteUrl("/reference/constraints.json"),
            variableMeasured: rows.map((c) => ({
              "@type": "PropertyValue",
              name: `${c.name}: indicative relief lead time`,
              minValue: c.lead_time_weeks!.low,
              maxValue: c.lead_time_weeks!.high,
              unitText: "weeks",
            })),
          },
          breadcrumbJsonLd([
            { name: "Time to Power", path: "/" },
            { name: "Lead times", path: "/lead-times" },
          ]),
        ]}
      />
      <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-power">Time to power</p>
      <h1 className="mt-3 text-3xl font-semibold leading-tight text-ghost sm:text-4xl">
        What sets the date is usually one item&rsquo;s lead time.
      </h1>
      <p className="mt-4 max-w-3xl text-mute">
        Each constraint on an existing hall has a relief, and each relief has a lead time. These are the ranges the engine uses when it
        has no quotation of your own. They are ranges from a reference library, not quotations, and a date built on one is labelled
        as resting on an assumption, not presented as a date.
      </p>

      {!rows.length ? (
        <p className="mt-8 text-sm text-mute">The constraint reference is not built on this deployment.</p>
      ) : (
        <div className="mt-8 overflow-x-auto rounded border border-line">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b border-line text-left font-mono text-[10px] uppercase tracking-[0.14em] text-faint">
                <th className="p-3">Constraint</th>
                <th className="p-3">Domain</th>
                <th className="p-3 text-right">Indicative lead time</th>
                <th className="p-3">What the cost figure for the relief rests on</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.slug} className="border-t border-line/60 align-top">
                  <td className="p-3">
                    <Link href={`/constraints/${c.slug}`} className="font-semibold text-ghost hover:text-power">
                      {c.name}
                    </Link>
                  </td>
                  <td className="p-3 capitalize text-mute">{c.domain}</td>
                  <td className="p-3 text-right font-mono text-power">
                    {c.lead_time_weeks!.low} to {c.lead_time_weeks!.high} weeks
                  </td>
                  <td className="p-3 text-mute">
                    {c.cost_basis ? `${c.cost_basis.evidence.split("_")[0]}, ${c.cost_basis.basis.replace(/_/g, " ")}` : "no priced relief in the library"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <section className="mt-8 max-w-3xl text-sm text-mute" aria-labelledby="read-h">
        <h2 id="read-h" className="text-lg font-semibold text-ghost">How to read this</h2>
        <ul className="mt-2 list-disc space-y-2 pl-5">
          <li>A wide range means the item is uncertain, not that the table is vague: the spread between the low and the high is the uncertainty.</li>
          <li>The longest range among the items your hall needs sets the date, because items procure in parallel.</li>
          <li>
            Replace a range with a quotation and the date tightens, and its evidence class improves. See{" "}
            <Link href="/evidence" className="text-power underline">evidence classes</Link>.
          </li>
          <li>Supplier lead times move; a range here is not a promise that anyone will deliver inside it.</li>
        </ul>
      </section>

      <div className="mt-10 flex flex-wrap items-center gap-4 border-t border-line pt-8">
        <Link href="/qualify" className="rounded bg-power px-5 py-2.5 font-semibold text-ink">
          {QUALIFY_LINK.label}
        </Link>
        <Link href="/constraints" className="text-sm text-power underline">
          The thirteen constraints
        </Link>
        <Link href="/products/density-screen" className="text-sm text-power underline">
          Density Screen
        </Link>
      </div>
    </div>
  );
}
