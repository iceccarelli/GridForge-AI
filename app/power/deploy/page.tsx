import type { Metadata } from "next";
import { PowerDeployCaseForm } from "@/components/PowerDeployCaseForm";

export const metadata: Metadata = {
  title: "BTM Power Deployment Assessment",
  description:
    "Compare grid, generation and storage architectures under a real contingency test, priced and dated where declared.",
  robots: { index: false, follow: false },
};

/**
 * The customer-facing entry point to `gridforge/reporting/btm_assessment.py`.
 *
 * Everything below this form is real: the submit posts to
 * `/api/power/deploy/cases`, which calls the deployed engine exactly once and
 * writes the answer as revision 1 of a persistent case. There is no sample
 * project and no canned result — an empty state here means no case exists.
 */
export default function PowerDeployPage() {
  return (
    <main className="mx-auto w-full max-w-3xl px-5 pb-24 pt-28 sm:px-8">
      <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-power">
        BTM power deployment
      </p>
      <h1 className="mt-3 text-3xl font-semibold leading-tight text-ghost sm:text-4xl">
        What combination of grid, generation and storage gets you to firm power?
      </h1>
      <p className="mt-4 text-mute">
        Compares GRID ONLY, GRID + GENERATION, GRID + BESS and GRID + BESS + GENERATION against
        your declared redundancy policy, each priced and dated from what you enter below — never
        priced at zero when a unit is uncosted. This is screening-level engineering: a directional
        read from a flat load assumption, not a bankable number. See{" "}
        <code className="text-ghost">docs/07_DELIVERY_RUNBOOK.md</code> for the full request
        shape, including a real interval load profile.
      </p>
      <div className="mt-8">
        <PowerDeployCaseForm />
      </div>
    </main>
  );
}
