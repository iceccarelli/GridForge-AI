"use client";

// What a project's accepted supplier quotations did to THIS comparison, in the engine's own words.
//
// The visitor ran a comparison priced on library placeholders. Here they give the token of their project and the engine is asked the same
// question again with the quotations a named reviewer accepted for that project (POST /api/projects/{token}/cost-evidence/compare). Every figure
// is the engine's: the capex before and after, whether the capex is now complete, which ladder steps moved from a library placeholder to a
// supplier quote, and every quotation it IGNORED with its reason. Quotations nobody has accepted are listed as "not yet counted" and were never sent.
//
// Nothing here prices anything, and nothing here sells anything: these are the customer's own suppliers' quotations.

import { useEffect, useId, useState } from "react";
import { CircleAlert, Loader2 } from "lucide-react";
import type { CompareResult } from "@/lib/ttp-compare";
import { effectView, type EffectView } from "@/lib/quotation-effect";
import { LEAD_TIME_NOTE, NO_EQUIPMENT_STATEMENT } from "@/lib/cost-evidence-claims";
import { DateFigure } from "@/components/DateFigure";
import { ClaimsList, leadTimeText } from "@/components/QuotationClaims";
import type { ClaimView } from "@/lib/project-quotation-claims";

export type Answer = {
  offered: number;
  applied: string[];
  result: CompareResult | null;
  claims: ClaimView[];
  excluded: { id: string; reason: string }[];
};

const eur = (n: number | null) => (n === null ? "—" : `€${Math.round(n).toLocaleString("en-IE")}`);
const yn = (b: boolean | null) => (b === null ? "not reported" : b ? "yes" : "no");

export function QuotationEffectPanel({ compare, base, initialToken = null }: { compare: Record<string, unknown>; base: CompareResult; initialToken?: string | null }) {
  const uid = useId();
  const [token, setToken] = useState(initialToken ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [answer, setAnswer] = useState<Answer | null>(null);

  useEffect(() => {
    if (initialToken) return;
    try {
      const t = new URLSearchParams(window.location.search).get("project");
      if (t) setToken(t);
    } catch {
      /* no query string to read */
    }
  }, [initialToken]);

  async function run(e: React.FormEvent) {
    e.preventDefault();
    if (!token.trim()) {
      setError("Enter the token of the project that holds your quotations.");
      return;
    }
    setBusy(true);
    setError(null);
    setAnswer(null);
    try {
      const r = await fetch(`/api/projects/${encodeURIComponent(token.trim())}/cost-evidence/compare`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ compare }),
      });
      const b = await r.json().catch(() => ({}));
      if (!r.ok || !b.ok) {
        setError(r.status === 404 ? "No project has that token." : b?.error ?? "The quotations could not be applied.");
        return;
      }
      setAnswer(b as Answer);
    } catch {
      setError("Could not reach the server. Nothing was calculated.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby={`${uid}-h`} className="panel flex flex-col gap-4 p-5" data-testid="quotation-effect">
      <div>
        <p id={`${uid}-h`} className="eyebrow">Your own supplier quotations</p>
        <p className="mt-2 max-w-3xl text-sm text-mute" data-testid="no-equipment-statement">{NO_EQUIPMENT_STATEMENT}</p>
        <p className="mt-2 max-w-3xl text-sm text-mute">
          The figures above price the capital items on library placeholders, which are not prices. If your project holds supplier quotations that a
          reviewer has accepted, the engine can be asked the same question again with them. Only accepted quotations are sent; the rest are shown as
          not yet counted.
        </p>
      </div>
      <form onSubmit={run} className="flex flex-col gap-2" aria-busy={busy}>
        <label htmlFor={`${uid}-token`} className="font-mono text-[10px] uppercase tracking-[0.1em] text-faint">Project token</label>
        <div className="flex flex-wrap gap-2">
          <input
            id={`${uid}-token`}
            value={token}
            onChange={(e) => setToken(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            className="field min-h-11 min-w-0 flex-1 basis-60"
            aria-describedby={`${uid}-help`}
          />
          <button type="submit" disabled={busy} className="btn-secondary inline-flex min-h-11 items-center gap-2 px-4 py-2 text-sm disabled:opacity-60">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
            {busy ? "Asking the engine" : "Apply my accepted quotations"}
          </button>
        </div>
        <p id={`${uid}-help`} className="text-xs text-faint">The token opens only your own project. Nothing is saved by this.</p>
      </form>

      <div role="status" aria-live="polite">
        {error ? (
          <div role="alert" className="flex gap-3 rounded border border-flag/40 bg-flag/10 p-3 text-sm text-ghost">
            <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-flag" aria-hidden />
            <p>{error}</p>
          </div>
        ) : null}
      </div>

      {answer ? <EffectBody answer={answer} base={base} /> : null}
    </section>
  );
}

/** The engine's answer, laid out. Exported so the same words can be rendered and checked without a browser. */
export function EffectBody({ answer, base }: { answer: Answer; base: CompareResult }) {
  const view: EffectView | null = answer.result ? effectView(base, answer.result) : null;
  const counted = answer.claims.filter((c) => c.counted);
  const pending = answer.claims.filter((c) => !c.counted);
  const withLead = counted.filter((c) => c.lead_time_weeks !== null);
  return (
    <>
    {answer.offered === 0 ? (
      <div className="text-sm text-mute" data-testid="effect-none">
        <p className="text-ghost">No accepted quotation is counted for this project, so the engine was not asked again and nothing above changes.</p>
        {answer.excluded.length ? (
          <ul className="mt-2 list-disc pl-5">{answer.excluded.map((x) => (<li key={x.id}>{x.reason}</li>))}</ul>
        ) : null}
      </div>
    ) : null}

    {answer.offered > 0 && !view ? (
      <p role="alert" className="text-sm text-flag">The engine did not report how it used the quotations, so nothing is shown rather than something guessed.</p>
    ) : null}

    {view ? (
      <div className="flex flex-col gap-4" data-testid="effect-result">
        <p className="text-sm text-ghost">
          {answer.offered} accepted quotation{answer.offered === 1 ? "" : "s"} offered to the engine; it applied {answer.applied.length}
          {view.ignored.length ? ` and ignored ${view.ignored.length}` : ""}.
        </p>
        {view.scenarios.map((s) => (
          <div key={s.id} className="rounded border border-line p-4" data-scenario={s.id}>
            <p className="text-sm font-medium text-ghost">{s.name}</p>
            <p className="mt-2 text-sm text-mute" data-testid="capex-move">
              Capex <span className="data text-ghost">{eur(s.capex_before_eur)}</span> → <span className="data text-ghost">{eur(s.capex_after_eur)}</span>
              {s.capex_delta_eur !== 0 ? <> ({s.capex_delta_eur > 0 ? "+" : "−"}{eur(Math.abs(s.capex_delta_eur))})</> : " (no change)"}
              {!s.complete_after ? <span className="ml-1 text-queue" data-testid="modelled-incomplete"> · modelled, incomplete: a lower bound, not a price</span> : null}
            </p>
            <p className="mt-1 text-sm text-mute" data-testid="complete-after">
              Capex complete: before {yn(s.complete_before)}, after <strong className={s.complete_after ? "text-verified" : "text-queue"}>{yn(s.complete_after)}</strong>
              {s.decision_grade_after !== null ? <> · decision grade after: {yn(s.decision_grade_after)}</> : null}
              {s.placeholder_lines_before !== null && s.placeholder_lines_after !== null ? <> · library-placeholder lines {s.placeholder_lines_before} → {s.placeholder_lines_after}</> : null}
            </p>
            {s.steps.length ? (
              <div className="mt-3 overflow-x-auto" role="region" aria-label={`Ladder steps repriced in ${s.name}, scrollable`} tabIndex={0}>
                <table className="w-full min-w-[480px] border-collapse text-left text-xs">
                  <caption className="sr-only">Ladder steps the quotations repriced</caption>
                  <thead>
                    <tr className="border-b border-line font-mono text-[10px] uppercase tracking-[0.1em] text-faint">
                      <th scope="col" className="py-1.5 pr-3">Step</th>
                      <th scope="col" className="py-1.5 pr-3">Was</th>
                      <th scope="col" className="py-1.5 pr-3">Now</th>
                      <th scope="col" className="py-1.5 pr-3">Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {s.steps.map((st) => (
                      <tr key={st.step} className="border-b border-line/60 align-top" data-step={st.step}>
                        <th scope="row" className="py-1.5 pr-3 font-medium text-ghost">{st.step}. {st.name}</th>
                        <td className="py-1.5 pr-3 text-mute">{st.from}</td>
                        <td className="py-1.5 pr-3 text-ghost">{st.to}</td>
                        <td className="py-1.5 pr-3 text-mute">
                          {st.capex_before_eur !== null && st.capex_after_eur !== null ? <span className="data">{eur(st.capex_before_eur)} → {eur(st.capex_after_eur)}</span> : "—"}
                          {st.price_kind ? <span className="block text-[11px] text-faint">{st.price_kind.replace(/_/g, " ")}</span> : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="mt-2 text-xs text-faint">No ladder step of this scenario is priced by an accepted quotation.</p>
            )}
            <div className="mt-3 text-sm text-mute" data-testid="date-effect">
              <p className="eyebrow">Time to full capacity</p>
              <p className="mt-1">{s.priced ? <DateFigure t={s.priced.time_to_power} evidenceText={s.priced.time_to_power.date_evidence_class ?? s.priced.time_to_power.evidence} /> : null}</p>
              <p className="mt-1 text-xs text-faint">
                {s.date_unchanged
                  ? s.weeks_with === null
                    ? "The engine gave no date with the quotations, as it gave none without them: a quotation prices the works and does not supply a lead time to the engine."
                    : "The same date as without the quotations: the engine's cost overlay prices the works and does not take a lead time from a quotation."
                  : `Without the quotations the engine gave ${s.weeks_without === null ? "no date" : `${s.weeks_without} weeks`}; with them ${s.weeks_with === null ? "no date" : `${s.weeks_with} weeks`}.`}
              </p>
            </div>
          </div>
        ))}

        {view.ignored.length ? (
          <div data-testid="effect-ignored">
            <p className="eyebrow">Ignored by the engine</p>
            <ul className="mt-1 list-disc pl-5 text-sm text-mute">
              {view.ignored.map((i, n) => (
                <li key={`${i.evidence_id}-${n}`}><span className="data">{i.key}</span>: {i.reason}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {withLead.length ? (
          <div data-testid="effect-lead-times">
            <p className="eyebrow">Lead times quoted</p>
            <ul className="mt-1 list-disc pl-5 text-sm text-mute">
              {withLead.map((c) => (
                <li key={c.id}>{c.item}: {leadTimeText(c)}.</li>
              ))}
            </ul>
            <p className="mt-1 text-xs text-faint">{LEAD_TIME_NOTE}</p>
          </div>
        ) : null}
      </div>
    ) : null}

    {pending.length ? (
      <div data-testid="effect-not-counted">
        <p className="eyebrow">Not yet counted</p>
        <div className="mt-2 text-xs"><ClaimsList claims={pending} /></div>
      </div>
    ) : null}
    </>
  );
}
