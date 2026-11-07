import type { Metadata } from "next";
import { OG_BASE } from "@/lib/site";
import { pageImages } from "@/lib/page-cards";
import { PowerDeployCaseForm } from "@/components/PowerDeployCaseForm";
import { availabilityIn, deployedEngineRoutes } from "@/lib/engine-capabilities";
import { NotYetAvailable } from "@/app/power/NotYetAvailable";
import { PageJsonLd } from "@/components/PageJsonLd";
import { breadcrumbJsonLd, webPageJsonLd } from "@/lib/jsonld";

const DEPLOY_TITLE = "BTM Power Deployment Assessment";
const DEPLOY_DESCRIPTION =
  "Compare grid, generation and storage architectures under a real contingency test, priced and dated where declared.";

// Whether the form is shown follows the DEPLOYED engine (its /v1/version), not the last build of this site.
export const revalidate = 300;

export const metadata: Metadata = {
  title: "BTM Power Deployment Assessment",
  alternates: { canonical: "/power/deploy" },
  twitter: { card: "summary_large_image", images: pageImages("deploy") },
  openGraph: {
    ...OG_BASE,
    images: pageImages("deploy"),
    url: "/power/deploy",
    title: "BTM Power Deployment Assessment",
    description: "Compare grid, generation and storage architectures under a real contingency test, priced and dated where declared.",
  },
  description:
    "Compare grid, generation and storage architectures under a real contingency test, priced and dated where declared.",
};

/**
 * The customer-facing entry point to `gridforge/reporting/btm_assessment.py`.
 *
 * Everything below this form is real: the submit posts to
 * `/api/power/deploy/cases`, which calls the deployed engine exactly once and
 * writes the answer as revision 1 of a persistent case. There is no sample
 * project and no canned result — an empty state here means no case exists.
 */
export default async function PowerDeployPage() {
  const state = availabilityIn(await deployedEngineRoutes(), "/v1/power/deploy/assess");
  return (
    <div className="mx-auto w-full max-w-3xl px-5 pb-24 pt-28 sm:px-8">
      <PageJsonLd
        data={[
          webPageJsonLd("/power/deploy", DEPLOY_TITLE, DEPLOY_DESCRIPTION),
          breadcrumbJsonLd([
            { name: "Time to Power", path: "/" },
            { name: "BTM power deployment", path: "/power/deploy" },
          ]),
        ]}
      />
      <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-power">
        BTM power deployment
      </p>
      <h1 className="mt-3 text-3xl font-semibold leading-tight text-ghost sm:text-4xl">
        What combination of grid, generation and storage gets you to firm power?
      </h1>
      <p className="mt-4 text-mute">
        {state === "available" ? "Compares" : "Once it is available, this compares"} GRID ONLY, GRID + GENERATION, GRID + BESS and GRID + BESS + GENERATION against
        your declared redundancy policy, each priced and dated from what you enter — never
        priced at zero when a unit is uncosted. This is screening-level engineering: a directional
        read from a flat load assumption, not a bankable number. The API accepts a fuller request, including a real interval load profile.
      </p>
      {state === "available" ? (
        <div className="mt-8">
          <PowerDeployCaseForm />
        </div>
      ) : (
        <NotYetAvailable
          what="The BTM power deployment assessment"
          unreadable={state === "unknown"}
          alternative={{ href: "/qualify", label: "Run the free capacity check instead" }}
        />
      )}
    </div>
  );
}
