import type { Metadata } from "next";
import Link from "next/link";
import { PageJsonLd } from "@/components/PageJsonLd";
import { orgRef } from "@/lib/entity";
import { breadcrumbJsonLd } from "@/lib/jsonld";
import { QUALIFY_LINK } from "@/lib/nav";
import { pageImages } from "@/lib/page-cards";
import { OG_BASE, SITE, siteUrl } from "@/lib/site";

const TITLE = "Contact Time to Power";
const DESCRIPTION =
  "How to reach Time to Power, and what to include so the first reply can be useful: the hall, the platform, the decision and what you already have. NDA on request. A founder-led, pilot-stage practice that sells no equipment.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "/contact" },
  twitter: { card: "summary_large_image", images: pageImages("contact") },
  openGraph: { ...OG_BASE, images: pageImages("contact"), title: TITLE, description: DESCRIPTION, url: "/contact" },
};

const INCLUDE = [
  "The hall in a line: the country or metro, the contracted capacity in MW and whether it is already energised.",
  "The platform you intend to deploy (for example the rack model) and roughly how many racks.",
  "The decision you are trying to make, and by when it has to be made.",
  "What you already hold: single-lines, busway and tap-off ratings, metered peak data. Say what you do not have; that is useful.",
  "Whether an NDA is needed before you send documents. It is available on request.",
];

export default function ContactPage() {
  const page = {
    "@context": "https://schema.org",
    "@type": "ContactPage",
    name: TITLE,
    description: DESCRIPTION,
    url: siteUrl("/contact"),
    mainEntity: { ...orgRef(), contactPoint: { "@type": "ContactPoint", contactType: "customer support", email: SITE.email, availableLanguage: "en" } },
  };
  return (
    <div className="mx-auto w-full max-w-3xl px-5 pb-24 pt-28 sm:px-8">
      <PageJsonLd data={[page, breadcrumbJsonLd([{ name: "Time to Power", path: "/" }, { name: "Contact", path: "/contact" }])]} />
      <p className="eyebrow mb-3 text-power">CONTACT</p>
      <h1 className="[overflow-wrap:anywhere] text-3xl font-semibold leading-tight text-ghost sm:text-4xl">Talk to the engineer who will do the work.</h1>
      <p className="mt-4 text-[17px] leading-relaxed text-mute">
        Time to Power is a founder-led, pilot-stage practice. Early partners work with the engineer, not an account manager. It sells no equipment and
        takes no margin on hardware, so what you are told is not shaped by something it wants to sell you.
      </p>

      <section className="mt-8 rounded-lg border border-line bg-panel p-5" aria-labelledby="email-h">
        <h2 id="email-h" className="data text-[11px] tracking-[0.14em] text-power">EMAIL</h2>
        <p className="mt-2 text-lg text-ghost">
          <a href={`mailto:${SITE.email}`} className="text-power underline">{SITE.email}</a>
        </p>
        <p className="mt-2 text-[14px] leading-relaxed text-mute">
          We make no promise about when we will reply. If the question is urgent, say what makes it urgent. No postal address, telephone number or social
          account is published because none is maintained for enquiries.
        </p>
      </section>

      <section className="mt-10" aria-labelledby="include-h">
        <h2 id="include-h" className="text-xl font-semibold text-ghost">What to include</h2>
        <ul className="mt-3 list-disc space-y-2 pl-5 text-[15px] leading-relaxed text-mute">
          {INCLUDE.map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
      </section>

      <section className="mt-10" aria-labelledby="first-h">
        <h2 id="first-h" className="text-xl font-semibold text-ghost">If you would rather not write first</h2>
        <p className="mt-3 text-[15px] leading-relaxed text-mute">
          <Link href={QUALIFY_LINK.href} className="text-power underline">{QUALIFY_LINK.label}</Link> takes seven numbers and needs no account, card or contact
          details; it names the constraint likely to bind first and what it had to assume. <Link href="/products" className="text-power underline">The engagements</Link>{" "}
          each state what you receive, what we need from you and what they are not. <Link href="/for" className="text-power underline">Who it is for</Link> starts from
          each buyer&rsquo;s own decision.
        </p>
      </section>

      <section className="mt-10" aria-labelledby="what-h">
        <h2 id="what-h" className="text-xl font-semibold text-ghost">What an enquiry is and is not</h2>
        <ul className="mt-3 list-disc space-y-2 pl-5 text-[15px] leading-relaxed text-mute">
          <li>An email is not an engagement, and no price is agreed or implied by one. Fees are on <Link href="/pricing" className="text-power underline">the pricing page</Link>; a deposit is agreed against a scoped fee before any work.</li>
          <li>A reply is directional unless it says otherwise, and is not an engineering opinion, approval or commitment on behalf of the company.</li>
          <li>What you send is handled as described on <Link href="/legal/privacy" className="text-power underline">the privacy page</Link>. Please do not send credentials or live customer data.</li>
        </ul>
      </section>
    </div>
  );
}
