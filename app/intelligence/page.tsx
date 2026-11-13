import type { Metadata } from "next";
import { OG_BASE } from "@/lib/site";
import { pageImages } from "@/lib/page-cards";
import { GridForgeVisual } from "@/components/GridForgeVisual";
import { IntelligenceClient } from "@/components/IntelligenceClient";
import { PageJsonLd } from "@/components/PageJsonLd";
import { breadcrumbJsonLd, webPageJsonLd } from "@/lib/jsonld";
import { INTELLIGENCE_VISUALS, visualsImageObjectsJsonLd, type VisualItem } from "@/lib/visual-packs";

const TITLE = "GridForge Intelligence: regional siting";
const DESCRIPTION =
  "A modelled ranking of regions by time to energize, with US interconnection-queue history and day-ahead prices. A modelled subscription, not verified sites.";

const ALL_INTELLIGENCE_ITEMS: VisualItem[] = [
  INTELLIGENCE_VISUALS.hero,
  ...INTELLIGENCE_VISUALS.overview,
  ...INTELLIGENCE_VISUALS.basis,
  ...INTELLIGENCE_VISUALS.delayAndBtm,
  INTELLIGENCE_VISUALS.scenarioLab,
  ...INTELLIGENCE_VISUALS.workspace,
  ...INTELLIGENCE_VISUALS.pricingAndCta,
];

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "/intelligence" },
  twitter: { card: "summary_large_image", images: pageImages("intelligence") },
  openGraph: {
    ...OG_BASE,
    images: pageImages("intelligence"),
    title: TITLE,
    description: DESCRIPTION,
    url: "/intelligence",
  },
};

function Row({ items, cols = "md:grid-cols-3" }: { items: VisualItem[]; cols?: string }) {
  return (
    <div className={`mt-8 grid gap-5 ${cols}`}>
      {items.map((v) => (
        <GridForgeVisual
          key={v.slug}
          slug={v.slug}
          alt={v.alt}
          caption={v.caption}
          sizes="(max-width: 768px) 100vw, 420px"
        />
      ))}
    </div>
  );
}

export default function Page() {
  const webPage = {
    ...webPageJsonLd("/intelligence", TITLE, DESCRIPTION),
    image: visualsImageObjectsJsonLd(ALL_INTELLIGENCE_ITEMS),
  };
  return (
    <>
      <PageJsonLd
        data={[
          webPage,
          breadcrumbJsonLd([
            { name: "Time to Power", path: "/" },
            { name: "Intelligence", path: "/intelligence" },
          ]),
        ]}
      />
      <IntelligenceClient
        heroVisuals={
          <div className="mt-10 space-y-6">
            <div className="max-w-5xl">
              <GridForgeVisual
                slug={INTELLIGENCE_VISUALS.hero.slug}
                alt={INTELLIGENCE_VISUALS.hero.alt}
                caption={INTELLIGENCE_VISUALS.hero.caption}
                priority
                sizes="(max-width: 1024px) 100vw, 1024px"
              />
            </div>
            <Row items={INTELLIGENCE_VISUALS.overview} cols="md:grid-cols-2 max-w-5xl" />
          </div>
        }
        basisVisuals={<Row items={INTELLIGENCE_VISUALS.basis} />}
        delayVisuals={<Row items={INTELLIGENCE_VISUALS.delayAndBtm} />}
        labVisuals={
          <div className="mt-6 max-w-4xl">
            <GridForgeVisual
              slug={INTELLIGENCE_VISUALS.scenarioLab.slug}
              alt={INTELLIGENCE_VISUALS.scenarioLab.alt}
              caption={INTELLIGENCE_VISUALS.scenarioLab.caption}
              sizes="(max-width: 1024px) 100vw, 896px"
            />
          </div>
        }
        workspaceVisuals={
          <section className="mt-14" aria-labelledby="workspace-visuals-h">
            <div className="eyebrow text-power mb-3">INSIDE THE SUBSCRIPTION</div>
            <h2 id="workspace-visuals-h" className="text-2xl font-semibold tracking-tight text-ghost">
              Siting analyst, saved scenarios and exportable briefs.
            </h2>
            <Row items={INTELLIGENCE_VISUALS.workspace} />
          </section>
        }
        footerVisuals={<Row items={INTELLIGENCE_VISUALS.pricingAndCta} cols="md:grid-cols-2 max-w-5xl" />}
      />
    </>
  );
}
