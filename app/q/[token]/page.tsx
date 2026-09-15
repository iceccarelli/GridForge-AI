import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CommissionScreen } from "@/components/CommissionScreen";
import { AlertTriangle, ArrowRight, Users } from "lucide-react";
import { BENCHMARK_MIN_HALLS, benchmark, getQualification } from "@/lib/qualify";
import { constraintReference } from "@/lib/constraints";
import { PRODUCTS } from "@/lib/products";
import { eur } from "@/lib/commerce";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Capacity read | GridForge AI",
  // Somebody's hall, shared by them, with whoever they choose. Not for indexing.
  robots: { index: false, follow: false },
};

/**
 * The capacity read, on a link.
 *
 * The qualifier produced a real engineering answer and then lost it when the tab
 * closed. Commercially that is the whole problem: the person who types seven
 * numbers into a capacity qualifier is an operations engineer, and the person who
 * signs off a five-figure study is a director. The distance between them is a
 * link, and there was not one.
 *
 * So this page carries the engineering rather than a summary of it — the binding
 * constraint with its basis, what it takes to move, what nobody has measured, and
 * the same disclosure the paid document carries. A shareable page that softened
 * any of that would be a brochure, and a director who has read one brochure
 * recognises the next one.
 */
export default async function QualificationPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const q = await getQualification(token);
  if (!q) notFound();

  const [bench, ref] = await Promise.all([
    benchmark(q.binding_constraint),
    constraintReference(),
  ]);
  const doc = ref?.constraints.find((c) => c.name === q.binding_constraint);
  const screen = PRODUCTS.density_screen;
  const asFound = q.racks_as_found ?? 0;
  const afterRelief = q.racks_after_relief ?? 0;
  const where = [q.site_name, q.hall_id].filter(Boolean).join(" · ") || "This hall";

  if (q.status !== "scored" || !q.binding_constraint) {
    return (
      <main className="mx-auto w-full max-w-3xl px-5 pb-24 pt-28 sm:px-8">
        <h1 className="text-2xl font-semibold text-ghost">No result was produced</h1>
        <p className="mt-3 text-mute">
          The figures for {where} were saved, but the engine did not return a read. Nothing was
          invented to fill the gap. We will come back with it.
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-4xl px-5 pb-24 pt-28 sm:px-8">
      <header>
        <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-power">
          Capacity read · {new Date(q.created_at).toLocaleDateString("en-IE")}
          {q.metro ? ` · ${q.metro}` : ""}
        </p>
        <h1 className="mt-3 text-3xl font-semibold leading-tight text-ghost sm:text-4xl">
          {where} stops at {asFound} rack{asFound === 1 ? "" : "s"}
          {q.platform ? ` of ${q.platform}` : ""}.
        </h1>
        <p className="mt-4 text-lg text-mute">
          {q.binding_constraint} binds first — before anything else in the hall runs out.
        </p>
      </header>

      <section className="mt-8 grid gap-3 sm:grid-cols-3">
        <Fig k="Deployable as found" v={String(asFound)} n="racks, with nothing changed" />
        <Fig
          k="After the relief ladder"
          v={String(afterRelief)}
          n="racks, once the costed steps are taken"
        />
        <Fig
          k="Intake completeness"
          v={`${Math.round((q.intake_completeness ?? 0) * 100)}%`}
          n="the rest is assumed, and named below"
        />
      </section>

      {bench.published ? (
        <section className="mt-8 rounded border border-line bg-panel-2 p-6">
          <h2 className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.14em] text-power">
            <Users className="h-3.5 w-3.5" /> How this compares
          </h2>
          <p className="mt-3 text-mute">
            {q.binding_constraint} binds first in{" "}
            <span className="font-mono text-ghost">
              {bench.sameConstraint} of {bench.halls}
            </span>{" "}
            halls that have been through this engine ({bench.sharePct}%).{" "}
            {bench.blockedAsFound !== null ? (
              <>
                {bench.blockedAsFound} of those {bench.halls} deploy zero racks as they stand.
              </>
            ) : null}
          </p>
          <p className="mt-2 text-[11px] text-faint">
            Anonymised and aggregated; nothing identifying any hall is published. Nothing is
            shown below {BENCHMARK_MIN_HALLS} halls, because a distribution over a handful of
            sites is noise dressed as evidence.
          </p>
        </section>
      ) : null}

      {doc ? (
        <section className="mt-8 rounded border border-line bg-panel-2 p-6">
          <h2 className="font-mono text-[11px] uppercase tracking-[0.14em] text-power">
            What {q.binding_constraint.toLowerCase()} actually is
          </h2>
          <p className="mt-3 text-mute">{doc.headline}</p>
          <p className="mt-3 text-sm text-mute">{doc.relation}</p>
          {doc.lead_time_weeks ? (
            <p className="mt-3 text-sm text-mute">
              Relieving it takes{" "}
              <span className="font-mono text-ghost">
                {doc.lead_time_weeks.low}–{doc.lead_time_weeks.high} weeks
              </span>{" "}
              in European retrofits. The schedule, not the capital cost, is usually what
              decides.
            </p>
          ) : null}
          <Link
            href={`/constraints/${doc.slug}`}
            className="mt-4 inline-flex items-center gap-2 text-sm text-power"
          >
            The full engineering reference for this constraint <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </section>
      ) : null}

      <section className="mt-8 rounded border border-queue/40 bg-queue/10 p-6">
        <h2 className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.12em] text-queue">
          <AlertTriangle className="h-3.5 w-3.5" /> What this is, and is not
        </h2>
        <p className="mt-3 text-sm text-mute">
          A directional screening read, modelled from the figures supplied and from library
          defaults for everything not supplied. It is not a bankable number, not a design, and
          not a measurement of this asset. Capital cost, programme duration, the full constraint
          ladder and the comparison between cooling architectures are part of the paid
          engagement — and the model has not yet been reconciled against any instrumented site,
          which we report on every response rather than leave you to ask.
        </p>
      </section>

      <section className="mt-8 flex flex-wrap items-center gap-4 rounded border border-line bg-panel-2 p-6">
        <div className="min-w-64 flex-1">
          <h2 className="text-lg font-semibold text-ghost">
            Find out what it costs to move, and by when.
          </h2>
          <p className="mt-1 text-sm text-mute">
            A {screen.name} turns this read into a document: the first six rungs of the costed
            ladder, the item that sets the energisation date, and a data request you can hand
            your own engineers verbatim. {screen.turnaroundDays} working days, fixed fee, and it
            credits in full against the full study.
          </p>
        </div>
        <CommissionScreen
          productId={screen.id}
          qualificationId={q.id}
          company={q.company}
          capacityMW={
            typeof q.inputs?.contractedMW === "number" ? q.inputs.contractedMW : null
          }
          label={`${eur(screen.amountCents)} — commission it`}
        />
        <Link
          href="/reference"
          className="inline-flex items-center gap-2 rounded border border-line px-5 py-2.5 font-semibold text-ghost hover:border-power/50"
        >
          Read one in full first
        </Link>
      </section>

      <p className="mt-6 text-[11px] text-faint">
        This page is private to whoever holds the link and is not indexed. Run another hall at{" "}
        <Link href="/qualify" className="text-power">
          /qualify
        </Link>
        .
      </p>
    </main>
  );
}

function Fig({ k, v, n }: { k: string; v: string; n: string }) {
  return (
    <div className="rounded border border-line bg-panel-2 px-4 py-3">
      <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">{k}</p>
      <p className="mt-1 font-mono text-3xl font-semibold text-power">{v}</p>
      <p className="mt-1 text-xs text-faint">{n}</p>
    </div>
  );
}
