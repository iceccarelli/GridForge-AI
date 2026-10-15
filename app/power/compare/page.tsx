import type { Metadata } from "next";
import { TtpCompare } from "@/components/TtpCompare";

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
 * resting on assumed lead times says it is indicative. There is no stored sample and nothing is persisted.
 */
export default function PowerComparePage() {
  return (
    <main className="mx-auto w-full max-w-6xl px-5 pb-24 pt-28 sm:px-8">
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
      <div className="mt-8">
        <TtpCompare />
      </div>
    </main>
  );
}
