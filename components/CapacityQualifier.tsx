"use client";

import React, { useEffect, useRef, useState } from "react";
import { ArrowRight, CircleAlert, Loader2 } from "lucide-react";
import type { QualifyResult } from "@/lib/qualify";
import { PRODUCTS } from "@/lib/products";
import { eur } from "@/lib/commerce";
import { PAYG } from "@/lib/products";
import { formatSetsTheDate } from "@/lib/date-basis";
import FreeAllowanceForm from "@/components/FreeAllowanceForm";

/**
 * Capacity qualifier.
 *
 * Seven numbers a facilities engineer already knows, answered by the same engine
 * that produces the paid study. It returns the binding constraint — the thing that
 * actually stops the hall — and the list of inputs nobody has measured.
 *
 * It shows the constraint and the rack count. The free Time-to-Power comparison
 * (/power/compare) also shows scenarios with indicative capital cost and a time to
 * full capacity, each with its evidence class. What is paid is human-reviewed
 * engagement work and metered engine usage beyond the free allowance.
 *
 * Every figure it displays comes back from the engine with an evidence class
 * attached. Nothing here is computed in the browser.
 */

interface FieldDef {
  key: keyof typeof DEFAULTS;
  label: string;
  unit: string;
  hint: string;
  step?: string;
  /** Bounds the engine enforces (lib/qualify.ts). Checked here only so the error is next to the field; the server stays the authority. */
  min: number;
  max: number;
  /** The engine rejects zero as well as negatives. */
  positive?: boolean;
  integer?: boolean;
}

const DEFAULTS = {
  contractedMW: 12,
  currentPeakMW: 7.4,
  currentItLoadMW: 4.9,
  buswayAmpacityA: 400,
  tapoffMaxA: 63,
  plantSupplyC: 6,
  positionsAvailable: 180,
};

const FIELDS: FieldDef[] = [
  { key: "contractedMW", label: "Contracted capacity", unit: "MW", step: "0.1", min: 0, max: 2000, positive: true,
    hint: "From the supply contract, not the connection nameplate." },
  { key: "currentPeakMW", label: "Current site peak", unit: "MW", step: "0.1", min: 0, max: 2000,
    hint: "Half-hourly metered peak over 12 months." },
  { key: "currentItLoadMW", label: "Current IT load", unit: "MW", step: "0.1", min: 0, max: 2000,
    hint: "Protected load at the UPS output." },
  { key: "buswayAmpacityA", label: "Busway ampacity", unit: "A", min: 0, max: 6300, positive: true,
    hint: "400 A legacy or 800–1000 A modern. The most common hard stop." },
  { key: "tapoffMaxA", label: "Tap-off rating", unit: "A", min: 0, max: 1600, positive: true,
    hint: "A rack that cannot be fed cannot be placed." },
  { key: "plantSupplyC", label: "Plant supply temperature", unit: "°C", step: "0.5", min: -5, max: 45,
    hint: "Chilled water flow setpoint. Legacy plant runs 6–7 °C." },
  { key: "positionsAvailable", label: "Rack positions available", unit: "", min: 0, max: 20000, positive: true, integer: true,
    hint: "Positions you could actually release from tenancy." },
];

const PLATFORMS = [
  { id: "gb300_nvl72", label: "NVIDIA GB300 NVL72" },
  { id: "gb200_nvl72", label: "NVIDIA GB200 NVL72" },
  { id: "generic_dlc_50", label: "Generic DLC rack, 50 kW" },
];

type Values = typeof DEFAULTS;
type Raw = Record<keyof Values, string>;
type FieldErrors = Partial<Record<keyof Values, string>>;

/** The first problem with one field's text, or null. Mirrors the engine's bounds so the message sits beside the field. */
function fieldProblem(f: FieldDef, raw: string): string | null {
  if (raw.trim() === "") return "Enter a value.";
  const n = Number(raw);
  if (!Number.isFinite(n)) return "Enter a number.";
  if (f.integer && !Number.isInteger(n)) return "Enter a whole number.";
  if (f.positive ? n <= 0 : n < f.min) return f.positive ? "Enter a number greater than zero." : `Enter ${f.min} or more.`;
  if (n > f.max) return `Enter ${f.max.toLocaleString("en-GB")} or less.`;
  return null;
}

export function CapacityQualifier() {
  const [raw, setRaw] = useState<Raw>(() => Object.fromEntries(Object.entries(DEFAULTS).map(([k, v]) => [k, String(v)])) as Raw);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const alertRef = useRef<HTMLDivElement>(null);
  const [platform, setPlatform] = useState<string>("gb300_nvl72");
  const [siteName, setSiteName] = useState("");
  const [metro, setMetro] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<QualifyResult | null>(null);
  const [headline, setHeadline] = useState<string>("");
  const [share, setShare] = useState<string | null>(null);
  /**
   * The read this session produced, so a purchase made here carries it.
   *
   * Without it the commonest path of all — qualify, then commission in the same
   * tab — opened an empty intake form and asked the customer to retype the seven
   * numbers they had just entered, after paying. The shareable read carried its
   * qualification; the tab it was produced in did not.
   */
  const [qualificationId, setQualificationId] = useState<string | null>(null);
  const [qualificationToken, setQualificationToken] = useState<string | null>(null);

  const set = (key: keyof Values, text: string) => {
    setRaw((v) => ({ ...v, [key]: text }));
    // Correcting a field clears its own message at once; the rest stay until the next submit.
    setFieldErrors((e) => (e[key] ? { ...e, [key]: undefined } : e));
  };

  // A message that appears after submit must be announced (role="alert") and reachable: when the failure is not tied to one field,
  // focus moves to the message itself, so a keyboard or screen-reader user is not left on a button that now means something else.
  const [alertTick, setAlertTick] = useState(0);
  useEffect(() => {
    if (alertTick > 0) alertRef.current?.focus();
  }, [alertTick]);

  function focusField(key: string) {
    document.getElementById(`qualify-${key}`)?.focus();
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const problems: FieldErrors = {};
    for (const f of FIELDS) {
      const p = fieldProblem(f, raw[f.key]);
      if (p) problems[f.key] = p;
    }
    const bad = FIELDS.filter((f) => problems[f.key]);
    if (bad.length > 0) {
      setFieldErrors(problems);
      setResult(null);
      setShare(null);
      setError(`${bad.length === 1 ? "One value needs" : `${bad.length} values need`} attention: ${bad.map((f) => f.label).join(", ")}.`);
      focusField(bad[0].key);
      return;
    }
    setFieldErrors({});
    const values = Object.fromEntries(FIELDS.map((f) => [f.key, Number(raw[f.key])])) as Values;
    setBusy(true);
    setError(null);
    setResult(null);
    setShare(null);
    try {
      const res = await fetch("/api/qualify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...values, platform, siteName, metro }),
      });
      const body = await res.json();
      if (!res.ok || !body.ok) {
        // The server names the fields it rejected: put each message beside its field and move focus to the first.
        const named = (body?.issues?.fieldErrors ?? {}) as Record<string, unknown>;
        const serverProblems: FieldErrors = {};
        for (const f of FIELDS) if (Array.isArray(named[f.key])) serverProblems[f.key] = "The engine rejected this value. Check it and try again.";
        const first = FIELDS.find((f) => serverProblems[f.key]);
        setError(body?.error ?? "The engine did not return a result.");
        if (first) {
          setFieldErrors(serverProblems);
          focusField(first.key);
        } else {
          setAlertTick((t) => t + 1);
        }
        return;
      }
      setResult(body.result as QualifyResult);
      setHeadline(String(body.headline ?? ""));
      setShare(typeof body.share === "string" ? body.share : null);
      setQualificationId(typeof body.qualificationId === "string" ? body.qualificationId : null);
      setQualificationToken(typeof body.qualificationToken === "string" ? body.qualificationToken : null);
    } catch {
      setError("Could not reach the server. Your figures were not saved — please check your connection and try again.");
      setAlertTick((t) => t + 1);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel p-6 sm:p-8">
      <div className="mb-6">
        <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-power mb-2">
          Capacity qualifier
        </p>
        <h2 className="text-xl sm:text-2xl font-semibold text-ghost">
          What actually stops your hall?
        </h2>
        <p className="text-mute mt-2 max-w-2xl text-sm">
          Seven numbers you already know. The same engine that produces our paid study returns the
          binding constraint, the deployable rack count, and the inputs nobody has measured yet.
          For scenarios with indicative capital cost and time to full capacity, the free Time-to-Power comparison goes
          further; a human-reviewed engagement is the paid step.
        </p>
      </div>

      <form onSubmit={submit} noValidate className="grid gap-5">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {FIELDS.map((f) => {
            const err = fieldErrors[f.key];
            return (
              <div key={f.key} className="block">
                <label htmlFor={`qualify-${f.key}`} className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">
                  {f.label}
                  {f.unit ? ` · ${f.unit}` : ""}
                </label>
                <input
                  id={`qualify-${f.key}`}
                  type="number"
                  inputMode="decimal"
                  step={f.step ?? "1"}
                  min={f.min}
                  max={f.max}
                  value={raw[f.key]}
                  onChange={(e) => set(f.key, e.target.value)}
                  aria-required="true"
                  aria-invalid={err ? true : undefined}
                  aria-describedby={err ? `qualify-${f.key}-error qualify-${f.key}-hint` : `qualify-${f.key}-hint`}
                  className={`mt-1 w-full bg-panel-2 border rounded px-3 py-2 font-mono text-ghost
                           focus:outline-none focus:ring-2 focus:ring-power/60 focus:border-power/60 ${err ? "border-flag" : "border-line"}`}
                />
                {err ? (
                  <span id={`qualify-${f.key}-error`} className="block mt-1 text-xs font-medium text-flag">
                    {err}
                  </span>
                ) : null}
                <span id={`qualify-${f.key}-hint`} className="block mt-1 text-[11px] leading-snug text-faint">
                  {f.hint}
                </span>
              </div>
            );
          })}

          <div className="block">
            <label htmlFor="qualify-platform" className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">
              Target platform
            </label>
            <select
              id="qualify-platform"
              aria-describedby="qualify-platform-hint"
              value={platform}
              onChange={(e) => setPlatform(e.target.value)}
              className="mt-1 w-full bg-panel-2 border border-line rounded px-3 py-2 font-mono text-ghost
                         focus:outline-none focus:ring-2 focus:ring-power/60"
            >
              {PLATFORMS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
            <span id="qualify-platform-hint" className="block mt-1 text-[11px] leading-snug text-faint">
              Platforms whose rack power the manufacturer has not published are absent by design.
            </span>
          </div>

          <div className="block">
            <label htmlFor="qualify-site" className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">
              Site / hall (optional)
            </label>
            <input
              id="qualify-site"
              type="text"
              value={siteName}
              onChange={(e) => setSiteName(e.target.value)}
              className="mt-1 w-full bg-panel-2 border border-line rounded px-3 py-2 text-ghost
                         focus:outline-none focus:ring-2 focus:ring-power/60"
            />
          </div>

          <div className="block">
            <label htmlFor="qualify-metro" className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">
              Metro (optional)
            </label>
            <input
              id="qualify-metro"
              type="text"
              value={metro}
              onChange={(e) => setMetro(e.target.value)}
              className="mt-1 w-full bg-panel-2 border border-line rounded px-3 py-2 text-ghost
                         focus:outline-none focus:ring-2 focus:ring-power/60"
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="submit"
            disabled={busy}
            className="inline-flex items-center gap-2 rounded bg-power px-5 py-2.5 font-semibold text-ink
                       disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
            {busy ? "Solving" : "Find the binding constraint"}
          </button>
          <span className="text-[11px] text-faint font-mono">
            13 constraints · electrical, thermal and physical · solved server-side
          </span>
        </div>
      </form>

      {error ? (
        <div
          ref={alertRef}
          role="alert"
          tabIndex={-1}
          className="mt-6 flex gap-3 rounded border border-flag/40 bg-flag/10 p-4 text-sm text-ghost outline-none focus-visible:ring-2 focus-visible:ring-power/60"
        >
          <CircleAlert className="h-4 w-4 shrink-0 text-flag mt-0.5" aria-hidden="true" />
          <p>{error}</p>
        </div>
      ) : null}

      {result ? (
        <QualifyReadout
          result={result}
          headline={headline}
          share={share}
          qualificationId={qualificationId}
          qualificationToken={qualificationToken}
        />
      ) : null}
    </div>
  );
}

function QualifyReadout({
  result,
  headline,
  share,
  qualificationId,
  qualificationToken,
}: {
  result: QualifyResult;
  headline: string;
  share: string | null;
  qualificationId: string | null;
  qualificationToken: string | null;
}) {
  const { as_found: found, after_relief: after, intake } = result;
  return (
    <div className="mt-8 animate-slide-up">
      <p className="text-lg text-ghost leading-snug max-w-3xl">{headline}</p>
      {share ? <ShareLink href={share} /> : null}

      <div className="mt-5 grid gap-3 sm:grid-cols-3">
        <Readout label="Deployable today" value={String(found.racks)} suffix="racks" tone="ghost" />
        <Readout label="After the ladder" value={String(after.racks)} suffix="racks" tone="power" />
        <SetsTheDate after={after} />
      </div>

      <div className="mt-5 rounded border border-line bg-panel-2 p-4">
        <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-queue">
          Binding constraint · {found.domain}
        </p>
        <p className="text-ghost font-semibold mt-1">{found.binding_constraint}</p>
        <p className="text-mute text-sm mt-1">{found.basis}</p>
      </div>

      {result.first_three_constraints.length ? (
        <div className="mt-5">
          <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint mb-2">
            What has to move, in order
          </p>
          <ol className="grid gap-2">
            {result.first_three_constraints.map((c, i) => (
              <li
                key={`${c.name}-${i}`}
                className="flex gap-3 rounded border border-line bg-panel-2 px-3 py-2 text-sm"
              >
                <span className="font-mono text-faint">{i + 1}</span>
                <span className="text-ghost">{c.name}</span>
                <span className="text-faint ml-auto text-right">{c.relief ?? "—"}</span>
              </li>
            ))}
          </ol>
        </div>
      ) : null}

      {intake.gaps.length ? (
        <div className="mt-6">
          <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint mb-2">
            Assumed, because nobody supplied it · intake {Math.round(intake.completeness * 100)}%
            complete
          </p>
          <div className="overflow-x-auto rounded border border-line">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-panel">
                  {["Input", "Assumed", "Why it binds"].map((h) => (
                    <th
                      key={h}
                      className="text-left font-mono text-[10px] uppercase tracking-[0.12em] text-faint px-3 py-2"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {intake.gaps.slice(0, 8).map((g) => (
                  <tr key={g.input} className="border-t border-line align-top">
                    <td className="px-3 py-2 text-ghost">
                      {g.input}
                      {g.required ? <span className="text-flag"> *</span> : null}
                    </td>
                    <td className="px-3 py-2 font-mono text-mute">{g.assumed}</td>
                    <td className="px-3 py-2 text-faint">{g.why_it_binds}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-[11px] text-faint mt-2">
            {intake.required_inputs_missing} required input
            {intake.required_inputs_missing === 1 ? "" : "s"} assumed. Each one moves the answer.
          </p>
        </div>
      ) : null}

      <CommissionPanel
        recommendation={intake.recommended_engagement}
        summary={`${headline} Binding constraint: ${found.binding_constraint}. ${intake.required_inputs_missing} required inputs still assumed.`}
        capacityMW={Math.round((found.it_load_kW?.value ?? 0) / 1000)}
        qualificationId={qualificationId}
        qualificationToken={qualificationToken}
      />

      <NextSteps share={share} />

      <p className="text-[11px] text-faint mt-5 leading-relaxed max-w-3xl">{result.notice}</p>
    </div>
  );
}

/**
 * Save and continue. Four next steps, each a real route that exists today, in the order most people want them:
 * keep this read, get the free allowance to call the engine yourself, see what running more would cost, or
 * commission the engagement. Nothing here sends the figures typed above anywhere new: the first step is the
 * permanent page this qualification already produced, and the rest are ordinary pages.
 */
function NextSteps({ share }: { share: string | null }) {
  return (
    <section aria-labelledby="next-steps" className="mt-6 rounded border border-line bg-panel-2 p-4 sm:p-5">
      <h3 id="next-steps" className="font-mono text-[10px] uppercase tracking-[0.14em] text-power">
        Save and continue
      </h3>
      <ol className="mt-3 grid gap-4 md:grid-cols-2">
        <li className="min-w-0">
          <p className="text-sm font-semibold text-ghost">1. Keep this read</p>
          <p className="mt-1 text-xs text-mute">
            {share
              ? "It has a permanent page, private to whoever holds the link. Open it, or copy the link above to send on."
              : "It was not saved to a page on this deployment, so copy the figures above before you leave."}
          </p>
          {share ? (
            <a href={share} target="_blank" rel="noreferrer" className="mt-2 inline-flex min-h-11 items-center text-sm text-power underline">
              Open the saved page
            </a>
          ) : null}
        </li>
        <li className="min-w-0">
          <p className="text-sm font-semibold text-ghost">2. Compare the relief options, then save a project</p>
          <p className="mt-1 text-xs text-mute">
            The free Time-to-Power comparison puts dates and evidence classes on each option and can be saved to a project
            for whoever approves the spend.
          </p>
          <a href="/power/compare" className="mt-2 inline-flex min-h-11 items-center text-sm text-power underline">
            Run the comparison
          </a>
        </li>
        <li className="min-w-0 md:col-span-2">
          <p className="text-sm font-semibold text-ghost">3. Run more halls yourself, free to start</p>
          <p className="mt-1 text-xs text-mute">
            An email address gets {PAYG.freeAllowanceUnits} units a month, no card, to call the engine from your own
            tooling. <a href="/developers#rates" className="text-power underline">See what the next operation would cost</a>{" "}
            before you run it.
          </p>
          <div className="mt-3 max-w-xl">
            <FreeAllowanceForm compact heading="Get the free allowance" />
          </div>
        </li>
        <li className="min-w-0 md:col-span-2">
          <p className="text-sm font-semibold text-ghost">4. Commission the engagement</p>
          <p className="mt-1 text-xs text-mute">
            The panel above carries this read into the engagement, so the intake starts from the numbers you already
            entered.{" "}
            <a href="/pricing#engagements" className="text-power underline">
              Compare the engagements
            </a>
            .
          </p>
        </li>
      </ol>
    </section>
  );
}

function CommissionPanel({
  recommendation,
  summary,
  capacityMW,
  qualificationId,
  qualificationToken,
}: {
  recommendation: string;
  summary: string;
  capacityMW: number;
  /** The read being commissioned, so the engagement opens joined to it. */
  qualificationId: string | null;
  /** Its q-token: /api/checkout drops the id without it. */
  qualificationToken: string | null;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const screen = PRODUCTS.density_screen;

  async function commission() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // The read this was bought from travels with the purchase: the webhook
        // writes it to the engagement, and the intake form seeds itself from the
        // numbers already typed above rather than asking for them twice.
        body: JSON.stringify({
          product: screen.id,
          capacityMW,
          qualificationId: qualificationId ?? undefined,
          qualificationToken: qualificationToken ?? undefined,
        }),
      });
      const body = await res.json();
      if (!res.ok || !body.ok || !body.url) {
        setError(
          body?.error === "Payments not configured"
            ? "Checkout is not live on this deployment yet — use the conversation route below."
            : (body?.error ?? "Could not start checkout.")
        );
        return;
      }
      window.location.href = body.url as string;
    } catch {
      setError("Could not reach checkout. Try the conversation route below.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-6 rounded border border-line bg-panel-2 p-4">
      <p className="text-sm text-ghost">{recommendation}</p>
      <p className="mt-2 text-xs text-faint">
        {screen.deliverable} {screen.turnaroundDays} working days from a complete intake, and the
        fee credits in full against the full study.
      </p>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={commission}
          disabled={busy}
          className="inline-flex items-center gap-2 rounded bg-power px-5 py-2.5 text-sm font-semibold text-ink disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          Commission the {screen.name} · {eur(screen.amountCents)}
        </button>
        <a
          href="/reference"
          className="inline-flex items-center gap-1.5 text-sm text-mute hover:text-power"
        >
          See what {eur(screen.amountCents)} buys, worked in full
          <ArrowRight className="h-3.5 w-3.5" />
        </a>
      </div>
      {error ? <p role="alert" className="mt-3 text-sm text-flag">{error}</p> : null}
    </div>
  );
}

/**
 * "Sets the date" never reads as a date on its own: the item that sets it is shown with what the figure rests on, an
 * assumed lead time is named as one, and a hall with no date says so. The weeks themselves are withheld from the
 * free read by the engine; this is only the label that must travel with the item.
 */
function SetsTheDate({ after }: { after: QualifyResult["after_relief"] }) {
  const f = formatSetsTheDate(after.sets_the_date, after);
  return (
    <div className="rounded border border-line bg-panel-2 px-4 py-3">
      <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">
        {f.info.basis === "none" ? "Date" : "Sets the lead time"}
      </p>
      <p className="font-mono text-base font-semibold text-queue mt-1">{f.value}</p>
      <p className="mt-1 text-[11px] leading-snug text-queue">{f.label}</p>
    </div>
  );
}

function Readout({
  label,
  value,
  suffix,
  tone,
  small,
}: {
  label: string;
  value: string;
  suffix?: string;
  tone: "ghost" | "power" | "queue";
  small?: boolean;
}) {
  const color = tone === "power" ? "text-power" : tone === "queue" ? "text-queue" : "text-ghost";
  return (
    <div className="rounded border border-line bg-panel-2 px-4 py-3">
      <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">{label}</p>
      <p className={`font-mono ${small ? "text-base" : "text-3xl"} font-semibold ${color} mt-1`}>
        {value}
        {suffix ? <span className="text-sm text-faint font-normal"> {suffix}</span> : null}
      </p>
    </div>
  );
}


/**
 * The link out.
 *
 * This answer is usually read by an operations engineer, and the decision it leads
 * to is usually signed by somebody else. Until there was a link, the engineering
 * stopped at whoever happened to be at the keyboard — which is not a marketing
 * problem, it is the answer failing to reach the person who can act on it.
 *
 * Placed directly under the headline rather than at the end: the moment to forward
 * something is the moment you have just read the thing worth forwarding.
 */
function ShareLink({ href }: { href: string }) {
  const [copied, setCopied] = React.useState(false);
  const url = typeof window === "undefined" ? href : new URL(href, window.location.origin).toString();

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* the link is visible and selectable either way */
    }
  }

  return (
    <div className="mt-4 flex flex-wrap items-center gap-3 rounded border border-power/40 bg-power/5 px-4 py-3">
      <div className="min-w-56 flex-1">
        <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-power">
          Send this to whoever owns the capex
        </p>
        <p className="mt-1 text-xs text-mute">
          A permanent page with the binding constraint, what it takes to move it, and how this
          hall compares with every other one the engine has seen. Private to whoever holds the
          link.
        </p>
      </div>
      <a href={href} target="_blank" rel="noreferrer" className="text-sm text-power underline">
        Open
      </a>
      <button
        onClick={copy}
        className="rounded bg-power px-4 py-2 text-sm font-semibold text-ink"
      >
        {copied ? "Copied" : "Copy link"}
      </button>
    </div>
  );
}
