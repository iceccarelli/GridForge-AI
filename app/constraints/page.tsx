import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, Cable, Snowflake, Weight } from "lucide-react";
import { DOMAIN_LABEL, constraintReference } from "@/lib/constraints";

export const metadata: Metadata = {
  title: "What stops an existing hall taking AI racks — all thirteen constraints",
  description:
    "The complete, quantified list of what physically limits AI rack density in an existing data hall: electrical, thermal and physical. Each with the governing relation, a worked example you can check by hand, what relieves it and how long that takes.",
  alternates: { canonical: "/constraints" },
  openGraph: {
    title: "The thirteen constraints that stop a hall taking AI racks",
    description:
      "Quantified, vendor-neutral, and generated from a working capacity engine. Not a reference design with a bill of materials at the end.",
    url: "/constraints",
  },
};

const ICON = {
  electrical: Cable,
  thermal: Snowflake,
  physical: Weight,
} as const;

/**
 * The constraint reference index.
 *
 * The commercial argument for publishing this in full: anyone deciding whether to
 * pay for a capacity study first wants to understand the problem, and today they
 * read vendor reference designs written by companies whose every document ends in
 * their own bill of materials. There is no independent quantitative account of what
 * actually stops a hall. So we write it, and every page ends at a free tool that
 * answers the question for the reader's own hall.
 */
export default async function ConstraintsPage() {
  const ref = await constraintReference();
  if (!ref) {
    return (
      <main className="mx-auto w-full max-w-4xl px-5 pb-24 pt-28 sm:px-8">
        <p className="text-mute">The constraint reference is not built on this deployment.</p>
      </main>
    );
  }

  const byDomain = ref.domains.map((d) => ({
    domain: d,
    items: ref.constraints.filter((c) => c.domain === d),
  }));

  return (
    <main className="mx-auto w-full max-w-6xl px-5 pb-24 pt-28 sm:px-8">
      <header className="max-w-3xl">
        <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-power">
          Engineering reference · {ref.count} constraints
        </p>
        <h1 className="mt-3 text-3xl font-semibold leading-tight text-ghost sm:text-4xl">
          What actually stops an existing hall taking AI racks.
        </h1>
        <p className="mt-4 text-mute">
          Thirteen constraints — electrical, thermal and physical — evaluated against every hall
          we screen. Each page below states what physically runs out, the relation that governs
          it, a worked example you can reproduce by hand, what relieves it, and how many weeks
          that relief takes. No make, no model, no supplier: we take no margin on hardware.
        </p>
        <p className="mt-3 text-sm text-faint">{ref.notice}</p>
      </header>

      <div className="mt-12 space-y-12">
        {byDomain.map(({ domain, items }) => {
          const Icon = ICON[domain as keyof typeof ICON] ?? Cable;
          return (
            <section key={domain}>
              <h2 className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.16em] text-power">
                <Icon className="h-3.5 w-3.5" />
                {DOMAIN_LABEL[domain] ?? domain} · {items.length}
              </h2>
              <div className="mt-4 grid gap-4 md:grid-cols-2">
                {items.map((c) => (
                  <Link
                    key={c.id}
                    href={`/constraints/${c.slug}`}
                    className="panel flex flex-col p-5 transition-colors hover:border-power/50"
                  >
                    <h3 className="text-base font-semibold text-ghost">{c.name}</h3>
                    <p className="mt-2 flex-1 text-sm text-mute">{c.headline}</p>
                    <div className="mt-4 flex items-center justify-between">
                      <span className="font-mono text-[11px] text-faint">
                        {c.lead_time_weeks
                          ? `relief ${c.lead_time_weeks.low}–${c.lead_time_weeks.high} weeks`
                          : ""}
                      </span>
                      <span className="text-sm text-power">Read →</span>
                    </div>
                  </Link>
                ))}
              </div>
            </section>
          );
        })}
      </div>

      <section className="mt-14 flex flex-wrap items-center gap-4 rounded border border-line bg-panel-2 p-6">
        <div className="min-w-64 flex-1">
          <h2 className="text-lg font-semibold text-ghost">
            Which of these binds in your hall?
          </h2>
          <p className="mt-1 text-sm text-mute">
            Seven numbers you already know. The engine evaluates all thirteen and names the one
            that stops you first, how many racks fit as found, and which item sets the date.
            Free, and no key needed.
          </p>
        </div>
        <Link
          href="/qualify"
          className="inline-flex items-center gap-2 rounded bg-power px-5 py-2.5 font-semibold text-ink"
        >
          Find out <ArrowRight className="h-4 w-4" />
        </Link>
      </section>
    </main>
  );
}
