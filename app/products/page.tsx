import type { Metadata } from "next";
import Link from "next/link";
import { breadcrumbJsonLd } from "@/lib/jsonld";
import { PRODUCT_PAGES, productForPage } from "@/lib/product-pages";
import { OG_BASE } from "@/lib/site";
import { pageImages } from "@/lib/page-cards";
import { eurFromCents, priceLine, PRODUCTS } from "@/lib/products";

const DESCRIPTION = `Fixed-fee engineering engagements for the owner of an existing AI data hall, from the ${eurFromCents(
  PRODUCTS.density_screen.amountCents
)} Density Screen to the Capacity & Density Envelope Study, a tender-ready Procurement Specification, a multi-hall Portfolio Screen and quarterly Hall Watch. Each page states what you receive, what we need from you and what it is not.`;

const OG_DESCRIPTION = "Fixed-fee engineering engagements for the owner of an existing AI data hall. Each page states what you receive, what we need from you and what it is not.";

export const metadata: Metadata = {
  title: "Engagements — fixed-fee capacity and density engineering",
  description: DESCRIPTION,
  alternates: { canonical: "/products" },
  twitter: { card: "summary_large_image", images: pageImages("products") },
  openGraph: {
    ...OG_BASE,
    images: pageImages("products"), title: "Engagements — fixed-fee capacity and density engineering", description: OG_DESCRIPTION, url: "/products" },
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
          Each is a fixed fee for a named deliverable, not retainer hours. Most halls begin with the Density Screen, which credits
          in full against the study it usually leads to. Not sure? Run the{" "}
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
