"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { buildChains, diffPoints, evidenceLine, evidenceShift, pointsOf, successions, type Diff, type DiffRow, type Point, type Step } from "@/lib/site-registry-diff";
import type { RegistryApi, RegistryInput } from "@/lib/site-registry-model";
import { fieldBox } from "@/components/SiteRegistryParts";

// "What changed" at a hall: two points in its history compared, or one field's successive values. Computed here from the claims the read API returns;
// a change in a figure is always printed with the declared origin, class and file it rests on. It compares what was RECORDED; it is not a recomputed capacity result.

const KIND_TITLE: Record<DiffRow["kind"], string> = {
  changed: "Changed",
  added: "Added",
  withdrawn: "Withdrawn: now recorded as missing",
  unknown: "Cannot be told: older history not loaded",
  unchanged: "Unchanged",
};
const ORDER: DiffRow["kind"][] = ["changed", "added", "withdrawn", "unknown", "unchanged"];

export const FILE_STATUS_NOTE = "A file's review status is its status now: the registry does not keep the status a file had when the figure was recorded.";

export function AspectList({ aspects }: { aspects: DiffRow["aspects"] }) {
  return (
    <ul className="mt-1 space-y-0.5 text-[13px]">
      {aspects.map((a) => (
        <li key={a.what}>
          <span className="text-faint">{a.what}:</span> <span className="text-mute">{a.from}</span> <span aria-hidden="true">→</span><span className="sr-only"> to </span> <span className="text-white">{a.to}</span>
          {a.direction && <span className="data text-[10px] text-faint"> ({a.direction}, as declared)</span>}
          {a.note && <span className="data text-[10px] text-faint"> {a.note}</span>}
        </li>
      ))}
    </ul>
  );
}

export function DiffView({ diff }: { diff: Diff }) {
  return (
    <div>
      <p role="status" className="text-[13px] text-mute" id="diff-summary">
        {diff.counts.changed} changed, {diff.counts.added} added, {diff.counts.withdrawn} withdrawn, {diff.counts.unknown} that cannot be told, {diff.counts.unchanged} unchanged.
      </p>
      {ORDER.map((k) => {
        const rows = diff.rows.filter((r) => r.kind === k);
        if (rows.length === 0) return null;
        const body = (
          <ul className="divide-y divide-line/60 rounded-lg border border-line">
            {rows.map((r) => (
              <li key={r.path} className="px-4 py-3 text-[13px]" data-kind={r.kind}>
                <p className="text-white break-all">{r.path}</p>
                {r.kind === "unchanged" && r.after && <p className="text-mute">Stands as: {evidenceLine(r.after)}{r.note ? `. ${r.note}` : ""}</p>}
                {r.kind === "unknown" && <p className="text-mute">{r.note}</p>}
                {(r.kind === "changed" || r.kind === "withdrawn") && r.before && r.after && (
                  <>
                    <AspectList aspects={r.aspects} />
                    <p className="data text-[10px] text-faint mt-1">Rests on: {evidenceShift(r.before, r.after)}</p>
                  </>
                )}
                {r.kind === "added" && r.after && (
                  <>
                    <p className="text-white">{r.after.origin === "missing" ? "Recorded as missing" : `${r.after.value === null ? "" : String(r.after.value)}${r.after.unit ? " " + r.after.unit : ""}`}</p>
                    <p className="data text-[10px] text-faint mt-1">Rests on: {evidenceShift(null, r.after)}</p>
                  </>
                )}
                {r.between > 1 && <p className="data text-[10px] text-faint">{r.between} recordings of this field in between; only the first and last points are compared here.</p>}
                {r.cautions.map((c) => <p key={c} className="text-queue text-[12px] mt-1">{c}</p>)}
              </li>
            ))}
          </ul>
        );
        return k === "unchanged" ? (
          <details key={k} className="mt-4"><summary className="cursor-pointer text-sm font-semibold">{KIND_TITLE[k]} ({rows.length})</summary><div className="mt-2">{body}</div></details>
        ) : (
          <div key={k} className="mt-4"><h5 className="text-sm font-semibold mb-2">{KIND_TITLE[k]} ({rows.length})</h5>{body}</div>
        );
      })}
      {diff.rows.length === 0 && <p className="text-mute text-[13px] mt-3">Nothing was recorded at either point.</p>}
    </div>
  );
}

export function StepsView({ steps }: { steps: Step[] }) {
  return (
    <ol className="divide-y divide-line/60 rounded-lg border border-line">
      {steps.map((s) => (
        <li key={s.after.id} className="px-4 py-3 text-[13px]">
          <p className="data text-[10px] text-faint">{s.before ? "Correction" : "First recorded"} · {s.after.recordedAt ? s.after.recordedAt.slice(0, 10) : "date unknown"} · by {s.after.recordedBy}</p>
          {s.before ? <AspectList aspects={s.aspects} /> : <p className="text-white">{s.after.origin === "missing" ? "Recorded as missing" : `${String(s.after.value)}${s.after.unit ? " " + s.after.unit : ""}`}</p>}
          {s.before && s.aspects.length === 0 && <p className="text-mute">Recorded again with the same content.</p>}
          <p className="data text-[10px] text-faint mt-1">Rests on: {evidenceShift(s.before, s.after)}</p>
          {s.cautions.map((c) => <p key={c} className="text-queue text-[12px] mt-1">{c}</p>)}
        </li>
      ))}
    </ol>
  );
}

export default function SiteRegistryDiff({ hall, api, current, refreshKey }: { hall: { id: string }; api: RegistryApi; current: RegistryInput[]; refreshKey: number }) {
  const [open, setOpen] = useState(false);
  const [history, setHistory] = useState<RegistryInput[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<"points" | "field">("points");
  const [fromId, setFromId] = useState<string | null>(null);
  const [toId, setToId] = useState("now");
  const [field, setField] = useState("");
  const [fieldRows, setFieldRows] = useState<RegistryInput[] | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const head = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (!open) return;
    let on = true;
    setError(null);
    api(`/api/halls/${hall.id}/inputs?history=1&limit=500`).then((r) => {
      if (!on) return;
      if (!r.body?.ok || !Array.isArray(r.body.inputs)) { setHistory(null); setError((r.body?.error ?? "Could not load the history.") + " Nothing is compared."); return; }
      setHistory(r.body.inputs as RegistryInput[]); setTruncated(Boolean(r.body.truncated));
    }).catch(() => { if (on) { setHistory(null); setError("Could not reach the server. Nothing is compared."); } });
    return () => { on = false; };
  }, [open, hall.id, api, refreshKey]);

  useEffect(() => {
    if (!open || mode !== "field" || !field) { setFieldRows(null); setFieldError(null); return; }
    let on = true;
    setFieldRows(null); setFieldError(null);
    api(`/api/halls/${hall.id}/inputs?history=1&field=${encodeURIComponent(field)}`).then((r) => {
      if (!on) return;
      if (!r.body?.ok || !Array.isArray(r.body.inputs)) { setFieldError(r.body?.error ?? "Could not load this field's history."); return; }
      setFieldRows(r.body.inputs as RegistryInput[]);
    }).catch(() => { if (on) setFieldError("Could not reach the server."); });
    return () => { on = false; };
  }, [open, mode, field, hall.id, api, refreshKey]);

  const claims = useMemo(() => [...(history ?? []), ...current], [history, current]);
  const chains = useMemo(() => buildChains(claims), [claims]);
  const points = useMemo<Point[]>(() => pointsOf(claims), [claims]);
  const paths = useMemo(() => [...chains.keys()].sort(), [chains]);
  const from = points.find((p) => p.id === (fromId ?? defaultFrom(points))) ?? points[points.length - 1]!;
  const to = points.find((p) => p.id === toId) ?? points[0]!;
  const result = useMemo(() => (history ? diffPoints(chains, from, to) : null), [chains, from, to, history]);
  const steps = useMemo(() => {
    if (!fieldRows) return null;
    const c = buildChains(fieldRows).get(field);
    return c ? successions(c) : [];
  }, [fieldRows, field]);

  return (
    <section aria-labelledby="diff-title" className="mt-8 rounded-lg border border-line p-4">
      <h3 id="diff-title" ref={head} tabIndex={-1} className="text-sm font-semibold outline-none">What changed</h3>
      <p className="text-mute text-[13px] mt-1">
        Compare what was recorded about this hall at two points, or follow one field through its corrections. This compares recorded claims: each change is shown with the
        origin, class and file it rests on, as declared by the person who recorded it. It is not a recalculated capacity result. {FILE_STATUS_NOTE}
      </p>
      <button type="button" aria-expanded={open} aria-controls="diff-body" onClick={() => setOpen((o) => !o)} className="mt-3 rounded-lg border border-line px-3 py-1.5 text-[13px] text-mute hover:text-white">
        {open ? "Hide what changed" : "Show what changed"}
      </button>
      <div id="diff-body" hidden={!open}>
        {open && (
          <div className="mt-4">
            <p role="alert" className={error ? "text-red-400 text-[13px]" : "sr-only"}>{error ?? ""}</p>
            {!history && !error && <Loader2 className="animate-spin text-power" size={16} aria-label="Loading" />}
            {history && (
              <>
                {truncated && (
                  <p className="text-queue text-[12px] mb-3">
                    Only the newest 500 recorded claims are loaded. A field whose older claims are not loaded is listed as &ldquo;cannot be told&rdquo; for points before its first loaded claim, not as added.
                  </p>
                )}
                <fieldset className="mb-3">
                  <legend className="text-[12px] text-mute mb-1">Compare</legend>
                  <div className="flex flex-wrap gap-4 text-[13px]">
                    <label className="inline-flex items-center gap-2"><input type="radio" name="diff-mode" checked={mode === "points"} onChange={() => setMode("points")} /> Two points in time</label>
                    <label className="inline-flex items-center gap-2"><input type="radio" name="diff-mode" checked={mode === "field"} onChange={() => setMode("field")} /> One field&apos;s successive values</label>
                  </div>
                </fieldset>
                {mode === "points" && (
                  <>
                    <div className="grid gap-3 sm:grid-cols-2 max-w-xl">
                      <div>
                        <label htmlFor="diff-from" className="block text-[12px] text-mute mb-1">From (earlier point)</label>
                        <select id="diff-from" className={fieldBox} value={from.id} onChange={(e) => setFromId(e.target.value)}>
                          {[...points].reverse().map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                        </select>
                      </div>
                      <div>
                        <label htmlFor="diff-to" className="block text-[12px] text-mute mb-1">To (later point)</label>
                        <select id="diff-to" className={fieldBox} value={to.id} onChange={(e) => setToId(e.target.value)}>
                          {points.filter((p) => p.id !== "start").map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                        </select>
                      </div>
                    </div>
                    <div className="mt-4" aria-live="polite">
                      {result && !result.ok && <p role="alert" className="text-red-400 text-[13px]">{result.error}</p>}
                      {result && result.ok && <DiffView diff={result.diff} />}
                    </div>
                  </>
                )}
                {mode === "field" && (
                  <>
                    <div className="max-w-md">
                      <label htmlFor="diff-field" className="block text-[12px] text-mute mb-1">Field</label>
                      <select id="diff-field" className={fieldBox} value={field} onChange={(e) => setField(e.target.value)}>
                        <option value="">Choose a field…</option>
                        {paths.map((p) => <option key={p} value={p}>{p}</option>)}
                      </select>
                    </div>
                    <div className="mt-4" aria-live="polite">
                      <p role="alert" className={fieldError ? "text-red-400 text-[13px]" : "sr-only"}>{fieldError ?? ""}</p>
                      {field && !steps && !fieldError && <Loader2 className="animate-spin text-power" size={16} aria-label="Loading" />}
                      {steps && <StepsView steps={steps} />}
                    </div>
                  </>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

/** From: the end of the second-newest day something was recorded (what changed since the previous day), else the start. */
function defaultFrom(points: Point[]): string {
  const days = points.filter((p) => p.id !== "now" && p.id !== "start");
  return days.length >= 2 ? days[1]!.id : "start";
}
