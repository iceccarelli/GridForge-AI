"use client";

import React, { useCallback, useEffect, useState } from "react";
import { CircleAlert, CircleCheck, Loader2, Paperclip } from "lucide-react";

/**
 * Evidence for the three figures a Density Screen can be left without: attach the document, say where in it the number is, confirm.
 *
 * What this does and does not do, stated to the buyer in the panel itself: GridForge does not read the file. The number is the one the
 * buyer types against it and attests to; the document they receive names the file and the place in it, and says it was not independently
 * verified. Where the storage behind this is not available the panel renders nothing and the form works as it always did.
 */

const FIELDS = [
  { field: "firmCapacityMVA", label: "Firm connection capacity", unit: "MVA", from: "your DSO connection agreement" },
  { field: "floorLoadingKPa", label: "Floor loading", unit: "kPa", from: "the structural record for the hall" },
  { field: "plantCapacityKW", label: "Chilled-water plant capacity", unit: "kW", from: "the mechanical schedule for the plant" },
] as const;

type FieldId = (typeof FIELDS)[number]["field"];

interface FileRow { id: string; filename: string; byte_size: number }
interface Confirmed { field: FieldId; value: number; unit: string; file: { id: string; filename: string }; locator: string }

const MAX_BYTES = 5 * 1024 * 1024;
const inputCls =
  "w-full rounded border border-line bg-panel-2 px-3 py-2 font-mono text-ghost focus:border-power/60 focus:outline-none focus:ring-2 focus:ring-power/60";

export function IntakeEvidence({ token, onConfirmedChange }: { token: string; onConfirmedChange: (fields: FieldId[]) => void }) {
  const base = `/api/intake/${token}`;
  const [state, setState] = useState<"loading" | "unavailable" | "ready">("loading");
  const [files, setFiles] = useState<FileRow[]>([]);
  const [confirmed, setConfirmed] = useState<Confirmed[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [draft, setDraft] = useState<Record<string, { value: string; fileId: string; locator: string }>>({});

  const apply = useCallback(
    (c: Confirmed[]) => {
      setConfirmed(c);
      onConfirmedChange(c.map((x) => x.field));
    },
    [onConfirmedChange]
  );

  useEffect(() => {
    let alive = true;
    fetch(`${base}/evidence`)
      .then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }))
      .then(({ status, body }) => {
        if (!alive) return;
        if (status !== 200 || !body.ok) return setState("unavailable");
        setFiles(body.files ?? []);
        apply(body.confirmed ?? []);
        setState("ready");
      })
      .catch(() => alive && setState("unavailable"));
    return () => {
      alive = false;
    };
  }, [base, apply]);

  if (state === "loading") return null;
  if (state === "unavailable") return null;

  async function attach(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (file.size > MAX_BYTES) return setMsg({ kind: "err", text: `That file is larger than ${MAX_BYTES / (1024 * 1024)} MB.` });
    setBusy("upload");
    setMsg(null);
    try {
      const res = await fetch(`${base}/evidence?filename=${encodeURIComponent(file.name)}`, { method: "POST", headers: { "Content-Type": file.type || "application/octet-stream" }, body: file });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.ok) return setMsg({ kind: "err", text: body?.error ?? "The file could not be attached." });
      setFiles((cur) => [...cur, body.file]);
      setMsg({ kind: "ok", text: `${body.file.filename} attached.` });
    } catch {
      setMsg({ kind: "err", text: "Could not reach the server. Nothing was attached." });
    } finally {
      setBusy(null);
    }
  }

  async function send(field: FieldId, payload: Record<string, unknown>, ok: string) {
    setBusy(field);
    setMsg(null);
    try {
      const res = await fetch(`${base}/confirm`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ field, ...payload }) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.ok) return setMsg({ kind: "err", text: body?.error ?? "That could not be saved." });
      apply(body.confirmed ?? []);
      setMsg({ kind: "ok", text: ok });
    } catch {
      setMsg({ kind: "err", text: "Could not reach the server. Nothing was saved." });
    } finally {
      setBusy(null);
    }
  }

  const set = (field: string, key: "value" | "fileId" | "locator") => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setDraft((d) => {
      const cur = d[field] ?? { value: "", fileId: files[0]?.id ?? "", locator: "" };
      return { ...d, [field]: { ...cur, [key]: e.target.value } };
    });

  return (
    <div data-testid="intake-evidence" className="rounded border border-line bg-panel/60 p-4 text-[12px] leading-relaxed text-mute">
      <div className="eyebrow mb-2 text-power">Back a number with your own document</div>
      <p className="mb-3">
        Attach the document a figure comes from, say where in it the number is, and confirm it. The document you receive then names the
        file and the place in it. <strong className="text-ghost">We do not read your file</strong>: the number is the one you type and
        attest to, it counts as your own data, and we state that we have not independently verified it. PDF, CSV or JSON, up to 5 MB.
      </p>

      <label className="mb-4 inline-flex cursor-pointer items-center gap-2 rounded border border-line px-3 py-2 text-ghost focus-within:ring-2 focus-within:ring-power/60">
        {busy === "upload" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Paperclip className="h-4 w-4" aria-hidden />}
        <span>Attach a document</span>
        <input type="file" accept="application/pdf,text/csv,application/json,.pdf,.csv,.json" className="sr-only" onChange={attach} disabled={busy !== null} />
      </label>
      {files.length > 0 ? (
        <ul className="mb-4 space-y-1" aria-label="Attached documents">
          {files.map((f) => (
            <li key={f.id} className="data text-[11px] text-faint">· {f.filename} ({Math.max(1, Math.round(f.byte_size / 1024))} KB)</li>
          ))}
        </ul>
      ) : null}

      <div className="grid gap-4">
        {FIELDS.map(({ field, label, unit, from }) => {
          const have = confirmed.find((c) => c.field === field);
          const d = draft[field] ?? { value: "", fileId: files[0]?.id ?? "", locator: "" };
          const id = `ev-${field}`;
          return (
            <div key={field} className="rounded border border-line/60 p-3">
              <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">{label} · {unit}</div>
              {have ? (
                <div className="mt-2 flex flex-wrap items-center gap-3">
                  <CircleCheck className="h-4 w-4 text-verified" aria-hidden />
                  <span className="text-ghost">
                    {have.value} {have.unit} — {have.file.filename}, {have.locator}
                  </span>
                  <button type="button" className="underline decoration-dotted hover:text-ghost" disabled={busy !== null} onClick={() => send(field, { withdraw: true }, `${label} withdrawn: it will be treated as you typed it, or assumed.`)}>
                    Withdraw
                  </button>
                </div>
              ) : files.length === 0 ? (
                <p className="mt-2 text-faint">Attach {from} to confirm this from it, or type the number in the form below.</p>
              ) : (
                <div className="mt-2 grid gap-3 sm:grid-cols-4">
                  <div>
                    <label htmlFor={`${id}-file`} className="text-faint">Document</label>
                    <select id={`${id}-file`} className={inputCls} value={d.fileId} onChange={set(field, "fileId")}>
                      {files.map((f) => <option key={f.id} value={f.id}>{f.filename}</option>)}
                    </select>
                  </div>
                  <div>
                    <label htmlFor={`${id}-loc`} className="text-faint">Where in it</label>
                    <input id={`${id}-loc`} className={inputCls} placeholder="clause 4.2" maxLength={200} value={d.locator} onChange={set(field, "locator")} />
                  </div>
                  <div>
                    <label htmlFor={`${id}-val`} className="text-faint">Value · {unit}</label>
                    <input id={`${id}-val`} className={inputCls} type="number" step="any" min="0" value={d.value} onChange={set(field, "value")} />
                  </div>
                  <div className="flex items-end">
                    <button
                      type="button"
                      className="rounded border border-power/60 px-3 py-2 text-ghost hover:bg-power/10 disabled:opacity-50"
                      disabled={busy !== null || d.value === "" || d.locator.trim() === "" || d.fileId === ""}
                      onClick={() => send(field, { value: Number(d.value), fileId: d.fileId, locator: d.locator.trim() }, `${label} confirmed from ${files.find((f) => f.id === d.fileId)?.filename ?? "the document"}.`)}
                    >
                      {busy === field ? "Saving…" : "Confirm"}
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <p role="status" aria-live="polite" className={`mt-3 flex items-center gap-2 ${msg?.kind === "err" ? "text-flag" : "text-verified"}`}>
        {msg ? (<>{msg.kind === "err" ? <CircleAlert className="h-4 w-4" aria-hidden /> : <CircleCheck className="h-4 w-4" aria-hidden />}{msg.text}</>) : null}
      </p>
    </div>
  );
}
