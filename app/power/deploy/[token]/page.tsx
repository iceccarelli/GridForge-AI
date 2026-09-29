import type { Metadata } from "next";
import Link from "next/link";
import { latestDeploymentCase } from "@/lib/power-deploy";
import { PowerDeployCaseUpdate } from "@/components/PowerDeployCaseUpdate";

export const metadata: Metadata = {
  title: "Power Deployment Case",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

interface DeploymentResult {
  load_profile: {
    source: string;
    evidence: string;
    peak_MW: number;
    mean_kW: number;
    load_factor: number;
    ramp_rate_kW_per_min: number;
    step_events: number;
    warnings: string[];
    usable: boolean;
  };
  capacity: {
    target_MW: number;
    grid_firm_MW: number;
    gap_MW: number;
    critical_load_MW: number;
    ride_through_hours: number;
    redundancy: string;
  };
  architectures: {
    label: string;
    status: "pass" | "fail" | "requires_engineering_study";
    scenario: string;
    available_MW: number;
    margin_MW: number;
    basis: string;
    blocking: string[];
    capex_eur: number | null;
    lead_time_weeks: number | null;
    buildable: boolean;
    ready_for_procurement: boolean;
    readiness_gates: {
      gate: string;
      status: string;
      reason: string;
      missing: string[];
      review_requirement: string;
      blocking: boolean;
    }[];
  }[];
  next_action: { action: string; why: string };
}

const STATUS_LABEL: Record<string, string> = {
  pass: "PASS",
  fail: "FAIL",
  requires_engineering_study: "NEEDS ENGINEERING STUDY",
};

const GATE_LABEL: Record<string, string> = {
  pass: "PASS",
  fail: "FAIL",
  unknown: "UNKNOWN",
  missing_data: "MISSING DATA",
  requires_engineering_study: "ENGINEERING STUDY REQUIRED",
  requires_licensed_review: "LICENSED REVIEW REQUIRED",
  not_applicable: "N/A",
};

const GATE_NAME: Record<string, string> = {
  interconnection: "Interconnection",
  protection: "Protection",
  fuel: "Fuel",
  permitting: "Permitting",
  electrical: "Electrical",
  reliability: "Reliability",
};

export default async function PowerDeployCasePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const row = await latestDeploymentCase(token);

  if (!row) {
    return (
      <main className="mx-auto w-full max-w-3xl px-5 pb-24 pt-28 sm:px-8">
        <p className="text-mute">
          This link does not correspond to a case. Check the address, or start a{" "}
          <Link href="/power/deploy" className="text-power underline">
            new assessment
          </Link>
          .
        </p>
      </main>
    );
  }

  const result = row.result as unknown as DeploymentResult;
  const { load_profile: lp, capacity: cap, architectures, next_action } = result;

  return (
    <main className="mx-auto w-full max-w-4xl px-5 pb-24 pt-28 sm:px-8">
      <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-power">
        Power deployment case · revision {row.revision}
      </p>
      <h1 className="mt-3 text-3xl font-semibold leading-tight text-ghost sm:text-4xl">
        {cap.grid_firm_MW} MW firm today &middot; {cap.target_MW} MW target &middot; gap{" "}
        {cap.gap_MW} MW
      </h1>

      {row.changed_fields.length > 0 && (
        <div className="mt-6 rounded border border-power/40 bg-power/5 p-4">
          <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-power">
            What changed since revision {row.revision - 1}
          </p>
          <p className="mt-1 text-sm text-mute">{row.changed_fields.join(", ")}</p>
        </div>
      )}

      <section className="mt-8 rounded border border-line bg-panel-2 p-6">
        <h2 className="font-mono text-[11px] uppercase tracking-[0.14em] text-faint">
          Load profile
        </h2>
        <p className="mt-2 text-sm text-mute">
          {lp.source} ({lp.evidence}) &middot; peak {lp.peak_MW} MW &middot; load factor{" "}
          {lp.load_factor} &middot; ramp {lp.ramp_rate_kW_per_min} kW/min &middot; {lp.step_events}{" "}
          step event(s)
        </p>
        {lp.warnings.map((w, i) => (
          <p key={i} className="mt-1 text-[12px] text-faint">
            ! {w}
          </p>
        ))}
      </section>

      <section className="mt-8">
        <h2 className="font-mono text-[11px] uppercase tracking-[0.14em] text-faint">
          Architectures compared &middot; {cap.redundancy} contingency, {cap.ride_through_hours}h
          ride-through
        </h2>
        <div className="mt-3 space-y-3">
          {architectures.map((a) => (
            <div key={a.label} className="rounded border border-line bg-panel-2 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="font-semibold text-ghost">{a.label}</h3>
                <span
                  className={`font-mono text-[11px] uppercase tracking-[0.1em] ${
                    a.status === "pass" ? "text-power" : "text-flag"
                  }`}
                >
                  {STATUS_LABEL[a.status] ?? a.status}
                </span>
              </div>
              <p className="mt-2 text-sm text-mute">{a.basis}</p>
              <div className="mt-2 flex flex-wrap gap-4 text-[12px] text-faint">
                <span>
                  CAPEX:{" "}
                  {a.capex_eur !== null ? `EUR ${a.capex_eur.toLocaleString()}` : "UNKNOWN — not costed"}
                </span>
                <span>
                  Lead time: {a.lead_time_weeks !== null ? `${a.lead_time_weeks} weeks` : "UNKNOWN"}
                </span>
                <span>Margin: {a.margin_MW} MW</span>
              </div>
              {a.blocking.map((b, i) => (
                <p key={i} className="mt-2 text-[12px] text-faint">
                  ⚠ {b}
                </p>
              ))}
              {a.readiness_gates.length > 0 && (
                <div className="mt-3 border-t border-line pt-3">
                  <p className="font-mono text-[10px] uppercase tracking-[0.1em] text-faint">
                    Readiness gates{" "}
                    {a.ready_for_procurement ? (
                      <span className="text-power">— nothing missing</span>
                    ) : (
                      <span className="text-flag">— not yet schedule-credible</span>
                    )}
                  </p>
                  <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
                    {a.readiness_gates.map((g) => (
                      <div key={g.gate} className="text-[12px]">
                        <span className="text-ghost">{GATE_NAME[g.gate] ?? g.gate}: </span>
                        <span className={g.status === "pass" ? "text-power" : "text-faint"}>
                          {GATE_LABEL[g.status] ?? g.status}
                        </span>
                        {g.review_requirement && (
                          <span className="text-faint"> ({g.review_requirement})</span>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      </section>

      <section className="mt-8 rounded border border-power/40 bg-power/5 p-6">
        <h2 className="font-mono text-[11px] uppercase tracking-[0.14em] text-power">
          Next action
        </h2>
        <p className="mt-2 font-semibold text-ghost">{next_action.action}</p>
        <p className="mt-1 text-sm text-mute">{next_action.why}</p>
      </section>

      <section className="mt-8">
        <h2 className="mb-3 font-mono text-[11px] uppercase tracking-[0.14em] text-faint">
          Update this case
        </h2>
        <PowerDeployCaseUpdate token={token} />
      </section>
    </main>
  );
}
