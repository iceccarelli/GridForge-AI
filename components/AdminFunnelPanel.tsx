"use client";

import React, { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";

// A compact, honest read of the adoption funnel and the unit economics (GET /api/admin/funnel, /api/admin/economics). It shows the
// denominator beside every rate, says whether each step is measured or derived, prints "n/a" (never 0%) where there is nothing to
// divide by, and lists what cannot be measured. It claims no margin.

interface Step { key: string; label: string; count: number; denominator: number | null; rate: number | null; source: "events" | "derived"; basis: string }
interface Derived { label: string; formula: string; numerator: number; denominator: number; value: number | null }
interface Checkout {
  available: boolean;
  reason?: string;
  statement: string;
  measured?: { attempted: number; session_created: number; failed: number; failed_by_reason: Record<string, number>; by_kind: Record<string, { attempted: number; session_created: number; failed: number }>; basis: string };
  derived?: {
    refused_before_stripe: number;
    failed_at_stripe: number;
    session_creation_rate: Derived;
    stripe_failure_rate: Derived;
    refusal_rate: Derived;
    unresolved_attempts: { label: string; formula: string; value: number; note: string };
    by_kind: Record<string, { attempted: number; session_created: number; session_creation_rate: Derived }>;
    basis: string;
  };
}
interface Funnel {
  days: number;
  checkout?: Checkout;
  steps: Step[];
  cohort_definition: string;
  unmeasured: string[];
  subscriptions: { started: { total: number; by_kind: Record<string, number> }; cancelled: { total: number; by_kind: Record<string, number> }; cancellations_per_start: number | null };
  engagements: { commissioned: { total: number; by_kind: Record<string, number> } };
  payments: { payment_failed: { total: number }; refunds: number; disputes: number };
  qualifier_to_engagement: { qualifications_scored: number; engagements_linked_to_those: number; rate: number | null; truncated: boolean };
  retention: { cohorts: { cohort_week: string; size: number; weeks: { offset: number; active: number; rate: number | null; partial: boolean }[] }[] };
}
interface Economics {
  month: string;
  revenue: { accrued_payg_cents: number; payg_units: number; free_units: number; unit_price_cents: number; settlements: { invoiced_cents: number; collected_cents: number; failed_cents: number } };
  compute: { available: true; totals: { calls: number; units: number; wall_ms_total: number }; endpoints: { endpoint: string; calls: number; units: number; wall_ms_p50: number | null; wall_ms_p95: number | null }[] } | { available: false; reason: string };
  revenue_per_compute_second_cents: number | null;
  margin: { claimed: boolean; reason: string };
  not_included: string[];
  unknown: string[];
  statement: string;
}

const pct = (r: number | null) => (r === null ? "n/a" : `${(r * 100).toFixed(1)}%`);
const eur = (c: number) => `EUR ${(c / 100).toFixed(2)}`;

/** The checkout section. Measured counts and derived values are two separate blocks, and a created session is never presented as a payment. */
export function CheckoutSection({ checkout, days }: { checkout: Checkout; days: number }) {
  return (
    <div className="mt-5 border-t border-line pt-3 text-sm" aria-label="Checkout funnel">
      <div className="text-mute mb-1">Checkout ({days} d)</div>
      <p className="text-xs mb-2">{checkout.statement}</p>
      {!checkout.available || !checkout.measured || !checkout.derived ? (
        <p className="text-mute">Checkout figures unavailable: {checkout.reason}</p>
      ) : (
        <>
          <div className="font-medium">Measured (recorded events)</div>
          <table className="w-full text-sm mb-2">
            <tbody>
              <tr className="border-t border-line"><td className="py-1 pr-3">Checkout attempted (valid request handed to Stripe)</td><td className="tabular-nums">{checkout.measured.attempted}</td></tr>
              <tr className="border-t border-line"><td className="py-1 pr-3">Session created (Stripe returned a URL; not a payment)</td><td className="tabular-nums">{checkout.measured.session_created}</td></tr>
              <tr className="border-t border-line"><td className="py-1 pr-3">Checkout failed (refused or no session)</td><td className="tabular-nums">{checkout.measured.failed}</td></tr>
              {Object.entries(checkout.measured.failed_by_reason).map(([reason, n]) => (
                <tr key={reason} className="border-t border-line text-mute"><td className="py-1 pl-4 pr-3">failed: {reason}</td><td className="tabular-nums">{n}</td></tr>
              ))}
            </tbody>
          </table>
          <div className="font-medium">Derived (calculated from the counts above; not recorded)</div>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-mute"><th className="py-1 pr-3 font-normal">Value</th><th className="font-normal pr-3">Of</th><th className="font-normal pr-3">Rate</th><th className="font-normal">Formula</th></tr>
            </thead>
            <tbody>
              {[checkout.derived.session_creation_rate, checkout.derived.stripe_failure_rate, checkout.derived.refusal_rate].map((d) => (
                <tr key={d.label} className="border-t border-line align-top">
                  <td className="py-1 pr-3">{d.label} (derived)</td>
                  <td className="pr-3 tabular-nums">{d.numerator} of {d.denominator}</td>
                  <td className="pr-3 tabular-nums">{pct(d.value)}</td>
                  <td className="text-mute">{d.formula}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-xs text-mute mt-1">{checkout.derived.unresolved_attempts.label} (derived): {checkout.derived.unresolved_attempts.value}. {checkout.derived.unresolved_attempts.note}</p>
          {Object.keys(checkout.measured.by_kind).length > 0 && (
            <details className="mt-2">
              <summary className="cursor-pointer text-mute">By product kind</summary>
              <table className="mt-2 text-xs">
                <thead><tr className="text-left text-mute"><th className="pr-3 font-normal">Kind</th><th className="pr-3 font-normal">Attempted</th><th className="pr-3 font-normal">Session created</th><th className="pr-3 font-normal">Failed (refused before Stripe or no session)</th><th className="font-normal">Session creation rate (derived)</th></tr></thead>
                <tbody>
                  {Object.entries(checkout.measured.by_kind).map(([kind, m]) => (
                    <tr key={kind} className="border-t border-line">
                      <td className="pr-3 py-1">{kind}</td>
                      <td className="pr-3 tabular-nums">{m.attempted}</td>
                      <td className="pr-3 tabular-nums">{m.session_created}</td>
                      <td className="pr-3 tabular-nums">{m.failed}</td>
                      <td className="tabular-nums">{pct(checkout.derived?.by_kind[kind]?.session_creation_rate.value ?? null)} ({m.session_created} of {m.attempted})</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          )}
          <p className="text-xs text-mute mt-2">{checkout.derived.basis}</p>
        </>
      )}
    </div>
  );
}

export function AdminFunnelPanel() {
  const [days, setDays] = useState(30);
  const [funnel, setFunnel] = useState<Funnel | null>(null);
  const [econ, setEcon] = useState<Economics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [f, e] = await Promise.all([fetch(`/api/admin/funnel?days=${days}`, { cache: "no-store" }), fetch("/api/admin/economics", { cache: "no-store" })]);
      const fj = await f.json();
      const ej = await e.json();
      if (!f.ok || !fj.ok) setError(fj.error ?? "The funnel could not be read.");
      else setFunnel(fj as Funnel);
      if (e.ok && ej.ok) setEcon(ej as Economics);
    } catch {
      setError("The funnel could not be read.");
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section className="panel p-4 mb-6" aria-label="Adoption funnel and unit economics">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
        <div>
          <div className="eyebrow mb-1">ADOPTION</div>
          <h2 className="text-lg font-semibold">Funnel and unit economics</h2>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <label htmlFor="funnel-days" className="text-mute">Window</label>
          <select id="funnel-days" value={days} onChange={(e) => setDays(Number(e.target.value))} className="bg-panel-2 border border-line rounded px-2 py-1">
            {[7, 30, 90].map((d) => <option key={d} value={d}>{d} days</option>)}
          </select>
          <button onClick={() => void load()} className="btn-secondary px-3 py-1.5 rounded-lg flex items-center gap-2" disabled={loading}>
            <RefreshCw size={13} /> Refresh
          </button>
        </div>
      </div>
      {error && <p className="text-sm text-flag mb-3">{error}</p>}
      {funnel && (
        <>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-mute"><th className="py-1 pr-3 font-normal">Step</th><th className="font-normal pr-3">Count</th><th className="font-normal pr-3">Of</th><th className="font-normal pr-3">Rate</th><th className="font-normal">Source</th></tr>
            </thead>
            <tbody>
              {funnel.steps.map((s) => (
                <tr key={s.key} className="border-t border-line align-top" title={s.basis}>
                  <td className="py-1 pr-3">{s.label}</td>
                  <td className="pr-3 tabular-nums">{s.count}</td>
                  <td className="pr-3 tabular-nums">{s.denominator === null ? "-" : s.denominator}</td>
                  <td className="pr-3 tabular-nums">{pct(s.rate)}</td>
                  <td className="text-mute">{s.source === "events" ? "measured" : "derived"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-xs text-mute mt-2">{funnel.cohort_definition}</p>
          <div className="grid sm:grid-cols-3 gap-3 mt-4 text-sm">
            <div>
              <div className="text-mute">Subscriptions ({funnel.days} d)</div>
              <div>{funnel.subscriptions.started.total} started, {funnel.subscriptions.cancelled.total} cancelled ({pct(funnel.subscriptions.cancellations_per_start)} per start)</div>
            </div>
            <div>
              <div className="text-mute">Engagements commissioned</div>
              <div>{funnel.engagements.commissioned.total}; {funnel.qualifier_to_engagement.engagements_linked_to_those} of {funnel.qualifier_to_engagement.qualifications_scored} scored qualifications linked ({pct(funnel.qualifier_to_engagement.rate)})</div>
            </div>
            <div>
              <div className="text-mute">Payments</div>
              <div>{funnel.payments.payment_failed.total} failed, {funnel.payments.refunds} refunds, {funnel.payments.disputes} disputes</div>
            </div>
          </div>
          {funnel.checkout && <CheckoutSection checkout={funnel.checkout} days={funnel.days} />}
          {funnel.retention.cohorts.length > 0 && (
            <details className="mt-3 text-sm">
              <summary className="cursor-pointer text-mute">Retention by cohort week (net usage, from the ledger)</summary>
              <table className="mt-2 text-xs">
                <tbody>
                  {funnel.retention.cohorts.map((c) => (
                    <tr key={c.cohort_week} className="border-t border-line">
                      <td className="pr-3 py-1">{c.cohort_week} (n={c.size})</td>
                      {c.weeks.map((w) => <td key={w.offset} className="pr-2 tabular-nums" title={`${w.active} of ${c.size}`}>{pct(w.rate)}{w.partial ? "*" : ""}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="text-xs text-mute mt-1">* the current week is partial.</p>
            </details>
          )}
          <details className="mt-3 text-sm">
            <summary className="cursor-pointer text-mute">Not measured ({funnel.unmeasured.length})</summary>
            <ul className="list-disc pl-5 mt-2 text-xs text-mute space-y-1">{funnel.unmeasured.map((u) => <li key={u}>{u}</li>)}</ul>
          </details>
        </>
      )}
      {econ && (
        <div className="mt-5 border-t border-line pt-3 text-sm">
          <div className="text-mute mb-1">Economics, {econ.month}</div>
          <div>
            Accrued pay-as-you-go revenue {eur(econ.revenue.accrued_payg_cents)} ({econ.revenue.payg_units} units at {eur(econ.revenue.unit_price_cents)}); free units {econ.revenue.free_units}.
            Invoiced {eur(econ.revenue.settlements.invoiced_cents)}, collected {eur(econ.revenue.settlements.collected_cents)}, failed {eur(econ.revenue.settlements.failed_cents)}.
          </div>
          {econ.compute.available ? (
            <div className="mt-1">
              Measured compute {(econ.compute.totals.wall_ms_total / 1000).toFixed(1)} s over {econ.compute.totals.calls} calls
              {econ.revenue_per_compute_second_cents === null ? "" : `; revenue per compute second ${econ.revenue_per_compute_second_cents} cents`}.
            </div>
          ) : (
            <div className="mt-1 text-mute">Compute unavailable: {econ.compute.reason}</div>
          )}
          <p className="text-xs text-mute mt-2">{econ.statement} Not included: {econ.not_included.join("; ")}. {econ.margin.reason}</p>
        </div>
      )}
    </section>
  );
}
