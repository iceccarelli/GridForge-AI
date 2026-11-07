import type { Metadata } from "next";
import Link from "next/link";
import { PageJsonLd } from "@/components/PageJsonLd";
import { ORG_DESCRIPTION, ORG_ID, entityGraph } from "@/lib/entity";
import { breadcrumbJsonLd } from "@/lib/jsonld";
import { OG_BASE, SITE, siteUrl } from "@/lib/site";
import { pageImages } from "@/lib/page-cards";
import { QUALIFY_LINK } from "@/lib/nav";

const TITLE = "About Time to Power — who is behind it, what it does and how to reach us";
const DESCRIPTION =
  "Time to Power is a founder-led engineering practice for existing AI data halls. What we sell and what we do not, where we are and how to reach us.";

export const metadata: Metadata = {
  title: "About",
  description: DESCRIPTION,
  alternates: { canonical: "/about" },
  twitter: { card: "summary_large_image", images: pageImages("about") },
  openGraph: {
    ...OG_BASE,
    images: pageImages("about"), title: TITLE, description: DESCRIPTION, url: "/about" },
};

export default function AboutPage() {
  return (
    <div className="mx-auto w-full max-w-3xl px-5 pb-24 pt-28 sm:px-8">
      <PageJsonLd
        data={[
          // The page IS about the organisation: the same graph the home page carries (one definition, lib/entity.ts), plus the AboutPage.
          entityGraph(),
          {
            "@context": "https://schema.org",
            "@type": "AboutPage",
            "@id": siteUrl("/about#page"),
            url: siteUrl("/about"),
            name: TITLE,
            description: DESCRIPTION,
            mainEntity: { "@id": ORG_ID },
            isPartOf: { "@id": siteUrl("/#website") },
          },
          breadcrumbJsonLd([
            { name: SITE.name, path: "/" },
            { name: "About", path: "/about" },
          ]),
        ]}
      />
      <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-power">About</p>
      <h1 className="mt-3 text-3xl font-semibold leading-tight text-ghost sm:text-4xl">{SITE.name}</h1>
      <p className="mt-3 text-lg text-mute">{SITE.tagline}</p>

      <section className="mt-10" aria-labelledby="what-h">
        <h2 id="what-h" className="text-xl font-semibold text-ghost">What it is</h2>
        <p className="mt-3 text-[15px] leading-relaxed text-mute">{ORG_DESCRIPTION}</p>
        <p className="mt-3 text-[15px] leading-relaxed text-mute">
          Every number in a document carries an evidence class, from an assumption to an observation in operation, and the calibration
          record says how far the model has been checked against real sites. It is published, not hidden:{" "}
          <Link href="/evidence" className="text-power underline">evidence classes and calibration status</Link>.
        </p>
      </section>

      <section className="mt-10" aria-labelledby="who-h">
        <h2 id="who-h" className="text-xl font-semibold text-ghost">Who is behind it</h2>
        <p className="mt-3 text-[15px] leading-relaxed text-mute">
          Time to Power is founder-led and pilot-stage. It is built by {SITE.founder}, a grid networks engineer working on the
          digitalization of high-voltage assets, with an M.Sc. from RWTH Aachen in cross-domain grid intelligence. His own site is{" "}
          <a href={SITE.founderUrl} className="text-power underline" rel="noopener">{SITE.founderUrl.replace(/^https:\/\//, "")}</a>. The
          engine underneath is GridForge Engine; its source is public at{" "}
          <a href={SITE.repo} className="text-power underline" rel="noopener">{SITE.repo.replace(/^https:\/\//, "")}</a>.
        </p>
      </section>

      <section className="mt-10" aria-labelledby="sell-h">
        <h2 id="sell-h" className="text-xl font-semibold text-ghost">What we sell, and what we do not</h2>
        <ul className="mt-3 list-disc space-y-2 pl-5 text-[15px] leading-relaxed text-mute">
          <li>
            Fixed-fee engineering engagements and metered software, each priced before you start:{" "}
            <Link href="/products" className="text-power underline">engagements</Link>,{" "}
            <Link href="/pricing" className="text-power underline">pricing</Link>,{" "}
            <Link href="/developers" className="text-power underline">machine interface</Link>.
          </li>
          <li>We sell no equipment, hold no inventory and take no margin on hardware. We name no make and no model.</li>
          <li>
            Engagement documents are produced and reviewed by a senior engineer, in screening mode. They are not an issued engineering
            opinion and carry no professional signature.
          </li>
        </ul>
      </section>

      <section className="mt-10" aria-labelledby="where-h">
        <h2 id="where-h" className="text-xl font-semibold text-ghost">Where we are and how to reach us</h2>
        <dl className="mt-3 space-y-2 text-[15px] text-mute">
          <div className="flex gap-3"><dt className="w-28 shrink-0 text-faint">Based in</dt><dd>{SITE.baseLocation}</dd></div>
          <div className="flex gap-3">
            <dt className="w-28 shrink-0 text-faint">Email</dt>
            <dd><a href={`mailto:${SITE.email}`} className="text-power underline">{SITE.email}</a></dd>
          </div>
          <div className="flex gap-3">
            <dt className="w-28 shrink-0 text-faint">Contact card</dt>
            <dd><a href="/contact.vcf" className="text-power underline" download>contact.vcf</a>, to add us to an address book</dd>
          </div>
          <div className="flex gap-3">
            <dt className="w-28 shrink-0 text-faint">Security</dt>
            <dd><Link href="/legal/security" className="text-power underline">disclosure policy</Link> and <a href="/.well-known/security.txt" className="text-power underline">security.txt</a></dd>
          </div>
        </dl>
      </section>

      <section className="mt-10" aria-labelledby="machine-h">
        <h2 id="machine-h" className="text-xl font-semibold text-ghost">For software and AI assistants</h2>
        <ul className="mt-3 list-disc space-y-1 pl-5 text-[15px] text-mute">
          <li><a href="/llms.txt" className="text-power underline">llms.txt</a>, an index of the site for language models</li>
          <li><a href="/openapi.json" className="text-power underline">openapi.json</a>, the engine&rsquo;s HTTP interface</li>
          <li><a href="/api/cite" className="text-power underline">/api/cite</a>, how to cite the constraint reference</li>
          <li><Link href="/constraints" className="text-power underline">The thirteen constraints</Link> and the <Link href="/platforms" className="text-power underline">platform library</Link></li>
        </ul>
      </section>

      <div className="mt-12 border-t border-line pt-8">
        <Link href="/qualify" className="inline-block rounded bg-power px-5 py-2.5 font-semibold text-ink">{QUALIFY_LINK.label}</Link>
      </div>
    </div>
  );
}
