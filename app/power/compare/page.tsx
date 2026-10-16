import type { Metadata } from "next";
import Link from "next/link";
import { TtpCompare } from "@/components/TtpCompare";
import { comparisonToolJsonLd } from "@/lib/jsonld";
import { PRODUCTS, eurFromCents } from "@/lib/products";

export const metadata: Metadata = {
  title: "Time-to-Power scenario comparison",
  description:
    "Compare cooling and supply scenarios for one data-centre hall: racks, binding constraint, date with its evidence class, and capital — dated only where the lead times support it.",
};

/**
 * The customer-facing front of `POST /v1/compare` (gridforge/api/compare_payload.py).
 *
 * Everything under the form is the engine's answer to what was entered. A scenario whose date depends on a lead
 * time nobody has supplied gets no date and a reason, nothing is ranked on a missing figure, and a comparison
 * resting on assumed lead times says it is indicative. There is no stored sample. Nothing is persisted unless the visitor
 * chooses to save the comparison to a project (components/TtpSaveToProject.tsx).
 */
export default function PowerComparePage() {
  return (
    <main className="mx-auto w-full max-w-6xl px-5 pb-24 pt-28 sm:px-8">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(comparisonToolJsonLd()).replace(/</g, "\\u003c") }}
      />
      <p className="eyebrow">Time-to-Power</p>
      <h1 className="mt-3 text-3xl font-semibold leading-tight text-ghost sm:text-4xl">
        Which route gets this hall to power first — and how sure are we?
      </h1>
      <p className="mt-4 max-w-3xl text-mute">
        Describe one hall. The engine solves it once and lays the scenarios side by side: racks deployable now and after relief, what
        binds, when full capacity could energise (with a low–high band and the evidence class behind it) and what the works cost.
        It will not date a scenario whose lead time is unknown, will not rank on a price it does not have, and does not date grid
        reinforcement — that needs the network operator&apos;s offer. Screening-level engineering; not an issued opinion.
      </p>
      <p className="mt-3 max-w-3xl text-sm text-mute">
        Free, no account. When it is worth taking further, save it to a project, give whoever approves the spend a read-only page
        (the decision, what it rests on, the evidence class behind each date), and commission the next step from there — the{" "}
        {PRODUCTS.density_screen.name} starts at {eurFromCents(PRODUCTS.density_screen.amountCents)}.{" "}
        <Link href="/pricing" className="text-power">
          See pricing
        </Link>
        .
      </p>
      <div className="mt-8">
        <TtpCompare />
      </div>
    </main>
  );
}
