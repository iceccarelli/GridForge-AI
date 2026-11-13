"use client";

import React, { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowRight, CircleAlert, Loader2 } from "lucide-react";
import { constraintHref, type ConstraintSlugs } from "@/lib/constraint-links";
import type { QualifyResult } from "@/lib/qualify";
import { assumedText } from "@/lib/assumed-text";
import { PRODUCTS } from "@/lib/products";
import { eur } from "@/lib/commerce";
import { PAYG } from "@/lib/products";
import { formatSetsTheDate } from "@/lib/date-basis";
import FreeAllowanceForm from "@/components/FreeAllowanceForm";
import { NEXT_STEP_HREFS } from "@/lib/qualify-next-steps";
import { isInputProblem, joinNames, orderedWarnings, rackNoun, splitGaps, upperBoundInputs, type QualifyGap } from "@/lib/qualify-readout";
import { assumedRecordMatches, type QualifyAssumable } from "@/lib/qualify-assumed";
import {
  HALL_PRESETS,
  PRESET_DISCLOSURE,
  PRESET_VALUE_CLASS,
  QUALIFY_PRESET_KEYS,
  isUntouchedQualifyTemplate,
  presetById,
  qualifyTemplateState,
  stillTemplateQualifyValues,
  switchQualifyTemplate,
  type QualifyPresetKey,
  type HallPreset,
} from "@/lib/hall-presets";

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
 *
 * REFERENCE TEMPLATES. When the deployed engine advertises that it can label a figure as assumed (`presetsAvailable`, read from its
 * /v1/version by the page), a visitor with no figures to hand may start from a template. Its values are synthetic and nobody measured them:
 * a field still holding the template's value is sent as `assumedFields` and the engine classes it E0 (assumed) in the result, never E5
 * (customer data). A field the visitor edits is theirs from then on. The disclosure stays while any value is edited, and a read that still
 * contains a template's values is not stored or shareable and cannot be commissioned from (app/api/qualify/route.ts). Without the flag
 * nothing of this is rendered and the form is exactly what it was.
 */

/** Exported, with FIELDS and fieldProblem, so the suite (which has no DOM) can run the form's own rule on typed text. */
export interface FieldDef {
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

/**
 * An EXAMPLE of each figure, shown as the field's placeholder and nothing else. The fields start empty: a pre-filled value was submitted as the
 * visitor's own customer data (class E5) when they pressed the button without typing, and the engine then reported demo numbers as their hall.
 * Choosing "no template" empties the fields again for the same reason.
 */
const DEFAULTS = {
  contractedMW: 12,
  currentPeakMW: 7.4,
  currentItLoadMW: 4.9,
  buswayAmpacityA: 400,
  tapoffMaxA: 63,
  plantSupplyC: 6,
  positionsAvailable: 180,
};

export const FIELDS: FieldDef[] = [
  { key: "contractedMW", label: "Contracted capacity", unit: "MW", step: "0.1", min: 0, max: 2000, positive: true,
    hint: "From the supply contract, not the connection nameplate." },
  { key: "currentPeakMW", label: "Current site peak", unit: "MW", step: "0.1", min: 0, max: 2000,
    hint: "Half-hourly metered peak over 12 months." },
  { key: "currentItLoadMW", label: "Current IT load", unit: "MW", step: "0.1", min: 0, max: 2000,
    hint: "Protected load at the UPS output." },
  { key: "buswayAmpacityA", label: "Busway ampacity", unit: "A", min: 0, max: 6300, positive: true,
    hint: "400 A legacy or 800–1000 A modern. A legacy busway can be the hard stop." },
  { key: "tapoffMaxA", label: "Tap-off rating", unit: "A", min: 0, max: 1600, positive: true,
    hint: "A rack that cannot be fed cannot be placed." },
  { key: "plantSupplyC", label: "Plant supply temperature", unit: "°C", step: "0.5", min: -5, max: 45,
    hint: "Chilled water flow setpoint. Legacy plant runs 6–7 °C." },
  // Zero is an answer: the engine accepts it and reports that rack positions are what stops the hall.
  { key: "positionsAvailable", label: "Rack positions available", unit: "", min: 0, max: 20000, integer: true,
    hint: "Positions you could actually release from tenancy. Enter 0 if none are free." },
];

const PLATFORMS = [
  { id: "gb300_nvl72", label: "NVIDIA GB300 NVL72" },
  { id: "gb200_nvl72", label: "NVIDIA GB200 NVL72" },
  { id: "generic_dlc_50", label: "Generic DLC rack, 50 kW" },
];

type Values = typeof DEFAULTS;
type Raw = Record<keyof Values, string>;
const EMPTY_RAW = Object.fromEntries(Object.keys(DEFAULTS).map((k) => [k, ""])) as Raw;
type FieldErrors = Partial<Record<keyof Values, string>>;

/** The first problem with one field's text, or null. Mirrors the engine's bounds so the message sits beside the field. */
export function fieldProblem(f: FieldDef, raw: string): string | null {
  if (raw.trim() === "") return "Enter a value.";
  const n = Number(raw);
  if (!Number.isFinite(n)) return "Enter a number.";
  if (f.integer && !Number.isInteger(n)) return "Enter a whole number.";
  if (f.positive ? n <= 0 : n < f.min) return f.positive ? "Enter a number greater than zero." : `Enter ${f.min} or more.`;
  if (n > f.max) return `Enter ${f.max.toLocaleString("en-GB")} or less.`;
  return null;
}

/** What a result remembers about the template it started from: the label stays with the answer, whatever was edited afterwards. */
type TemplateUsed = { name: string; assumed: number; total: number; untouched: boolean; fields: QualifyAssumable[] };

/** Under a field a template filled in: whether the figure is still the template's (assumed) or has become the visitor's. */
function TemplateTag({ id, preset, fieldKey, value }: { id: string; preset: HallPreset; fieldKey: string; value: string }) {
  if (!(QUALIFY_PRESET_KEYS as readonly string[]).includes(fieldKey)) return null;
  const still = value.trim() === preset.values[fieldKey as (typeof QUALIFY_PRESET_KEYS)[number]];
  return (
    <span id={id} className={`mt-1 block text-[11px] leading-snug ${still ? "text-queue" : "text-faint"}`}>
      {still ? `Template value · assumed (${PRESET_VALUE_CLASS})` : "Your value"}
    </span>
  );
}

export function CapacityQualifier({
  presetsAvailable = false,
  initialTemplateId = null,
  constraintSlugs,
}: {
  presetsAvailable?: boolean;
  initialTemplateId?: string | null;
  /** Constraint name -> page slug (lib/constraint-links.ts), read by the server page from the published reference. A name not in it renders as plain text. */
  constraintSlugs?: ConstraintSlugs;
} = {}) {
  // `initialTemplateId` starts the form as if that template had been chosen (server-rendered tests only; the page never passes it).
  const start = presetsAvailable ? presetById(initialTemplateId) : null;
  const [templateId, setTemplateId] = useState<string | null>(start?.id ?? null);
  const preset = presetsAvailable ? presetById(templateId) : null;
  const [raw, setRaw] = useState<Raw>(() => ({ ...EMPTY_RAW, ...(start ? qualifyTemplateState(start).raw : {}) }));
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const alertRef = useRef<HTMLDivElement>(null);
  const headlineRef = useRef<HTMLParagraphElement>(null);
  const [platform, setPlatform] = useState<string>(start ? qualifyTemplateState(start).platform : "gb300_nvl72");
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
  /** The template the displayed result started from (null: none, or none of its values were still the template's). */
  const [templateUsed, setTemplateUsed] = useState<TemplateUsed | null>(null);
  const templateStill = preset ? stillTemplateQualifyValues(preset, raw).length : 0;

  /**
   * What a screen reader is told when a template is chosen or cleared, or a template result arrives. The live region that carries it is
   * rendered from the first paint and only its text changes: a region inserted together with its message is often not announced at all.
   */
  const [announcement, setAnnouncement] = useState("");

  /**
   * Choosing a template (or "no template") never overwrites what the visitor typed. A field they changed (non-empty and not the previous
   * template's value) is kept and tagged "Your value"; the others take the new template's value, or are emptied. The announcement says how many were kept.
   */
  const chooseTemplate = (id: string) => {
    const p = presetById(id);
    setResult(null);
    setShare(null);
    setError(null);
    setFieldErrors({});
    setTemplateUsed(null);
    const { raw: next, kept } = switchQualifyTemplate(raw, preset, p);
    const keptNote = kept.length ? ` ${kept.length} figure${kept.length === 1 ? "" : "s"} you had typed ${kept.length === 1 ? "was" : "were"} kept as yours.` : "";
    setRaw(next);
    if (!p) {
      setTemplateId(null);
      if (preset && platform === preset.platform) setPlatform("gb300_nvl72");
      setAnnouncement(`Template cleared.${keptNote || " The fields it filled are empty again."}`);
      return;
    }
    setTemplateId(p.id);
    if (platform === "gb300_nvl72" || (preset && platform === preset.platform)) setPlatform(p.platform);
    setAnnouncement(`${PRESET_DISCLOSURE}. Template loaded: ${p.name}.${keptNote} Figures still the template's are assumed (${PRESET_VALUE_CLASS}).`);
  };

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

  // A result appears below the form: move focus to its headline (a screen reader reads it, and a keyboard user is not left on a button that
  // has just changed meaning).
  useEffect(() => {
    if (result) headlineRef.current?.focus();
  }, [result]);

  function focusField(key: string) {
    document.getElementById(`qualify-${key}`)?.focus();
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    // The button is aria-disabled while a request runs (not `disabled`, which would drop keyboard focus to <body>): a second press does nothing.
    if (busy) return;
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
    setTemplateUsed(null);
    // Only the figures that still hold the template's own value are declared assumed (E0); a figure the visitor changed is theirs.
    const assumedFields = preset ? stillTemplateQualifyValues(preset, raw) : [];
    const used: TemplateUsed | null =
      preset && assumedFields.length > 0
        ? { name: preset.name, assumed: assumedFields.length, total: QUALIFY_PRESET_KEYS.length, untouched: isUntouchedQualifyTemplate(preset, raw), fields: assumedFields }
        : null;
    try {
      const res = await fetch("/api/qualify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...values, platform, siteName, metro, ...(assumedFields.length ? { assumedFields } : {}) }),
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
      // The page claims a figure is assumed only when the engine's own record says so, and lists exactly what was declared (a rolling deploy can
      // send the request to an engine that ignored it): otherwise no result is shown, not even the numbers.
      if (used && !assumedRecordMatches(body.result, used.fields)) {
        setError("The capacity engine did not confirm that it labels the template's figures as assumed, so no result is shown. Enter your own figures instead.");
        setAlertTick((t) => t + 1);
        return;
      }
      setResult(body.result as QualifyResult);
      setTemplateUsed(used);
      if (used) setAnnouncement(`Result ready for a reference template. ${used.assumed} of ${used.total} figures are the template's and are classed assumed (${PRESET_VALUE_CLASS}); this read is not saved.`);
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

      {presetsAvailable ? (
        <div className="mb-5">
          <div id="qualify-template-live" role="status" aria-live="polite" aria-atomic="true" className="sr-only">
            {announcement}
          </div>
          <label htmlFor="qualify-template" className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">
            No figures to hand? Start from a reference template
          </label>
          <select
            id="qualify-template"
            aria-describedby="qualify-template-help"
            value={templateId ?? ""}
            onChange={(e) => chooseTemplate(e.target.value)}
            className="mt-1 min-h-11 w-full max-w-xl bg-panel-2 border border-line rounded px-3 py-2 text-ghost
                       focus:outline-none focus:ring-2 focus:ring-power/60"
          >
            <option value="">No template — I will enter my own figures</option>
            {HALL_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <span id="qualify-template-help" className="block mt-1 text-[11px] leading-snug text-faint">
            A template fills the seven figures with synthetic input values, assumed ({PRESET_VALUE_CLASS}), not a customer&apos;s hall. Nothing is solved
            until you press the button.
          </span>
          {preset ? (
            <div data-testid="qualify-template-disclosure" className="mt-3 rounded border border-queue/40 bg-queue/10 p-3 text-sm text-ghost">
              <p>
                <strong>{PRESET_DISCLOSURE}.</strong>
              </p>
              <p className="mt-1 text-mute">
                Started from &ldquo;{preset.name}&rdquo;. {templateStill} of {QUALIFY_PRESET_KEYS.length} figures are still the template&apos;s; they are
                sent to the engine as assumed ({PRESET_VALUE_CLASS}), and a figure you change is yours from then on. A read that still contains
                template figures is not saved, has no share link and cannot be commissioned from.
              </p>
            </div>
          ) : null}
        </div>
      ) : null}

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
                  placeholder={`e.g. ${DEFAULTS[f.key]}`}
                  onChange={(e) => set(f.key, e.target.value)}
                  aria-required="true"
                  aria-invalid={err ? true : undefined}
                  aria-describedby={`${err ? `qualify-${f.key}-error ` : ""}qualify-${f.key}-hint${preset ? ` qualify-${f.key}-tag` : ""}`}
                  className={`mt-1 min-h-11 w-full bg-panel-2 border rounded px-3 py-2 font-mono text-ghost
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
                {preset ? <TemplateTag id={`qualify-${f.key}-tag`} preset={preset} fieldKey={f.key} value={raw[f.key]} /> : null}
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
              className="mt-1 min-h-11 w-full bg-panel-2 border border-line rounded px-3 py-2 font-mono text-ghost
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
              className="mt-1 min-h-11 w-full bg-panel-2 border border-line rounded px-3 py-2 text-ghost
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
              className="mt-1 min-h-11 w-full bg-panel-2 border border-line rounded px-3 py-2 text-ghost
                         focus:outline-none focus:ring-2 focus:ring-power/60"
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="submit"
            aria-disabled={busy}
            className="inline-flex min-h-11 items-center gap-2 rounded bg-power px-5 py-2.5 font-semibold text-ink
                       aria-disabled:opacity-60 aria-disabled:cursor-not-allowed"
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
          headlineRef={headlineRef}
          share={share}
          qualificationId={qualificationId}
          qualificationToken={qualificationToken}
          template={templateUsed}
          constraintSlugs={constraintSlugs}
        />
      ) : null}
    </div>
  );
}

/**
 * A constraint's name, linked to its engineering reference when the page knows it (the name is in the map the server page passed) and plain text
 * otherwise. Underlined, so the link is not signalled by colour alone, and 44 px tall for a thumb. The hidden suffix tells a screen reader where it goes.
 */
function ConstraintName({ name, slugs }: { name: string; slugs?: ConstraintSlugs }) {
  const href = constraintHref(slugs, name);
  if (!href) return <span>{name}</span>;
  return (
    <Link
      href={href}
      className="inline-flex min-h-11 items-center underline decoration-power/60 underline-offset-2 hover:text-power focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-power/60"
    >
      <span>
        {name}
        <span className="sr-only"> (engineering reference)</span>
      </span>
    </Link>
  );
}

/** Exported so the tests render the readout from a canned engine answer; the page uses it only through CapacityQualifier. */
export function QualifyReadout({
  result,
  headline,
  headlineRef,
  share,
  qualificationId,
  qualificationToken,
  template,
  constraintSlugs,
}: {
  result: QualifyResult;
  headline: string;
  headlineRef?: React.Ref<HTMLParagraphElement>;
  share: string | null;
  qualificationId: string | null;
  qualificationToken: string | null;
  template: TemplateUsed | null;
  constraintSlugs?: ConstraintSlugs;
}) {
  const { as_found: found, after_relief: after, intake } = result;
  // The inputs the engine treated as "no limit": the rack counts are then upper bounds, and the page says so beside them.
  const unevaluated = upperBoundInputs(result);
  // Everything the engine warned about, the unit and inconsistency findings first. The verdict below is not a finding about the hall while one stands.
  const warnings = orderedWarnings(result);
  // Every required gap is shown, then optional ones up to a cap; the rest sit behind a disclosure. The footer counts the starred rows.
  const gapRows = splitGaps(intake.gaps);
  return (
    <div className="mt-8 animate-slide-up">
      {template ? <TemplateNotice template={template} recorded={result.inputs_declared_assumed ?? []} /> : null}
      {warnings.length ? <EngineWarnings warnings={warnings} /> : null}
      <p ref={headlineRef} tabIndex={-1} className="text-lg text-ghost leading-snug max-w-3xl outline-none focus-visible:ring-2 focus-visible:ring-power/60">{headline}</p>
      {share ? <ShareLink href={share} /> : null}

      <div className="mt-5 grid gap-3 sm:grid-cols-3">
        <Readout label={`Deployable today${unevaluated.length ? " · upper bound" : ""}`} value={String(found.racks)} suffix={rackNoun(found.racks)} tone="ghost" />
        <Readout label={`After the ladder${unevaluated.length ? " · upper bound" : ""}`} value={String(after.racks)} suffix={rackNoun(after.racks)} tone="power" />
        <SetsTheDate after={after} />
      </div>
      {unevaluated.length ? (
        <p data-testid="qualify-upper-bound" className="mt-2 max-w-3xl text-[11px] leading-snug text-queue">
          Upper bound: {joinNames(unevaluated)} {unevaluated.length === 1 ? "was" : "were"} not evaluated (treated as no limit), so the hall may carry fewer racks than this.
        </p>
      ) : null}

      <div className="mt-5 rounded border border-line bg-panel-2 p-4">
        <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-queue">
          Binding constraint · {found.domain}
        </p>
        <p className="text-ghost font-semibold mt-1">
          <ConstraintName name={found.binding_constraint} slugs={constraintSlugs} />
        </p>
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
                className="flex min-h-11 items-center gap-3 rounded border border-line bg-panel-2 px-3 py-1 text-sm"
              >
                <span className="font-mono text-faint">{i + 1}</span>
                <span className="text-ghost">
                  <ConstraintName name={c.name} slugs={constraintSlugs} />
                </span>
                <span className="text-faint ml-auto text-right">{c.relief ?? "—"}</span>
              </li>
            ))}
          </ol>
        </div>
      ) : null}

      {gapRows.shown.length ? (
        <div className="mt-6">
          <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint mb-2">
            Assumed, because nobody supplied it
            {template ? "" : ` · intake ${Math.round(intake.completeness * 100)}% complete`}
          </p>
          <GapTable rows={gapRows.shown} label="Inputs the engine assumed" />
          {gapRows.more.length ? (
            <details data-testid="qualify-more-gaps" className="mt-3">
              <summary className="flex min-h-11 cursor-pointer items-center text-sm text-power underline decoration-power/60 underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-power/60">
                +{gapRows.more.length} more optional input{gapRows.more.length === 1 ? "" : "s"}
              </summary>
              <div className="mt-2">
                <GapTable rows={gapRows.more} label="More optional inputs the engine assumed" />
              </div>
            </details>
          ) : null}
          <p className="text-[11px] text-faint mt-2">
            {gapRows.requiredCount === 0 ? "No required inputs assumed. Each optional one still moves the answer." : `${gapRows.requiredCount} required input${gapRows.requiredCount === 1 ? "" : "s"} assumed. Each one moves the answer.`} A * marks an input the paid document requires.
            {template ? " The figures that are still the template's are assumed too (listed above); the engine's completeness score would count them as supplied, so it is not shown for a template." : ""}
          </p>
        </div>
      ) : null}

      <NextSteps
        share={share}
        templateDerived={template !== null}
        commission={
          <CommissionPanel
            recommendation={intake.recommended_engagement}
            summary={`${headline} Binding constraint: ${found.binding_constraint}. ${gapRows.requiredCount} required input${gapRows.requiredCount === 1 ? "" : "s"} still assumed.`}
            capacityMW={Math.round((found.it_load_kW?.value ?? 0) / 1000)}
            qualificationId={qualificationId}
            qualificationToken={qualificationToken}
          />
        }
      />

      <p className="text-[11px] text-faint mt-5 leading-relaxed max-w-3xl">{result.notice}</p>
    </div>
  );
}

/** One table of assumed inputs. A required one carries a star; the paid document needs it. */
function GapTable({ rows, label }: { rows: QualifyGap[]; label: string }) {
  return (
    <div role="region" aria-label={label} tabIndex={0} className="overflow-x-auto rounded border border-line focus:outline-none focus-visible:ring-2 focus-visible:ring-power/60">
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
          {rows.map((g, i) => (
            <tr key={`${g.input}-${i}`} className="border-t border-line align-top">
              <td className="px-3 py-2 text-ghost">
                {g.input}
                {g.required ? <span className="text-flag"> *</span> : null}
              </td>
              <td className="px-3 py-2 font-mono text-mute">{assumedText(g.assumed)}</td>
              <td className="px-3 py-2 text-faint">
                {g.why_it_binds}
                {g.how_to_get_it ? (
                  <span className="mt-1 block text-mute">Where to find it: {g.how_to_get_it}</span>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * What the engine warned about, above the verdict it qualifies. Each warning is text the engine wrote about THESE inputs; it is rendered as
 * text (React escapes it), never as markup. A unit or consistency finding (a peak below the IT load, a MW/MVA/kW slip) is listed first and the
 * box says so: the zero beside it can then be a sign of a typo rather than of a full hall.
 */
function EngineWarnings({ warnings }: { warnings: string[] }) {
  const problems = warnings.filter(isInputProblem).length;
  return (
    <div
      role="note"
      aria-label="Warnings from the engine"
      data-testid="qualify-warnings"
      className={`mb-4 rounded border p-4 text-sm text-ghost ${problems ? "border-flag/50 bg-flag/10" : "border-line bg-panel-2"}`}
    >
      <p className={`font-mono text-[10px] uppercase tracking-[0.14em] ${problems ? "text-flag" : "text-faint"}`}>
        {problems ? `Check these figures · ${warnings.length === 1 ? "1 warning" : `${warnings.length} warnings`} from the engine` : `Noted by the engine · ${warnings.length === 1 ? "1 warning" : `${warnings.length} warnings`}`}
      </p>
      <ul className="mt-2 grid gap-2">
        {warnings.map((w, i) => (
          <li key={i} className={isInputProblem(w) ? "text-ghost" : "text-mute"}>
            {w}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Three next steps, each a real route or workflow that exists today, in the order that costs the visitor least first: compare the relief
 * scenarios (free), get a free API key to call the engine yourself (free, no card), then the paid Density Screen. Nothing here sends the
 * figures typed above anywhere new. The first step is an ordinary page; the second is the existing free-allowance form; the third is the
 * existing commission flow, or, for a read that still contains a reference template's figures, the product page (a template is not a hall,
 * so nothing is commissioned from it).
 */
function NextSteps({ share, templateDerived, commission }: { share: string | null; templateDerived: boolean; commission: React.ReactNode }) {
  return (
    <section aria-labelledby="next-steps" className="mt-6 rounded border border-line bg-panel-2 p-4 sm:p-5">
      <h3 id="next-steps" className="font-mono text-[10px] uppercase tracking-[0.14em] text-power">
        What to do next
      </h3>
      <ol className="mt-3 grid gap-4 md:grid-cols-2">
        <li className="min-w-0 md:col-span-2" data-next-step="compare">
          <p className="text-sm font-semibold text-ghost">1. Compare the relief scenarios · free</p>
          <p className="mt-1 text-xs text-mute">
            The free Time-to-Power comparison puts dates and evidence classes on each option and can be saved to a project for whoever
            approves the spend.
            {share ? " This read also has a permanent page, private to whoever holds its link (above)." : ""}
          </p>
          {!share && !templateDerived ? (
            <p className="mt-1 text-xs text-mute">It was not saved to a page on this deployment, so copy the figures above before you leave.</p>
          ) : null}
          <a href={NEXT_STEP_HREFS.compare} className="mt-2 inline-flex min-h-11 items-center text-sm text-power underline">
            Run the comparison
          </a>
        </li>
        <li className="min-w-0 md:col-span-2" data-next-step="free-key">
          <p className="text-sm font-semibold text-ghost">2. Get a free API key · no card</p>
          <p className="mt-1 text-xs text-mute">
            An email address gets {PAYG.freeAllowanceUnits} units a month to call the engine from your own tooling.{" "}
            <a href={NEXT_STEP_HREFS.developersRates} className="text-power underline">See what the next operation would cost</a>{" "}
            before you run it.
          </p>
          <div className="mt-3 max-w-xl">
            <FreeAllowanceForm compact heading="Get the free allowance" />
          </div>
        </li>
        <li className="min-w-0 md:col-span-2" data-next-step="density-screen">
          <p className="text-sm font-semibold text-ghost">3. The Density Screen · paid</p>
          {templateDerived ? (
            <p className="mt-1 text-xs text-mute">
              This read used a reference template&apos;s figures, so there is nothing to commission from it. Run the qualifier again with your own
              hall&apos;s figures to commission the Screen from that read, or read what it is first.{" "}
              <a href={NEXT_STEP_HREFS.densityScreen} className="text-power underline">What the Density Screen is</a>.
            </p>
          ) : (
            <>
              <p className="mt-1 text-xs text-mute">
                The engagement below carries this read into the Screen, so the intake starts from the numbers you already entered.{" "}
                <a href={NEXT_STEP_HREFS.engagements} className="text-power underline">Compare the engagements</a>.
              </p>
              {commission}
            </>
          )}
        </li>
      </ol>
    </section>
  );
}

/**
 * Said above a read whose figures include a reference template's: what it is, how many figures are the template's, and what the engine recorded.
 * It asserts the class E0 ONLY when the engine's own record lists exactly the figures that were declared, each as E0 (assumedRecordMatches);
 * otherwise it says the engine did not confirm it and claims nothing. (The route and the form already refuse such an answer; this is the last lock.)
 * Not a live region of its own: the announcement is made through the one region the form renders from its first paint.
 */
export function TemplateNotice({ template, recorded }: { template: TemplateUsed; recorded: NonNullable<QualifyResult["inputs_declared_assumed"]> }) {
  const confirmed = assumedRecordMatches({ inputs_declared_assumed: recorded }, template.fields);
  return (
    <div data-testid="qualify-template-result" className="mb-5 rounded border border-queue/40 bg-queue/10 p-4 text-sm text-ghost">
      <p>
        <strong>{PRESET_DISCLOSURE}.</strong>
      </p>
      {confirmed ? (
        <>
          <p className="mt-1 text-mute">
            {template.untouched
              ? `This read is for the template “${template.name}”, not for any hall: all ${template.total} figures are the template's and are classed assumed (${PRESET_VALUE_CLASS}) in the result.`
              : `${template.assumed} of ${template.total} figures in this read are still the template's “${template.name}” and are classed assumed (${PRESET_VALUE_CLASS}) in the result; the others are yours.`}{" "}
            It is not saved and has no share link.
          </p>
          <ul className="mt-2 space-y-0.5 font-mono text-[11px] text-faint">
            {recorded.map((r) => (
              <li key={r.path}>
                · {r.input}: {r.value} {r.unit} · {r.evidence} assumed
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="mt-1 text-mute">
          This read started from the template “{template.name}”, but the engine did not confirm which figures it recorded as assumed, so do not read any figure
          in it as a hall&apos;s own, and do not use it. It is not saved and has no share link.
        </p>
      )}
    </div>
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
