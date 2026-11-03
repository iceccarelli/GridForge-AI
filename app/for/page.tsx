import type { Metadata } from "next";
import Link from "next/link";
import { AUDIENCES } from "@/lib/audiences";
import { breadcrumbJsonLd, webPageJsonLd } from "@/lib/jsonld";
import { pageImages } from "@/lib/page-cards";
import { OG_BASE } from "@/lib/site";

const TITLE = "Who Time to Power is for";
const DESCRIPTION =
  "Seven buyers of power-capacity work on existing AI data halls: owners, colocation operators, AI infrastructure operators, developers, investors, engineers and advisors. Each page starts from that buyer's own decision and names what the work would and would not tell them.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "/for" },
  twitter: { card: "summary_large_image", images: pageImages("for") },
  openGraph: { ...OG_BASE, images: pageImages("for"), title: TITLE, description: DESCRIPTION, url: "/for" },
};

export default function ForIndex() {
  const crumbs = breadcrumbJsonLd([
    { name: "Time to Power", path: "/" },
    { name: "Who it is for", path: "/for" },
  ]);
  const page = webPageJsonLd("/for", TITLE, DESCRIPTION);
  return (
    <div className="min-h-screen bg-ink pb-24 pt-28">
      {[crumbs, page].map((j, i) => (
        <script key={i} type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(j).replace(/</g, "\\u003c") }} />
      ))}
      <div className="mx-auto max-w-5xl px-6">
        <div className="eyebrow mb-4 text-power">WHO IT IS FOR</div>
        <h1 className="max-w-3xl text-4xl font-semibold tracking-tight text-ghost">One engine, seven different decisions.</h1>
        <p className="mt-5 max-w-2xl text-[17px] leading-relaxed text-mute">
          An owner deciding whether a hall is worth a study, an investor underwriting an asset and an advisor comparing bids are asking for
          different things. Each page below starts from that buyer&rsquo;s decision, names the constraints most likely to decide it, and
          lays out the route through what can be bought, starting with what is free.
        </p>
        <ul className="mt-10 grid gap-4 md:grid-cols-2">
          {AUDIENCES.map((a) => (
            <li key={a.slug}>
              <Link href={`/for/${a.slug}`} className="panel panel-hover block h-full p-6">
                <h2 className="text-lg font-semibold text-ghost">{a.name}</h2>
                <p className="mt-2 text-[15px] leading-relaxed text-mute">{a.summary}</p>
                <p className="data mt-4 text-[11px] text-power">{a.firstQuestion}</p>
              </Link>
            </li>
          ))}
        </ul>
        <p className="mt-10 max-w-2xl text-sm text-mute">
          Nothing on these pages is a customer story. Time to Power is a founder-led, pilot-stage practice, and a reference is added only
          with the customer&rsquo;s permission. See <Link href="/evidence" className="text-power underline">how every number is graded</Link>.
        </p>
      </div>
    </div>
  );
}
