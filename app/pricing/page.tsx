import type { Metadata } from "next";
import { OG_BASE } from "@/lib/site";
import { pageImages } from "@/lib/page-cards";
import { PageJsonLd } from "@/components/PageJsonLd";
import { breadcrumbJsonLd, engagementCatalogJsonLd, webPageJsonLd } from "@/lib/jsonld";
import Link from "next/link";
import CostEstimator from "@/components/CostEstimator";
import { EngagementLadder } from "@/components/EngagementLadder";
import FreeAllowanceForm from "@/components/FreeAllowanceForm";
import PaygRateCard from "@/components/PaygRateCard";
import ThreePaths from "@/components/ThreePaths";
import { TtpPhoto } from "@/components/TtpPhoto";
import { INTELLIGENCE_PLANS, PAYG, PRODUCTS, eurFromCents } from "@/lib/products";
import { PLANS, eurMonth, seatLine } from "@/lib/subscriptions";
import { QUALIFY_LINK } from "@/lib/nav";
import { CAPABILITY_REGISTRY } from "@/lib/capability-registry";
import { callableRates } from "@/lib/payg-pricing";
import { engineServes } from "@/lib/engine-capabilities";
import { estimateEndpointServed, readToolRatesWithAvailability } from "@/lib/tool-rates";
import { GridForgeVisual } from "@/components/GridForgeVisual";

const PRICING_TITLE = "Pricing: free check, API, engagements";
const PRICING_DESCRIPTION = `A free capacity check, a metered API with a free allowance, engagements from the ${eurFromCents(PRODUCTS.density_screen.amountCents)} Density Screen, and a market intelligence subscription.`;

// True while every Intelligence plan is recorded in the capability registry with an unverified production state.
const INTELLIGENCE_UNVERIFIED = CAPABILITY_REGISTRY.filter((c) => c.family === "intelligence").every((c) => c.production_status === "unverified");

// The engagements, named as a buyer says them (the catalogue names the deposits "... — deposit").
const short = (id: keyof typeof PRODUCTS) => PRODUCTS[id].name.replace(/ — deposit$/, "").replace(/^Capacity & Density /, "");

export const metadata: Metadata = {
  title: PRICING_TITLE,
  description: PRICING_DESCRIPTION,
  alternates: { canonical: "/pricing" },
  twitter: { card: "summary_large_image", images: pageImages("pricing") },
  openGraph: {
    ...OG_BASE,
    images: pageImages("pricing"),
    title: PRICING_TITLE,
    description: PRICING_DESCRIPTION,
    url: "/pricing",
  },
};

// Which metered operations are callable follows the DEPLOYED engine (its /v1/version), which changes when the engine is
// redeployed, not when this site is. Regenerate at most every five minutes instead of freezing the answer at build time.
export const revalidate = 300;

export default async function PricingPage() {
  const rates = await readToolRatesWithAvailability();
  const estimateAvailable = await estimateEndpointServed();
  const compareAvailable = await engineServes("/v1/compare");
  return (
    <div className="bg-ink min-h-screen pt-28 pb-24">
      <PageJsonLd
        data={[
          webPageJsonLd("/pricing", PRICING_TITLE, PRICING_DESCRIPTION),
          engagementCatalogJsonLd(),
          breadcrumbJsonLd([
            { name: "Time to Power", path: "/" },
            { name: "Pricing", path: "/pricing" },
          ]),
        ]}
      />
        <div className="max-w-7xl mx-auto px-6">
          <div className="max-w-2xl">
            <div className="eyebrow text-power mb-4">Pricing</div>
            <h1 className="text-4xl md:text-5xl font-semibold tracking-tight leading-[1.1]">
              Three ways to use it,
              <br />
              <span className="text-power">each priced before you start.</span>
            </h1>
            <p className="text-mute text-[17px] leading-relaxed mt-6">
              A free result you can get without an account, metered software you call from your own code, and
              engineering a named power-systems engineer reviews for your site. They are different things with different
              prices, and none of them is billed by the hour. Market intelligence is a separate subscription, further down.
            </p>
            {/* One line, every link to the page that explains the step: the answer to "which one do I need?". */}
            <p className="mt-5 max-w-2xl text-sm leading-relaxed text-mute" data-testid="which-one">
              <span className="font-semibold text-ghost">Which one do I need?</span>{" "}
              Not sure what binds your hall:{" "}
              <Link href={QUALIFY_LINK.href} className="text-power underline">the free check</Link>. One hall and a decision:{" "}
              <Link href="/products/density-screen" className="text-power underline">{short("density_screen")}</Link>. The full ladder and the
              architecture to commit to:{" "}
              <Link href="/products/envelope-study" className="text-power underline">{short("envelope_study_deposit")}</Link>. The engine from
              your own code: <Link href="/developers#plans" className="text-power underline">the API</Link>. The answer kept current as inputs
              change: <Link href="/products/hall-watch" className="text-power underline">{short("hall_watch")}</Link>.
            </p>
          </div>

          <div className="mt-10">
            <ThreePaths />

          <div className="mt-12">
            <GridForgeVisual
              slug="commercial-model-three-paths"
              alt="Three architectural monolith cards for free capacity check, metered engine API, and fixed-fee density screen engagements."
            />
          </div>
          </div>

          <TtpPhoto
            id="ttp-11"
            className="rounded-xl overflow-hidden border border-line aspect-[21/9] max-h-[280px] my-10"
          />

          {/* One price list. It used to render PACKAGES above this — a second,
              unsourced fee structure from the practice this repository used to be,
              so a buyer met two unrelated price lists on one page. Everything
              purchasable now comes from the catalogue, which is parity-tested
              against the engine's own commercial figures. */}
          <section id="engagements" aria-labelledby="engagements-h" className="scroll-mt-24">
            <h2 id="engagements-h" className="text-2xl font-semibold text-ghost">Engineering engagements</h2>
            <p className="mt-2 mb-6 max-w-2xl text-sm text-mute">
              Every engagement is a named deliverable, not retainer hours. The Density Screen and the Procurement
              Specification are priced at checkout. The Envelope Study and the Portfolio Screen start with a deposit: the
              fee is then agreed with you in writing, within the band shown, before any work starts, and the deposit is
              credited in full against it. Hall Watch is billed every quarter. The first paid step is the Density Screen,
              which credits in full against the Envelope Study.
            </p>
            <EngagementLadder />
          </section>

          <section id="metered" aria-labelledby="metered-h" className="mt-16 scroll-mt-24">
            <h2 id="metered-h" className="text-2xl font-semibold text-ghost">Metered software</h2>
            <p className="mt-2 max-w-3xl text-sm text-mute">
              The same engine, called directly. Start on a free allowance, move to pay-as-you-go under a monthly cap you
              set, and take a plan when the volume warrants one. API responses are screening output: an engagement document is drafted
              by the engine, then reviewed and released by a named engineer, in screening mode and not as an issued engineering opinion.
            </p>
            <div className="mt-6 rounded border border-power/40 bg-panel-2 p-5 sm:p-6">
              <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-power">
                Free allowance · {PAYG.freeAllowanceUnits} units a month · no card
              </p>
              <div className="mt-3 max-w-2xl">
                <FreeAllowanceForm heading="Try the engine on your own hall, free" />
              </div>
            </div>
            <div className="mt-8">
              <PaygRateCard rates={rates} />
            </div>
            <div className="mt-6">
              <CostEstimator
                rates={callableRates(rates)}
                estimateAvailable={estimateAvailable}
                engine={process.env.GRIDFORGE_API_URL || "https://gridforge-engine.fly.dev"}
              />
            </div>
            <p className="mt-4 text-sm text-mute">
              Plans, the MCP install and the tool schemas are on the{" "}
              <Link href="/developers#plans" className="text-power underline">
                API and MCP page
              </Link>
              .
            </p>
          </section>

          <section id="intelligence" aria-labelledby="intelligence-h" className="mt-16 scroll-mt-24">
            <h2 id="intelligence-h" className="text-2xl font-semibold text-ghost">Market intelligence subscription</h2>
            <p className="mt-2 max-w-3xl text-sm text-mute">
              A separate product from the engine, the API and the engagements: a siting dashboard that ranks regions by
              modelled time to energize, with US interconnection-queue history and day-ahead price context. Billed monthly.
              The plan names below belong to this dashboard; API plans are on the{" "}
              <Link href="/developers#plans" className="text-power underline">API and MCP page</Link>.
            </p>
            {/* Shown while the capability registry records Intelligence's production state as unverified (tests/site/pricing-lanes.test.ts
                keeps the two in step). /intelligence says the ranking is modelled; it does not say this. */}
            {INTELLIGENCE_UNVERIFIED ? (
              <p className="mt-3 max-w-3xl text-sm text-faint" data-testid="intelligence-unverified">
                We have not yet verified this subscription end to end in production. The ranking is modelled, not a verified-site portfolio.
              </p>
            ) : null}
            <ul className="mt-5 grid gap-4 md:grid-cols-3">
              {PLANS.map((plan) => (
                <li key={plan.id} className="panel flex flex-col p-5" data-testid={`intelligence-plan-${plan.id}`}>
                  <div className="flex items-baseline justify-between gap-3">
                    <h3 className="text-lg font-semibold text-ghost">{plan.name}</h3>
                    <span className="data font-mono text-power">
                      {eurMonth(INTELLIGENCE_PLANS[plan.id].priceCents)}
                      <span className="text-faint"> / {INTELLIGENCE_PLANS[plan.id].interval}</span>
                    </span>
                  </div>
                  <p className="mt-2 text-sm text-mute">{plan.tagline}</p>
                  <p className="mt-3 text-[12px] text-faint">{seatLine(INTELLIGENCE_PLANS[plan.id].seats)}</p>
                </li>
              ))}
            </ul>
            <Link href="/intelligence" className="mt-4 inline-flex min-h-11 items-center text-sm text-power underline">
              See what the subscription contains
            </Link>
          </section>

          <section className="mt-12 max-w-3xl rounded border border-line bg-panel-2 p-6" aria-labelledby="start-free">
            <h2 id="start-free" className="text-lg font-semibold text-ghost">
              Not sure which step to start with?
            </h2>
            {compareAvailable ? (
              <>
                <p className="mt-2 text-sm text-mute">
                  Run the free Time-to-Power comparison on your hall: racks as found and after relief, what binds, and the date to full
                  capacity with the evidence class behind it. Save it to a project and send the read-only page to whoever approves the
                  spend; they can commission the next step from it, at the prices above.
                </p>
                <Link href="/power/compare" className="mt-3 inline-flex min-h-11 items-center text-sm text-power">
                  Run the comparison →
                </Link>
              </>
            ) : (
              <>
                <p className="mt-2 text-sm text-mute">
                  Start with the free capacity check on your hall: seven numbers, no account, and it names the constraint that binds
                  first. The free Time-to-Power scenario comparison is not available yet: it is waiting on an engine release, and
                  nothing is charged for it either way. The Density Screen is the next step, at the price above.
                </p>
                <Link href="/qualify" className="mt-3 inline-block text-sm text-power">
                  Run the free check →
                </Link>
              </>
            )}
          </section>

          <div className="mt-12">
            <Link
              href="/#services"
              className="data text-xs uppercase tracking-[0.12em] text-mute hover:text-power transition-colors inline-flex min-h-11 items-center gap-1.5"
            >
              ← Full service detail
            </Link>
          </div>
        </div>
    </div>
  );
}
