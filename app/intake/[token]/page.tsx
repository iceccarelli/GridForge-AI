import type { Metadata } from "next";
import { EngagementIntake } from "@/components/EngagementIntake";

export const metadata: Metadata = {
  title: "Engagement intake | GridForge AI",
  robots: { index: false, follow: false },
};

export default async function IntakePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return (
    <main className="mx-auto w-full max-w-5xl px-5 pb-24 pt-28 sm:px-8">
      <header className="mb-8 max-w-3xl">
        <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-power">
          Commissioned engagement
        </p>
        <h1 className="mt-3 text-3xl font-semibold leading-tight text-ghost">
          The hall&apos;s own numbers
        </h1>
        <p className="mt-4 text-mute">
          Thirteen of these decide the answer. Every one you supply is treated as your measured
          data; every one you leave blank is filled from a library default and named as an
          assumption in the document you receive. That list of assumptions is part of the
          deliverable — it tells your engineers exactly what to go and measure.
        </p>
      </header>
      <EngagementIntake token={token} />
    </main>
  );
}
