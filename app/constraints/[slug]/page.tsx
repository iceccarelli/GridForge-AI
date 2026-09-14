import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AlertTriangle, ArrowRight, Calculator } from "lucide-react";
import { DOMAIN_LABEL, constraintBySlug, constraintReference } from "@/lib/constraints";

export async function generateStaticParams() {
  const ref = await constraintReference();
  return (ref?.constraints ?? []).map((c) => ({ slug: c.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const c = await constraintBySlug(slug);
  if (!c) return { title: "Constraint not found" };
  return {
    title: `${c.name} — what it limits and what relieves it`,
    description: `${c.headline} ${c.limits}`.slice(0, 300),
    alternates: { canonical: `/constraints/${c.slug}` },
    openGraph: {
      title: `${c.name} — AI rack density in an existing hall`,
      description: c.headline,
      url: `/constraints/${c.slug}`,
      type: "article",
    },
  };
}

function jsonLd(obj: unknown) {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{
        __html: JSON.stringify(obj).replace(/</g, "\\u003c"),
      }}
    />
  );
}

export default async function ConstraintPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const c = await constraintBySlug(slug);
  if (!c) notFound();
  const ref = await constraintReference();
  const related = (c.see_also ?? [])
    .map((id) => ref?.constraints.find((x) => x.id === id))
    .filter((x): x is NonNullable<typeof x> => Boolean(x));

  return (
    <main className="mx-auto w-full max-w-4xl px-5 pb-24 pt-28 sm:px-8">
      {jsonLd({
        "@context": "https://schema.org",
        "@type": "TechArticle",
        headline: `${c.name} — what it limits and what relieves it`,
        description: c.headline,
        about: c.name,
        articleSection: DOMAIN_LABEL[c.domain] ?? c.domain,
        isAccessibleForFree: true,
        publisher: { "@type": "Organization", name: "GridForge AI" },
      })}

      <nav className="font-mono text-[11px] uppercase tracking-[0.14em] text-faint">
        <Link href="/constraints" className="hover:text-power">
          Constraints
        </Link>
        <span className="mx-2">/</span>
        <span className="text-power">{DOMAIN_LABEL[c.domain] ?? c.domain}</span>
      </nav>

      <h1 className="mt-4 text-3xl font-semibold leading-tight text-ghost sm:text-4xl">
        {c.name}
      </h1>
      <p className="mt-4 text-lg text-mute">{c.headline}</p>

      <Block title="What runs out">{c.limits}</Block>
      <Block title="The relation that governs it">{c.relation}</Block>

      {c.worked_example ? (
        <section className="mt-8 rounded border border-power/40 bg-power/5 p-6">
          <h2 className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.14em] text-power">
            <Calculator className="h-3.5 w-3.5" /> Worked example
          </h2>
          <p className="mt-3 font-semibold text-ghost">{c.worked_example.question}</p>
          <p className="mt-2 font-mono text-sm text-mute">{c.worked_example.working}</p>
          <p className="mt-2 font-mono text-2xl font-semibold text-power">
            {c.worked_example.answer}
          </p>
          <p className="mt-2 text-sm text-mute">{c.worked_example.consequence}</p>
          <p className="mt-3 text-[11px] text-faint">
            Reproducible by hand. A page that asks you to trust a number has taught you nothing.
          </p>
        </section>
      ) : null}

      <section className="mt-8 rounded border border-line bg-panel-2 p-6">
        <h2 className="font-mono text-[11px] uppercase tracking-[0.14em] text-power">
          How to tell whether it binds in your hall
        </h2>
        <p className="mt-3 text-mute">{c.binds_when}</p>
      </section>

      <Block title="What relieves it">{c.relief}</Block>
      <Block title="What that relief costs beyond money">{c.relief_risk}</Block>

      {c.lead_time_weeks ? (
        <div className="mt-6 grid gap-3 sm:grid-cols-2">
          <Fact
            k="Indicative relief lead time"
            v={`${c.lead_time_weeks.low}–${c.lead_time_weeks.high} weeks`}
            n="European retrofits. The schedule, not the capex, usually decides."
          />
          {c.cost_basis ? (
            <Fact
              k="How we currently price this relief"
              v={c.cost_basis.evidence.split("_")[0]}
              n={c.cost_basis.note}
            />
          ) : null}
        </div>
      ) : null}

      {c.misconception ? (
        <section className="mt-8 rounded border border-queue/40 bg-queue/10 p-6">
          <h2 className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.12em] text-queue">
            <AlertTriangle className="h-3.5 w-3.5" /> The mistake we actually see
          </h2>
          <p className="mt-3 text-mute">{c.misconception}</p>
        </section>
      ) : null}

      {c.sources.length ? (
        <section className="mt-8">
          <h2 className="font-mono text-[11px] uppercase tracking-[0.14em] text-faint">
            Basis
          </h2>
          <ul className="mt-2 space-y-1 text-sm text-mute">
            {c.sources.map((s) => (
              <li key={s}>— {s}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {related.length ? (
        <section className="mt-8">
          <h2 className="font-mono text-[11px] uppercase tracking-[0.14em] text-faint">
            These usually travel together
          </h2>
          <div className="mt-3 flex flex-wrap gap-2">
            {related.map((r) => (
              <Link
                key={r.id}
                href={`/constraints/${r.slug}`}
                className="rounded border border-line px-3 py-1.5 text-sm text-mute hover:border-power/50 hover:text-ghost"
              >
                {r.name}
              </Link>
            ))}
          </div>
        </section>
      ) : null}

      <section className="mt-12 flex flex-wrap items-center gap-4 rounded border border-line bg-panel-2 p-6">
        <div className="min-w-64 flex-1">
          <h2 className="text-lg font-semibold text-ghost">
            Does this one bind in your hall?
          </h2>
          <p className="mt-1 text-sm text-mute">
            Seven numbers you already know, all thirteen constraints evaluated, and the one that
            stops you first named with its basis in engineering units. Free.
          </p>
        </div>
        <Link
          href="/qualify"
          className="inline-flex items-center gap-2 rounded bg-power px-5 py-2.5 font-semibold text-ink"
        >
          Run your hall <ArrowRight className="h-4 w-4" />
        </Link>
      </section>
    </main>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-8">
      <h2 className="font-mono text-[11px] uppercase tracking-[0.14em] text-power">{title}</h2>
      <p className="mt-3 text-mute">{children}</p>
    </section>
  );
}

function Fact({ k, v, n }: { k: string; v: string; n: string }) {
  return (
    <div className="rounded border border-line bg-panel-2 px-4 py-3">
      <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">{k}</p>
      <p className="mt-1 font-mono text-xl font-semibold text-power">{v}</p>
      <p className="mt-1 text-xs text-faint">{n}</p>
    </div>
  );
}
