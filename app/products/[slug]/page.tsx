import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CommissionScreen } from "@/components/CommissionScreen";
import { engagementOfferJsonLd } from "@/lib/jsonld";
import { PRODUCT_PAGES, productForPage, productPageBySlug } from "@/lib/product-pages";
import { OG_IMAGES, siteUrl } from "@/lib/site";
import { priceLine } from "@/lib/products";

export const dynamicParams = false;

export function generateStaticParams() {
  return PRODUCT_PAGES.map((p) => ({ slug: p.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const page = productPageBySlug(slug);
  if (!page) return {};
  const p = productForPage(page);
  const title = `${p.name} — ${priceLine(p)}`;
  return {
    title,
    description: p.description,
    alternates: { canonical: `/products/${slug}` },
    openGraph: { images: OG_IMAGES, title, description: p.description, url: `/products/${slug}` },
  };
}

function List({ items }: { items: string[] }) {
  return (
    <ul className="mt-3 space-y-2 text-[15px] leading-relaxed text-mute list-disc pl-5">
      {items.map((i) => (
        <li key={i}>{i}</li>
      ))}
    </ul>
  );
}

export default async function ProductPageRoute({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const page = productPageBySlug(slug);
  if (!page) notFound();
  const p = productForPage(page);
  const jsonLd = {
    "@context": "https://schema.org",
    ...engagementOfferJsonLd(p),
    url: siteUrl(`/products/${slug}`),
  };
  return (
    <main className="bg-ink min-h-screen pt-28 pb-24">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, "\\u003c") }}
      />
      <div className="max-w-3xl mx-auto px-6">
        <div className="eyebrow text-power mb-4">Engagement</div>
        <h1 className="text-4xl font-semibold tracking-tight text-ghost">{p.name}</h1>
        <p className="mt-3 font-mono text-xl text-power">{priceLine(p)}</p>
        <p className="mt-6 text-[17px] leading-relaxed text-mute">{p.description}</p>

        <dl className="mt-8 grid gap-6 sm:grid-cols-2">
          <div>
            <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">Who it is for</dt>
            <dd className="mt-1 text-sm text-ghost">{page.buyer}</dd>
          </div>
          <div>
            <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">The decision it informs</dt>
            <dd className="mt-1 text-sm text-ghost">{page.decision}</dd>
          </div>
          <div>
            <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">Turnaround</dt>
            <dd className="mt-1 text-sm text-ghost">
              {p.turnaroundDays} working days
              {p.opensBandCents
                ? ", counted from the scoping call, not from payment"
                : p.producesDeliverable
                  ? ", from a complete intake"
                  : ""}
            </dd>
          </div>
          <div>
            <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">What you receive</dt>
            <dd className="mt-1 text-sm text-ghost">{p.deliverable}</dd>
          </div>
        </dl>

        <section className="mt-10" aria-labelledby="inputs-h">
          <h2 id="inputs-h" className="text-xl font-semibold text-ghost">What we need from you</h2>
          <List items={page.inputs} />
        </section>
        <section className="mt-10" aria-labelledby="flow-h">
          <h2 id="flow-h" className="text-xl font-semibold text-ghost">How it works</h2>
          <List items={page.flow} />
        </section>
        <section className="mt-10" aria-labelledby="limits-h">
          <h2 id="limits-h" className="text-xl font-semibold text-ghost">What it is not</h2>
          <List items={page.limits} />
        </section>

        <div className="mt-12 flex flex-wrap items-center gap-6 border-t border-line pt-8">
          <CommissionScreen productId={p.id} label={`Commission the ${p.name}`} context={`product-page:${slug}`} />
          <Link href="/pricing#engagements" className="text-sm text-power hover:underline">
            Compare all engagements
          </Link>
        </div>
      </div>
    </main>
  );
}
