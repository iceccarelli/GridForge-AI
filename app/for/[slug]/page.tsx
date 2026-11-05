import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Bullets } from "@/components/for/Bullets";
import { PathList } from "@/components/for/PathList";
import { AUDIENCES, audienceBySlug } from "@/lib/audiences";
import { constraintReference } from "@/lib/constraints";
import { breadcrumbJsonLd, webPageJsonLd } from "@/lib/jsonld";
import { OG_BASE } from "@/lib/site";

export const dynamicParams = false;

export function generateStaticParams() {
  return AUDIENCES.map((a) => ({ slug: a.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const a = audienceBySlug(slug);
  if (!a) return {};
  const title = `For ${a.name.toLowerCase()}`;
  return {
    title,
    description: a.summary,
    alternates: { canonical: `/for/${a.slug}` },
    openGraph: { ...OG_BASE, title: a.headline, description: a.summary, url: `/for/${a.slug}` },
  };
}

export default async function AudiencePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const a = audienceBySlug(slug);
  if (!a) notFound();
  const ref = await constraintReference();
  const named = a.constraints.map((c) => ({ ...c, doc: ref?.constraints.find((d) => d.slug === c.slug) }));
  const crumbs = breadcrumbJsonLd([
    { name: "Time to Power", path: "/" },
    { name: "Who it is for", path: "/for" },
    { name: a.name, path: `/for/${a.slug}` },
  ]);
  const page = webPageJsonLd(`/for/${a.slug}`, a.headline, a.summary);
  const others = AUDIENCES.filter((o) => o.slug !== a.slug);
  return (
    <div className="min-h-screen bg-ink pb-24 pt-28">
      {[crumbs, page].map((j, i) => (
        <script key={i} type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(j).replace(/</g, "\\u003c") }} />
      ))}
      <div className="mx-auto max-w-3xl px-6">
        <nav aria-label="Breadcrumb" className="mb-4 text-[12px] text-faint">
          <Link href="/" className="inline-flex min-h-11 min-w-11 items-center hover:text-power">Home</Link> /{" "}
          <Link href="/for" className="inline-flex min-h-11 items-center hover:text-power">Who it is for</Link> / <span className="text-mute">{a.name}</span>
        </nav>
        <div className="eyebrow mb-4 text-power">FOR {a.name.toUpperCase()}</div>
        <h1 className="[overflow-wrap:anywhere] text-3xl font-semibold leading-tight tracking-tight text-ghost sm:text-4xl">{a.headline}</h1>

        <section className="mt-8" aria-labelledby="situation-h">
          <h2 id="situation-h" className="text-xl font-semibold text-ghost">Your situation</h2>
          {a.situation.map((p) => (
            <p key={p} className="mt-3 text-[16px] leading-relaxed text-mute">{p}</p>
          ))}
        </section>

        <section className="mt-10" aria-labelledby="decision-h">
          <h2 id="decision-h" className="text-xl font-semibold text-ghost">The decision this informs</h2>
          <p className="mt-3 text-[16px] leading-relaxed text-mute">{a.decision}</p>
          <p className="mt-4 rounded-lg border border-line bg-panel px-4 py-3 text-[15px] text-ghost">
            <span className="data mr-2 text-[10px] text-power">THE FIRST QUESTION</span>
            {a.firstQuestion}
          </p>
        </section>

        <section className="mt-10" aria-labelledby="have-h">
          <h2 id="have-h" className="text-xl font-semibold text-ghost">What you probably already have</h2>
          <Bullets items={a.alreadyHave} />
        </section>

        <section className="mt-10" aria-labelledby="constraints-h">
          <h2 id="constraints-h" className="text-xl font-semibold text-ghost">The constraints most likely to decide your answer</h2>
          <ul className="mt-4 space-y-3">
            {named.map((c) => (
              <li key={c.slug} className="panel p-5">
                {c.doc ? (
                  <Link href={`/constraints/${c.slug}`} className="inline-flex min-h-11 items-center font-semibold text-ghost underline-offset-4 hover:text-power underline">
                    {c.doc.name}
                  </Link>
                ) : (
                  <span className="font-semibold text-ghost">{c.slug}</span>
                )}
                <p className="mt-2 text-[15px] leading-relaxed text-mute">{c.why}</p>
                {c.doc ? <p className="mt-2 text-[13px] italic text-faint">{c.doc.headline}</p> : null}
              </li>
            ))}
          </ul>
        </section>

        <section className="mt-10" aria-labelledby="path-h">
          <h2 id="path-h" className="text-xl font-semibold text-ghost">The route through what can be bought</h2>
          <p className="mt-3 text-[15px] leading-relaxed text-mute">
            It starts free and each step credits or informs the next; none is required. Prices are read from the live catalogue.
          </p>
          <PathList path={a.path} label={`Steps for ${a.name.toLowerCase()}`} />
        </section>

        <section className="mt-10" aria-labelledby="ask-h">
          <h2 id="ask-h" className="text-xl font-semibold text-ghost">What to ask us before you rely on the answer</h2>
          <Bullets items={a.askUs} />
        </section>

        <section className="mt-10" aria-labelledby="not-h">
          <h2 id="not-h" className="text-xl font-semibold text-ghost">What it is not</h2>
          <Bullets items={a.notWhat} />
          <p className="mt-4 text-[14px] leading-relaxed text-mute">
            Time to Power sells no equipment, holds no inventory and owns no megawatts. A figure is modelled unless its evidence class
            says otherwise, and a date that rests on an assumed lead time is labelled as one.
          </p>
        </section>

        <nav aria-label="Other buyers" className="mt-14 border-t border-line pt-8">
          <h2 className="data text-[11px] text-faint">OTHER BUYERS</h2>
          <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-sm">
            {others.map((o) => (
              <li key={o.slug}>
                <Link href={`/for/${o.slug}`} className="inline-flex min-h-11 items-center text-power underline">{o.name}</Link>
              </li>
            ))}
          </ul>
        </nav>
      </div>
    </div>
  );
}
