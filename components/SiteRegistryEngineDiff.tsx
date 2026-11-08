"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { button, quietButton } from "@/components/SiteRegistryParts";
import {
  ENGINE_DIFF_LABEL, ENGINE_DIFF_PER_HALL_PER_DAY, ENGINE_DIFF_PER_HOUR, ENGINE_DIFF_UNITS, racksSentence,
  type ClassNote, type EngineDiffView, type MissingField, type NotUsed, type Placeholder, type Side,
} from "@/lib/site-registry-engine";
import { formatWeeksDelta } from "@/lib/date-basis";
import type { RegistryApi } from "@/lib/site-registry-model";

// The engine's own answer to "what did the change do to this hall's capacity envelope?", asked on a click. It costs the operator engine units, so nothing here runs
// on page load: the cost and the allowance are printed before the button, and the engine is asked only when the button is pressed. The numbers shown are the
// server's whitelisted answer (lib/site-registry-engine.ts), printed with the declared origin and class they rest on. Never a measurement.

export type PointBody = { now: true } | { asOf: string } | { proposed: { n: number; fromCsv: boolean; cells: Record<string, string | number | boolean | null> }[] };

type PointMeta = { kind: "now" | "asOf" | "proposed"; asOf: string | null; label: string; rows?: { used: number; unchanged: number; excluded: { n: number; fieldPath: string; reason: string }[] } };

export type EngineAnswer = {
  ok: true; ran: boolean; reason?: "missing" | "identical"; message?: string; hall: { id: string; label: string }; from: PointMeta; to: PointMeta; label: string; units: number; historyTruncated: boolean;
  missing: MissingField[]; classNotes: (ClassNote & { side: Side })[]; placeholders: (Placeholder & { sides: Side[] })[]; notUsed: (NotUsed & { sides: Side[] })[];
  ceiling: { cls: string; paths: string[] } | null; classChanges: { path: string; from: string; to: string }[];
  engine?: { version: string; digest: string } | null; diff?: EngineDiffView; carriedBy?: string | null;
};

type Outcome = { kind: "answer"; answer: EngineAnswer } | { kind: "problem"; text: string };

const sideText = (s: Side[]) => (s.length === 2 ? "both points" : s[0] === "from" ? "the earlier point" : "the later point");
const NEED_TEXT: Record<MissingField["need"], string> = {
  engine_required: "The engine's intake requires it.",
  no_gap_default: "The engine would fill it from a library default without listing it as a gap, so it is asked for here.",
};

/** Put a path in the record form and move to it. The form belongs to the page; this only fills its two inputs the way typing would. */
export function jumpToRecordForm(path: string, unit: string): boolean {
  const field = document.getElementById("rec-path") as HTMLInputElement | null;
  if (!field) return false;
  const set = (el: HTMLInputElement | null, value: string) => {
    if (!el) return;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  };
  set(field, path);
  if (unit) set(document.getElementById("rec-unit") as HTMLInputElement | null, unit);
  field.scrollIntoView({ block: "center" });
  field.focus();
  return true;
}

/** Move to the import section (the template buttons are the first things in it). */
export function jumpToImport(): boolean {
  const el = document.getElementById("import-title") as HTMLElement | null;
  if (!el) return false;
  el.setAttribute("tabindex", "-1");
  el.scrollIntoView({ block: "start" });
  el.focus();
  return true;
}

export function MissingList({ missing, canRecord, canImport, onJump, onImport }: { missing: MissingField[]; canRecord: boolean; canImport: boolean; onJump: (m: MissingField) => void; onImport: () => void }) {
  return (
    <div>
      <ul className="mt-2 divide-y divide-line/60 rounded-lg border border-line" aria-label="Figures the engine needs that are not recorded">
        {missing.map((m) => (
          <li key={m.path} className="px-4 py-3 text-[13px]" data-missing={m.path}>
            <p className="text-white break-all">{m.path} <span className="text-mute">· {m.label}{m.unit ? ` (${m.unit})` : ""}</span></p>
            <p className="text-mute">{m.reason} Needed at {sideText(m.sides)}. {NEED_TEXT[m.need]}</p>
            {canRecord
              ? <button type="button" className={`${quietButton} mt-2`} onClick={() => onJump(m)} aria-label={`Record ${m.path}`}>Record this figure</button>
              : <p className="data text-[10px] text-faint mt-1">You cannot record figures in this organisation: ask an owner or an editor to record it.</p>}
          </li>
        ))}
      </ul>
      {canImport && missing.some((m) => m.inTemplate) && (
        <p className="text-[13px] text-mute mt-3">
          Some of these are fields of the import template.{" "}
          <button type="button" className="underline hover:text-white" onClick={onImport}>Go to the import and its template</button>
        </p>
      )}
    </div>
  );
}

const cell = "px-3 py-2 align-top text-[13px]";
/** The movement in weeks through the one shared formatter (lib/date-basis.ts): a number only beside what it rests on, and none when the engine said nothing about it. */
function weeksSentence(w: EngineDiffView["weeks"]): string {
  const keys = { date_basis: w.basis === "unverified" ? undefined : w.basis, date_evidence_class: w.evidenceClass, date_binding_item: w.bindingItem, date_label: w.label };
  return `Time to full capacity: ${formatWeeksDelta(w.delta, keys, keys)}.`;
}
const value = (v: number | string | boolean | null) => (v === null ? "—" : String(v));

export function EngineResult({ a }: { a: EngineAnswer }) {
  const d = a.diff!;
  const sentence = racksSentence(d, a.carriedBy ?? null);
  return (
    <div data-testid="engine-result">
      <p className="text-queue text-[13px]" id="engine-diff-label">{a.label || ENGINE_DIFF_LABEL}</p>
      <p className="data text-[10px] text-faint mt-1">
        Earlier: {a.from.label}{a.from.asOf ? ` (as of ${a.from.asOf})` : ""} · Later: {a.to.label}{a.to.asOf ? ` (as of ${a.to.asOf})` : ""}
      </p>
      {a.historyTruncated && <p className="text-queue text-[12px] mt-1">Only the newest 500 recorded claims were read, so an earlier point may lack figures that were recorded before them.</p>}

      <p className="text-white text-[14px] mt-3"><span className="text-faint">The engine&apos;s headline: </span>{d.headline}</p>
      <p className="text-white text-[14px] mt-2" data-testid="engine-racks">{sentence}</p>
      <p className="text-mute text-[13px] mt-1">
        Moving the inputs one at a time explains {d.explainedRacks >= 0 ? "+" : ""}{d.explainedRacks} racks; {d.unexplainedRacks >= 0 ? "+" : ""}{d.unexplainedRacks} racks are not explained by any one input
        {d.unexplainedRacks !== 0 ? " (the constraints interact)" : ""}. Scenario compared: {d.before.scenario || "not stated"}.
      </p>

      <div className="mt-4 overflow-x-auto" role="region" aria-label="Which recorded inputs moved the rack count" tabIndex={0}>
        <table className="w-full min-w-[40rem] text-left border-collapse">
          <caption className="text-left text-mute text-[12px] mb-2">
            {d.drivers.length === 0 ? "The engine attributes the movement to no recorded input." : "Each recorded input that changed, applied alone to the earlier figures. The engine's label, and the recorder's declared value on each side."}
          </caption>
          {d.drivers.length > 0 && (
            <>
              <thead>
                <tr className="border-b border-line text-faint data text-[10px] uppercase">
                  {["Recorded input", "Engine's label", "Earlier → later", "Effect on the rack count", "Binding constraint"].map((h) => <th key={h} scope="col" className="px-3 py-2 font-normal">{h}</th>)}
                </tr>
              </thead>
              <tbody className="divide-y divide-line/60">
                {d.drivers.map((r) => (
                  <tr key={r.enginePath} data-direction={r.direction}>
                    <th scope="row" className={`${cell} font-normal text-white break-all`}>{r.path ?? r.enginePath}</th>
                    <td className={cell}>{r.label ?? "—"}</td>
                    <td className={cell}>{value(r.before)} <span aria-hidden="true">→</span><span className="sr-only"> to </span> {value(r.after)}</td>
                    <td className={cell}>{r.direction === "no change" ? "No change" : `${r.direction === "raises" ? "Raises" : "Lowers"} by ${Math.abs(r.racksDelta)}`}{r.racksClass ? <span className="data text-[10px] text-faint"> · class {r.racksClass}</span> : null}</td>
                    <td className={cell}>{r.flipsBindingTo ? `Moves what binds first to ${r.flipsBindingTo}` : "Unchanged"}</td>
                  </tr>
                ))}
              </tbody>
            </>
          )}
        </table>
      </div>
      {d.notAttributed.length > 0 && <p className="text-queue text-[12px] mt-2">Not attributed by the engine (it could not move them alone): {d.notAttributed.join(", ")}.</p>}

      <p className="text-white text-[14px] mt-4" data-testid="engine-binding">
        What binds first: {d.before.bindingName} <span aria-hidden="true">→</span><span className="sr-only"> to </span> {d.after.bindingName}
        <span className="text-mute"> ({d.bindingMoved ? "it moved" : "it holds"})</span>
      </p>
      <p className="text-mute text-[13px] mt-1">Before: {d.before.bindingBasis || "no basis stated"}</p>
      {d.bindingMoved && <p className="text-mute text-[13px]">After: {d.after.bindingBasis || "no basis stated"}</p>}

      <p className="text-white text-[14px] mt-4" data-testid="engine-weeks">{weeksSentence(d.weeks)}</p>

      <p className="text-mute text-[13px] mt-3" data-testid="engine-class">
        {a.carriedBy ? `The rack count is carried by evidence class ${a.carriedBy}` : "The engine did not state a class for the rack count"}
        {a.ceiling ? `; the answer is held to ${a.ceiling.cls} because ${a.ceiling.paths.length === 1 ? "this recorded figure carries" : "these recorded figures carry"} no class in the engine: ${a.ceiling.paths.join(", ")}` : ""}.
        {" "}Origin and class are what the recorder declared.
      </p>
      {a.classChanges.length > 0 && <p className="text-queue text-[12px] mt-1">The declared class changed with the value the same for: {a.classChanges.map((c) => `${c.path} (${c.from} → ${c.to})`).join(", ")}. That changes the evidence behind the answer, not an input.</p>}

      {a.classNotes.length > 0 && (
        <details className="mt-3 text-[13px]">
          <summary className="cursor-pointer text-mute">Figures sent at a lower class than declared ({a.classNotes.length})</summary>
          <ul className="list-disc pl-5 mt-1">{a.classNotes.map((n) => <li key={`${n.side}${n.path}`}>{n.path} ({n.side === "from" ? "earlier" : "later"} point): declared {n.declared}, sent as {n.sent}. {n.why}</li>)}</ul>
        </details>
      )}
      {a.placeholders.length > 0 && (
        <details className="mt-3 text-[13px]">
          <summary className="cursor-pointer text-mute">Not recorded: the engine used its own placeholder for {a.placeholders.length} input{a.placeholders.length === 1 ? "" : "s"}</summary>
          <ul className="list-disc pl-5 mt-1">{a.placeholders.map((p) => <li key={p.path}>{p.path} · {p.label}: {p.fallback}</li>)}</ul>
        </details>
      )}
      {a.notUsed.length > 0 && (
        <details className="mt-3 text-[13px]">
          <summary className="cursor-pointer text-mute">Recorded but not used ({a.notUsed.length})</summary>
          <ul className="list-disc pl-5 mt-1">{a.notUsed.map((n) => <li key={n.path + n.reason}>{n.path}: {n.reason}</li>)}</ul>
        </details>
      )}
      {a.to.rows && a.to.rows.excluded.length > 0 && (
        <details className="mt-3 text-[13px]" open>
          <summary className="cursor-pointer text-mute">Rows the import would refuse, left out of this run ({a.to.rows.excluded.length})</summary>
          <ul className="list-disc pl-5 mt-1">{a.to.rows.excluded.map((e) => <li key={e.n}>Row {e.n} ({e.fieldPath}): {e.reason}</li>)}</ul>
        </details>
      )}

      <p className="data text-[10px] text-faint mt-4">
        Not in this run: behind-the-meter options and the scenario set are not recorded figures, so the engine ran its standard scenarios with none declared. A recorded figure is a declaration; nothing here checks it against the real hall.
      </p>
      <p className="data text-[10px] text-faint mt-1">
        {a.engine ? <>Engine {a.engine.version} · build <span title={a.engine.digest}>{a.engine.digest.slice(0, 12)}</span></> : "The engine did not state which build answered."} · {a.units} units used
      </p>
    </div>
  );
}

/**
 * The panel: what it costs, a button, and the answer. `from` and `to` are the two points; null for either (or a reason in `blocked`) disables the button and says why.
 * Nothing is asked of the engine until the button is pressed.
 */
export default function EngineDiffRun({ api, hallId, from, to, blocked, idPrefix = "engine-diff", title, buttonLabel = "Run the engine", intro }: {
  api: RegistryApi; hallId: string; from: PointBody | null; to: PointBody | null; blocked?: string | null; idPrefix?: string; title?: string; buttonLabel?: string; intro?: React.ReactNode;
}) {
  const [phase, setPhase] = useState<"idle" | "running">("idle");
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [canRecord, setCanRecord] = useState(false);
  const [canImport, setCanImport] = useState(false);
  const head = useRef<HTMLHeadingElement>(null);
  const key = JSON.stringify([from, to]);
  const lastKey = useRef(key);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);
  // A different pair of points is a different question: the earlier answer is dropped, not left beside it.
  useEffect(() => { if (lastKey.current !== key) { lastKey.current = key; setOutcome(null); } }, [key]);
  useEffect(() => {
    if (outcome?.kind === "answer" && outcome.answer.missing.length > 0) {
      setCanRecord(Boolean(document.getElementById("rec-path")));
      setCanImport(Boolean(document.getElementById("import-title")));
    }
    if (outcome) head.current?.focus();
  }, [outcome]);

  const reason = blocked ?? (from && to ? null : "Choose two points first.");
  const costId = `${idPrefix}-cost`;

  async function run() {
    if (!from || !to || reason) return;
    setPhase("running"); setOutcome(null);
    try {
      const r = await api(`/api/halls/${hallId}/diff`, { method: "POST", body: { from, to } });
      if (!mounted.current) return;
      if (r.body?.ok === true && typeof r.body.ran === "boolean" && Array.isArray(r.body.missing)) setOutcome({ kind: "answer", answer: r.body as EngineAnswer });
      else if (r.status === 404) setOutcome({ kind: "problem", text: "This hall could not be found. Nothing was run." });
      else if (r.status === 429) setOutcome({ kind: "problem", text: `${r.body?.error ?? "The allowance for engine runs is used up."}${r.retryAfter ? ` Try again in about ${r.retryAfter < 120 ? `${r.retryAfter} seconds` : `${Math.ceil(r.retryAfter / 60)} minutes`}.` : ""} Nothing was run.` });
      else if (r.status === 503) setOutcome({ kind: "problem", text: `The engine is not available: ${r.body?.error ?? "nothing was run and nothing was charged."}` });
      else setOutcome({ kind: "problem", text: `${r.body?.error ?? "That did not work."} Nothing is shown.` });
    } catch {
      if (mounted.current) setOutcome({ kind: "problem", text: "Could not reach the server. Nothing was run." });
    } finally {
      if (mounted.current) setPhase("idle");
    }
  }

  const a = outcome?.kind === "answer" ? outcome.answer : null;
  return (
    <section aria-labelledby={`${idPrefix}-title`} className="mt-5 rounded-lg border border-line p-4" data-testid={idPrefix}>
      <h4 id={`${idPrefix}-title`} className="text-sm font-semibold">{title ?? "Engine capacity-envelope diff"}</h4>
      <p className="text-mute text-[13px] mt-1">{intro ?? <>Asks the engine what the change between these two points does to the hall&apos;s capacity envelope: the rack count, what binds first, and the time to power. It solves both sets of recorded figures and says which recorded input moved the answer.</>}</p>
      <p className="text-queue text-[12px] mt-1">{ENGINE_DIFF_LABEL}</p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button type="button" id={`${idPrefix}-run`} className={button} onClick={() => void run()} disabled={phase === "running" || Boolean(reason)} aria-describedby={costId}>
          {phase === "running" ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : null}{buttonLabel}
        </button>
        <p id={costId} className="data text-[11px] text-mute">This runs the engine ({ENGINE_DIFF_UNITS} units) — limited to {ENGINE_DIFF_PER_HOUR} per hour, and {ENGINE_DIFF_PER_HALL_PER_DAY} a day for this hall.</p>
      </div>
      {reason && <p className="text-[12px] text-queue mt-2" id={`${idPrefix}-blocked`}>{reason}</p>}
      <p role="status" className="sr-only">{phase === "running" ? "Asking the engine." : ""}</p>

      <div aria-live="polite" className="mt-3">
        {outcome?.kind === "problem" && (
          <div>
            <h5 ref={head} tabIndex={-1} className="text-sm font-semibold outline-none">The engine did not answer</h5>
            <p role="alert" className="text-red-400 text-[13px] mt-1">{outcome.text}</p>
          </div>
        )}
        {a && !a.ran && a.reason === "missing" && (
          <div>
            <h5 ref={head} tabIndex={-1} className="text-sm font-semibold outline-none">The engine was not run: figures it needs are not recorded</h5>
            <p className="text-mute text-[13px] mt-1">{a.message}</p>
            <MissingList missing={a.missing} canRecord={canRecord} canImport={canImport}
              onJump={(m) => { if (!jumpToRecordForm(m.path, m.unit === "-" ? "" : m.unit)) setCanRecord(false); }} onImport={() => { if (!jumpToImport()) setCanImport(false); }} />
            {a.to.rows && a.to.rows.excluded.length > 0 && <p className="text-queue text-[12px] mt-2">{a.to.rows.excluded.length} row{a.to.rows.excluded.length === 1 ? "" : "s"} of the import would be refused and are left out.</p>}
          </div>
        )}
        {a && !a.ran && a.reason === "identical" && (
          <div>
            <h5 ref={head} tabIndex={-1} className="text-sm font-semibold outline-none">Nothing to compare</h5>
            <p className="text-mute text-[13px] mt-1">{a.message}</p>
          </div>
        )}
        {a && a.ran && a.diff && (
          <div>
            <h5 ref={head} tabIndex={-1} className="text-sm font-semibold outline-none">The engine&apos;s answer</h5>
            <EngineResult a={a} />
          </div>
        )}
      </div>
    </section>
  );
}
