import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AlertTriangle } from "lucide-react";
import { BuyerCommission } from "@/components/BuyerCommission";
import { getBuyerView, type BuyerView } from "@/lib/buyer-view";
import type { BuyerStep } from "@/lib/buyer-path";
import { CALIBRATION_NOTICE } from "@/lib/ai/provenance";
import { eurFromCents } from "@/lib/products";
import { OBJECTIVE_LABEL, type CompareResult, type CompareScenario } from "@/lib/ttp-compare";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Shared project",
  // A project's hall figures, shared by its owner with whoever they chose. Never indexed, never followed.
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};

/**
 * The buyer's page: a project's saved Time-to-Power comparison, read-only, on a link.
 *
 * The person who runs the comparison is an engineer; the person who approves the spend is not, and has no account here
 * and should not need one. This page carries the decision, the inputs it rests on, the evidence class behind each date,
 * how the capital figure was priced, what is still missing, and the next engagement to buy. Every figure is read from the
 * stored engine result; the page computes nothing and softens no caveat. The next step and its price come from the
 * product catalogue (lib/buyer-path.ts), not from this file.
 */
export default async function SharedProjectPage({ params }: { params: Promise<{ shareToken: string }> }) {
  const { shareToken } = await params;
  const got = await getBuyerView(shareToken);
  if (!got.ok) {
    if (got.status === 404) notFound();
    return (
      <main className="mx-auto w-full max-w-3xl px-5 pb-24 pt-28 sm:px-8">
        <h1 className="text-2xl font-semibold text-ghost">This project cannot be shown right now</h1>
        <p className="mt-3 text-mute">The record could not be read, so nothing is displayed rather than something incomplete. Try again shortly.</p>
      </main>
    );
  }
  const v = got.view;
  const where = [v.project.company, v.project.site_label].filter(Boolean).join(" · ");

  return (
    <main className="mx-auto w-full max-w-5xl px-5 pb-24 pt-28 sm:px-8">
      <header>
        <p className="eyebrow">Shared project · read-only{where ? ` · ${where}` : ""}</p>
        <h1 className="mt-3 text-3xl font-semibold leading-tight text-ghost sm:text-4xl">{v.project.project_name}</h1>
        <p className="mt-3 max-w-3xl text-sm text-mute">
          This is a screening-level engineering comparison shared by the project&apos;s owner. It is not an issued opinion, a design or
          a quotation. Opening it needs no account and changes nothing.
        </p>
      </header>

      {v.comparison ? <Decision v={v} result={v.comparison.result} savedAt={v.comparison.saved_at} /> : <NoComparison />}

      <section className="mt-10" aria-labelledby="next-step">
        <h2 id="next-step" className="text-xl font-semibold text-ghost">
          Next step
        </h2>
        <NextStep v={v} shareToken={shareToken} />
      </section>

      <section className="mt-10 rounded border border-queue/40 bg-queue/10 p-5">
        <h2 className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.12em] text-queue">
          <AlertTriangle className="h-3.5 w-3.5" aria-hidden /> What this page is, and is not
        </h2>
        <p className="mt-3 text-sm text-mute">{CALIBRATION_NOTICE}</p>
      </section>

      <p className="mt-6 text-[11px] text-faint">
        Private to whoever holds the link and not indexed. Compare your own hall at{" "}
        <Link href="/power/compare" className="text-power">
          /power/compare
        </Link>{" "}
        · <Link href="/pricing" className="text-power">Pricing</Link>
      </p>
    </main>
  );
}

function NoComparison() {
  return (
    <section className="mt-8 rounded border border-line bg-panel-2 p-5">
      <h2 className="text-lg font-semibold text-ghost">No comparison has been saved to this project yet</h2>
      <p className="mt-2 text-sm text-mute">There is no decision to show. Nothing has been estimated to fill the gap.</p>
    </section>
  );
}

/** "E0_ASSUMPTION" -> "E0 · assumption": the class code first, as the engine names it. */
function evidenceCode(e: string | null | undefined): string | null {
  if (!e) return null;
  const [code, ...rest] = e.split("_");
  return rest.length ? `${code} · ${rest.join(" ").toLowerCase()}` : code;
}

function Decision({ v, result: r, savedAt }: { v: BuyerView; result: CompareResult; savedAt: string }) {
  const byId = Object.fromEntries(r.scenarios.map((s) => [s.id, s]));
  const leader = r.ranking.leader ? byId[r.ranking.leader] : null;
  const missing = Array.from(new Set(r.scenarios.flatMap((s) => s.missing_inputs)));
  return (
    <>
      <section className="mt-8 panel p-5" aria-labelledby="decision">
        <div className="flex flex-wrap items-center gap-3">
          <h2 id="decision" className="text-xl font-semibold text-ghost">
            Decision
          </h2>
          <span className={`rounded border px-2 py-0.5 font-mono text-[11px] uppercase tracking-[0.1em] ${r.grade === "indicative" ? "border-queue/50 text-queue" : "border-verified/50 text-verified"}`}>
            {r.grade}
          </span>
          <span className="text-xs text-faint">saved {new Date(savedAt).toISOString().slice(0, 10)}</span>
        </div>
        <p className="mt-3 text-ghost">
          {leader ? (
            <>
              On <strong>{OBJECTIVE_LABEL[r.objective].toLowerCase()}</strong> the engine ranks <strong>{leader.name}</strong> first (
              {r.ranking.metric}: <span className="data">{r.ranking.values[leader.id]?.toLocaleString()}</span>).
            </>
          ) : (
            <>The engine ranks no scenario first on {OBJECTIVE_LABEL[r.objective].toLowerCase()}. {r.ranking.note}</>
          )}
        </p>
        {leader && r.ranking.note ? <p className="mt-1 text-xs text-queue">{r.ranking.note}</p> : null}
        {r.ranking.excluded.length ? (
          <ul className="mt-2 list-disc pl-5 text-xs text-mute">
            {r.ranking.excluded.map((e) => (
              <li key={e.id}>
                <span className="text-ghost">{byId[e.id]?.name ?? e.id}</span> not ranked — {e.reason}
              </li>
            ))}
          </ul>
        ) : null}
        <ul className="mt-3 list-disc pl-5 text-xs text-mute">
          {r.caveats.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
        {v.earlier_comparisons > 0 ? (
          <p className="mt-3 text-xs text-faint">
            {v.earlier_comparisons} earlier saved comparison{v.earlier_comparisons === 1 ? "" : "s"} for this project {v.earlier_comparisons === 1 ? "is" : "are"} not shown; this is the latest.
          </p>
        ) : null}
      </section>

      <section className="mt-8" aria-labelledby="scenarios">
        <h2 id="scenarios" className="text-xl font-semibold text-ghost">
          Scenarios, side by side
        </h2>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[760px] border-collapse text-left text-sm">
            <caption className="sr-only">Scenarios compared</caption>
            <thead>
              <tr className="border-b border-line font-mono text-[10px] uppercase tracking-[0.1em] text-faint">
                <th scope="col" className="py-2 pr-4">Scenario</th>
                <th scope="col" className="py-2 pr-4">Racks, as found → after relief</th>
                <th scope="col" className="py-2 pr-4">Limit after relief</th>
                <th scope="col" className="py-2 pr-4">Time to full capacity</th>
                <th scope="col" className="py-2 pr-4">Capex and its basis</th>
              </tr>
            </thead>
            <tbody>
              {r.scenarios.map((s) => (
                <tr key={s.id} className="border-b border-line/60 align-top">
                  <th scope="row" className="py-3 pr-4 font-medium text-ghost">
                    {s.name}
                    {s.id === r.baseline ? <span className="ml-2 text-[10px] uppercase text-faint">baseline</span> : null}
                  </th>
                  <td className="data py-3 pr-4">{s.as_found.racks} → {s.after_ladder.racks}</td>
                  <td className="py-3 pr-4 text-mute">{s.after_ladder.binding_name ?? "—"}</td>
                  <td className="py-3 pr-4"><When s={s} /></td>
                  <td className="py-3 pr-4"><Capex s={s} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="mt-8 grid gap-4 sm:grid-cols-2">
        <div className="panel p-5">
          <h2 className="text-lg font-semibold text-ghost">What it rests on</h2>
          <p className="mt-1 text-xs text-faint">
            Entered by the project&apos;s owner and not verified by GridForge. Intake completeness {Math.round(r.intake_completeness * 100)}%; anything not entered is a library default, named in the comparison.
          </p>
          {v.assumptions.length ? (
            <dl className="mt-3 grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-sm">
              {v.assumptions.map((a) => (
                <div key={a.label} className="contents">
                  <dt className="text-mute">{a.label}</dt>
                  <dd className="data text-right text-ghost">{a.value}</dd>
                </div>
              ))}
            </dl>
          ) : null}
        </div>
        <div className="panel p-5">
          <h2 className="text-lg font-semibold text-ghost">Still needed to firm this up</h2>
          {missing.length ? (
            <ul className="mt-3 list-disc pl-5 text-sm text-mute">
              {missing.map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-sm text-mute">The engine flagged no missing inputs for these scenarios.</p>
          )}
          <h3 className="mt-5 text-sm font-semibold text-ghost">Quotations</h3>
          <p className="mt-1 text-sm text-mute">
            This comparison is computed from the inputs listed here and library cost data; it does not use supplier quotations, and the basis column says so line by line.
            {v.quotations
              ? ` ${v.quotations.total} quotation line${v.quotations.total === 1 ? " has" : "s have"} been recorded against this project's engagements, ${v.quotations.accepted} accepted by a named reviewer; they apply to a priced run, not to this comparison.`
              : " No supplier quotations have been recorded for this project."}
          </p>
          <h3 className="mt-5 text-sm font-semibold text-ghost">Provenance</h3>
          <p className="mt-1 text-xs text-mute">
            Engine {r.provenance.engine_version} · report date {r.provenance.report_date} · question{" "}
            <span className="data">{r.request_digest.slice(0, 16)}</span> · provenance <span className="data">{r.provenance.digest.slice(0, 12)}</span>. The same request to the API or{" "}
            <code className="data">gridforge compare</code> returns the same numbers.
          </p>
        </div>
      </section>
    </>
  );
}

function When({ s }: { s: CompareScenario }) {
  const t = s.time_to_power;
  if (t.status !== "dated" || t.weeks === null) {
    return (
      <span className="text-mute">
        <span className="font-semibold text-ghost">No date.</span> {t.reason}
      </span>
    );
  }
  return (
    <span>
      <span className="data text-ghost">{t.weeks.toLocaleString()} wk</span>{" "}
      <span className="data text-mute">({t.low?.toLocaleString()}–{t.high?.toLocaleString()})</span>{" "}
      <span className="data text-[11px] text-queue">{evidenceCode(t.evidence)}</span>
      {t.sets_the_date ? <span className="block text-[11px] text-faint">set by {t.sets_the_date}</span> : null}
    </span>
  );
}

function Capex({ s }: { s: CompareScenario }) {
  const e = s.economics;
  const mix = Object.values(e.cost_basis_mix ?? {});
  return (
    <span>
      {e.capex_total_eur ? <span className="data">€{Math.round(e.capex_total_eur.value).toLocaleString()}</span> : "—"}{" "}
      {e.capex_total_eur ? <span className="data text-[11px] text-queue">{evidenceCode(e.capex_total_eur.evidence)}</span> : null}
      {!e.capex_complete ? <span className="block text-[11px] text-queue">incomplete — {e.unpriced_components.length} unpriced</span> : null}
      <span className="block text-[11px] text-faint">
        {e.basis}
        {e.decision_grade ? "" : " · not decision-grade"}
      </span>
      {mix.map((m) => (
        <span key={m.label} className="block text-[11px] text-faint">
          {m.lines} line{m.lines === 1 ? "" : "s"}: {m.label}
        </span>
      ))}
    </span>
  );
}

function StepCard({ step }: { step: BuyerStep }) {
  const p = step.product;
  return (
    <div className="panel p-5">
      <h3 className="text-lg font-semibold text-ghost">
        {p.name} <span className="data text-power">{eurFromCents(p.amountCents)}</span>
        {p.recurring ? <span className="text-sm text-mute"> every {p.recurring.intervalCount} {p.recurring.interval}s</span> : null}
      </h3>
      <p className="mt-2 text-sm text-mute">{p.description}</p>
      <p className="mt-2 text-sm text-mute">
        <span className="text-ghost">You receive:</span> {p.deliverable}
      </p>
      <p className="mt-2 text-xs text-faint">
        {p.turnaroundDays > 0 ? `${p.turnaroundDays} working days from a complete intake. ` : ""}
        {p.opensBandCents ? `A deposit toward a scoped engagement of ${eurFromCents(p.opensBandCents[0])}–${eurFromCents(p.opensBandCents[1])}. ` : ""}
        {step.creditsAgainst ? `Credits in full against the ${step.creditsAgainst.name} if you go further.` : ""}
      </p>
    </div>
  );
}

function NextStep({ v, shareToken }: { v: BuyerView; shareToken: string }) {
  if (!v.next) {
    return <p className="mt-3 text-sm text-mute">Every engagement on the ladder has already been commissioned for this project.</p>;
  }
  const options = [v.next, ...v.others].map((s, i) => ({
    id: s.product.id,
    label: `${i === 0 ? "Commission" : "Or"} ${s.product.name} — ${eurFromCents(s.product.amountCents)}`,
    primary: i === 0,
  }));
  return (
    <div className="mt-3 flex flex-col gap-4">
      {v.engagements.length ? (
        <p className="text-sm text-mute">
          Already commissioned for this project: {v.engagements.map((e) => e.name).join(", ")}.
        </p>
      ) : null}
      <StepCard step={v.next} />
      {v.others.length ? (
        <details className="text-sm text-mute">
          <summary className="cursor-pointer text-ghost">Other engagements for this project</summary>
          <div className="mt-3 flex flex-col gap-3">
            {v.others.map((s) => (
              <StepCard key={s.product.id} step={s} />
            ))}
          </div>
        </details>
      ) : null}
      <BuyerCommission shareToken={shareToken} options={options} />
    </div>
  );
}
