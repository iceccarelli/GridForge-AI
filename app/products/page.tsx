import type { Metadata } from "next";
import Link from "next/link";
import { breadcrumbJsonLd } from "@/lib/jsonld";
import { PRODUCT_PAGES, productForPage } from "@/lib/product-pages";
import { OG_BASE } from "@/lib/site";
import { pageImages } from "@/lib/page-cards";
import { eurFromCents, priceLine, PRODUCTS } from "@/lib/products";
import { GridForgeVisual } from "@/components/GridForgeVisual";

const DESCRIPTION = `Engagements for owners of existing AI data halls: the ${eurFromCents(
  PRODUCTS.density_screen.amountCents
)} Density Screen, Envelope Study, Procurement Specification, Portfolio Screen, Hall Watch.`;

const OG_DESCRIPTION = "Engineering engagements for the owner of an existing AI data hall. Each page states what you receive, what we need from you and what is not included.";

export const metadata: Metadata = {
  title: "Engineering engagements for AI data halls",
  description: DESCRIPTION,
  alternates: { canonical: "/products" },
  twitter: { card: "summary_large_image", images: pageImages("products") },
  openGraph: {
    ...OG_BASE,
    images: pageImages("products"), title: "Engagements — capacity and density engineering", description: OG_DESCRIPTION, url: "/products" },
};

export default function ProductsIndex() {
  const crumbs = breadcrumbJsonLd([
    { name: "Time to Power", path: "/" },
    { name: "Engagements", path: "/products" },
  ]);
  return (
    <div className="bg-ink min-h-screen pt-28 pb-24">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(crumbs).replace(/</g, "\\u003c") }}
      />
      <div className="max-w-3xl mx-auto px-6">
        <div className="eyebrow text-power mb-4">Engagements</div>
        <h1 className="text-4xl font-semibold tracking-tight text-ghost">Five engagements, each priced before you start</h1>
        <p className="mt-5 text-[17px] leading-relaxed text-mute">
          Each is a named deliverable, not retainer hours. The Envelope Study and the Portfolio Screen are opened with a deposit, and the fee is agreed with you in writing, within its band, before work starts; the deposit is credited in full against it. The first paid step is the Density Screen, which credits
          in full against the Envelope Study. Not sure? Run the{" "}
          <Link href="/qualify" className="text-power underline">free capacity check</Link> first.
        </p>
        <ul className="mt-10 space-y-5">
          {PRODUCT_PAGES.map((page) => {
            const p = productForPage(page);
            return (
              <li key={page.slug} className="panel p-6">
                <h2 className="text-lg font-semibold text-ghost">
                  <Link href={`/products/${page.slug}`} className="hover:text-power">{p.name}</Link>
                </h2>
                <p className="mt-1 font-mono text-sm text-power">{priceLine(p)}</p>
                <p className="mt-3 text-[14px] leading-relaxed text-mute">{page.decision}</p>
              </li>
            );
          })}
        </ul>
        <p className="mt-8 text-sm text-mute">
          Metered API access is on the <Link href="/developers#plans" className="text-power underline">developers page</Link>;
          every price in one place is on <Link href="/pricing" className="text-power underline">pricing</Link>.
        </p>
      </div>
    </div>
  );
}

      <div className="mt-12 space-y-10">
        <GridForgeVisual slug="synthetic-hall-worked-floorplan" alt="Isometric floorplan of a synthetic 2.0 MW hall with three aisles: cyan active 120 kW, amber 36 kW capped, and dark stranded wireframes." />
        <GridForgeVisual slug="portfolio-multi-hall-triage-matrix" alt="Executive dashboard of six synthetic halls ranked by unlockable headroom, lead time and evidence class, highlighting fastest ROI and deferred transformer-bound halls." />
      </div>