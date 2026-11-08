"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { Alert, button, fieldBox, quietButton, useForm } from "@/components/SiteRegistryParts";
import { saveTextFile } from "@/components/site-registry-download";
import EngineDiffRun, { type PointBody } from "@/components/SiteRegistryEngineDiff";
import {
  IMPORT_COLUMNS, IMPORT_MAX_BYTES, IMPORT_MAX_ROWS, WRITES_PER_HOUR, buildPreview, importTemplateCsv, importTemplateJson, parseImport, replacesText, runImport, sniffFormat, writeOrder,
  type ImportReport, type Preview, type RawRow, type RowPlan,
} from "@/lib/site-registry-import";
import type { RegistryApi, RegistryInput } from "@/lib/site-registry-model";

// Batch import for one hall. The path is: choose a file -> PREVIEW (every row, and what will happen to it) -> an explicit confirm -> the rows are written
// one at a time -> a report of exactly what was written. Nothing is written before the confirm; a row the rules refuse is shown and left out, never adjusted.
// The page only presents; lib/site-registry-import.ts holds the rules and the run, and the server and the database re-check every row.

const STATUS_TEXT: Record<RowPlan["status"], string> = {
  new: "New figure",
  supersede: "Replaces the current figure",
  unchanged: "Unchanged: not written",
  rejected: "Rejected: not written",
};

export default function SiteRegistryImport({ hall, api, onWritten, onSynced, onRunning }: {
  hall: { id: string; label: string }; api: RegistryApi;
  /** The figures a finished run wrote (the table is updated from the writes' own answers). */
  onWritten: (written: RegistryInput[]) => void;
  /** After a STOP: the hall's figures as they were read again, to replace the table wholesale (so it is not stale). */
  onSynced?: (current: RegistryInput[]) => void;
  /** true while rows are being written: the page pauses hall, site and organisation navigation, so the run is never abandoned. */
  onRunning?: (running: boolean) => void;
}) {
  const f = useForm();
  const [fileName, setFileName] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  /** The rows as the file gave them: what "Run the engine on this preview" sends, so the server judges them by the import's own rules again. */
  const [rawRows, setRawRows] = useState<RawRow[] | null>(null);
  const [okReplace, setOkReplace] = useState(false);
  const [okFlagged, setOkFlagged] = useState(false);
  const [announce, setAnnounce] = useState("");
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number; current: number | null } | null>(null);
  const [waitUntil, setWaitUntil] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [report, setReport] = useState<ImportReport | null>(null);
  const cancelled = useRef(false);
  const mounted = useRef(true);
  const previewHead = useRef<HTMLHeadingElement>(null);
  const reportHead = useRef<HTMLHeadingElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const stopButton = useRef<HTMLButtonElement>(null);
  const lastAnnounced = useRef(0);

  useEffect(() => () => { mounted.current = false; cancelled.current = true; }, []);
  // A new preview, and then the report, take focus once they are on the page, so a keyboard user lands on what to read next.
  useEffect(() => { if (preview) previewHead.current?.focus(); }, [preview]);
  useEffect(() => { if (report) reportHead.current?.focus(); }, [report]);
  // A run started from the keyboard: the button that was pressed is now disabled, so focus goes to the one control that matters while it runs.
  useEffect(() => { if (running) stopButton.current?.focus(); }, [running]);
  useEffect(() => { onRunning?.(running); return () => onRunning?.(false); }, [running, onRunning]);
  useEffect(() => {
    if (waitUntil === null) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [waitUntil]);
  // Leaving the page half-way through a run would strand it: ask the browser to confirm.
  useEffect(() => {
    if (!running) return;
    const guard = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [running]);

  const reset = () => { setPreview(null); setRawRows(null); setOkReplace(false); setOkFlagged(false); setAnnounce(""); setReport(null); setProgress(null); setWaitUntil(null); f.setMsg(null); };

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    reset();
    setFileName(file?.name ?? null);
    if (!file) return;
    if (file.size > IMPORT_MAX_BYTES) { f.fail(`That file is ${Math.ceil(file.size / 1024)} KB; the most this import reads is ${IMPORT_MAX_BYTES / 1024} KB. Split it. Nothing was read.`); return; }
    f.setBusy(true);
    try {
      const text = await file.text();
      const parsed = parseImport(text, sniffFormat(file.name, text));
      if (!parsed.ok) { f.fail(parsed.error); return; }
      // The current figures are read fresh now, so "replaces" is judged against what the hall holds at this moment.
      const cur = await api(`/api/halls/${hall.id}/inputs`);
      if (!cur.body?.ok || !Array.isArray(cur.body.inputs)) { f.fail((cur.body?.error ?? "Could not read the hall's current figures.") + " Nothing was previewed or written."); return; }
      if (!mounted.current) return;
      setRawRows(parsed.rows);
      setPreview(buildPreview(parsed.rows, { current: cur.body.inputs as RegistryInput[], today: new Date().toISOString().slice(0, 10) }, parsed.commentLines));
    } catch {
      f.fail("Could not read the file or reach the server. Nothing was written.");
    } finally {
      f.setBusy(false);
    }
  }

  async function confirm() {
    if (!preview) return;
    const rows = writeOrder(preview);
    cancelled.current = false;
    lastAnnounced.current = 0;
    onRunning?.(true);                                   // the lock is taken in the same step as the click, not a render later
    setRunning(true); setReport(null); f.setMsg(null); setProgress({ done: 0, total: rows.length, current: null });
    setAnnounce(`Writing ${rows.length} figure${rows.length === 1 ? "" : "s"}, one at a time. The Stop button pauses after the current row.`);
    const result = await runImport(rows, {
      post: async (body) => {
        const r = await api(`/api/halls/${hall.id}/inputs`, { method: "POST", body });
        return { status: r.status, body: r.body, retryAfter: r.retryAfter ?? null };
      },
      sleep: (ms) => new Promise((res) => setTimeout(res, ms)),
      isCancelled: () => cancelled.current,
      verify: async () => {
        const r = await api(`/api/halls/${hall.id}/inputs`);
        return r.body?.ok && Array.isArray(r.body.inputs) ? (r.body.inputs as RegistryInput[]) : null;
      },
      gapMs: 150,
      onProgress: (p) => {
        if (!mounted.current) return;
        setProgress({ done: p.done, total: p.total, current: p.current });
        // The live region is told only every 10 rows and when a wait begins (the report announces the end): not once per row.
        if (p.waitingSeconds !== null) setAnnounce(`Waiting for the registry's allowance before row ${p.current} is tried again.`);
        else if (p.done > 0 && p.done % 10 === 0 && p.done !== lastAnnounced.current) { lastAnnounced.current = p.done; setAnnounce(`Written ${p.done} of ${p.total}.`); }
        setWaitUntil(p.waitingSeconds === null ? null : Date.now() + p.waitingSeconds * 1000);
        setNow(Date.now());
      },
    });
    if (!mounted.current) return;
    setRunning(false); setWaitUntil(null); setReport(result); setPreview(null); setOkReplace(false); setOkFlagged(false); setAnnounce("");
    const inputs = result.written.map((w) => w.input).filter((x): x is RegistryInput => x !== null);
    if (result.afterStop?.current) onSynced?.(result.afterStop.current);
    else if (inputs.length) onWritten(inputs);
    if (fileInput.current) fileInput.current.value = "";
  }

  const c = preview?.counts;
  const canConfirm = Boolean(preview && c && c.writes > 0 && (c.supersede === 0 || okReplace) && (c.flagged === 0 || okFlagged) && !running);
  const proposed = proposedFor(preview, rawRows);
  const waiting = waitUntil !== null ? Math.max(0, Math.ceil((waitUntil - now) / 1000)) : null;

  return (
    <section aria-labelledby="import-title" className="mt-8 rounded-lg border border-line p-4">
      <h3 id="import-title" className="text-sm font-semibold">Import figures from a file</h3>
      <p className="text-mute text-[13px] mt-1">
        A CSV or JSON file of up to {IMPORT_MAX_ROWS} rows and {IMPORT_MAX_BYTES / 1024} KB. You see every row and what will happen to it before anything is written. A row the rules refuse is
        left out and shown with the reason; it is never changed to fit. Origin and class are what your file declares: nothing here checks them against the real hall.
      </p>
      <div className="flex flex-wrap gap-2 mt-3" role="group" aria-label="Import templates">
        <button type="button" className={quietButton} onClick={() => saveTextFile("gridforge-hall-figures-template.csv", "text/csv", importTemplateCsv())}>Download CSV template</button>
        <button type="button" className={quietButton} onClick={() => saveTextFile("gridforge-hall-figures-template.json", "application/json", importTemplateJson())}>Download JSON template</button>
      </div>
      <p className="data text-[10px] text-faint mt-1">Columns: {IMPORT_COLUMNS.join(", ")}. The template lists the intake fields with their units and no figures.</p>

      <div className="mt-4 max-w-md">
        <label htmlFor="import-file" className="block text-[12px] text-mute mb-1">File to import (CSV or JSON)</label>
        <input id="import-file" ref={fileInput} type="file" accept=".csv,.json,text/csv,application/json" onChange={(e) => void onFile(e)} disabled={f.busy || running}
          className={fieldBox} aria-describedby="import-file-hint" />
        <p id="import-file-hint" className="data text-[10px] text-faint mt-1">{fileName ? `Chosen: ${fileName}` : "Nothing chosen. Choosing a file shows a preview; it writes nothing."}</p>
      </div>
      {f.busy && !running && <p role="status" className="text-mute text-[13px] mt-3 inline-flex items-center gap-2"><Loader2 size={14} className="animate-spin" aria-hidden="true" /> Reading the file</p>}
      <Alert msg={f.msg} forwardRef={f.alertRef} />

      {preview && c && (
        <div className="mt-5">
          <h4 id="import-preview-title" ref={previewHead} tabIndex={-1} className="text-sm font-semibold outline-none">Preview of {fileName}: nothing has been written yet</h4>
          <p className="text-[13px] text-mute mt-1" id="import-preview-summary">
            {c.total} row{c.total === 1 ? "" : "s"}: {c.new} new, {c.supersede} replacing a current figure, {c.unchanged} unchanged, <strong className={c.rejected ? "text-red-400" : "text-white"}>{c.rejected} rejected</strong>.
            {" "}{c.writes} would be written, one at a time.
            {preview.commentLines > 0 && ` ${preview.commentLines} comment line${preview.commentLines === 1 ? "" : "s"} (starting with #) skipped.`}
            {c.needDatabaseCheck > 0 && ` ${c.needDatabaseCheck} cite${c.needDatabaseCheck === 1 ? "s" : ""} a project file whose review status this page cannot see; the database decides, and they are written first.`}
          </p>
          {c.writes > WRITES_PER_HOUR && (
            <p className="text-[13px] text-queue mt-1">The registry allows {WRITES_PER_HOUR} writes an hour for your account and this import has {c.writes}. It will wait out short pauses and otherwise stop and say when to continue.</p>
          )}
          <PreviewTable rows={preview.rows} />
          <EngineDiffRun api={api} hallId={hall.id} from={{ now: true }} to={proposed} idPrefix="engine-import" title="What the engine makes of this preview" buttonLabel="Run the engine on this preview"
            blocked={running ? "Wait for the import to finish or stop it." : proposed === null ? "Nothing in this preview would be written, so there is nothing to ask the engine about." : null}
            intro={<>Asks the engine what the rows above would do to the hall&apos;s capacity envelope, compared with the figures now. Nothing is written: this is a question, and the import is still yours to confirm below.{preview.counts.rejected > 0 ? ` ${preview.counts.rejected} row${preview.counts.rejected === 1 ? " the preview rejects is" : "s the preview rejects are"} left out of this run.` : ""}</>} />

          <div className="mt-4">
            {c.supersede > 0 && (
              <label htmlFor="import-confirm-replace" className="flex items-start gap-2 text-[13px] text-mute mb-3">
                <input id="import-confirm-replace" type="checkbox" checked={okReplace} onChange={(e) => setOkReplace(e.target.checked)} disabled={running} className="mt-1" />
                <span>I understand that {c.supersede} row{c.supersede === 1 ? "" : "s"} will replace a current figure. The earlier figures stay in the history.</span>
              </label>
            )}
            {c.flagged > 0 && (
              <label htmlFor="import-confirm-flagged" className="flex items-start gap-2 text-[13px] text-mute mb-3">
                <input id="import-confirm-flagged" type="checkbox" checked={okFlagged} onChange={(e) => setOkFlagged(e.target.checked)} disabled={running} className="mt-1" />
                <span>I understand that {c.flagged} row{c.flagged === 1 ? "" : "s"} raise the declared class, change the origin or withdraw a figure. These are declarations in my file; nothing here checks them.</span>
              </label>
            )}
            <div className="flex flex-wrap gap-3 items-center">
              <button type="button" id="import-confirm" onClick={() => void confirm()} disabled={!canConfirm} aria-describedby="import-preview-summary" className={button}>
                {running ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : null}{c.writes === 0 ? "Nothing to write" : `Write ${c.writes} figure${c.writes === 1 ? "" : "s"}`}
              </button>
              <button type="button" onClick={() => { reset(); setFileName(null); if (fileInput.current) fileInput.current.value = ""; }} disabled={running} className={quietButton}>Discard this preview</button>
            </div>
          </div>
        </div>
      )}

      {running && (
        <div className="mt-4">
          <p className="text-[13px] text-white" id="import-progress">
            {waiting !== null && waiting > 0
              ? `Waiting about ${waiting} second${waiting === 1 ? "" : "s"} for the registry's allowance, then row ${progress?.current ?? ""} is tried again.`
              : `Written ${progress?.done ?? 0} of ${progress?.total ?? 0}${progress?.current ? `; writing row ${progress.current}` : ""}.`}
          </p>
          <button type="button" ref={stopButton} id="import-stop" aria-describedby="import-progress" onClick={() => { cancelled.current = true; }} className={`${quietButton} mt-2`}>Stop after the current row</button>
          <p className="data text-[10px] text-faint mt-1">While rows are being written, the hall, site and organisation controls are paused so this run is not abandoned.</p>
        </div>
      )}
      {/* Announced to screen readers every 10 rows and when a wait begins, never once per row; the report (which takes focus) announces the end. */}
      <p role="status" id="import-announce" className="sr-only">{announce}</p>

      {report && <ReportView report={report} headRef={reportHead} hallLabel={hall.label} />}
    </section>
  );
}

/** The rows of the file that the preview did not reject, as the engine route takes them (it judges them again). null when there are none. */
function proposedFor(preview: Preview | null, raw: RawRow[] | null): PointBody | null {
  if (!preview || !raw) return null;
  const rejected = new Set(preview.rows.filter((p) => p.status === "rejected").map((p) => p.n));
  const rows = raw.filter((r) => !rejected.has(r.n)).map((r) => {
    const cells: Record<string, string | number | boolean | null> = {};
    for (const [k, v] of Object.entries(r.cells)) if (v === null || ["string", "number", "boolean"].includes(typeof v)) cells[k] = v as string | number | boolean | null;
    return { n: r.n, fromCsv: r.fromCsv, cells };
  });
  return rows.length ? { proposed: rows } : null;
}

/** Every row of a preview. The wrapper scrolls sideways on a narrow screen, so it is a focusable, named region (a keyboard user can scroll it). */
export function PreviewTable({ rows }: { rows: RowPlan[] }) {
  return (
  <div className="mt-3 overflow-x-auto" role="region" aria-labelledby="import-preview-title" tabIndex={0}>
    <table className="w-full min-w-[52rem] text-left border-collapse">
      <caption className="text-left text-mute text-[12px] mb-2">Every row of the file and what will happen to it. Origin and class are as declared in the file.</caption>
      <thead>
        <tr className="border-b border-line text-faint data text-[10px] uppercase">
          {["Row", "Field", "What will happen", "Value", "Origin", "Class", "Source file", "Why / notes"].map((h) => <th key={h} scope="col" className="px-3 py-2 font-normal">{h}</th>)}
        </tr>
      </thead>
      <tbody className="divide-y divide-line/60">
        {rows.map((r) => (
          <tr key={r.n} data-status={r.status}>
            <th scope="row" className="px-3 py-2 align-top text-[13px] font-normal text-white">{r.n}</th>
            <td className="px-3 py-2 align-top text-[13px] break-all">{r.fieldPath || "(empty)"}</td>
            <td className={`px-3 py-2 align-top text-[13px] ${r.status === "rejected" ? "text-red-400" : r.status === "supersede" ? "text-queue" : "text-white"}`}>{STATUS_TEXT[r.status]}</td>
            <td className="px-3 py-2 align-top text-[13px] break-all">{r.shown.value || <span className="text-faint">(none)</span>}</td>
            <td className="px-3 py-2 align-top text-[13px]">{r.shown.origin || <span className="text-faint">(none)</span>}</td>
            <td className="px-3 py-2 align-top text-[13px]">{r.shown.evidenceClass || <span className="text-faint">(none)</span>}</td>
            <td className="px-3 py-2 align-top text-[13px] break-all">{r.shown.source || <span className="text-faint">none</span>}</td>
            <td className="px-3 py-2 align-top text-[13px]">
              {r.reasons.length > 0 && <ul className="list-disc pl-4 text-red-400">{r.reasons.map((x) => <li key={x}>{x}</li>)}</ul>}
              {r.flags.length > 0 && <ul className="list-disc pl-4 text-queue font-semibold" aria-label="Provenance changes">{r.flags.map((x) => <li key={x}>{x}</li>)}</ul>}
              {r.replaces && <p className="text-mute">{r.status === "unchanged" ? "Same as the current figure: " : "Replaces: "}{replacesText(r.replaces)}. The earlier figure stays in the history.</p>}
              {r.warnings.length > 0 && <ul className="list-disc pl-4 text-queue">{r.warnings.map((x) => <li key={x}>{x}</li>)}</ul>}
              {r.status === "new" && r.reasons.length === 0 && r.warnings.length === 0 && <span className="text-faint">First figure for this field.</span>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
  );
}

export function ReportView({ report, headRef, hallLabel }: { report: ImportReport; headRef: React.RefObject<HTMLHeadingElement>; hallLabel: string }) {
  const title = report.outcome === "complete" ? "Import finished" : report.outcome === "cancelled" ? "Import stopped at your request" : "Import stopped: not everything was written";
  return (
    <div className="mt-5" role="region" aria-labelledby="import-report-title">
      <h4 id="import-report-title" ref={headRef} tabIndex={-1} className={`text-sm font-semibold outline-none ${report.outcome === "stopped" ? "text-red-400" : ""}`}>{title}</h4>
      <p className="text-[13px] text-mute mt-1">
        {report.written.length} figure{report.written.length === 1 ? "" : "s"} written to {hallLabel}
        {report.notAttempted.length > 0 ? `, ${report.notAttempted.length} not tried` : ""}{report.failed ? ", 1 failed" : ""}.
      </p>
      {report.failed && (
        report.failed.outcomeUnknown ? (
          <p role="alert" className="text-[13px] text-red-400 mt-2">Row {report.failed.n} ({report.failed.fieldPath}): {report.failed.message}</p>
        ) : (
          <p role="alert" className="text-[13px] text-red-400 mt-2">Row {report.failed.n} ({report.failed.fieldPath}) was NOT written: {report.failed.message}</p>
        )
      )}
      {report.afterStop && (
        <p className="text-[13px] text-mute mt-2" id="import-after-stop">
          {report.afterStop.read
            ? `After the stop the hall's figures were read again. ${report.afterStop.landed.length > 0 ? `Rows ${report.afterStop.landed.join(", ")} ARE in the hall (their answer was lost or came too late). ` : ""}${report.afterStop.absent.length > 0 ? `Rows ${report.afterStop.absent.join(", ")} are not in the hall.` : "Every remaining row is in the hall."}`
            : "The hall's figures could not be read again after the stop. Reload the page and check them before importing again."}
        </p>
      )}
      {report.written.length > 0 && (
        <details className="mt-2 text-[13px]">
          <summary className="cursor-pointer text-mute">Written rows ({report.written.length})</summary>
          <ul className="list-disc pl-5 mt-1">{report.written.map((w) => <li key={w.n}>Row {w.n}: {w.fieldPath}</li>)}</ul>
        </details>
      )}
      {report.notAttempted.length > 0 && (
        <details className="mt-2 text-[13px]" open>
          <summary className="cursor-pointer text-mute">Never tried ({report.notAttempted.length})</summary>
          <ul className="list-disc pl-5 mt-1">{report.notAttempted.map((w) => <li key={w.n}>Row {w.n}: {w.fieldPath}</li>)}</ul>
        </details>
      )}
    </div>
  );
}
