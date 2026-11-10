import type { Metadata } from "next";
import Link from "next/link";
import { FileAwareLink } from "@/components/FileAwareLink";
import { notFound } from "next/navigation";
import { CommissionScreen } from "@/components/CommissionScreen";
import { breadcrumbJsonLd, engagementOfferJsonLd } from "@/lib/jsonld";
import { QUALIFY_LINK } from "@/lib/nav";
import { pageTitleKeeping } from "@/lib/meta";
import { PRODUCT_PAGES, audiencesForProduct, beforeYouBuy, productForPage, productPageBySlug } from "@/lib/product-pages";
import { OG_BASE, siteUrl } from "@/lib/site";
import { eurFromCents, priceLine } from "@/lib/products";

export const dynamicParams = false;

export function generateStaticParams() {
  return PRODUCT_PAGES.map((p) => ({ slug: p.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const page = productPageBySlug(slug);
  if (!page) return {};
  const p = productForPage(page);
  // The price line is a sentence for a deposit ("... opens a scoped engagement priced at ..."), which is too long for a result title: there the
  // title says "deposit" and the band is on the page and in the description of the page's structured data.
  const base = p.name.replace(/ — deposit$/, "");
  const amount = eurFromCents(p.amountCents);
  const title = pageTitleKeeping(p.opensBandCents ? `${base} — ${amount} deposit` : `${p.name} — ${priceLine(p)}`, base);
  return {
    title,
    description: page.metaDescription,
    alternates: { canonical: `/products/${slug}` },
    openGraph: {
    ...OG_BASE, title: p.name, description: page.metaDescription, url: `/products/${slug}` },
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
  // A Service with its Offer attached: an Offer is not a top-level entity a search engine reads on its own.
  const { itemOffered, ...offer } = engagementOfferJsonLd(p);
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Service",
    name: itemOffered.name,
    description: p.description,
    provider: itemOffered.provider,
    url: siteUrl(`/products/${slug}`),
    offers: offer,
  };
  const audiences = audiencesForProduct(p.id);
  const crumbs = breadcrumbJsonLd([
    { name: "Time to Power", path: "/" },
    { name: "Engagements", path: "/products" },
    { name: p.name, path: `/products/${slug}` },
  ]);
  return (
    <div className="bg-ink min-h-screen pt-28 pb-24">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(crumbs).replace(/</g, "\\u003c") }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, "\\u003c") }}
      />
      <div className="max-w-3xl mx-auto px-6">
        <nav aria-label="Breadcrumb" className="mb-4 text-[12px] text-faint">
          <Link href="/" className="inline-flex min-h-11 min-w-11 items-center hover:text-power">Home</Link> /{" "}
          <Link href="/products" className="inline-flex min-h-11 items-center hover:text-power">Engagements</Link> / <span className="text-mute">{p.name}</span>
        </nav>
        <div className="eyebrow text-power mb-3">Engagement</div>
        <h1 className="text-3xl font-semibold tracking-tight text-ghost sm:text-4xl">{p.name}</h1>
        <p className="mt-2 font-mono text-lg text-power sm:text-xl">{priceLine(p)}</p>

        {/* The three next steps, before the long description: on a phone this block is inside the first screen. */}
        <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center" data-testid="product-actions">
          <div className="[&_button]:w-full sm:[&_button]:w-auto">
            <CommissionScreen productId={p.id} label={`Commission the ${p.name}`} context={`product-page:${slug}`} />
          </div>
          <FileAwareLink
            href={page.sample?.href ?? "/reference"}
            className="inline-flex min-h-11 items-center justify-center rounded-xl border border-power/50 px-5 py-2.5 text-sm font-semibold text-power hover:bg-power/10"
          >
            {/* Only a product with its own sample says "the sample deliverable"; the others point at the set, and the block below says none is published for them. */}
            {page.sample ? "See the sample deliverable" : "See the sample deliverables"}
          </FileAwareLink>
          <Link
            href={QUALIFY_LINK.href}
            className="inline-flex min-h-11 items-center justify-center px-1 text-sm text-power underline"
          >
            Try the free capacity check first
          </Link>
        </div>

        <p className="mt-6 text-[16px] leading-relaxed text-mute sm:text-[17px]">{p.description}</p>

        <section className="mt-8 rounded border border-line bg-panel-2 p-5" aria-labelledby="before-h">
          <h2 id="before-h" className="text-xl font-semibold text-ghost">Before you buy</h2>
          <dl className="mt-4 space-y-4">
            {beforeYouBuy(page).map((row) => (
              <div key={row.label}>
                <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">{row.label}</dt>
                <dd className="mt-1 text-sm text-ghost">
                  {row.text}
                  {row.link ? (
                    <>
                      {row.text ? " " : null}
                      <FileAwareLink href={row.link.href} className="text-power underline">
                        {row.link.label}
                      </FileAwareLink>
                    </>
                  ) : null}
                  {row.items ? <List items={row.items} /> : null}
                </dd>
              </div>
            ))}
          </dl>
        </section>

        <dl className="mt-8 grid gap-6 sm:grid-cols-2">
          <div>
            <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">Who it is for</dt>
            <dd className="mt-1 text-sm text-ghost">{page.buyer}</dd>
          </div>
          <div>
            <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">The decision it informs</dt>
            <dd className="mt-1 text-sm text-ghost">{page.decision}</dd>
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

        {audiences.length ? (
          <section className="mt-10" aria-labelledby="aud-h">
            <h2 id="aud-h" className="text-xl font-semibold text-ghost">Read it for your role</h2>
            <p className="mt-2 text-sm text-mute">How this step fits the decision in front of each kind of buyer.</p>
            <ul className="mt-3 flex flex-wrap gap-2">
              {audiences.map((a) => (
                <li key={a.slug}>
                  <Link
                    href={`/for/${a.slug}`}
                    className="inline-flex min-h-11 items-center rounded border border-line px-3 text-sm text-mute hover:border-power/50 hover:text-ghost"
                  >
                    {a.name}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <div className="mt-12 flex flex-wrap items-center gap-6 border-t border-line pt-8">
          <CommissionScreen productId={p.id} label={`Commission the ${p.name}`} context={`product-page:${slug}`} />
          <Link href="/pricing#engagements" className="inline-flex min-h-11 items-center text-sm text-power underline">
            Compare all engagements
          </Link>
          <Link href="/legal/terms" className="inline-flex min-h-11 items-center text-sm text-mute underline">
            Terms
          </Link>
        </div>
      </div>
    </div>
  );
}
